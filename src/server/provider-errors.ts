import type { ErrorCode, FeatureCode, RecoveryAction } from "../shared/errors.js";
import { parseErrorWire, safeProviderField } from "../shared/errors.js";
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
const TIMEOUT_CODE = /timeout|timed out|deadline[_ -]?exceeded|etimedout|did not answer(?:\s+at\s+\S+)?\s+in time/i;
const NETWORK_MESSAGE = /fetch failed|econnrefused|econnreset|enotfound|eai_again|ehostunreach|enetunreach|epipe|getaddrinfo|socket hang up|network|other side closed|und_err|connection (?:closed|reset|refused)|could not reach ollama|could not reach/i;
const MEMORY_MESSAGE = /requires more (?:system )?memory|out of memory|not enough memory|memory pressure/i;

/**
 * Statuses where another attempt can plausibly succeed. Every 5xx still maps to `provider_overloaded`,
 * but only these are marked retryable (507 is a storage refusal, 501 is unimplemented, ...).
 */
const TRANSIENT_5XX = new Set([500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 527, 529]);
export function transientStatus(status: number): boolean {
  return status === 408 || status === 429 || TRANSIENT_5XX.has(status);
}

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
  /** The upstream machine code exactly as sent, bounded and charset-checked. */
  machineCode?: string;
  /** The upstream parameter name, when the body names one. */
  param?: string;
}

