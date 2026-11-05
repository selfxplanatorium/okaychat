import { AppError } from "./errors.js";

// Incremental Server-Sent Events parsing for the ChatGPT-plan Responses stream. Visible chat stays a
// pass-through byte stream; only the utility collector rebuilds a completed response as JSON.
// See docs/implementation/codex-chat.md.

export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

/** Raised when a bounded reader has consumed more than its allowance. */
export class SseLimitError extends Error {
  constructor(readonly maxBytes: number) {
    super("The event stream exceeded its size limit.");
    this.name = "SseLimitError";
  }
}

/** A line terminator can be split across chunks, so a trailing CR waits for the next read. */
function takeLine(buffer: string): { line: string; rest: string } | null {
  const match = /[\r\n]/.exec(buffer);
  if (!match) return null;
  const at = match.index;
  if (buffer[at] === "\r" && at === buffer.length - 1) return null;
  const width = buffer[at] === "\r" && buffer[at + 1] === "\n" ? 2 : 1;
  return { line: buffer.slice(0, at), rest: buffer.slice(at + width) };
}

/**
 * Reads `text/event-stream` frames incrementally. Fragmented UTF-8, CRLF, lone CR, multiline `data:`,
 * comments and unknown fields all follow the SSE grammar. An incomplete event at EOF is discarded.
 */
