import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { N8nAgentConfig } from "../../shared/n8n-agents.js";
import { AppError, toWireError } from "../errors.js";
import { BlockedAddressError } from "../public-fetch.js";
import { agentRequest } from "./transport.js";

// Section 11.4 of the n8n agents spec. Every request goes through an injected fetch seam: these
// tests never touch DNS or the network, and no real endpoint, header value, or body is printed.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const config = (overrides: Partial<N8nAgentConfig> = {}): N8nAgentConfig => ({
  webhookUrl: "https://agent.example/webhook/chat",
  protocol: "webhook",
  memoryMode: "none",
  inputKey: "message",
  sessionKey: "sessionId",
  historyKey: "history",
  responseMode: "auto",
  responsePointer: null,
  timeoutMs: 120_000,
  idleTimeoutMs: 60_000,
  authHeader: null,
  ...overrides,
});

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function fakeFetch(handler: (url: string, init: RequestInit) => Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return handler(String(input), init ?? {});
  }) as typeof fetch;
  return { fetch, calls };
}

const json = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": "application/json", ...headers } });

/** An error response whose body must be cancelled by the transport, never parsed. */
function errorWithBody(status: number, body: string, headers: Record<string, string> = {}) {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { response: new Response(stream, { status, headers }), cancelled: () => cancelled };
}

/** A body the test releases chunk by chunk; abort errors it so a pending read rejects. */
function controllable(chunks: Uint8Array[]) {
  let index = 0;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let cancelled = false;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    pull(value) {
      if (index < chunks.length) value.enqueue(chunks[index++]!);
      else return new Promise<void>(() => {});
    },
    cancel() {
      cancelled = true;
      closed = true;
    },
  });
  return {
    stream,
    wasCancelled: () => cancelled,
    wasClosed: () => closed,
    fail(reason: unknown) {
      closed = true;
      try {
        controller?.error(reason);
      } catch {
        // Already closed.
      }
    },
  };
}

