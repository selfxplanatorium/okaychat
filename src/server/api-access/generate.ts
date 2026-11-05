import type { LanguageModelUsage, ModelMessage, TextStreamPart, ToolSet } from "ai";
import { streamText } from "ai";
import {
  API_LIMITS,
  type CompletionChunk,
  type CompletionResponse,
  type CompletionUsage,
} from "../../shared/api-access.js";
import type { ModelInfo, TokenUsage } from "../../shared/types.js";
import type { Connection } from "../catalog/providers.js";
import type { ModelHandle } from "../llm.js";
import { ResponseLimitError } from "../response-bounds.js";
import { costOf, normalizeUsage } from "../usage.js";
import { registerApiCall } from "./limits.js";
import { apiFailure, apiHeaders, completionId, completionUsage, describeApiFailure, incompleteResponse, mapFinishReason, responseLimit, unsupportedOutput } from "./protocol.js";
import { settleApiRequest } from "./store.js";

// One stateless external completion (docs/implementation/api-access.md). There are no tools, no memory,
// no attachments, no history, and no follow-up call. The provider stream is read exactly once; any other
// SDK consumer is never started.

type Part = TextStreamPart<ToolSet>;

export interface GenerationPlan {
  userId: string;
  keyId: string;
  requestId: string;
  admittedAt: number;
  model: ModelInfo;
  conn: Connection;
  handle: ModelHandle;
  messages: ModelMessage[];
  maxOutputTokens: number;
  temperature?: number;
  stream: boolean;
  includeUsage: boolean;
  signal: AbortSignal;
  recheck: () => void;
  /** Extends the shared turn lease; returning false aborts the call before its next dispatch. */
  heartbeat?: () => boolean;
  /** Releases the admission slot and the total deadline exactly once, when the generation ends. */
  onDone?: () => void;
}

const reported = (usage: LanguageModelUsage | undefined): usage is LanguageModelUsage =>
  !!usage && (usage.inputTokens !== undefined || usage.outputTokens !== undefined || usage.totalTokens !== undefined);

const encoder = new TextEncoder();

/** Splits text into UTF-8 pieces of at most `maxBytes` without cutting a code point. */
export function splitUtf8(text: string, maxBytes = API_LIMITS.ssePieceBytes): string[] {
  const pieces: string[] = [];
  let current = "";
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > maxBytes && current) {
      pieces.push(current);
      current = "";
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  if (current) pieces.push(current);
  return pieces;
}

const sse = (value: unknown): Uint8Array => encoder.encode(`data: ${JSON.stringify(value)}\n\n`);

const isClientAbort = (signal: AbortSignal): boolean => {
  const reason = signal.reason as { name?: string } | undefined;
  return reason?.name === "AbortError" || signal.reason === undefined;
};

const isUnsupportedPart = (type: string): boolean => /^(?:tool|file|reasoning-file)/.test(type);

function failureOf(error: unknown, clientAborted: boolean, signal?: AbortSignal) {
  // An abort may surface as a bare AbortError from the provider reader; the controller's reason is
  // the real cause (live denial, timeout, or client disconnect) and must not be lost.
  if (signal?.aborted && signal.reason !== undefined) error = signal.reason;
  if (error instanceof ResponseLimitError || hasResponseLimitCause(error)) return responseLimit();
  if ((error as Error)?.message === "provider_timeout") {
    return apiFailure(504, "server_error", "timeout", "The model provider took too long to respond.");
  }
  if ((error as Error)?.message === "provider_eof") {
    return incompleteResponse();
  }
  return describeApiFailure(error, { abortedByClient: clientAborted });
}

function hasResponseLimitCause(error: unknown, depth = 0): boolean {
  if (depth > 5 || !error || typeof error !== "object") return false;
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof ResponseLimitError) return true;
  return hasResponseLimitCause(cause, depth + 1);
}

function errorResponse(failure: ReturnType<typeof describeApiFailure>, requestId: string): Response {
  const headers = apiHeaders(requestId);
  if (failure.status === 401) headers["WWW-Authenticate"] = 'Bearer realm="okaychat"';
  if (failure.retryAfterMs !== undefined) headers["Retry-After"] = String(Math.max(1, Math.ceil(failure.retryAfterMs / 1000)));
  if (failure.allow) headers.Allow = failure.allow;
  return new Response(
    JSON.stringify({ error: { message: failure.message.slice(0, 500), type: failure.type, param: failure.param, code: failure.code }, request_id: requestId }),
    { status: failure.status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } },
  );
}

/** A reader whose every pull has an inactivity deadline and that cancels upstream on abort. */
class ProviderReader {
  private readonly iterator: AsyncIterator<Part>;
  private first = true;
  constructor(private readonly stream: AsyncIterable<Part>, private readonly signal: AbortSignal) {
    this.iterator = stream[Symbol.asyncIterator]();
  }

