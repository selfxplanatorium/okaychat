import type { ErrorCode, RetryNotice } from "../shared/errors.js";
import { retryAfterFromHeaders } from "./provider-errors.js";

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

const retryableStatus = (status: number) => status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || status === 529;

// Google's 429 says RESOURCE_EXHAUSTED and may call it a project quota; only billing/credit is permanent.
const QUOTA_BODY = /insufficient[_ -]?quota|billing|credit balance|payment required|out of credit|hard limit/i;
const NETWORK_ERROR = /fetch failed|econnrefused|econnreset|enotfound|eai_again|ehostunreach|enetunreach|epipe|getaddrinfo|socket hang up|other side closed|und_err|connection (?:closed|reset|refused)/i;

const networkFailure = (error: unknown) => {
  const current = error as { message?: string; cause?: { code?: string } } | undefined;
  return NETWORK_ERROR.test(current?.message ?? "") || NETWORK_ERROR.test(current?.cause?.code ?? "");
};

function replayable(input: RequestInfo | URL, init?: RequestInit): boolean {
  if (init?.body && typeof (init.body as ReadableStream<unknown>).getReader === "function") return false;
  return !(input instanceof Request && input.bodyUsed);
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
        if (isAbort(error) || signal?.aborted) {
          notice({ status: "done" });
          throw error;
        }
        const delay = canRetry && networkFailure(error) ? computeRetryDelay(attempt, undefined, random, policy) : null;
        if (delay === null) {
          notice({ status: "done" });
          throw error;
        }
        notice({ attempt, delayMs: delay, code: "network" });
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
      if (!canRetry || !retryableStatus(response.status)) {
        notice({ status: "done" });
        return response;
      }
      if (response.status === 429) {
        // A quota refusal is permanent; do not burn attempts or make the user wait for the same answer.
        const body = await response.clone().text().catch(() => "");
        if (QUOTA_BODY.test(body.slice(0, 4_000))) {
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
      const code: ErrorCode = response.status === 429 ? "provider_rate_limit" : "provider_overloaded";
      notice({ attempt, delayMs: delay, code });
      // The failed response is never read; release its body before trying again.
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
