import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HTTPException } from "hono/http-exception";
import type { CompletionUsage, ApiProtocolError } from "../../shared/api-access.js";
import type { TokenUsage } from "../../shared/types.js";
import { AppError } from "../errors.js";
import { describeBoundaryError } from "../provider-errors.js";
import { ApiBodyTimeout, ApiBodyTooLarge, ApiValidationError } from "./schema.js";
import { ApiConcurrentLimit, ApiRateLimited } from "./limits.js";

// The external protocol's only error vocabulary and its finish/usage mapping. Messages are authored or
// come from the safe taxonomy catalog; provider prose, prompts, and request values never reach a client.

export type ApiErrorType = ApiProtocolError["error"]["type"];

export class ApiProtocolFailure extends Error {
  constructor(
    readonly status: number,
    readonly type: ApiErrorType,
    readonly code: string,
    message: string,
    readonly param: string | null = null,
    readonly retryAfterMs?: number,
    readonly allow?: string,
  ) {
    super(message);
    this.name = "ApiProtocolFailure";
  }
}

export const apiFailure = (
  status: number,
  type: ApiErrorType,
  code: string,
  message: string,
  param: string | null = null,
  retryAfterMs?: number,
  allow?: string,
): ApiProtocolFailure => new ApiProtocolFailure(status, type, code, message, param, retryAfterMs, allow);

export const invalidRequest = (message: string, param: string | null = null) =>
  apiFailure(400, "invalid_request_error", "invalid_request", message, param);
export const unsupportedParameter = (message = "Unsupported parameter.", param: string | null = null) =>
  apiFailure(400, "invalid_request_error", "unsupported_parameter", message, param);
export const permissionDenied = (message = "This credential is not allowed to use that model.") =>
  apiFailure(403, "permission_error", "permission_denied", message);
export const invalidPolicy = () => apiFailure(503, "server_error", "invalid_policy", "The server's API policy is invalid.");
export const notFound = () => apiFailure(404, "invalid_request_error", "not_found", "Not found.");
export const methodNotAllowed = (allow: string) =>
  apiFailure(405, "invalid_request_error", "method_not_allowed", "Method not allowed.", null, undefined, allow);
export const serverError = () => apiFailure(500, "server_error", "server_error", "Something went wrong.");
export const incompleteResponse = () => apiFailure(502, "server_error", "incomplete_response", "The provider did not finish the response.");
export const unsupportedOutput = () => apiFailure(502, "server_error", "unsupported_output", "The provider returned output this API does not support.");
export const responseLimit = () => apiFailure(502, "server_error", "response_limit", "The provider response exceeded the allowed size.");
export const upstreamUnavailable = () => apiFailure(503, "server_error", "upstream_unavailable", "The model provider is unavailable.");
export const contextLengthExceeded = (message = "The request is too long for this model.") =>
  apiFailure(400, "invalid_request_error", "context_length_exceeded", message);

/** The envelope every external error uses. There is no top-level app `error` string. */
export function protocolError(failure: ApiProtocolFailure, requestId: string): ApiProtocolError {
  return {
    error: {
      message: failure.message.slice(0, 500),
      type: failure.type,
      param: failure.param,
      code: failure.code,
    },
    request_id: requestId,
  };
}

/** Headers every external response carries, including errors and streams. */
export function apiHeaders(requestId: string): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "X-Request-Id": requestId,
    "X-Content-Type-Options": "nosniff",
  };
}

export function sendApiError(c: Context, failure: ApiProtocolFailure, requestId: string) {
  const headers = apiHeaders(requestId);
  if (failure.status === 401) headers["WWW-Authenticate"] = 'Bearer realm="okaychat"';
  if (failure.retryAfterMs !== undefined) headers["Retry-After"] = String(Math.max(1, Math.ceil(failure.retryAfterMs / 1000)));
  if (failure.allow) headers.Allow = failure.allow;
  return c.json(protocolError(failure, requestId), failure.status as ContentfulStatusCode, headers);
}

const statusMap: Record<number, ApiProtocolFailure> = {
  400: invalidRequest("The request is not valid."),
  401: apiFailure(401, "authentication_error", "invalid_api_key", "Invalid API key."),
  403: permissionDenied(),
  404: apiFailure(404, "invalid_request_error", "model_not_found", "That model is not available."),
  408: apiFailure(408, "invalid_request_error", "request_timeout", "The request body timed out."),
  413: apiFailure(413, "invalid_request_error", "request_too_large", "The request body is too large."),
  429: apiFailure(429, "rate_limit_error", "rate_limit_exceeded", "Too many requests.", null, 1_000),
};