function bodyInfo(body: unknown): BodyInfo {
  const root = Array.isArray(body) ? body[0] : body;
  const record = typeof root === "object" && root !== null ? root as Record<string, unknown> : {};
  const nested = typeof record.error === "object" && record.error !== null ? record.error as Record<string, unknown> : {};
  const direct = typeof record.error === "string" ? record.error : undefined;
  const requestId = [record.request_id, record.requestId, nested.request_id, nested.requestId].find((value) => typeof value === "string") as string | undefined;
  const machineCode = safeProviderField(nested.code ?? record.code);
  const param = safeProviderField(nested.param ?? record.param);
  return {
    message: [nested.message, direct, record.message, record.detail].find((value) => typeof value === "string") as string ?? "",
    type: lower(nested.type ?? record.type),
    code: lower(nested.code ?? record.code ?? record.status),
    status: lower(nested.status ?? record.status),
    ...(requestId ? { requestId } : {}),
    ...(machineCode ? { machineCode } : {}),
    ...(param ? { param } : {}),
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
  const causeCode = (error.cause as { code?: string } | undefined)?.code ?? "";
  return error.name === "TimeoutError" || error.code === "ETIMEDOUT" || /timeout/i.test(causeCode) || TIMEOUT_CODE.test(error.message ?? "");
}

function statusOf(error: ErrorShape): number | undefined {
  const value = error.statusCode ?? error.status;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * A structured ChatGPT-plan refusal. The upstream code picks the stable taxonomy, the authored
 * recovery, and the bounded diagnostic; its message never reaches the browser.
 */
export interface StructuredFailure {
  code: ErrorCode;
  retryable: boolean;
  featureCode?: FeatureCode;
  recoveryAction?: RecoveryAction;
  providerCode: string;
  providerParam?: string;
}

/**
 * The SIWC inference codes from docs section 9. `retryable` here means "another identical request
 * can succeed", so an eligibility, scope, capability, or usage-limit refusal is final. A 401 keeps
 * its single auth replay in the transport; this mapping runs only once that replay is exhausted.
 */
const STRUCTURED_FAILURES: Record<string, Omit<StructuredFailure, "providerCode" | "providerParam">> = {
  subscription_sharing_user_not_eligible: { code: "forbidden", retryable: false, recoveryAction: "choose_provider" },
  subscription_sharing_usage_limit_exceeded: { code: "provider_quota", retryable: false, recoveryAction: "manage_chatgpt_usage" },
  subscription_sharing_usage_unavailable: { code: "provider_overloaded", retryable: true, recoveryAction: "retry" },
  subscription_sharing_user_unavailable: { code: "provider_overloaded", retryable: true, recoveryAction: "retry" },
  subscription_sharing_unsupported_capability: { code: "validation", retryable: false },
  subscription_sharing_route_not_supported: {
    code: "forbidden",
    retryable: false,
    featureCode: "chatgpt_protocol_error",
    recoveryAction: "contact_admin",
  },
  subscription_sharing_invalid_user: {
    code: "provider_auth",
    retryable: false,
    featureCode: "chatgpt_reconnect_required",
    recoveryAction: "reconnect_chatgpt",
  },
  chatpass_v2_scope_not_authorized: {
    code: "forbidden",
    retryable: false,
    featureCode: "chatgpt_plan_disabled",
    recoveryAction: "enable_chatgpt_plan",
  },
  chatpass_v2_invalid_authorization_context: {
    code: "forbidden",
    retryable: false,
    featureCode: "chatgpt_reconnect_required",
    recoveryAction: "reconnect_chatgpt",
  },
};

/** The structured refusal in a body, if it is one we know, with its bounded diagnostics. */
export function structuredFailure(body: unknown): StructuredFailure | undefined {
  const info = bodyInfo(body);
  if (!info.machineCode) return undefined;
  const mapped = STRUCTURED_FAILURES[info.machineCode.toLowerCase()];
  if (!mapped) return undefined;
  return {
    ...mapped,
    providerCode: info.machineCode,
    ...(info.param ? { providerParam: info.param } : {}),
  };
}

/**
 * True when a failed response body names a structured refusal no retry can fix. The retry boundary
 * reads this from the bounded peek, so a plan usage limit is not retried just because it is a 429.
 */
export function structuredRefusalText(text: string): boolean {
  if (!text.trim() || text.length > 64 * 1024) return false;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return false;
  }
  return structuredFailure(body)?.retryable === false;
}

/** Extracts a safe provider code from a plain status + body when no Error object carries them. */
export function codeForProviderStatus(status: number | undefined, body: unknown, message = ""): ErrorCode {
  const structured = structuredFailure(body);
  if (structured) return structured.code;
  const info = bodyInfo(body);
  const combined = `${info.type} ${info.code} ${info.status} ${info.message} ${message}`.toLowerCase();
  if (status === 401 || status === 403) return "provider_auth";
  if (status === 402) return "provider_quota";
  if (status === 404) return "model_not_found";
  if (status === 408) return "timeout";
  if (status === 429) return STRICT_QUOTA.test(combined) ? "provider_quota" : "provider_rate_limit";
  // Every 5xx is an upstream server failure; retryability is decided separately from its status.
  if (status !== undefined && status >= 500 && status <= 599) {
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
  const structured = structuredFailure(body);
  const combined = `${info.type} ${info.code} ${info.status} ${info.message} ${error.message ?? ""}`;
  let code = structured?.code ?? codeForProviderStatus(status, body, error.message);
  // A 403 from a blocked outbound address is a configuration refusal, not a rejected provider key.
  if (!structured && error.name === "BlockedAddressError") code = "forbidden";
  // A structured refusal owns its retryability; the heuristics below only classify bare bodies.
  let retryable: boolean | undefined = structured?.retryable;
  if (!structured) {
    if (code === "provider_overloaded" && (MEMORY_MESSAGE.test(combined) || STRICT_QUOTA.test(combined) || CONTEXT_MESSAGE.test(combined) || AUTH_CODE.test(combined))) retryable = false;
    // A server status outside the transient set is a refusal, not a hiccup, even though it maps to overloaded.
    if (status !== undefined && status >= 500 && status <= 599 && !transientStatus(status)) retryable = false;
    // Network failures arrive as TypeError("fetch failed") with a cause code and no status.
    if (status === undefined && code === "unknown") {
      if (isTimeout(error)) code = "timeout";
      else if (NETWORK_MESSAGE.test(combined) || NETWORK_MESSAGE.test(lower((error.cause as ErrorShape | undefined)?.code))) code = "network";
      else if (context.kind === "tool") code = "tool_failed";
    }
    if (status === undefined && code === "validation" && context.kind === "tool") code = "tool_failed";
  }
  const retryAfterMs = code === "provider_rate_limit" || code === "provider_overloaded"
    ? retryAfterFromHeaders(error.responseHeaders)
    : undefined;
  const requestId = requestIdOf(error.responseHeaders, info);
  const providerCode = structured?.providerCode ?? info.machineCode;
  const providerParam = structured?.providerParam ?? info.param;
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
    ...(structured?.featureCode ? { featureCode: structured.featureCode } : {}),
    ...(providerCode ? { providerCode } : {}),
    ...(providerParam ? { providerParam } : {}),
    ...(structured?.recoveryAction ? { recoveryAction: structured.recoveryAction } : {}),
    details: { name: error.name, status, body: body ?? error.responseBody, message: error.message },
    cause: error,
  });
}

