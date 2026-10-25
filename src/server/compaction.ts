import { convertToModelMessages, generateText, isToolUIPart, type ModelMessage, type ToolSet, type UIMessage } from "ai";
import type { AssistantMetadata, CompactionState, ModelInfo } from "../shared/types.js";
import type { Connection } from "./catalog/providers.js";
import { createModel } from "./llm.js";
import { promptText } from "./prompts.js";
import { costOf, normalizeUsage, recordUsage } from "./usage.js";

/** Rough token estimate when the provider has not told us yet. */
export const estimateTokens = (value: unknown) => Math.ceil(JSON.stringify(value).length / 4);

/** Last known context size: the newest assistant message that reported it, plus anything after it. */
export function currentContextTokens(messages: UIMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const raw = messages[i]!.metadata as (AssistantMetadata & { custom?: AssistantMetadata }) | undefined;
    const meta = raw?.custom ?? raw;
    if (messages[i]!.role === "assistant" && meta?.contextTokens) {
      return meta.contextTokens + estimateTokens(messages.slice(i + 1));
    }
  }
  return estimateTokens(messages);
}

/**
 * Context size of the history as it is sent. Replies reported before a trim describe the untrimmed
 * history, so until a newer reply reports, the trim's own estimate stands in for them.
 */
export function contextTokens(messages: UIMessage[], state: CompactionState | null): number {
  const applied = applyCompaction(messages, state);
  const trim = applied.trimmed ? state?.trim : undefined;
  const last = trim ? applied.messages.findIndex((m) => m.id === trim.lastMessageId) : -1;
  if (!trim || last === -1) return currentContextTokens(applied.messages);
  const later = applied.messages.slice(last + 1);
  return later.some((m) => m.role === "assistant" && reportedTokens(m)) ? currentContextTokens(later) : trim.tokensAfter + estimateTokens(later);
}

function reportedTokens(message: UIMessage): number | undefined {
  const raw = message.metadata as (AssistantMetadata & { custom?: AssistantMetadata }) | undefined;
  return (raw?.custom ?? raw)?.contextTokens;
}

/**
 * Replace everything up to the summary boundary with the stored summary, and mark how many of the remaining
 * messages are trimmed. A boundary that is not on this branch (the user edited an earlier message) does not
 * apply, so the full history is sent.
 */
export function applyCompaction(messages: UIMessage[], state: CompactionState | null): { messages: UIMessage[]; summary?: string; trimmed: number } {
  let rest = messages;
  let summary: string | undefined;
  const index = state?.summary ? messages.findIndex((m) => m.id === state.boundaryMessageId) : -1;
  if (index !== -1) {
    rest = messages.slice(index + 1);
    summary = state!.summary;
  }
  const trimmed = state?.trim ? rest.findIndex((m) => m.id === state.trim!.throughMessageId) + 1 : 0;
  return { messages: rest, summary, trimmed };
}

/** Converts compacted history to model messages, sending the trimmed head as text only. */
export async function historyMessages(
  applied: { messages: UIMessage[]; trimmed: number },
  prepare: (messages: UIMessage[]) => Promise<UIMessage[]> | UIMessage[],
  tools?: ToolSet,
): Promise<ModelMessage[]> {
  const head = applied.messages.slice(0, applied.trimmed).map(trimMessage);
  const tail = await prepare(applied.messages.slice(applied.trimmed));
  // Trimmed tool results are plain strings now, so the head skips the tools' own toModelOutput.
  return [
    ...(await convertToModelMessages(head, { ignoreIncompleteToolCalls: true })),
    ...(await convertToModelMessages(tail, { tools, ignoreIncompleteToolCalls: true })),
  ];
}

const RESULT_REMOVED = "[Result removed from the conversation to save context. Call the tool again if you need it.]";
const MAX_KEPT_STRING = 300;
const MAX_ERROR = 300;

/**
 * The text-only form of a finished message: the user's and assistant's words stay verbatim, while reasoning,
 * tool results, long tool arguments, file bytes, and attachment bodies become short placeholders. Tool calls
 * stay real calls, so the model still knows what it did without learning to imitate a text format.
 */