function respondWith(init: RequestInit, chunks: Uint8Array[]) {
  const body = controllable(chunks);
  init.signal?.addEventListener("abort", () => body.fail(init.signal?.reason), { once: true });
  return new Response(body.stream, { status: 200, headers: { "content-type": "application/json" } });
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof AppError, `expected an AppError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the transport to reject");
}

function assertNoSecrets(error: AppError, secrets: string[]) {
  const wire = JSON.stringify(toWireError(error));
  for (const secret of secrets) {
    assert.ok(!error.message.includes(secret), `message leaked ${secret}`);
    assert.ok(!(error.hint ?? "").includes(secret), `hint leaked ${secret}`);
    assert.ok(!wire.includes(secret), `wire leaked ${secret}`);
  }
}

const enableTimers = (t: TestContext) => t.mock.timers.enable({ apis: ["setTimeout"] });

// ---------------------------------------------------------------------------------------------
// HTTP status mapping

test("401 and 403 map to agent_auth, not an app session failure", async () => {
  for (const status of [401, 403]) {
    const { response, cancelled } = errorWithBody(status, "SECRET_UPSTREAM");
    const fake = fakeFetch(async () => response);
    const error = await rejection(agentRequest(config(), "{}", { fetch: fake.fetch }));
    assert.equal(error.code, "agent_auth");
    assert.equal(error.status, 502);
    assert.equal(error.retryable, false);
    assert.equal(fake.calls.length, 1);
    assert.equal(cancelled(), true);
    assertNoSecrets(error, ["SECRET_UPSTREAM", "agent.example"]);
  }
});

test("404 and 410 map to agent_response/inactive", async () => {
  for (const status of [404, 410]) {
    const fake = fakeFetch(async () => json("missing", status));
    const error = await rejection(agentRequest(config(), "{}", { fetch: fake.fetch }));
    assert.equal(error.code, "agent_response");
    assert.equal(error.agentReason, "inactive");
    assert.equal(fake.calls.length, 1);
  }
});

test("a redirect is rejected without following it and without resending the body", async () => {
  const { response, cancelled } = errorWithBody(302, "moved", { location: "https://other.example/hijack" });
  const fake = fakeFetch(async () => response);
  const error = await rejection(agentRequest(config({ authHeader: { name: "Authorization", value: "Bearer SECRET_TOKEN" } }), "{\"message\":\"hi\"}", { fetch: fake.fetch }));
  assert.equal(error.code, "agent_response");
  assert.equal(error.agentReason, "redirect");
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]?.init.redirect, "manual");
  assert.equal(cancelled(), true);
  assertNoSecrets(error, ["SECRET_TOKEN", "other.example", "agent.example"]);
});

test("429 maps to a bounded Retry-After and never repeats the request", async () => {
  const cases: Array<[string | null, number | undefined]> = [
    ["2", 2000],
    ["0", 0],
    ["99999", 3_600_000],
    ["soon", undefined],
  ];
  for (const [header, expected] of cases) {
    const fake = fakeFetch(async () => json("slow down", 429, header === null ? {} : { "retry-after": header }));
    const error = await rejection(agentRequest(config(), "{}", { fetch: fake.fetch }));
    assert.equal(error.code, "rate_limited");
    assert.equal(error.retryable, false);
    assert.equal(error.retryAfterMs, expected, String(header));
    assert.equal(fake.calls.length, 1);
  }
});

test("408 and 504 map to timeout; other 4xx and 5xx map to agent_failed", async () => {
  for (const status of [408, 504]) {
    const fake = fakeFetch(async () => json("", status));
    const error = await rejection(agentRequest(config(), "{}", { fetch: fake.fetch }));
    assert.equal(error.code, "timeout", String(status));
    assert.equal(error.retryable, false);
  }
  for (const status of [400, 409, 418, 500, 502, 503]) {
    const fake = fakeFetch(async () => json("SECRET_UPSTREAM", status));
    const error = await rejection(agentRequest(config(), "{}", { fetch: fake.fetch }));
    assert.equal(error.code, "agent_failed", String(status));
    assert.equal(fake.calls.length, 1);
    assertNoSecrets(error, ["SECRET_UPSTREAM"]);
  }
});

test("a spoofed error body cannot reach the wire error or the message", async () => {
  const body = JSON.stringify({ code: "provider_auth", message: "SECRET_PROMPT", apiKey: "SECRET_KEY", hint: "SECRET_HINT" });
  const fake = fakeFetch(async () => json(body, 500));
  const error = await rejection(agentRequest(config(), "{}", { fetch: fake.fetch }));
  assert.equal(error.code, "agent_failed");
  assertNoSecrets(error, ["SECRET_PROMPT", "SECRET_KEY", "SECRET_HINT"]);
});

// ---------------------------------------------------------------------------------------------
// Request construction and validation

test("the configured auth header is sent once and never appears in errors", async () => {
  const fake = fakeFetch(async () => json("denied", 401));
  const error = await rejection(agentRequest(config({ authHeader: { name: "X-API-Key", value: "SUPER_SECRET_VALUE" } }), "{}", { fetch: fake.fetch }));
  assert.equal(fake.calls.length, 1);
  const headers = fake.calls[0]?.init.headers as Record<string, string>;
  assert.equal(headers["X-API-Key"], "SUPER_SECRET_VALUE");
  assert.equal(headers["Content-Type"], "application/json");
  assert.match(String(headers.Accept), /application\/x-ndjson/);
  assert.equal(fake.calls[0]?.init.method, "POST");
  assert.equal(fake.calls[0]?.init.body, "{}");
  assert.equal(fake.calls[0]?.init.redirect, "manual");
  assertNoSecrets(error, ["SUPER_SECRET_VALUE", "agent.example"]);
});

test("invalid headers and oversized bodies are refused before any POST", async () => {
  const cases: Array<Partial<N8nAgentConfig>> = [
    { authHeader: { name: "Host", value: "evil" } },
    { authHeader: { name: "Cookie", value: "a=b" } },
    { authHeader: { name: "X-Forwarded-For", value: "1.2.3.4" } },
    { authHeader: { name: "Authorization", value: "Bearer\nInjected" } },
    { authHeader: { name: "Authorization", value: "a\u0000b" } },
  ];
  for (const overrides of cases) {
    const fake = fakeFetch(async () => json("", 200));
    const error = await rejection(agentRequest(config(overrides), "{}", { fetch: fake.fetch }));
    assert.equal(error.code, "validation", JSON.stringify(overrides.authHeader));
    assert.equal(fake.calls.length, 0);
  }
  const fake = fakeFetch(async () => json("", 200));
  const error = await rejection(agentRequest(config(), "x".repeat(512 * 1024 + 1), { fetch: fake.fetch }));
  assert.equal(error.code, "validation");
  assert.equal(fake.calls.length, 0);
});

test("an unsafe destination is refused before the body or credential is forwarded", async () => {
  for (const webhookUrl of ["http://agent.example/hook", "https://user:pass@agent.example/hook", "https://agent.example/hook#fragment", "ftp://agent.example/hook"]) {
    const fake = fakeFetch(async () => json("", 200));
    const error = await rejection(agentRequest(config({ webhookUrl }), "{}", { fetch: fake.fetch }));
    assert.equal(error.code, "validation", webhookUrl);
    assert.equal(fake.calls.length, 0);
  }
});

test("beforePost runs immediately before the single POST and can veto it", async () => {
  const fake = fakeFetch(async () => json("ok"));
  let before = 0;
  const response = await agentRequest(config(), "{}", {
    fetch: fake.fetch,
    beforePost: () => {
      before++;
    },
  });
  assert.equal(before, 1);
  assert.equal(fake.calls.length, 1);
  await response.body?.cancel();

  const vetoed = fakeFetch(async () => json("ok"));
  const error = await rejection(agentRequest(config(), "{}", { fetch: vetoed.fetch, beforePost: () => { throw new AppError({ code: "forbidden" }); } }));
  assert.equal(error.code, "forbidden");
  assert.equal(vetoed.calls.length, 0);
});

// ---------------------------------------------------------------------------------------------
// Network failures

test("DNS and connection failures map to network with no retry", async () => {
  const fake = fakeFetch(async () => {
    throw new TypeError("fetch failed: getaddrinfo ENOTFOUND SECRET_HOST");
  });
  const error = await rejection(agentRequest(config(), "{}", { fetch: fake.fetch }));
  assert.equal(error.code, "network");
  assert.equal(error.retryable, false);
  assert.equal(fake.calls.length, 1);
  assertNoSecrets(error, ["SECRET_HOST", "agent.example"]);
});

test("a blocked private address maps to forbidden without echoing the URL", async () => {
  const fake = fakeFetch(async () => {
    throw new BlockedAddressError("Only public internet addresses are allowed.");
  });
  const error = await rejection(agentRequest(config(), "{}", { fetch: fake.fetch }));
  assert.equal(error.code, "forbidden");
  assert.equal(fake.calls.length, 1);
  assertNoSecrets(error, ["agent.example", "127.0.0.1"]);
});

// ---------------------------------------------------------------------------------------------
// Deadlines (fake clock)

test("the total timeout covers waiting for response headers", async (t) => {
  enableTimers(t);
  let aborted = false;
  const fake = fakeFetch(async (_url, init) => {
    init.signal?.addEventListener("abort", () => { aborted = true; });
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  });
  const pending = agentRequest(config({ timeoutMs: 5000, idleTimeoutMs: 5000 }), "{}", { fetch: fake.fetch });
  t.mock.timers.tick(4999);
  assert.equal(aborted, false);
  t.mock.timers.tick(1);
  const error = await rejection(pending);
  assert.equal(error.code, "timeout");
  assert.equal(error.retryable, false);
  assert.equal(aborted, true);
  assert.equal(fake.calls.length, 1);
});

test("the idle timeout fires only after a gap and resets on received bytes", async (t) => {
  enableTimers(t);
  let aborted = false;
  const fake = fakeFetch(async (_url, init) => {
    const response = respondWith(init, [encoder.encode("one"), encoder.encode("two")]);
    init.signal?.addEventListener("abort", () => { aborted = true; });
    return response;
  });
  const response = await agentRequest(config({ timeoutMs: 100_000, idleTimeoutMs: 5000 }), "{}", { fetch: fake.fetch });
  const reader = response.body!.getReader();
  assert.equal(decoder.decode((await reader.read()).value), "one");

  t.mock.timers.tick(4000);
  assert.equal(aborted, false);
  assert.equal(decoder.decode((await reader.read()).value), "two");
  t.mock.timers.tick(4999);
  assert.equal(aborted, false);
  t.mock.timers.tick(1);
  assert.equal(aborted, true);
  const error = await rejection(reader.read());
  assert.equal(error.code, "timeout");
  assert.equal(fake.calls.length, 1);
});

test("the total timeout also stops a stream that keeps sending bytes", async (t) => {
  enableTimers(t);
  let aborted = false;
  const fake = fakeFetch(async (_url, init) => {
    const response = respondWith(init, [encoder.encode("first"), encoder.encode("second")]);
    init.signal?.addEventListener("abort", () => { aborted = true; });
    return response;
  });
  const response = await agentRequest(config({ timeoutMs: 10_000, idleTimeoutMs: 9000 }), "{}", { fetch: fake.fetch });
  const reader = response.body!.getReader();
  assert.equal(decoder.decode((await reader.read()).value), "first");
  t.mock.timers.tick(5000);
  assert.equal(decoder.decode((await reader.read()).value), "second");
  t.mock.timers.tick(4999);
  assert.equal(aborted, false);
  t.mock.timers.tick(1);
  const error = await rejection(reader.read());
  assert.equal(error.code, "timeout");
});

// ---------------------------------------------------------------------------------------------
// Cancellation and cleanup

test("cancelling the returned stream without an external signal closes the upstream body", async (t) => {
  enableTimers(t);
  let upstream: ReturnType<typeof controllable> | null = null;
  const fake = fakeFetch(async (_url, init) => {
    upstream = controllable([encoder.encode("one"), encoder.encode("two")]);
    init.signal?.addEventListener("abort", () => upstream?.fail(init.signal?.reason), { once: true });
    return new Response(upstream.stream, { headers: { "content-type": "application/json" } });
  });
  const response = await agentRequest(config({ timeoutMs: 100_000, idleTimeoutMs: 50_000 }), "{}", { fetch: fake.fetch });
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(upstream!.wasClosed(), true);
  // The deadlines are cleared; ticking past them changes nothing and does not POST again.
  t.mock.timers.tick(200_000);
  assert.equal(fake.calls.length, 1);
});

test("an external abort while a read is pending rejects aborted and closes upstream", async (t) => {
  enableTimers(t);
  const controller = new AbortController();
  let upstream: ReturnType<typeof controllable> | null = null;
  const fake = fakeFetch(async (_url, init) => {
    upstream = controllable([encoder.encode("one")]);
    init.signal?.addEventListener("abort", () => upstream?.fail(init.signal?.reason), { once: true });
    return new Response(upstream.stream, { headers: { "content-type": "application/json" } });
  });
  const response = await agentRequest(config(), "{}", { fetch: fake.fetch, signal: controller.signal });
  const reader = response.body!.getReader();
  await reader.read();
  const pending = reader.read();
  controller.abort();
  const error = await rejection(pending);
  assert.equal(error.code, "aborted");
  assert.equal(upstream!.wasClosed(), true);
  assert.equal(fake.calls.length, 1);
});

test("an external abort while the consumer is not reading aborts the upstream fetch", async (t) => {
  enableTimers(t);
  const controller = new AbortController();
  let upstreamAborted = false;
  const fake = fakeFetch(async (_url, init) => {
    init.signal?.addEventListener("abort", () => { upstreamAborted = true; }, { once: true });
    return json("");
  });
  const response = await agentRequest(config(), "{}", { fetch: fake.fetch, signal: controller.signal });
  controller.abort();
  assert.equal(upstreamAborted, true);
  const error = await rejection(response.body!.getReader().read());
  assert.equal(error.code, "aborted");
  assert.equal(fake.calls.length, 1);
});

test("an external abort while the request is connecting rejects aborted with one POST", async (t) => {
  enableTimers(t);
  const controller = new AbortController();
  const fake = fakeFetch(async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  }));
  const pending = agentRequest(config(), "{}", { fetch: fake.fetch, signal: controller.signal });
  controller.abort();
  const error = await rejection(pending);
  assert.equal(error.code, "aborted");
  assert.equal(fake.calls.length, 1);
});

test("an external abort before the POST forwards no body or credential", async (t) => {
  enableTimers(t);
  const controller = new AbortController();
  controller.abort();
  const fake = fakeFetch(async () => json(""));
  const error = await rejection(agentRequest(config({ authHeader: { name: "Authorization", value: "Bearer SECRET" } }), "{\"message\":\"hi\"}", { fetch: fake.fetch, signal: controller.signal }));
  assert.equal(error.code, "aborted");
  assert.equal(fake.calls.length, 0);
  assertNoSecrets(error, ["SECRET"]);
});

test("a 204 response has no body and clears its deadlines", async (t) => {
  enableTimers(t);
  const fake = fakeFetch(async () => new Response(null, { status: 204 }));
  const response = await agentRequest(config({ timeoutMs: 5000, idleTimeoutMs: 5000 }), "{}", { fetch: fake.fetch });
  assert.equal(response.status, 204);
  assert.equal(response.body, null);
  t.mock.timers.tick(10_000);
  assert.equal(fake.calls.length, 1);
});
