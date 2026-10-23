import { convertToModelMessages, generateText, type ModelMessage, type UIMessage } from "ai";
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
 * Replace everything up to the boundary with the stored summary. If the boundary is not on this branch
 * (the user edited an earlier message), the compaction does not apply and the full history is sent.
 */
export function applyCompaction(messages: UIMessage[], state: CompactionState | null): { messages: UIMessage[]; summary?: string } {
  if (!state) return { messages };
  const index = messages.findIndex((m) => m.id === state.boundaryMessageId);
  if (index === -1) return { messages };
  return { messages: messages.slice(index + 1), summary: state.summary };
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
  const { messages: recent, summary: earlier } = applyCompaction(opts.messages, opts.previous);
  const boundary = opts.messages.at(-1);
  if (!boundary) throw new Error("Nothing to compact");
  const handle = createModel(opts.model, opts.conn, { affinity: opts.threadId });
  const history = [...(earlier ? summaryMessages(earlier) : []), ...(await convertToModelMessages(recent, { ignoreIncompleteToolCalls: true }))];
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
  return {
    boundaryMessageId: boundary.id,
    summary: result.text.trim(),
    tokensBefore: currentContextTokens(opts.messages),
    createdAt: Date.now(),
  };
}
