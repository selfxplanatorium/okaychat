import assert from "node:assert/strict";
import { test } from "node:test";
import { toWireError } from "./errors.js";
import { codeForProviderStatus, describeProviderError, retryAfterFromHeaders } from "./provider-errors.js";

const wire = (error: unknown, extra: Record<string, unknown> = {}) =>
  toWireError(describeProviderError(error, { log: false, model: "mock/model", provider: "mock", ...extra }));

test("OpenAI shapes: auth, quota, model gone, context length, and rate limit", () => {
  const auth = wire({ statusCode: 401, message: "Incorrect API key", responseBody: JSON.stringify({ error: { message: "bad key", type: "invalid_request_error", code: "invalid_api_key" } }) });
  assert.equal(auth.code, "provider_auth");
  assert.equal(auth.retryable, false);

  const quota = wire({ statusCode: 402, message: "Payment required", responseBody: JSON.stringify({ error: { message: "no credit", type: "insufficient_quota", code: "insufficient_quota" } }) });
  assert.equal(quota.code, "provider_quota");
  assert.equal(quota.retryable, false);

  const model = wire({ statusCode: 404, message: "Not found", responseBody: JSON.stringify({ error: { message: "The model `x` does not exist", code: "model_not_found" } }) });
  assert.equal(model.code, "model_not_found");

  const context = wire({ statusCode: 400, message: "Bad request", responseBody: JSON.stringify({ error: { message: "This model's maximum context length is 8192 tokens", code: "context_length_exceeded" } }) });
  assert.equal(context.code, "context_length");
  assert.equal(context.retryable, false);

  const rate = wire({ statusCode: 429, message: "Too many requests", responseHeaders: { "retry-after": "3" }, responseBody: JSON.stringify({ error: { message: "Rate limit reached", type: "rate_limit_exceeded" } }) });
  assert.equal(rate.code, "provider_rate_limit");
  assert.equal(rate.retryable, true);
  assert.equal(rate.retryAfterMs, 3_000);
});

test("Anthropic shapes: overloaded, request too large, authentication, and a Retry-After date", () => {
  const overloaded = wire({ statusCode: 529, message: "Overloaded", responseBody: JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }) });
  assert.equal(overloaded.code, "provider_overloaded");
  assert.equal(overloaded.retryable, true);

  const tooLarge = wire({ statusCode: 413, message: "Request entity too large", responseBody: JSON.stringify({ type: "error", error: { type: "request_too_large", message: "prompt is too long" } }) });
  assert.equal(tooLarge.code, "context_length");

  const auth = wire({ statusCode: 401, message: "Unauthorized", responseBody: JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }) });
  assert.equal(auth.code, "provider_auth");

  const now = Date.parse("2026-10-31T12:00:00Z");
  const retry = retryAfterFromHeaders({ "retry-after": "Sat, 31 Oct 2026 12:00:20 GMT" }, now);
  assert.equal(retry, 20_000);
  assert.equal(retryAfterFromHeaders({ "retry-after": "nonsense" }, now), undefined);
  assert.equal(retryAfterFromHeaders({ "retry-after-ms": "2500" }, now), 2_500);
});

test("Google and Ollama shapes pick stable codes", () => {
  const context = wire({ statusCode: 400, message: "Bad Request", responseBody: JSON.stringify([{ error: { code: 400, message: "The input token count exceeds the maximum", status: "INVALID_ARGUMENT" } }]) });
  assert.equal(context.code, "context_length");

  const denied = wire({ statusCode: 403, message: "Forbidden", responseBody: JSON.stringify({ error: { code: 403, message: "Permission denied", status: "PERMISSION_DENIED" } }) });
  assert.equal(denied.code, "provider_auth");

  const exhausted = wire({ statusCode: 429, message: "Too Many Requests", responseBody: JSON.stringify({ error: { code: 429, message: "Quota exceeded for this project", status: "RESOURCE_EXHAUSTED" } }) });
  assert.equal(exhausted.code, "provider_rate_limit");

  const ollamaMissing = wire({ name: "OllamaError", status: 404, message: "Ollama model llama3 is not installed." });
  assert.equal(ollamaMissing.code, "model_not_found");

  assert.equal(codeForProviderStatus(400, undefined, "unknown model mock-1"), "model_not_found");
  assert.equal(codeForProviderStatus(400, undefined, "invalid request"), "validation");
});

test("network, DNS, timeout, abort, and overloaded failures are classified", () => {
  assert.equal(wire({ name: "TypeError", message: "fetch failed", cause: { code: "ENOTFOUND" } }).code, "network");
  assert.equal(wire({ name: "TypeError", message: "fetch failed", cause: { code: "ECONNREFUSED" } }).retryable, true);
  assert.equal(wire({ name: "TimeoutError", message: "The operation timed out" }).code, "timeout");
  assert.equal(wire({ name: "AbortError", message: "aborted" }).code, "aborted");
  assert.equal(wire({ statusCode: 500, message: "server_error" }).code, "provider_overloaded");
  assert.equal(wire({ statusCode: 503, message: "unavailable" }).code, "provider_overloaded");
});

test("the serialized payload never carries provider text, keys, prompts, files, or a stack", () => {
  const responseBody = JSON.stringify({
    error: {
      message: "Incorrect API key sk-proj-SECRET1234567890 for prompt PROMPT_SECRET",
      type: "invalid_request_error",
      code: "invalid_api_key",
      file: "FILE_SECRET",
      stack: "at SECRET_STACK",
    },
  });
  const error = {
    statusCode: 401,
    message: "sk-proj-SECRET1234567890 PROMPT_SECRET FILE_SECRET SECRET_STACK",
    responseBody,
    responseHeaders: { "x-request-id": "req_safe_1" },
    requestBodyValues: { apiKey: "sk-proj-SECRET1234567890", prompt: "PROMPT_SECRET" },
  };
  const payload = wire(error);
  const text = JSON.stringify(payload);
  assert.equal(payload.code, "provider_auth");
  assert.equal(payload.requestId, "req_safe_1");
  for (const secret of ["SECRET", "PROMPT_SECRET", "FILE_SECRET", "SECRET_STACK", "apiKey", "prompt:"]) assert.ok(!text.includes(secret), `leaked ${secret}`);
});

test("logging adds a short reference without changing the safe payload", (t) => {
  t.mock.method(console, "error", () => {});
  const error = describeProviderError({ statusCode: 429, message: "slow down", responseHeaders: { "retry-after": "1" } }, { log: true, model: "mock/model", provider: "mock" });
  const payload = toWireError(error);
  assert.match(payload.ref ?? "", /^[0-9a-f]{8}$/);
  assert.equal(payload.retryable, true);
  assert.equal(payload.retryAfterMs, 1_000);
});
