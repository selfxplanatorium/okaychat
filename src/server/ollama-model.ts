import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4FunctionTool,
  LanguageModelV4GenerateResult,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4ToolResultOutput,
  LanguageModelV4Usage,
  SharedV4Warning,
} from "@ai-sdk/provider";
import type { ReasoningEffort } from "../shared/types.js";
import { ollamaChat, OllamaError, type OllamaConnection } from "./catalog/ollama.js";
import { newId } from "./crypto.js";

// A small in-repo provider for Ollama's native /api/chat protocol. The installed AI SDK speaks
// LanguageModelV4, so this implements that interface rather than the OpenAI compatibility layer.
// See docs/implementation/ollama.md.

interface NativeToolCall {
  function?: { name?: unknown; arguments?: unknown };
}

interface NativeMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: string[];
  thinking?: string;
  tool_name?: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
}

interface NativeChatChunk {
  model?: string;
  created_at?: string;
  message?: {
    role?: string;
    content?: unknown;
    thinking?: unknown;
    tool_calls?: NativeToolCall[];
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
  error?: string;
}

export interface OllamaModelOptions {
  id: string;
  baseURL: string;
  guarded?: boolean;
  /** `/api/show` reports the `thinking` capability. */
  thinking?: boolean;
  /** Named native thinking levels from `/api/show` (gpt-oss: low, medium, high). */
  thinkingLevels?: string[];
  /** Native `think: false` is accepted, so "none" can turn thinking off. */
  thinkingOff?: boolean;
  /** Context window requested with `num_ctx`; the same number the app advertises and meters. */
  context?: number;
  /** Default effort from the chat composer; a per-call `reasoning` option wins. */
  reasoning?: ReasoningEffort;
}

/** One NDJSON line of chat output. Tool arguments can be large, so the cap is generous. */
const MAX_CHAT_LINE = 8 * 1024 * 1024;

const finite = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const textOf = (value: unknown) => (typeof value === "string" ? value : "");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Ollama wants tool arguments as a JSON object, while AI SDK prompts carry an object or a JSON string. */
function argumentsObject(input: unknown): Record<string, unknown> {
  if (input === undefined || input === null) return {};
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Fall through to the wrapped value; the daemon still receives valid JSON.
    }
    return { input };
  }
  if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>;
  return { input: input ?? null };
}

function toolOutputText(output: LanguageModelV4ToolResultOutput): string {
  switch (output.type) {
    case "text":
      return output.value;
    case "json":
      return JSON.stringify(output.value);
    case "error-text":
      return `Error: ${output.value}`;
    case "error-json":
      return `Error: ${JSON.stringify(output.value)}`;
    case "execution-denied":
      return output.reason ?? "Tool execution was denied.";
    case "content":
      return output.value
        .map((part) => (part.type === "text" ? part.text : "[file output omitted: Ollama tool results are text only]"))
        .join("\n");
  }
}

function imageBase64(file: { data: unknown }): string {
  const data = file.data as
    | { type: "data"; data: Uint8Array | string }
    | { type: "url"; url: URL; originalUrl?: string }
    | { type: "reference"; reference: unknown }
    | { type: "text"; text: string };
  if (data.type === "data") {
    return typeof data.data === "string" ? data.data : Buffer.from(data.data).toString("base64");
  }
  if (data.type === "url") {
    const href = data.originalUrl ?? data.url.href;
    if (href.startsWith("data:")) {
      const comma = href.indexOf(",");
      if (comma >= 0) return href.slice(comma + 1);
    }
    throw new OllamaError("Ollama needs image bytes in the request, and this image is only available as a URL. Attach the image again.");
  }
  throw new OllamaError("Ollama cannot read this attachment. Attach it as an image or text.");
}

function unsupportedFile(mediaType: string, data: { type: string; text?: string }): string | null {
  if (data.type === "text" && typeof data.text === "string") return data.text;
  throw new OllamaError(`Ollama cannot read ${mediaType} attachments. Attach a text version or switch models.`);
}

/**
 * Converts the neutral AI SDK prompt into Ollama messages. System messages stay separate and are sent
 * unchanged; there are no cache fields to add. Images become the `images` array on a user message.
 */