/** Maps the app taxonomy and provider failures onto the external codes. */
export function describeApiFailure(error: unknown, options: { modelRef?: string; abortedByClient?: boolean } = {}): ApiProtocolFailure {
  if (error instanceof ApiProtocolFailure) return error;
  if (error instanceof ApiValidationError) {
    return error.code === "unsupported_parameter"
      ? unsupportedParameter(error.message, error.param)
      : invalidRequest(error.message, error.param);
  }
  if (error instanceof ApiBodyTooLarge) return apiFailure(413, "invalid_request_error", "request_too_large", "The request body is too large.");
  if (error instanceof ApiBodyTimeout) return apiFailure(408, "invalid_request_error", "request_timeout", "The request body timed out.");
  if (error instanceof ApiRateLimited) return apiFailure(429, "rate_limit_error", "rate_limit_exceeded", "Too many API requests.", null, error.retryAfterMs);
  if (error instanceof ApiConcurrentLimit) return apiFailure(429, "rate_limit_error", "concurrent_limit", error.message, null, error.retryAfterMs);
  if (error instanceof HTTPException) {
    // Resolver failures: forbidden keeps its denial, everything else becomes an external 404.
    if (error.status === 403) return permissionDenied();
    if (error.status === 404 || error.status === 400) return apiFailure(404, "invalid_request_error", "model_not_found", "That model is not available.");
    if (error.status === 503) return invalidPolicy();
    return statusMap[error.status] ?? serverError();
  }
  if (error instanceof AppError) {
    const app = error;
    switch (app.code) {
      case "token_credit_exhausted":
      case "token_credit_usage_unknown":
      case "token_credit_unmetered": return apiFailure(403, "permission_error", app.code, app.message);
      case "token_credit_busy": return apiFailure(409, "rate_limit_error", app.code, app.message);
      case "provider_auth": return apiFailure(502, "server_error", "upstream_auth", "The model provider rejected the server's credentials.");
      case "provider_quota": return apiFailure(502, "server_error", "upstream_quota", "The model provider account is out of quota.");
      case "model_not_found": return apiFailure(502, "server_error", "upstream_model_not_found", "The provider does not offer that model.");
      case "provider_overloaded":
      case "service_unavailable": return upstreamUnavailable();
      case "provider_rate_limit": return apiFailure(429, "rate_limit_error", "upstream_rate_limit", "The model provider is rate limiting requests.", null, app.retryAfterMs ?? 1_000);
      case "timeout": return apiFailure(504, "server_error", "timeout", "The model provider took too long to respond.");
      case "network": return apiFailure(502, "server_error", "upstream_network", "The server could not reach the model provider.");
      case "context_length": return contextLengthExceeded("The provider says the request is too long for this model.");
      case "validation": return invalidRequest("The request is not valid.");
      case "forbidden": return app.details && (app.details as { reason?: string }).reason === "policy_invalid" ? invalidPolicy() : permissionDenied(app.message);
      case "rate_limited": return apiFailure(429, "rate_limit_error", "rate_limit_exceeded", "Too many requests.", null, app.retryAfterMs ?? 1_000);
      case "not_found": return apiFailure(404, "invalid_request_error", "model_not_found", "That model is not available.");
      case "storage_quota": return serverError();
      case "aborted": return options.abortedByClient
        ? apiFailure(499, "server_error", "client_disconnected", "The client disconnected.")
        : apiFailure(500, "server_error", "cancelled", "The request was stopped.");
      case "tool_failed": return serverError();
      default: return serverError();
    }
  }
  // Provider SDK failures go through the taxonomy without writing their prose to logs or the response.
  const mapped = describeBoundaryError(error, { kind: "provider", log: false, ...(options.modelRef ? { model: options.modelRef } : {}) });
  return mapped === error ? serverError() : describeApiFailure(mapped, options);
}

/** AI SDK finish reasons become exactly three public values. A tool call is never a success. */
export function mapFinishReason(reason: string | undefined): "stop" | "length" | "content_filter" {
  switch (reason) {
    case "stop": return "stop";
    case "length": return "length";
    case "content-filter": return "content_filter";
    case "tool-calls": throw unsupportedOutput();
    case "error": throw serverError();
    // A provider that reports an unspecified or vendor-specific reason still finished its message
    // (the local Ollama adapter sends "other" when the daemon omits done_reason).
    case "other":
    case "unknown":
      return "stop";
    default: throw incompleteResponse();
  }
}

export function completionUsage(usage: TokenUsage): CompletionUsage {
  return {
    prompt_tokens: usage.input,
    completion_tokens: usage.output,
    total_tokens: usage.input + usage.output,
    prompt_tokens_details: { cached_tokens: usage.cacheRead },
    completion_tokens_details: { reasoning_tokens: usage.reasoning },
  };
}

export const completionId = (requestId: string) => `chatcmpl-${requestId.replace(/^apr_/, "")}`;
