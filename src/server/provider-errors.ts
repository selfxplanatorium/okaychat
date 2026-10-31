import type { ErrorCode } from "../shared/errors.js";
import { AppError, ERROR_CATALOG, newErrorRef, redactSecrets, toWireError } from "./errors.js";

/**
 * Provider failures, normalised once. The HTTP status and the common OpenAI, Anthropic, Google,
 * and Ollama body shapes select a stable code; the raw body is logged behind a short reference and
 * never reaches the browser. See docs/implementation/errors.md.
 */
export interface ProviderErrorContext {
  /** Temporary chats are not logged, like before: their content must not reach the server log. */
  log?: boolean;
  /** The model reference shown in Copy details, e.g. `openai/gpt-5`. */
  model?: string;
  provider?: string;
  /** A tool failure uses `tool_failed` when nothing identifies a provider. */
  kind?: "provider" | "tool" | "background";
}

interface ErrorShape {
  name?: string;
  message?: string;
  code?: string | number;
  status?: number;
  statusCode?: number;
  responseBody?: unknown;
  responseHeaders?: unknown;
  data?: unknown;
  isRetryable?: boolean;
  lastError?: unknown;
  reason?: string;
  cause?: unknown;
}

const shape = (error: unknown): ErrorShape => (typeof error === "object" && error !== null ? error as ErrorShape : {});
const lower = (value: unknown) => (typeof value === "string" ? value.toLowerCase() : "");

const CONTEXT_MESSAGE = /context[ _-]?length|context window|maximum context|too many tokens|token limit|prompt is too long|input is too long|request too large|request_too_large|reduce the length|exceeds? (?:the )?(?:maximum|model)|too large for (?:the )?model/i;
const MODEL_MESSAGE = /(?:model|deployment).{0,40}(?:not found|not exist|unknown|unsupported|does not exist|invalid|no access)|no such model|model_not_found|unknown model|invalid model/i;
const AUTH_CODE = /invalid[_ -]?api[_ -]?key|authentication|unauthenticated|unauthorized|permission[_ -]?denied|invalid[_ -]?token/i;
const QUOTA_CODE = /insufficient[_ -]?quota|billing|quota[_ -]?exceeded|credit balance|payment required|out of credit|hard limit/i;
// A Google 429 says RESOURCE_EXHAUSTED and often calls it a project quota; that is a rate limit, not a
// depleted account. Only explicit billing/credit shapes turn a 429 into a permanent quota error.
const STRICT_QUOTA = /insufficient[_ -]?quota|billing|credit balance|payment required|out of credit|hard limit/i;
const RATE_CODE = /rate[_ -]?limit|too many requests|resource[_ -]?exhausted|throttl/i;
const OVERLOAD_CODE = /overloaded|server[_ -]?error|internal[_ -]?error|service[_ -]?unavailable|api[_ -]?error|unavailable|capacity/i;
const TIMEOUT_CODE = /timeout|timed out|deadline[_ -]?exceeded|etimedout/i;
const NETWORK_MESSAGE = /fetch failed|econnrefused|econnreset|enotfound|eai_again|ehostunreach|enetunreach|epipe|getaddrinfo|socket hang up|network|other side closed|und_err|connection (?:closed|reset|refused)/i;
const MEMORY_MESSAGE = /requires more (?:system )?memory|out of memory|not enough memory/i;

/** Reads a provider error body without trusting its type or size. */
function bodyOf(error: ErrorShape): unknown {
  const data = error.data;
  if (typeof data === "object" && data !== null) return data;
  const raw = error.responseBody;
  if (typeof raw !== "string") return typeof raw === "object" && raw !== null ? raw : undefined;
  if (!raw.trim() || raw.length > 64 * 1024) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

interface BodyInfo {
  message: string;
  type: string;
  code: string;
  status: string;
  requestId?: string;
}

function bodyInfo(body: unknown): BodyInfo {
  const root = Array.isArray(body) ? body[0] : body;
  const record = typeof root === "object" && root !== null ? root as Record<string, unknown> : {};
  const nested = typeof record.error === "object" && record.error !== null ? record.error as Record<string, unknown> : {};
  const direct = typeof record.error === "string" ? record.error : undefined;
  const requestId = [record.request_id, record.requestId, nested.request_id, nested.requestId].find((value) => typeof value === "string") as string | undefined;
  return {
    message: [nested.message, direct, record.message, record.detail].find((value) => typeof value === "string") as string ?? "",
    type: lower(nested.type ?? record.type),
    code: lower(nested.code ?? record.code ?? record.status),
    status: lower(nested.status ?? record.status),
    ...(requestId ? { requestId } : {}),
  };
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof Headers !== "undefined" && headers instanceof Headers) return headers.get(name) ?? undefined;
  if (typeof headers !== "object") return undefined;
  const record = headers as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === name && typeof value === "string") return value;
  }
  return undefined;
}