export function ollamaMessages(prompt: LanguageModelV4Prompt): NativeMessage[] {
  const out: NativeMessage[] = [];
  for (const message of prompt) {
    if (message.role === "system") {
      out.push({ role: "system", content: message.content });
      continue;
    }
    if (message.role === "user") {
      const texts: string[] = [];
      const images: string[] = [];
      for (const part of message.content) {
        if (part.type === "text") texts.push(part.text);
        else if (part.type === "file") {
          if (part.mediaType.startsWith("image/")) images.push(imageBase64(part));
          else {
            const text = unsupportedFile(part.mediaType, part.data as { type: string; text?: string });
            if (text) texts.push(text);
          }
        }
      }
      out.push({ role: "user", content: texts.join("\n"), ...(images.length ? { images } : {}) });
      continue;
    }
    if (message.role === "assistant") {
      const texts: string[] = [];
      const calls: Array<{ function: { name: string; arguments: Record<string, unknown> } }> = [];
      const toolResults: NativeMessage[] = [];
      for (const part of message.content) {
        if (part.type === "text") texts.push(part.text);
        else if (part.type === "reasoning") {
          // Ollama does not accept prior thinking back in the conversation. Keeping it out of the
          // prompt is intentional; it is not a dropped attachment.
        } else if (part.type === "tool-call") {
          calls.push({ function: { name: part.toolName, arguments: argumentsObject(part.input) } });
        } else if (part.type === "tool-result") {
          toolResults.push({ role: "tool", tool_name: part.toolName, content: toolOutputText(part.output) });
        } else if (part.type === "file" || part.type === "reasoning-file") {
          throw new OllamaError(`Ollama cannot send ${part.mediaType} content in an assistant message.`);
        }
      }
      out.push({
        role: "assistant",
        content: texts.join(""),
        ...(calls.length ? { tool_calls: calls } : {}),
      });
      out.push(...toolResults);
      continue;
    }
    // role === "tool"
    for (const part of message.content) {
      if (part.type !== "tool-result") continue;
      out.push({ role: "tool", tool_name: part.toolName, content: toolOutputText(part.output) });
    }
  }
  return out;
}

function nativeTools(options: LanguageModelV4CallOptions, warnings: SharedV4Warning[]): LanguageModelV4FunctionTool[] | undefined {
  if (!options.tools?.length || options.toolChoice?.type === "none") return undefined;
  const functions = options.tools.filter((tool): tool is LanguageModelV4FunctionTool => tool.type === "function");
  if (functions.length !== options.tools.length) {
    warnings.push({ type: "unsupported", feature: "provider tools", details: "Ollama only runs function tools." });
  }
  if (options.toolChoice?.type === "required") {
    warnings.push({ type: "compatibility", feature: "required tool choice", details: "Ollama decides whether to call a tool." });
  }
  const choice = options.toolChoice;
  const chosen = choice?.type === "tool" ? functions.filter((tool) => tool.name === choice.toolName) : functions;
  return chosen.length ? chosen : undefined;
}

const THINK_RANK: Record<string, number> = { minimal: 1, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };

/** Picks the closest named level a daemon reported, so a broader app effort still maps to a valid value. */
function closestThinkLevel(levels: string[], effort: ReasoningEffort): string {
  const wanted = THINK_RANK[effort] ?? THINK_RANK.medium!;
  let best = levels[0]!;
  let distance = Infinity;
  for (const level of levels) {
    const gap = Math.abs((THINK_RANK[level] ?? wanted) - wanted);
    if (gap < distance) {
      best = level;
      distance = gap;
    }
  }
  return best;
}

/**
 * Maps the app's effort to Ollama's native `think`. Boolean-only models take true/false; models with
 * named levels (gpt-oss) take the level itself, never an invalid boolean. "none" becomes false only
 * when the daemon reported that it accepts false.
 */
