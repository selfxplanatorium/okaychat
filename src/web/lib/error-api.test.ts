import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { api, ApiError, apiErrorFromBody, isSessionUnauthorized, parseChatError, responseError, structuredResponseError } from "./api.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("ApiError reads structured fields, status, and the legacy error string", () => {
  const structured = apiErrorFromBody({
    error: "Rate limited",
    code: "provider_rate_limit",
    message: "The provider is rate limiting requests.",
    hint: "Wait a moment.",
    retryable: true,
    retryAfterMs: 3_000,
    ref: "abcd1234",
    model: "openai/gpt-5",
    provider: "openai",
    requestId: "req_1",
  }, 429);
  assert.equal(structured.message, "The provider is rate limiting requests.");
  assert.equal(structured.code, "provider_rate_limit");
  assert.equal(structured.retryAfterMs, 3_000);
  assert.equal(structured.ref, "abcd1234");
  assert.equal(structured.status, 429);

  const legacy = apiErrorFromBody({ error: "Storage quota exceeded" }, 413);
  assert.equal(legacy.message, "Storage quota exceeded");
  assert.equal(legacy.code, "unknown");
});

test("non-JSON and unknown error bodies fall back to a safe HTTP message", () => {
  const fallback = apiErrorFromBody("<html>secret stack</html>", 500);
  assert.equal(fallback.message, "The request failed (HTTP 500).");
  assert.ok(!fallback.message.includes("secret"));
  const object = apiErrorFromBody({ error: { message: "raw nested", apiKey: "sk-secret" } }, 400);
  assert.equal(object.message, "The request failed (HTTP 400).");
  assert.ok(!JSON.stringify(object).includes("sk-secret"));
});

test("a legacy string is kept only as authored 4xx validation, never as upstream 5xx text", () => {
  const authored = apiErrorFromBody({ error: "Pick a model before sending." }, 400);
  assert.equal(authored.message, "Pick a model before sending.");

  const upstream = apiErrorFromBody({ error: '{"error":{"message":"stack at provider"}}' }, 400);
  assert.equal(upstream.message, "The request failed (HTTP 400).");
  const secret = apiErrorFromBody({ error: "apiKey=sk-live-SECRETVALUE" }, 422);
  assert.equal(secret.message, "The request failed (HTTP 422).");
  const stack = apiErrorFromBody({ error: "Error: boom\n    at run (file.ts:12:3)" }, 409);
  assert.equal(stack.message, "The request failed (HTTP 409).");

  const server = apiErrorFromBody({ error: "upstream exploded with PROMPT_SECRET" }, 502);
  assert.equal(server.message, "The request failed (HTTP 502).");
});

test("a provider 401 is not a session expiry", () => {
  const provider = {
    error: "The provider rejected the credentials.",
    code: "provider_auth",
    message: "The provider rejected the credentials.",
    retryable: false,
  };
  assert.equal(isSessionUnauthorized(401, "/threads/compact", provider), false);
  assert.equal(isSessionUnauthorized(401, "/threads", { error: "unauthorized" }), true);
  assert.equal(isSessionUnauthorized(401, "/auth/login", { error: "unauthorized" }), false);
  assert.equal(isSessionUnauthorized(500, "/threads", { error: "unauthorized" }), false);
});

test("api does not sign the user out on a provider_auth 401", async () => {
  const dispatched: string[] = [];
  (globalThis as unknown as { window?: { dispatchEvent: (event: Event) => boolean } }).window = {
    dispatchEvent: (event) => { dispatched.push(event.type); return true; },
  };
  try {
    globalThis.fetch = (async () => Response.json({
      error: "The provider rejected the credentials.",
      code: "provider_auth",
      message: "The provider rejected the credentials.",
      retryable: false,
    }, { status: 401 })) as typeof fetch;
    await assert.rejects(api("/threads"), (error: unknown) => error instanceof ApiError && error.code === "provider_auth");
    assert.deepEqual(dispatched, []);

    globalThis.fetch = (async () => Response.json({ error: "unauthorized" }, { status: 401 })) as typeof fetch;
    await assert.rejects(api("/threads"));
    assert.deepEqual(dispatched, ["okaychat:unauthorized"]);
  } finally {
    delete (globalThis as unknown as { window?: unknown }).window;
  }
});

test("a network failure and an abort become safe ApiErrors", async () => {
  globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  await assert.rejects(api("/threads"), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, "network");
    assert.equal(error.retryable, true);
    assert.equal(error.message, "Could not reach the service.");
    return true;
  });

  globalThis.fetch = (async () => { throw new DOMException("aborted", "AbortError"); }) as typeof fetch;
  await assert.rejects(api("/threads"), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, "aborted");
    assert.equal(error.retryable, false);
    return true;
  });
});

test("a real service outage signals a registry refresh, and the health request never refreshes itself", async () => {
  const dispatched: string[] = [];
  (globalThis as unknown as { window?: { dispatchEvent: (event: Event) => boolean } }).window = {
    dispatchEvent: (event) => { dispatched.push(event.type); return true; },
  };
  const wire = { error: "The speech worker is not reachable.", code: "service_unavailable", message: "The speech worker is not reachable.", retryable: true };
  try {
    const error = await responseError(Response.json(wire, { status: 503 }), "/speech/transcribe");
    assert.equal(error.code, "service_unavailable");
    assert.deepEqual(dispatched, ["okaychat:service-failed"], "a raw audio boundary still refreshes the registry");

    dispatched.length = 0;
    await responseError(Response.json(wire, { status: 503 }), "/services");
    await responseError(Response.json(wire, { status: 503 }), "/services?refresh=1");
    assert.deepEqual(dispatched, [], "the health request is not evidence and cannot loop");

    dispatched.length = 0;
    globalThis.fetch = (async () => Response.json({ services: [] })) as typeof fetch;
    await api("/services");
    assert.deepEqual(dispatched, [], "a successful health request raises nothing");
  } finally {
    delete (globalThis as unknown as { window?: unknown }).window;
  }
});

test("a non-OK chat response is turned into parseable wire text", async () => {
  const response = Response.json({ error: "Stopped.", code: "aborted", message: "Stopped.", retryable: false }, { status: 400 });
  const text = await structuredResponseError(response);
  assert.equal(parseChatError(text).code, "aborted");
  assert.equal(await structuredResponseError(Response.json({ ok: true })), undefined);
});

test("streamed errors parse from wire JSON, an Error wrapper, and nothing at all", () => {
  const text = JSON.stringify({ code: "timeout", message: "The provider took too long to respond.", retryable: true });
  assert.equal(parseChatError(text).code, "timeout");
  assert.equal(parseChatError(new Error(text)).code, "timeout");
  assert.equal(parseChatError({ code: "unknown", message: text }).code, "timeout");
  const fallback = parseChatError("raw provider text SECRET");
  assert.equal(fallback.code, "unknown");
  assert.equal(fallback.message, "Something went wrong.");
  assert.ok(!JSON.stringify(fallback).includes("SECRET"));
});

test("API consumers see catalog text for coded provider failures", () => {
  const error = apiErrorFromBody({ code: "provider_auth", message: "upstream text must not be shown", retryable: false }, 401);
  assert.equal(error.message, "The provider rejected the credentials.");
});