export async function* readSseEvents(
  body: ReadableStream<Uint8Array>,
  options: { maxBytes?: number; signal?: AbortSignal } = {},
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let eventName: string | undefined;
  let id: string | undefined;
  let retry: number | undefined;
  let bytes = 0;
  let first = true;

  const handle = (line: string): SseEvent | undefined => {
    if (line === "") {
      if (data.length === 0) {
        eventName = undefined;
        return undefined;
      }
      const event: SseEvent = {
        data: data.join("\n"),
        ...(eventName !== undefined ? { event: eventName } : {}),
        ...(id !== undefined ? { id } : {}),
        ...(retry !== undefined ? { retry } : {}),
      };
      data = [];
      eventName = undefined;
      return event;
    }
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") eventName = value;
    else if (field === "id") {
      if (!value.includes("\0")) id = value;
    } else if (field === "retry") {
      if (/^\d+$/.test(value)) retry = Number(value);
    }
    return undefined;
  };

  const read = (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    if (!options.signal) return reader.read();
    if (options.signal.aborted) return Promise.reject(options.signal.reason ?? new DOMException("The request was stopped.", "AbortError"));
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        void reader.cancel(options.signal?.reason).catch(() => {});
        reject(options.signal?.reason ?? new DOMException("The request was stopped.", "AbortError"));
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      reader.read().then(
        (value) => {
          options.signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          options.signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  };

  try {
    for (;;) {
      const { done, value } = await read();
      if (done) break;
      bytes += value.byteLength;
      if (options.maxBytes !== undefined && bytes > options.maxBytes) {
        void reader.cancel().catch(() => {});
        throw new SseLimitError(options.maxBytes);
      }
      buffer += decoder.decode(value, { stream: true });
      if (first && buffer.length > 0) {
        first = false;
        if (buffer.startsWith("\uFEFF")) buffer = buffer.slice(1);
      }
      for (let line = takeLine(buffer); line; line = takeLine(buffer)) {
        buffer = line.rest;
        const event = handle(line.line);
        if (event) yield event;
      }
    }
    buffer += decoder.decode();
    // A final line without a blank line is not a complete SSE event; discard it.
  } finally {
    reader.releaseLock();
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function boundedCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,120}$/.test(value) ? value : undefined;
}

/**
 * Stream failures keep their HTTP-ish meaning. Plan usage limits are a quota refusal, not a transient
 * 429 that the generic retry boundary should send three times.
 */
export function chatgptFailureStatus(code: string | undefined, upstream: unknown): number {
  if (code === "subscription_sharing_usage_limit_exceeded") return 402;
  if (code === "subscription_sharing_unsupported_capability") return 400;
  if (code === "subscription_sharing_user_not_eligible" || code === "subscription_sharing_route_not_supported") return 403;
  if (code === "subscription_sharing_invalid_user") return 401;
  if (typeof upstream === "number" && Number.isInteger(upstream) && upstream >= 400 && upstream <= 599) return upstream;
  return 502;
}

const DIAGNOSTIC_HEADERS = ["x-request-id", "openai-request-id", "request-id", "retry-after", "retry-after-ms"] as const;

function diagnosticHeaders(headers: Headers, contentType?: string): Headers {
  const out = new Headers();
  for (const name of DIAGNOSTIC_HEADERS) {
    const value = headers.get(name);
    if (value) out.set(name, value);
  }
  if (contentType) out.set("content-type", contentType);
  return out;
}

function failureBody(code: string | undefined, message: string): string {
  return JSON.stringify({ error: { type: "chatgpt_error", ...(code ? { code } : {}), message } });
}

function failureResponse(code: string | undefined, upstream: unknown, headers: Headers, message: string): Response {
  const status = chatgptFailureStatus(code, upstream);
  return new Response(failureBody(code, message), { status, headers: diagnosticHeaders(headers, "application/json") });
}

function eventFailure(event: Record<string, unknown>): { code?: string; status?: unknown } {
  if (event.type === "response.failed") {
    const response = record(event.response);
    const error = record(response?.error);
    return { ...(boundedCode(error?.code) ? { code: boundedCode(error?.code) } : {}), status: response?.status };
  }
  const error = record(event.error) ?? event;
  return { ...(boundedCode(error.code) ? { code: boundedCode(error.code) } : {}), status: event.status ?? error.status };
}

/**
 * Collects one utility (non-streaming SDK) call. Only `response.completed` is success; `response.failed`,
 * `response.incomplete`, an `error` frame, or EOF without a terminal event is a safe failure. Bounded to
 * `maxBytes` and `timeoutMs`; the reader is cancelled when either is exceeded.
 */
export async function collectCompletedResponse(
  res: Response,
  options: { signal?: AbortSignal; deadline?: AbortSignal; maxBytes?: number; timeoutMs?: number } = {},
): Promise<Response> {
  if (!res.body) {
    return failureResponse("response_interrupted", undefined, res.headers, "ChatGPT returned no response.");
  }
  const deadline = options.deadline ?? AbortSignal.timeout(options.timeoutMs ?? 120_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  let completed: Record<string, unknown> | undefined;
  let failure: { code?: string; status?: unknown } | undefined;
  let incomplete = false;

  try {
    for await (const event of readSseEvents(res.body, { maxBytes, signal })) {
      let parsed: Record<string, unknown> | undefined;
      try {
        parsed = record(JSON.parse(event.data));
      } catch {
        continue;
      }
      if (!parsed) continue;
      if (parsed.type === "response.completed") {
        completed = record(parsed.response) ?? {};
        break;
      }
      if (parsed.type === "response.failed" || parsed.type === "error") {
        failure = eventFailure(parsed);
        break;
      }
      if (parsed.type === "response.incomplete") {
        incomplete = true;
        break;
      }
    }
  } catch (error) {
    if (error instanceof SseLimitError) {
      throw new AppError({ code: "unknown", message: "The ChatGPT response was too large to use.", cause: error });
    }
    if (deadline.aborted && !options.signal?.aborted) {
      throw new AppError({ code: "timeout", message: "ChatGPT took too long to answer.", cause: error });
    }
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("The request was stopped.", "AbortError");
    throw error;
  } finally {
    // A terminal event usually arrives before the upstream closes; stop the connection now.
    void res.body.cancel().catch(() => {});
  }

  if (completed) {
    return new Response(JSON.stringify(completed), { status: 200, headers: diagnosticHeaders(res.headers, "application/json") });
  }
  if (failure) {
    return failureResponse(failure.code, failure.status, res.headers, "ChatGPT did not complete the response.");
  }
  if (incomplete) {
    return failureResponse("response_incomplete", 422, res.headers, "ChatGPT did not finish the response.");
  }
  return failureResponse("response_interrupted", 502, res.headers, "ChatGPT ended the response before completion.");
}

/** Tracks only event types while forwarding bytes unchanged, so normal chat is never buffered. */
function terminalTracker() {
  let buffer = "";
  let terminal = false;
  return {
    feed(text: string) {
      buffer += text;
      for (let line = takeLine(buffer); line; line = takeLine(buffer)) {
        buffer = line.rest;
        if (!line.line.startsWith("data:")) continue;
        const data = line.line.slice(5).trimStart();
        if (!data || data.length > 256 * 1024) continue;
        try {
          const value = record(JSON.parse(data));
          if (value?.type === "response.completed" || value?.type === "response.failed" || value?.type === "error") terminal = true;
        } catch {
          // A partial or non-JSON data line is not a terminal event.
        }
      }
      // A single oversized line cannot be a terminal event; keep only a bounded tail for the next line.
      if (buffer.length > 256 * 1024) buffer = buffer.slice(-1024);
    },
    get terminal() {
      return terminal;
    },
  };
}

const INTERRUPTED_EVENT = `data: ${JSON.stringify({
  type: "error",
  code: "response_interrupted",
  message: "ChatGPT ended the stream before completion.",
})}\n\n`;

/**
 * Pass-through stream guard: forwards chunks immediately, and if upstream ends without
 * `response.completed`, `response.failed`, or `error`, appends one error frame so the SDK does not declare
 * a successful finish. Cancelling the returned body aborts the upstream request.
 */
export function guardStreamingResponse(
  res: Response,
  options: { abort?: () => void; onEnd?: () => void } = {},
): Response {
  if (!res.body) {
    options.onEnd?.();
    return res;
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("text/event-stream")) {
    return trackResponse(res, options);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const tracker = terminalTracker();
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    options.onEnd?.();
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done: ended, value } = await reader.read();
        if (ended) {
          if (!tracker.terminal) controller.enqueue(encoder.encode(INTERRUPTED_EVENT));
          controller.close();
          finish();
          return;
        }
        tracker.feed(decoder.decode(value, { stream: true }));
        controller.enqueue(value);
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    cancel(reason) {
      finish();
      options.abort?.();
      return reader.cancel(reason).catch(() => {});
    },
  });
  return new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/** For non-SSE bodies: pass through, release the request when it finishes or is cancelled. */
export function trackResponse(res: Response, options: { abort?: () => void; onEnd?: () => void } = {}): Response {
  if (!res.body) {
    options.onEnd?.();
    return res;
  }
  const reader = res.body.getReader();
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    options.onEnd?.();
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done: ended, value } = await reader.read();
        if (ended) {
          controller.close();
          finish();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    cancel(reason) {
      finish();
      options.abort?.();
      return reader.cancel(reason).catch(() => {});
    },
  });
  return new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers });
}
