/**
 * The one error vocabulary shared by the server and the browser. The server maps every boundary
 * (HTTP, streamed chat, tools, schedules) into this shape and sends only these fields: raw provider
 * text, request bodies, prompts, and stacks stay in the server log behind `ref`.
 */
export const ERROR_CODES = [
  "provider_auth",
  "provider_rate_limit",
  "provider_quota",
  "model_not_found",
  "context_length",
  "provider_overloaded",
  "network",
  "timeout",
  "aborted",
  "tool_failed",
  "service_unavailable",
  "storage_quota",
  "validation",
  "not_found",
  "forbidden",
  "conflict",
  "unknown",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Safe metadata for "Copy details". It never carries a provider message, key, prompt, or stack. */
export interface ErrorWire {
  code: ErrorCode;
  message: string;
  hint?: string;
  retryable: boolean;
  retryAfterMs?: number;
  ref?: string;
  model?: string;
  provider?: string;
  requestId?: string;
}

/** Data written into the chat stream while a provider call waits before another attempt. */
export interface RetryNotice {
  attempt: number;
  delayMs: number;
  code: ErrorCode;
  /** `done` clears the notice after a successful attempt or after the last attempt returned. */
  status?: "done";
}

const CODES = new Set<string>(ERROR_CODES);
const MAX_ERROR_TEXT = 8 * 1024;

export const isErrorCode = (value: unknown): value is ErrorCode => typeof value === "string" && CODES.has(value);

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.slice(0, 2_000) : undefined;

/** Keeps only known fields, so a forged payload cannot smuggle a key, prompt, or stack into the UI. */
export function parseErrorWire(value: unknown): ErrorWire | undefined {
  let input = value;
  if (typeof input === "string") {
    if (!input.trim() || input.length > MAX_ERROR_TEXT) return undefined;
    try {
      input = JSON.parse(input);
    } catch {
      return undefined;
    }
  }
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  if (!isErrorCode(record.code)) return undefined;
  const message = text(record.message);
  if (!message) return undefined;
  const retryAfterMs = typeof record.retryAfterMs === "number" && Number.isFinite(record.retryAfterMs) && record.retryAfterMs >= 0
    ? Math.round(record.retryAfterMs)
    : undefined;
  return {
    code: record.code,
    message,
    ...(text(record.hint) ? { hint: text(record.hint) } : {}),
    retryable: record.retryable === true,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(text(record.ref) ? { ref: text(record.ref) } : {}),
    ...(text(record.model) ? { model: text(record.model) } : {}),
    ...(text(record.provider) ? { provider: text(record.provider) } : {}),
    ...(text(record.requestId) ? { requestId: text(record.requestId) } : {}),
  };
}

/** The wire shape of an error no boundary identified. The caller supplies a translated UI message. */
export function unknownWire(message = "Something went wrong."): ErrorWire {
  return { code: "unknown", message, retryable: false };
}