function nativeThink(
  requested: ReasoningEffort | "provider-default" | undefined,
  options: OllamaModelOptions,
): boolean | string | undefined {
  const levels = options.thinkingLevels ?? [];
  // A model with named levels is never sent a bare boolean just because it also reports the
  // capability; only an explicit `thinkingOff` makes `false` valid there.
  const booleanThinking = options.thinkingOff === true || (options.thinking === true && levels.length === 0);
  if ((!booleanThinking && !levels.length) || requested === undefined || requested === "provider-default") return undefined;
  if (requested === "none") return booleanThinking && options.thinkingOff !== false ? false : undefined;
  const wanted = requested === "minimal" ? "low" : requested;
  if (levels.includes(wanted)) return wanted;
  if (levels.includes(requested)) return requested;
  if (levels.length) return closestThinkLevel(levels, requested);
  return true;
}

function nativeBody(options: LanguageModelV4CallOptions, stream: boolean, warnings: SharedV4Warning[], context?: number) {
  const messages = ollamaMessages(options.prompt);
  const tools = nativeTools(options, warnings);
  const nativeOptions: Record<string, number | string | string[]> = {};
  // The published context and the daemon's runtime context are the same number. Without this the
  // daemon can load a much smaller window while the meter, compaction, and the picker claim the
  // architecture maximum. See docs/implementation/ollama.md.
  if (context !== undefined && Number.isInteger(context) && context > 0) nativeOptions.num_ctx = context;
  if (options.temperature !== undefined) nativeOptions.temperature = options.temperature;
  if (options.topP !== undefined) nativeOptions.top_p = options.topP;
  if (options.topK !== undefined) nativeOptions.top_k = options.topK;
  if (options.maxOutputTokens !== undefined) nativeOptions.num_predict = options.maxOutputTokens;
  if (options.stopSequences?.length) nativeOptions.stop = options.stopSequences;
  if (options.seed !== undefined) nativeOptions.seed = options.seed;
  if (options.presencePenalty !== undefined) nativeOptions.presence_penalty = options.presencePenalty;
  if (options.frequencyPenalty !== undefined) nativeOptions.frequency_penalty = options.frequencyPenalty;

  const body: Record<string, unknown> = { messages, stream };
  if (Object.keys(nativeOptions).length) body.options = nativeOptions;
  if (tools) {
    body.tools = tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
    }));
  }
  if (options.responseFormat?.type === "json") body.format = options.responseFormat.schema ?? "json";
  return body;
}

function finishReason(raw: string | undefined, toolCalls: number): LanguageModelV4FinishReason {
  if (toolCalls > 0) return { unified: "tool-calls", raw };
  if (raw === "length") return { unified: "length", raw };
  if (raw === "stop" || raw === "load" || raw === "unload") return { unified: "stop", raw };
  return { unified: "other", raw };
}

function nativeUsage(chunk: NativeChatChunk): LanguageModelV4Usage {
  const input = finite(chunk.prompt_eval_count);
  const output = finite(chunk.eval_count);
  return {
    inputTokens: {
      total: input,
      noCache: input,
      cacheRead: input === undefined ? undefined : 0,
      cacheWrite: input === undefined ? undefined : 0,
    },
    outputTokens: { total: output, text: output, reasoning: undefined },
    raw: {
      prompt_eval_count: input ?? null,
      eval_count: output ?? null,
      done_reason: chunk.done_reason ?? null,
      ...(finite(chunk.total_duration) !== undefined ? { total_duration: chunk.total_duration! } : {}),
    },
  };
}

/**
 * Validates the little the adapter relies on before casting. A daemon that answers `null` or puts a
 * non-string in `message.content` must produce an OllamaError, not a TypeError from property access.
 */
function chatChunk(value: unknown, where: string): NativeChatChunk {
  if (!isRecord(value)) throw new OllamaError(`Ollama sent an unexpected ${where}.`);
  const message = value.message;
  if (message !== undefined) {
    if (!isRecord(message)) throw new OllamaError(`Ollama sent an invalid message in its ${where}.`);
    for (const key of ["content", "thinking"] as const) {
      if (message[key] !== undefined && typeof message[key] !== "string") {
        throw new OllamaError(`Ollama sent a non-text ${key} in its ${where}.`);
      }
    }
    if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) {
      throw new OllamaError(`Ollama sent invalid tool calls in its ${where}.`);
    }
  }
  if (value.error !== undefined && typeof value.error !== "string") {
    throw new OllamaError(`Ollama sent an unreadable error in its ${where}.`);
  }
  return value as NativeChatChunk;
}

