import type { ErrorCode, RetryNotice } from "../shared/errors.js";
import { retryAfterFromHeaders, transientStatus } from "./provider-errors.js";

/**
 * Provider retries live at the fetch boundary: before a response body is consumed, so a failed
 * attempt never duplicates emitted text or tool side effects. Permanent failures and aborted waits
 * are never retried. See docs/implementation/errors.md.
 */
export interface RetryPolicy {
  /** Includes the first attempt. */
  maxAttempts: number;
  baseDelayMs: number;
  factor: number;
  maxDelayMs: number;
  /** Fraction of the delay added or removed, e.g. 0.2 for ±20%. */
  jitter: number;
  /** A provider asking us to wait longer than this is surfaced instead of retried early. */
  maxRetryAfterMs: number;
}

export const PROVIDER_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  factor: 2,
  maxDelayMs: 15_000,
  jitter: 0.2,
  maxRetryAfterMs: 30_000,
};

/** Milliseconds before the next attempt, or null when this attempt is the last one. */
export function computeRetryDelay(
  failedAttempt: number,
  retryAfterMs: number | undefined,
  random: () => number = Math.random,
  policy: RetryPolicy = PROVIDER_RETRY_POLICY,
): number | null {
  if (failedAttempt >= policy.maxAttempts) return null;
  if (retryAfterMs !== undefined) return retryAfterMs <= policy.maxRetryAfterMs ? Math.round(retryAfterMs) : null;
  const base = Math.min(policy.maxDelayMs, policy.baseDelayMs * policy.factor ** Math.max(0, failedAttempt - 1));
  const spread = base * policy.jitter;
  return Math.round(Math.min(policy.maxDelayMs, base - spread + spread * 2 * random()));
}

const abortError = () => new DOMException("The request was stopped.", "AbortError");