  async next(): Promise<IteratorResult<Part>> {
    this.signal.throwIfAborted();
    const limit = this.first ? API_LIMITS.firstEventMs : API_LIMITS.inactivityMs;
    this.first = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("provider_timeout")), limit);
      timer.unref?.();
    });
    try {
      return await Promise.race([this.iterator.next(), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    try {
      await this.iterator.return?.();
    } catch {
      // The provider reader is already gone.
    }
  }
}

interface Collected {
  text: string;
  finishReason: string | undefined;
  usage: TokenUsage | null;
  generated: number;
}

/** What both modes need to record: the finish reason and the provider-reported usage, if any. */
function consumePart(part: Part, state: Collected): Uint8Array[] {
  switch (part.type) {
    case "text-delta":
      state.generated += Buffer.byteLength(part.text, "utf8");
      if (state.generated > API_LIMITS.generatedBytes) throw responseLimit();
      state.text += part.text;
      return [];
    case "reasoning-delta":
      state.generated += Buffer.byteLength(part.text, "utf8");
      if (state.generated > API_LIMITS.generatedBytes) throw responseLimit();
      return [];
    case "finish":
      state.finishReason = part.finishReason;
      state.usage = reported(part.totalUsage) ? normalizeUsage(part.totalUsage) : null;
      return [];
    case "error":
      throw part.error;
    case "abort":
      throw new Error("aborted");
    default:
      if (isUnsupportedPart(part.type)) throw unsupportedOutput();
      return [];
  }
}

/**
 * Runs one completion and returns either a buffered JSON response or an SSE response. Every terminal
 * path settles the receipt before claiming success; after an SSE finish chunk no error is ever emitted.
 */
export async function generateCompletion(plan: GenerationPlan): Promise<Response> {
  const { requestId } = plan;
  const created = Math.floor(plan.admittedAt / 1000);
  const id = completionId(requestId);
  const controller = new AbortController();
  const abortSignal = controller.signal;
  const abort = (reason: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const onAbort = () => abort(plan.signal.reason);
  if (plan.signal.aborted) onAbort();
  plan.signal.addEventListener("abort", onAbort, { once: true });
  // Polling closes the gap between local revoke notifications and expiry/connection edits.
  const poll = setInterval(() => {
    try {
      plan.recheck();
    } catch (error) {
      abort(error);
    }
  }, 1_000);
  poll.unref?.();
  const lease = plan.heartbeat
    ? setInterval(() => {
        if (!plan.heartbeat!()) abort(apiFailure(429, "rate_limit_error", "concurrent_limit", "The request lease expired."));
      }, 20_000)
    : null;
  lease?.unref?.();

  const settle = (
    state: "succeeded" | "failed" | "cancelled" | "interrupted",
    httpStatus: number | null,
    errorCode: string | null,
    finishReason: "stop" | "length" | "content_filter" | null,
    usage: TokenUsage | null,
  ) => {
    settleApiRequest({
      id: requestId,
      userId: plan.userId,
      keyId: plan.keyId,
      providerId: plan.model.providerId,
      modelId: plan.model.id,
      settlement: { state, httpStatus, errorCode, finishReason, usage, cost: usage ? costOf(plan.model.cost, usage) : 0 },
    });
  };

  const unregister = registerApiCall(plan.userId, plan.keyId, controller);
  const cleanup = () => {
    clearInterval(poll);
    if (lease) clearInterval(lease);
    plan.signal.removeEventListener("abort", onAbort);
    unregister();
    plan.onDone?.();
  };

  let result: ReturnType<typeof streamText>;
  try {
    result = streamText({
      model: plan.handle.model,
      messages: plan.messages,
      allowSystemInMessages: true,
      maxOutputTokens: plan.maxOutputTokens,
      providerOptions: plan.handle.providerOptions,
      maxRetries: 0,
      abortSignal: controller.signal,
      ...(plan.temperature !== undefined ? { temperature: plan.temperature } : {}),
    });
  } catch (error) {
    cleanup();
    const failure = failureOf(error, isClientAbort(plan.signal), abortSignal);
    settle(plan.signal.aborted ? "cancelled" : "failed", plan.signal.aborted ? null : failure.status, failure.code, null, null);
    return errorResponse(failure, requestId);
  }
  const reader = new ProviderReader(result.fullStream as unknown as AsyncIterable<Part>, controller.signal);

  const readAll = async (): Promise<Collected> => {
    const state: Collected = { text: "", finishReason: undefined, usage: null, generated: 0 };
    for (;;) {
      let step: IteratorResult<Part>;
      try {
        step = await reader.next();
      } catch (error) {
        if ((error as Error).message === "provider_timeout") throw error;
        throw error;
      }
      if (step.done) break;
      controller.signal.throwIfAborted();
      consumePart(step.value, state);
      if (state.finishReason !== undefined) break;
    }
    return state;
  };

  const complete = async (collected: Collected) => {
    const finish = mapFinishReason(collected.finishReason);
    settle("succeeded", 200, null, finish, collected.usage);
    return { finish, usage: collected.usage };
  };

  if (!plan.stream) {
    try {
      const collected = await readAll();
      await reader.close();
      // A revoke or feature change while the provider was finishing must prevent the buffered body.
      plan.recheck();
      const finish = mapFinishReason(collected.finishReason);
      const usage = collected.usage;
      const body: CompletionResponse = {
        id,
        object: "chat.completion",
        created,
        model: plan.model.ref,
        choices: [{ index: 0, message: { role: "assistant", content: collected.text }, finish_reason: finish, logprobs: null }],
        usage: usage ? completionUsage(usage) : null,
      };
      const serialized = JSON.stringify(body);
      if (Buffer.byteLength(serialized, "utf8") > API_LIMITS.bufferedBytes) {
        settle("failed", 502, "response_limit", null, null);
        cleanup();
        return errorResponse(responseLimit(), requestId);
      }
      settle("succeeded", 200, null, finish, usage);
      cleanup();
      return new Response(serialized, {
        status: 200,
        headers: { ...apiHeaders(requestId), "Content-Type": "application/json; charset=utf-8" },
      });
    } catch (error) {
      await reader.close();
      cleanup();
      const clientGone = plan.signal.aborted && isClientAbort(plan.signal);
      const failure = failureOf(error, clientGone, abortSignal);
      const state = plan.signal.aborted ? "cancelled" : "failed";
      const code = clientGone ? "client_disconnected" : plan.signal.aborted ? "cancelled" : failure.code;
      settle(state, plan.signal.aborted ? null : failure.status, code, null, null);
      return errorResponse(failure, requestId);
    }
  }

  // Streaming: commit 200 only after the provider acknowledged with a first meaningful item.
  let first: Part | null = null;
  try {
    for (;;) {
      const step = await reader.next();
      if (step.done) throw new Error("provider_eof");
      const part = step.value;
      if (part.type === "error") throw part.error;
      if (part.type === "abort") throw controller.signal.reason ?? new Error("aborted");
      if (part.type === "text-delta" || part.type === "reasoning-delta" || part.type === "finish") {
        first = part;
        break;
      }
      if (isUnsupportedPart(part.type)) throw unsupportedOutput();
    }
  } catch (error) {
    await reader.close();
    cleanup();
    const clientGone = plan.signal.aborted && isClientAbort(plan.signal);
    const failure = failureOf(error, clientGone, abortSignal);
    settle(plan.signal.aborted ? "cancelled" : "failed", plan.signal.aborted ? null : failure.status, plan.signal.aborted ? (clientGone ? "client_disconnected" : "cancelled") : failure.code, null, null);
    return errorResponse(failure, requestId);
  }

  const body = streamBody(plan, reader, first, { id, created, settle, cleanup, complete, signal: abortSignal });
  return new Response(body, {
    status: 200,
    headers: {
      ...apiHeaders(requestId),
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  });
}

interface StreamHelpers {
  id: string;
  created: number;
  settle: (
    state: "succeeded" | "failed" | "cancelled" | "interrupted",
    httpStatus: number | null,
    errorCode: string | null,
    finishReason: "stop" | "length" | "content_filter" | null,
    usage: TokenUsage | null,
  ) => void;
  cleanup: () => void;
  complete: (collected: Collected) => Promise<{ finish: "stop" | "length" | "content_filter"; usage: TokenUsage | null }>;
  signal: AbortSignal;
}

/**
 * The SSE body. It is pull-driven, so a slow consumer naturally throttles the provider reader; a consumer
 * that stops pulling for 30 s aborts upstream. Frames are serialized with JSON.stringify, so no text can
 * break the framing.
 */
function streamBody(plan: GenerationPlan, reader: ProviderReader, first: Part, helpers: StreamHelpers): ReadableStream<Uint8Array> {
  let cancelled = false;
  let terminal = false;
  let bytes = 0;
  let lastActivity = Date.now();
  let awaitingPull = false;
  let pullStarted = 0;
  let initial: Part | null = first;
  let queue: Uint8Array[] = [];
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  const state: Collected = { text: "", finishReason: undefined, usage: null, generated: 0 };
  let generated = 0;

  const acceptText = (text: string) => {
    generated += Buffer.byteLength(text, "utf8");
    if (generated > API_LIMITS.generatedBytes) throw responseLimit();
    state.text += text;
    for (const piece of splitUtf8(text)) queue.push(chunk([{ index: 0, delta: { content: piece }, finish_reason: null, logprobs: null }]));
  };

  const acceptPart = (part: Part) => {
    if (part.type === "text-delta") acceptText(part.text);
    else if (part.type === "reasoning-delta") {
      generated += Buffer.byteLength(part.text, "utf8");
      if (generated > API_LIMITS.generatedBytes) throw responseLimit();
    } else consumePart(part, state);
  };

  const write = (controller: ReadableStreamDefaultController<Uint8Array>, chunk: Uint8Array) => {
    bytes += chunk.byteLength;
    if (bytes > API_LIMITS.sseBytes - 4_096) throw responseLimit();
    controller.enqueue(chunk);
    lastActivity = Date.now();
  };

  const chunk = (choices: CompletionChunk["choices"], usage?: CompletionUsage | null): Uint8Array =>
    sse({
      id: helpers.id,
      object: "chat.completion.chunk",
      created: helpers.created,
      model: plan.model.ref,
      choices,
      ...(plan.includeUsage ? { usage: usage ?? null } : {}),
    } satisfies CompletionChunk);

  const finishFrame = async (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (terminal) return;
    // A revoke or feature change before the success terminal prevents it.
    plan.recheck();
    for (const frame of queue.splice(0)) write(controller, frame);
    const { finish, usage } = await helpers.complete(state);
    // No fallible step may follow this chunk: it is the success terminal.
    write(controller, chunk([{ index: 0, delta: {}, finish_reason: finish, logprobs: null }]));
    // Mark the terminal before the optional tail, so a cap failure there can never produce a later
    // error record after a finish chunk.
    terminal = true;
    try {
      if (plan.includeUsage) write(controller, chunk([], usage ? completionUsage(usage) : null));
      write(controller, encoder.encode("data: [DONE]\n\n"));
    } catch {
      // A truncated transport after the success terminal is the only honest outcome.
    }
  };

  const fail = async (controller: ReadableStreamDefaultController<Uint8Array>, error: unknown) => {
    if (terminal) return;
    const clientGone = isClientAbort(plan.signal);
    const failure = failureOf(error, clientGone, helpers.signal);
    helpers.settle(plan.signal.aborted ? "cancelled" : "failed", 200, plan.signal.aborted ? (clientGone ? "client_disconnected" : "cancelled") : failure.code, null, state.usage);
    if (!clientGone) {
      try {
        write(controller, sse({ error: { message: failure.message.slice(0, 500), type: failure.type, param: failure.param, code: failure.code }, request_id: plan.requestId }));
      } catch {
        // The output cap or a closed consumer leaves no room for the error record.
      }
    }
    terminal = true;
    try {
      controller.close();
    } catch {
      // Already closed by the consumer.
    }
  };

  const heartbeat = setInterval(() => {
    if (terminal || cancelled) return;
    if (awaitingPull && Date.now() - pullStarted >= API_LIMITS.drainTimeoutMs) {
      helpers.settle("cancelled", 200, "client_disconnected", null, state.usage);
      terminal = true;
      void reader.close();
      try {
        controllerRef?.close();
      } catch {
        // Already closed.
      }
      return;
    }
    if (Date.now() - lastActivity >= 15_000) {
      lastActivity = Date.now();
      try {
        controllerRef?.enqueue(encoder.encode(": keepalive\n\n"));
      } catch {
        // A closed stream simply has no heartbeat.
      }
    }
  }, 1_000);
  heartbeat.unref?.();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      try {
        write(controller, chunk([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null, logprobs: null }]));
      } catch (error) {
        void fail(controller, error);
      }
    },
    async pull(controller) {
      if (terminal) return;
      awaitingPull = true;
      pullStarted = Date.now();
      try {
        plan.recheck();
        if (initial) {
          const part = initial;
          initial = null;
          acceptPart(part);
        }
        while (queue.length === 0 && state.finishReason === undefined) {
          const step = await reader.next();
          if (step.done) {
            if (state.finishReason === undefined) throw new Error("provider_eof");
            break;
          }
          acceptPart(step.value);
        }
        awaitingPull = false;
        if (state.finishReason !== undefined) {
          await finishFrame(controller);
          clearInterval(heartbeat);
          helpers.cleanup();
          controller.close();
          return;
        }
        const next = queue.shift();
        if (next) write(controller, next);
      } catch (error) {
        awaitingPull = false;
        clearInterval(heartbeat);
        helpers.cleanup();
        void reader.close();
        await fail(controller, error);
      }
    },
    async cancel() {
      cancelled = true;
      clearInterval(heartbeat);
      helpers.cleanup();
      if (!terminal) helpers.settle("cancelled", 200, "client_disconnected", null, state.usage);
      terminal = true;
      await reader.close();
    },
  });
}