function requestIdOf(headers: unknown, body: BodyInfo): string | undefined {
  if (body.requestId) return body.requestId.slice(0, 200);
  for (const name of ["x-request-id", "request-id", "openai-request-id", "anthropic-request-id", "x-amzn-requestid", "x-goog-request-id"]) {
    const value = headerValue(headers, name);
    if (value) return value.slice(0, 200);
  }
  return undefined;
}

/** Millisecond wait from a provider header, in seconds or an HTTP date. */
export function retryAfterFromHeaders(headers: unknown, now = Date.now()): number | undefined {
  const milliseconds = headerValue(headers, "retry-after-ms");
  if (milliseconds && /^\d+$/.test(milliseconds.trim())) return Math.min(Number(milliseconds), 24 * 60 * 60_000);
  const raw = headerValue(headers, "retry-after");
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Math.min(Math.round(Number(trimmed) * 1000), 24 * 60 * 60_000);
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, Math.min(at - now, 24 * 60 * 60_000)) : undefined;
}

function isAbort(error: ErrorShape): boolean {
  return error.name === "AbortError" || error.code === "ABORT_ERR" || error.reason === "abort";
}

function isTimeout(error: ErrorShape): boolean {
  return error.name === "TimeoutError" || error.code === "ETIMEDOUT" || TIMEOUT_CODE.test(error.message ?? "");
}

function statusOf(error: ErrorShape): number | undefined {
  const value = error.statusCode ?? error.status;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Extracts a safe provider code from a plain status + body when no Error object carries them. */
export function codeForProviderStatus(status: number | undefined, body: unknown, message = ""): ErrorCode {
  const info = bodyInfo(body);
  const combined = `${info.type} ${info.code} ${info.status} ${info.message} ${message}`.toLowerCase();
  if (status === 401 || status === 403) return "provider_auth";
  if (status === 402) return "provider_quota";
  if (status === 404) return "model_not_found";
  if (status === 408) return "timeout";
  if (status === 429) return STRICT_QUOTA.test(combined) ? "provider_quota" : "provider_rate_limit";
  if (status === 529) return "provider_overloaded";
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return TIMEOUT_CODE.test(combined) ? "timeout" : "provider_overloaded";
  }
  if (status === 413) return "context_length";
  if (status === 400 || status === 422) {
    if (CONTEXT_MESSAGE.test(combined)) return "context_length";
    if (MODEL_MESSAGE.test(combined)) return "model_not_found";
    if (AUTH_CODE.test(combined)) return "provider_auth";
    if (QUOTA_CODE.test(combined)) return "provider_quota";
    if (OVERLOAD_CODE.test(combined)) return "provider_overloaded";
    return "validation";
  }
  if (AUTH_CODE.test(combined)) return "provider_auth";
  if (MODEL_MESSAGE.test(combined)) return "model_not_found";
  if (CONTEXT_MESSAGE.test(combined)) return "context_length";
  if (QUOTA_CODE.test(combined)) return "provider_quota";
  if (RATE_CODE.test(combined)) return "provider_rate_limit";
  if (OVERLOAD_CODE.test(combined)) return "provider_overloaded";
  if (MEMORY_MESSAGE.test(combined)) return "provider_overloaded";
  return "unknown";
}

function unwrap(error: unknown): ErrorShape {
  const current = shape(error);
  // The SDK wraps retried calls; the last real failure explains the code and status.
  if (current.lastError && (current.name === "AI_RetryError" || current.name === "RetryError")) {
    const inner = shape(current.lastError);
    return { ...inner, reason: current.reason, lastError: current.lastError };
  }
  return current;
}