export function trimMessage(message: UIMessage): UIMessage {
  const parts = message.parts.flatMap((part): UIMessage["parts"] => {
    if (part.type === "reasoning" || part.type === "reasoning-file") return [];
    if (part.type === "text") {
      const attachment = /^<attachment ([^>]*)>([\s\S]*)<\/attachment>$/.exec(part.text);
      if (attachment && attachment[2]!.trim()) {
        const note = /file_id="/.test(attachment[1]!)
          ? "[Content removed from the conversation to save context. Call read_attachment with this file_id to read it again.]"
          : "[Content removed from the conversation to save context. Ask the user to attach it again if you need it.]";
        return [{ type: "text", text: `<attachment ${attachment[1]}>${note}</attachment>` }];
      }
      // Provider item ids would point at reasoning items that are no longer sent.
      return [{ type: "text", text: part.text }];
    }
    if (part.type === "file") {
      const name = part.filename ? `"${part.filename.replaceAll('"', "'")}" ` : "";
      return [{ type: "text", text: `[File ${name}(${part.mediaType}) removed from the conversation to save context. Its <attachment> header, if any, has the file_id for read_attachment.]` }];
    }
    if (isToolUIPart(part)) {
      // Provider-executed results have provider-specific shapes that a placeholder would break.
      if (part.providerExecuted) return [];
      const { callProviderMetadata: _call, resultProviderMetadata: _result, rawInput: _raw, ...rest } = part as typeof part & { resultProviderMetadata?: unknown; rawInput?: unknown };
      if (part.state === "output-available") return [{ ...rest, input: shrink(part.input), output: RESULT_REMOVED, preliminary: undefined } as typeof part];
      if (part.state === "output-error") return [{ ...rest, input: shrink(part.input), errorText: part.errorText.slice(0, MAX_ERROR) } as typeof part];
      if (part.state === "output-denied") return [{ ...rest, input: shrink(part.input) } as typeof part];
      return [];
    }
    return [part];
  });
  // A user message never disappears: turn contexts are matched to user messages by position.
  return { ...message, parts: parts.length || message.role !== "user" ? parts : [{ type: "text", text: "[Message content removed to save context.]" }] };
}

/** Tool arguments keep their shape, but long strings (artifact sources, code) become a length note. */
function shrink(value: unknown): unknown {
  if (typeof value === "string") return value.length > MAX_KEPT_STRING ? `${value.slice(0, 120)}… [${value.length - 120} characters removed to save context]` : value;
  if (Array.isArray(value)) return value.map(shrink);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shrink(item)]));
  return value;
}

// Inline images and PDFs are base64 data URLs. Counting their characters would wildly overstate the tokens
// that trimming saves, so each counts as a typical image.
const FILE_TOKENS = 1_500;
const estimateSent = (messages: UIMessage[]) =>
  Math.ceil(JSON.stringify(messages, (_key, value: unknown) => (typeof value === "string" && value.startsWith("data:") ? "x".repeat(FILE_TOKENS * 4) : value)).length / 4);

/**
 * Moves the trim boundary to the message before the newest user message, so the latest exchange (and any
 * turn still in progress) keeps its tool calls, results, and files. Returns null when nothing new is trimmed.
 */
export function trimCompaction(messages: UIMessage[], previous: CompactionState | null): CompactionState | null {
  const lastUser = messages.findLastIndex((m) => m.role === "user");
  const through = messages[lastUser - 1];
  if (!through) return null;
  const before = applyCompaction(messages, previous);
  const next: CompactionState = { ...previous, trim: { throughMessageId: through.id, lastMessageId: messages.at(-1)!.id, tokensBefore: 0, tokensAfter: 0, createdAt: Date.now() } };
  const after = applyCompaction(messages, next);
  if (after.trimmed <= before.trimmed) return null;
  const newlyTrimmed = after.messages.slice(before.trimmed, after.trimmed);
  const saved = Math.max(0, estimateSent(newlyTrimmed) - estimateSent(newlyTrimmed.map(trimMessage)));
  const tokensBefore = contextTokens(messages, previous);
  next.trim!.tokensBefore = tokensBefore;
  next.trim!.tokensAfter = Math.max(0, tokensBefore - saved);
  return next;
}

export function summaryMessages(summary: string): ModelMessage[] {
  return [
    { role: "user", content: `<conversation-summary>\n${summary}\n</conversation-summary>\nContinue from this summary.` },
    { role: "assistant", content: "Understood. I have the context from the summary and will continue from there." },
  ];
}

export async function compact(opts: {
  userId: string;
  threadId: string;
  messages: UIMessage[];
  previous: CompactionState | null;
  model: ModelInfo;
  conn: Connection;
}): Promise<CompactionState> {
  const applied = applyCompaction(opts.messages, opts.previous);
  const boundary = opts.messages.at(-1);
  if (!boundary) throw new Error("Nothing to compact");
  const handle = createModel(opts.model, opts.conn, { userId: opts.userId });
  const history = [...(applied.summary ? summaryMessages(applied.summary) : []), ...(await historyMessages(applied, (tail) => tail))];
  const result = await generateText({
    model: handle.model,
    providerOptions: handle.providerOptions,
    messages: [...history, { role: "user", content: promptText("compaction") }],
    maxOutputTokens: Math.min(8_000, opts.model.maxOutput),
  });
  const usage = normalizeUsage(result.totalUsage);
  recordUsage({
    userId: opts.userId,
    threadId: opts.threadId,
    providerId: opts.model.providerId,
    modelId: opts.model.id,
    kind: "compaction",
    usage,
    cost: costOf(opts.model.cost, usage),
  });
  // The summary covers every trimmed message, so the trim boundary is dropped with them.
  return {
    boundaryMessageId: boundary.id,
    summary: result.text.trim(),
    tokensBefore: contextTokens(opts.messages, opts.previous),
    createdAt: Date.now(),
  };
}
