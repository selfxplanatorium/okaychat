import assert from "node:assert/strict";
import { test } from "node:test";
import { toWireError } from "./errors.js";
import { codeForProviderStatus, describeProviderError, retryAfterFromHeaders, toolErrorWireText, transientStatus } from "./provider-errors.js";

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
  assert.equal(wire({ name: "TypeError", message: "fetch failed", cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }).code, "timeout");
  assert.equal(wire({ name: "AbortError", message: "aborted" }).code, "aborted");
  assert.equal(wire({ statusCode: 500, message: "server_error" }).code, "provider_overloaded");
  assert.equal(wire({ statusCode: 503, message: "unavailable" }).code, "provider_overloaded");
});

test("HTTP status outranks timeout words in a provider message", () => {
  const auth = wire({ statusCode: 401, message: "timeout while validating the api key", responseBody: JSON.stringify({ error: { code: "invalid_api_key", message: "timed out" } }) });
  assert.equal(auth.code, "provider_auth");
  assert.equal(auth.retryable, false);
  const quota = wire({ statusCode: 402, message: "ETIMEDOUT while checking billing" });
  assert.equal(quota.code, "provider_quota");
  assert.equal(quota.retryable, false);
});

test("native Ollama network and timeout messages keep the provider taxonomy", () => {
  const unreachable = wire({ name: "OllamaError", message: "Could not reach Ollama at http://127.0.0.1:11434. Is the daemon running and is the URL correct?" });
  assert.equal(unreachable.code, "network");
  assert.equal(unreachable.retryable, true);
  const timeout = wire({ name: "OllamaError", message: "Ollama did not answer at http://127.0.0.1:11434 in time." });
  assert.equal(timeout.code, "timeout");
  assert.equal(timeout.retryable, true);
});

test("every 5xx maps to overloaded but only transient statuses retry", () => {
  for (let status = 500; status <= 599; status++) {
    const payload = wire({ statusCode: status, message: "upstream failed" });
    assert.equal(payload.code, "provider_overloaded", String(status));
    assert.equal(payload.retryable, transientStatus(status), String(status));
  }
  assert.equal(transientStatus(501), false);
  assert.equal(transientStatus(507), false);
  assert.equal(transientStatus(503), true);
  assert.equal(transientStatus(529), true);
  assert.equal(transientStatus(408), true);
  assert.equal(transientStatus(429), true);
});

test("an out-of-memory 5xx is overloaded but never retryable", () => {
  const oom = wire({ statusCode: 503, message: "llama3 requires more system memory" });
  assert.equal(oom.code, "provider_overloaded");
  assert.equal(oom.retryable, false);
});

test("tool output error text is normalized without echoing raw strings", () => {
  const generic = JSON.parse(toolErrorWireText("apiKey=sk-live-SECRETVALUE and prompt PROMPT_SECRET")) as { code: string; message: string };
  assert.equal(generic.code, "tool_failed");
  assert.ok(!JSON.stringify(generic).includes("SECRET"));
  assert.ok(!JSON.stringify(generic).includes("apiKey"));

  const object = JSON.parse(toolErrorWireText({ message: "PROMPT_SECRET", stack: "SECRET_STACK" })) as { code: string };
  assert.equal(object.code, "tool_failed");

  const stack = JSON.parse(toolErrorWireText("Error: boom\n    at run (file.ts:12:3)")) as { code: string };
  assert.equal(stack.code, "tool_failed");

  const wireText = JSON.stringify({ code: "provider_rate_limit", message: "The provider is rate limiting requests.", retryable: true });
  assert.equal(JSON.parse(toolErrorWireText(wireText)).code, "provider_rate_limit");

  const unknownWire = JSON.stringify({ code: "unknown", message: "raw provider JSON", retryable: false });
  assert.equal(JSON.parse(toolErrorWireText(unknownWire)).code, "tool_failed");
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