export interface RetryTimer {
  setTimeout: (handler: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const systemTimer: RetryTimer = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** A wait that rejects as soon as the caller aborts. */
export function sleep(ms: number, signal?: AbortSignal, timer: RetryTimer = systemTimer): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      timer.clearTimeout(handle);
      reject(abortError());
    };
    const handle = timer.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const isAbort = (error: unknown) => {
  const current = error as { name?: string; code?: string } | undefined;
  return current?.name === "AbortError" || current?.code === "ABORT_ERR";
};

const TIMEOUT_MESSAGE = /timeout|timed out|etimedout|deadline[_ -]?exceeded|did not answer(?:\s+at\s+\S+)?\s+in time/i;
const timeoutFailure = (error: unknown) => {
  const current = error as { name?: string; code?: string; message?: string; cause?: { code?: string } } | undefined;
  return current?.name === "TimeoutError"
    || current?.code === "ETIMEDOUT"
    || current?.cause?.code === "ETIMEDOUT"
    || /timeout/i.test(current?.cause?.code ?? "")
    || TIMEOUT_MESSAGE.test(current?.message ?? "");
};

// Google's 429 says RESOURCE_EXHAUSTED and may call it a project quota; only billing/credit is permanent.
const QUOTA_BODY = /insufficient[_ -]?quota|billing|credit balance|payment required|out of credit|hard limit/i;
const NETWORK_ERROR = /fetch failed|econnrefused|econnreset|enotfound|eai_again|ehostunreach|enetunreach|epipe|getaddrinfo|socket hang up|other side closed|und_err|connection (?:closed|reset|refused)|could not reach/i;

const networkFailure = (error: unknown) => {
  const current = error as { message?: string; cause?: { code?: string } } | undefined;
  return NETWORK_ERROR.test(current?.message ?? "") || NETWORK_ERROR.test(current?.cause?.code ?? "");
};

/**
 * A provider response body that names a refusal rather than a hiccup. A 5xx that says it is out of
 * memory, out of quota, over the context window, or rejected the credentials is permanent.
 */
const PERMANENT_BODY = new RegExp(
  [
    /requires more (?:system )?memory|out of memory|not enough memory|memory pressure/i.source,
    QUOTA_BODY.source,
    /context[ _-]?length|maximum context|too many tokens|token limit|prompt is too long|input is too long|request too large|request_too_large|reduce the length/i.source,
    /invalid[_ -]?api[_ -]?key|authentication|unauthenticated|unauthorized|permission[_ -]?denied|invalid[_ -]?token/i.source,
    /model.{0,40}(?:not found|not exist|unknown|unsupported|does not exist|invalid|no access)|no such model|model_not_found/i.source,
  ].join("|"),
  "i",
);

function replayable(input: RequestInfo | URL, init?: RequestInit): boolean {
  // Sending a Request consumes its body, even when it is a string or FormData. Only a bodyless
  // Request can be sent twice; init bodies are replayed by re-sending the same value.
  if (input instanceof Request && input.body !== null) return false;
  if (init?.body && typeof (init.body as ReadableStream<unknown>).getReader === "function") return false;
  return true;
}

/** Reads at most this much of a failed response before deciding to retry, then keeps the body intact. */
const MAX_PEEK_BODY = 16 * 1024;

/**
 * Reads a bounded prefix of a response body without consuming it for the caller. `tee()` lets the
 * untouched branch become the response returned on a terminal failure, so the SDK still sees the
 * provider's body (the AI SDK needs it to map a status when the retry gives up).
 */
async function peek(response: Response): Promise<{ text: string; response: Response }> {
  if (!response.body) return { text: "", response };
  const [prefix, kept] = response.body.tee();
  const reader = prefix.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let read = 0;
  try {
    while (read < MAX_PEEK_BODY) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = MAX_PEEK_BODY - read;
      const slice = value.byteLength > room ? value.subarray(0, room) : value;
      text += decoder.decode(slice, { stream: true });
      read += slice.byteLength;
      if (slice.byteLength < value.byteLength) break;
    }
    text += decoder.decode();
  } catch {
    // Keep whatever arrived; the status still decides.
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const copy = new Response(kept, { status: response.status, statusText: response.statusText, headers: response.headers });
  return { text, response: copy };
}

export interface RetryingFetchOptions {
  policy?: Partial<RetryPolicy>;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  fetchImpl?: typeof fetch;
  /** Streams "Retrying in Ns…" into the chat while a wait is in progress. */
  onRetry?: (notice: RetryNotice) => void;
}

/** One fetch wrapper for every model provider call. Non-replayable bodies are never retried. */
export function createRetryingFetch(options: RetryingFetchOptions = {}): typeof fetch {
  const policy = { ...PROVIDER_RETRY_POLICY, ...options.policy };
  const random = options.random ?? Math.random;
  const wait = options.sleep ?? ((ms, signal) => sleep(ms, signal));
  const send = options.fetchImpl ?? fetch;
  return async (input, init) => {
    const canRetry = replayable(input, init);
    const signal: AbortSignal | undefined = init?.signal ?? (input instanceof Request ? input.signal : undefined) ?? undefined;
    let shown = false;
    const notice = (value: RetryNotice | { status: "done" }) => {
      if (value.status === "done") {
        if (!shown) return;
        shown = false;
        options.onRetry?.({ attempt: 0, delayMs: 0, code: "unknown", status: "done" });
        return;
      }
      shown = true;
      options.onRetry?.(value);
    };
    for (let attempt = 1; ; attempt++) {
      let response: Response;
      try {
        response = await send(input, init);
      } catch (error) {
        // A caller's abort, including an AbortSignal.timeout() that already fired, is final.
        if (isAbort(error) || signal?.aborted) {
          notice({ status: "done" });
          throw error;
        }
        const code: ErrorCode | undefined = timeoutFailure(error) ? "timeout" : networkFailure(error) ? "network" : undefined;
        if (!canRetry || !code) {
          notice({ status: "done" });
          throw error;
        }
        const delay = computeRetryDelay(attempt, undefined, random, policy);
        if (delay === null) {
          notice({ status: "done" });
          throw error;
        }
        notice({ attempt, delayMs: delay, code });
        try {
          await wait(delay, signal);
        } catch (error) {
          notice({ status: "done" });
          throw error;
        }
        continue;
      }
      if (response.ok) {
        notice({ status: "done" });
        return response;
      }
      if (!canRetry || !transientStatus(response.status)) {
        notice({ status: "done" });
        return response;
      }
      // A 429 or 5xx body can say the failure is permanent (quota, OOM, context, credentials). The
      // status alone would retry it three times and keep the user waiting for the same answer.
      let inspected: { text: string; response: Response } | undefined;
      if (response.status >= 500 || response.status === 429) {
        inspected = await peek(response);
        response = inspected.response;
        if (PERMANENT_BODY.test(inspected.text.slice(0, 4_000))) {
          notice({ status: "done" });
          return response;
        }
      }
      const retryAfter = retryAfterFromHeaders(response.headers);
      const delay = computeRetryDelay(attempt, retryAfter, random, policy);
      if (delay === null) {
        notice({ status: "done" });
        return response;
      }
      const code: ErrorCode = response.status === 429 ? "provider_rate_limit" : response.status === 408 ? "timeout" : "provider_overloaded";
      notice({ attempt, delayMs: delay, code });
      // The failed response is never read; release its untouched body before trying again.
      await response.body?.cancel().catch(() => {});
      try {
        await wait(delay, signal);
      } catch (error) {
        notice({ status: "done" });
        throw error;
      }
    }
  };
}