function parseChunk(line: string): NativeChatChunk {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new OllamaError("Ollama sent an unreadable chat line.");
  }
  return chatChunk(parsed, "chat line");
}

/** Yields complete NDJSON lines, including a final line without a newline. */
async function* ndjson(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.length > MAX_CHAT_LINE) {
          throw new OllamaError("Ollama sent an overlong chat line (over 8 MiB). Check the model or daemon before retrying.");
        }
        if (line.trim()) yield line;
        newline = buffer.indexOf("\n");
      }
      if (buffer.length > MAX_CHAT_LINE) {
        throw new OllamaError("Ollama sent an overlong chat line (over 8 MiB) without a newline. Check the model or daemon before retrying.");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      if (buffer.length > MAX_CHAT_LINE) {
        throw new OllamaError("Ollama sent an overlong chat line (over 8 MiB). Check the model or daemon before retrying.");
      }
      yield buffer.trim();
    }
  } catch (error) {
    if (signal?.aborted) return;
    throw error;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function responseMetadata(chunk: NativeChatChunk) {
  return {
    ...(chunk.model ? { modelId: chunk.model } : {}),
    ...(chunk.created_at && !Number.isNaN(Date.parse(chunk.created_at)) ? { timestamp: new Date(chunk.created_at) } : {}),
  };
}

class OllamaLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider = "ollama";
  readonly modelId: string;
  readonly supportedUrls = {};

  constructor(private readonly options: OllamaModelOptions) {
    this.modelId = options.id;
  }

  private connection(): OllamaConnection {
    return { baseURL: this.options.baseURL, guarded: this.options.guarded };
  }

  async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    const warnings: SharedV4Warning[] = [];
    const partial = nativeBody(options, false, warnings, this.options.context);
    const reasoning = options.reasoning !== undefined ? options.reasoning : this.options.reasoning;
    const think = nativeThink(reasoning, this.options);
    const body = { model: this.modelId, ...partial, ...(think !== undefined ? { think } : {}) };
    const res = await ollamaChat(this.connection(), body, options.abortSignal);
    let chunk: NativeChatChunk;
    try {
      chunk = chatChunk(await res.json(), "chat response");
    } catch (error) {
      if (error instanceof OllamaError) throw error;
      throw new OllamaError("Ollama returned an unreadable chat response.");
    }
    if (chunk.error) throw new OllamaError(`Ollama could not chat with ${this.modelId}: ${chunk.error}`);
    const content: LanguageModelV4Content[] = [];
    const thinking = textOf(chunk.message?.thinking);
    if (thinking) content.push({ type: "reasoning", text: thinking });
    const text = textOf(chunk.message?.content);
    if (text) content.push({ type: "text", text });
    const calls = Array.isArray(chunk.message?.tool_calls) ? chunk.message.tool_calls : [];
    for (const call of calls) {
      const name = textOf(call.function?.name);
      if (!name) continue;
      content.push({
        type: "tool-call",
        toolCallId: newId("call"),
        toolName: name,
        input: JSON.stringify(argumentsObject(call.function?.arguments)),
      });
    }
    const meta = responseMetadata(chunk);
    return {
      content,
      finishReason: finishReason(chunk.done_reason, calls.length),
      usage: nativeUsage(chunk),
      response: { ...meta, headers: Object.fromEntries(res.headers) },
      request: { body },
      warnings,
    };
  }

  async doStream(options: LanguageModelV4CallOptions) {
    const warnings: SharedV4Warning[] = [];
    const partial = nativeBody(options, true, warnings, this.options.context);
    const reasoning = options.reasoning !== undefined ? options.reasoning : this.options.reasoning;
    const think = nativeThink(reasoning, this.options);
    const body = { model: this.modelId, ...partial, ...(think !== undefined ? { think } : {}) };
    // The consumer can cancel the returned stream without an external signal, for example when the
    // chat UI stops rendering. Abort the request ourselves, or the daemon keeps streaming into a body
    // nobody reads. See docs/implementation/ollama.md.
    const cancelRequest = new AbortController();
    const signal = options.abortSignal ? AbortSignal.any([options.abortSignal, cancelRequest.signal]) : cancelRequest.signal;
    const res = await ollamaChat(this.connection(), body, signal);
    if (!res.body) throw new OllamaError("Ollama returned no chat stream.");
    const headers = Object.fromEntries(res.headers);
    const modelId = this.modelId;
    let cancelled = false;

    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      async start(controller) {
        let textOpen = false;
        let reasoningOpen = false;
        let textSections = 0;
        let reasoningSections = 0;
        let textId = "";
        let reasoningId = "";
        let toolCount = 0;
        let finished = false;
        let metadata = false;
        const send = (part: LanguageModelV4StreamPart) => {
          if (cancelled || signal.aborted) return;
          try {
            controller.enqueue(part);
          } catch {
            cancelled = true;
          }
        };

        const closeText = () => {
          if (!textOpen) return;
          textOpen = false;
          send({ type: "text-end", id: textId });
        };
        const closeReasoning = () => {
          if (!reasoningOpen) return;
          reasoningOpen = false;
          send({ type: "reasoning-end", id: reasoningId });
        };

        send({ type: "stream-start", warnings });
        try {
          for await (const line of ndjson(res.body!, signal)) {
            if (signal.aborted) break;
            const chunk = parseChunk(line);
            if (chunk.error) throw new OllamaError(`Ollama could not chat with ${modelId}: ${chunk.error}`);
            if (!metadata) {
              const meta = responseMetadata(chunk);
              if (meta.modelId || meta.timestamp) {
                metadata = true;
                send({ type: "response-metadata", ...meta });
              }
            }
            const thinking = textOf(chunk.message?.thinking);
            if (thinking) {
              closeText();
              if (!reasoningOpen) {
                reasoningOpen = true;
                // A reopened section needs a new id; reusing an ended id breaks the UI's part keys.
                reasoningId = `reasoning-${reasoningSections++}`;
                send({ type: "reasoning-start", id: reasoningId });
              }
              send({ type: "reasoning-delta", id: reasoningId, delta: thinking });
            }
            const text = textOf(chunk.message?.content);
            if (text) {
              closeReasoning();
              if (!textOpen) {
                textOpen = true;
                textId = `text-${textSections++}`;
                send({ type: "text-start", id: textId });
              }
              send({ type: "text-delta", id: textId, delta: text });
            }
            const calls = Array.isArray(chunk.message?.tool_calls) ? chunk.message.tool_calls : [];
            if (calls.length) {
              closeReasoning();
              closeText();
              for (const call of calls) {
                const name = textOf(call.function?.name);
                if (!name) continue;
                toolCount++;
                const id = newId("call");
                const input = JSON.stringify(argumentsObject(call.function?.arguments));
                send({ type: "tool-input-start", id, toolName: name });
                send({ type: "tool-input-delta", id, delta: input });
                send({ type: "tool-input-end", id });
                send({ type: "tool-call", toolCallId: id, toolName: name, input });
              }
            }
            if (chunk.done) {
              closeReasoning();
              closeText();
              send({ type: "finish", finishReason: finishReason(chunk.done_reason, toolCount), usage: nativeUsage(chunk) });
              finished = true;
              break;
            }
          }
          if (!finished && !cancelled && !signal.aborted) {
            send({ type: "error", error: new OllamaError("Ollama ended the chat stream without finishing.") });
          }
        } catch (error) {
          if (!cancelled && !signal.aborted) send({ type: "error", error });
        } finally {
          if (!cancelled) {
            try {
              controller.close();
            } catch {
              // Already closed by a cancelled stream.
            }
          }
        }
      },
      cancel() {
        cancelled = true;
        cancelRequest.abort();
      },
    });
    return { stream, request: { body }, response: { headers } };
  }
}

export function createOllamaModel(options: OllamaModelOptions): LanguageModelV4 {
  return new OllamaLanguageModel(options);
}