function summarize(error: ErrorShape, body: unknown, context: ProviderErrorContext, status: number | undefined): AppError {
  const info = bodyInfo(body);
  const combined = `${info.type} ${info.code} ${info.status} ${info.message} ${error.message ?? ""}`;
  let code = codeForProviderStatus(status, body, error.message);
  // A 403 from a blocked outbound address is a configuration refusal, not a rejected provider key.
  if (error.name === "BlockedAddressError") code = "forbidden";
  if (status === undefined && error.name === "BlockedAddressError") code = "forbidden";
  let retryable: boolean | undefined;
  if (code === "provider_overloaded" && MEMORY_MESSAGE.test(combined)) retryable = false;
  // Network failures arrive as TypeError("fetch failed") with a cause code and no status.
  if (status === undefined && code === "unknown") {
    if (isTimeout(error)) code = "timeout";
    else if (NETWORK_MESSAGE.test(combined) || NETWORK_MESSAGE.test(lower((error.cause as ErrorShape | undefined)?.code))) code = "network";
    else if (context.kind === "tool") code = "tool_failed";
  }
  if (status === undefined && code === "validation" && context.kind === "tool") code = "tool_failed";
  const retryAfterMs = code === "provider_rate_limit" || code === "provider_overloaded"
    ? retryAfterFromHeaders(error.responseHeaders)
    : undefined;
  const requestId = requestIdOf(error.responseHeaders, info);
  const entry = ERROR_CATALOG[code];
  return new AppError({
    code,
    message: entry.message,
    hint: entry.hint,
    status: entry.status,
    ...(retryable !== undefined ? { retryable } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(context.model ? { model: context.model } : {}),
    ...(context.provider ? { provider: context.provider } : {}),
    ...(requestId ? { requestId } : {}),
    details: { name: error.name, status, body: body ?? error.responseBody, message: error.message },
    cause: error,
  });
}

function logFailure(app: AppError, error: unknown, context: ProviderErrorContext): void {
  if (context.log === false || app.code === "aborted") return;
  const ref = app.ref ?? newErrorRef();
  app.ref = ref;
  const current = shape(error);
  const rawBody = typeof current.responseBody === "string" ? current.responseBody : current.responseBody ? JSON.stringify(current.responseBody) : "";
  const line = {
    code: app.code,
    status: app.status,
    provider: app.provider,
    model: app.model,
    requestId: app.requestId,
    name: current.name,
    message: redactSecrets(String(current.message ?? "")).slice(0, 500),
    body: redactSecrets(rawBody).slice(0, 500),
  };
  console.error(`[provider] ref=${ref}`, line);
}

/** Maps any provider call failure to the taxonomy. Logging keeps the raw detail server-side. */
export function describeProviderError(error: unknown, context: ProviderErrorContext = {}): AppError {
  if (error instanceof AppError) {
    logFailure(error, error, context);
    return error;
  }
  const current = unwrap(error);
  if (isAbort(current)) {
    const app = new AppError({
      code: "aborted",
      ...(context.model ? { model: context.model } : {}),
      ...(context.provider ? { provider: context.provider } : {}),
      details: { name: current.name, message: current.message },
      cause: error,
    });
    return app;
  }
  if (isTimeout(current)) {
    const app = new AppError({
      code: "timeout",
      ...(context.model ? { model: context.model } : {}),
      ...(context.provider ? { provider: context.provider } : {}),
      details: { name: current.name, message: current.message },
      cause: error,
    });
    logFailure(app, error, context);
    return app;
  }
  const status = statusOf(current);
  const body = bodyOf(current);
  const app = summarize(current, body, context, status);
  logFailure(app, error, context);
  return app;
}

/** The JSON string the AI SDK stream error chunk carries; the client parses only these fields. */
export const wireErrorText = (error: AppError) => JSON.stringify(toWireError(error));

/** A plain, non-provider failure at a user-visible boundary (titles, schedules, tool code). */
export function describeBoundaryError(error: unknown, context: ProviderErrorContext = {}): AppError {
  if (error instanceof AppError) return error;
  const current = shape(error);
  const message = current.message ?? "";
  if (isAbort(current)) return new AppError({ code: "aborted", details: { message }, cause: error });
  if (isTimeout(current)) {
    const app = new AppError({ code: "timeout", details: { message }, cause: error });
    logFailure(app, error, context);
    return app;
  }
  // HTTPException from a route carries a message the author intended the user to read.
  if (typeof current.status === "number") {
    const code = current.status === 404 ? "not_found" : current.status === 403 ? "forbidden" : current.status === 409 ? "conflict" : current.status === 429 ? "conflict" : "validation";
    return new AppError({ code, status: current.status, message, details: { message }, cause: error });
  }
  const app = new AppError({
    code: context.kind === "background" ? "unknown" : "tool_failed",
    ...(context.model ? { model: context.model } : {}),
    ...(context.provider ? { provider: context.provider } : {}),
    details: { name: current.name, message },
    cause: error,
  });
  logFailure(app, error, context);
  return app;
}