/** OAuth parameters whose value must never reach a log, even outside a URL query string. */
const OAUTH_PARAM = /\b(code_verifier|code_challenge|code|state|verifier|nonce|id_token_hint|helperSecret|helper_secret|helperCapability|client_secret)\b(\s*[:=]\s*['"]?)([^\s'",;}\]]{2,})/gi;

/**
 * A log line may name what failed, never the secret that failed. Whole query strings are dropped, so
 * an authorization or callback URL cannot carry a code, state, verifier, nonce, or token into the
 * application or reverse-proxy log. The body is a bounded prefix; the rest never leaves the process.
 */
function diagnosticText(value: string, max: number): string {
  return redactSecrets(value)
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (url) => url.split(/[?#]/)[0] ?? url)
    .replace(OAUTH_PARAM, "$1$2[redacted]")
    .slice(0, max);
}

function logFailure(app: AppError, error: unknown, context: ProviderErrorContext): void {
  if (context.log === false || app.code === "aborted") return;
  const ref = app.ref ?? newErrorRef();
  app.ref = ref;
  const current = shape(error);
  const rawBody = typeof current.responseBody === "string" ? current.responseBody : current.responseBody ? JSON.stringify(current.responseBody) : "";
  const line = {
    code: app.code,
    featureCode: app.featureCode,
    providerCode: app.providerCode,
    status: app.status,
    provider: app.provider,
    model: app.model,
    requestId: app.requestId,
    name: current.name,
    message: diagnosticText(String(current.message ?? "").slice(0, 2_000), 500),
    body: diagnosticText(rawBody.slice(0, 4_000), 500),
  };
  console.error(`[provider] ref=${ref}`, line);
}

/** Maps any provider call failure to the taxonomy. Logging keeps the raw detail server-side. */
export function describeProviderError(error: unknown, context: ProviderErrorContext = {}): AppError {
  if (error instanceof AppError) {
    logFailure(error, error, context);
    return error;
  }
  // An abort names itself; a timeout does not outrank an HTTP status (a 401 whose message mentions
  // "timeout" is still an authentication failure).
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
  const status = statusOf(current);
  if (status === undefined && isTimeout(current)) {
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
  const body = bodyOf(current);
  const app = summarize(current, body, context, status);
  logFailure(app, error, context);
  return app;
}

/** The JSON string the AI SDK stream error chunk carries; the client parses only these fields. */
export const wireErrorText = (error: AppError) => JSON.stringify(toWireError(error));

/**
 * The UI text for one `tool-output-error` chunk. The model already saw the original tool error, so
 * this only reshapes what the card renders: a known wire passes through, anything else becomes the
 * generic tool failure. Raw tool/provider text never reaches the browser.
 */
export function toolErrorWireText(errorText: unknown): string {
  const wire = parseErrorWire(errorText);
  if (wire && wire.code !== "unknown") return JSON.stringify(wire);
  return wireErrorText(new AppError({ code: "tool_failed" }));
}

/** A plain, non-provider failure at a user-visible boundary (titles, schedules, tool code). */
export function describeBoundaryError(error: unknown, context: ProviderErrorContext = {}): AppError {
  if (error instanceof AppError) return error;
  const current = shape(error);
  const message = current.message ?? "";
  if (isAbort(current)) return new AppError({ code: "aborted", details: { message }, cause: error });
  const status = typeof current.status === "number" ? current.status : undefined;
  if (status === undefined && isTimeout(current)) {
    const app = new AppError({ code: "timeout", details: { message }, cause: error });
    logFailure(app, error, context);
    return app;
  }
  // HTTPException from a route carries a message the author intended the user to read.
  if (status !== undefined) {
    const code = status === 404 ? "not_found" : status === 403 ? "forbidden" : status === 409 ? "conflict" : status === 429 ? "rate_limited" : "validation";
    return new AppError({ code, status, message, details: { message }, cause: error });
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
