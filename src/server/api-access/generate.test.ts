import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import type { AddressInfo } from "node:net";

import type { ModelInfo } from "../../shared/types.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-api-generate-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "api-generate-test-secret-not-for-production";

const { db } = await import("../db.js");
const { createModel } = await import("../llm.js");
const { generateCompletion, splitUtf8 } = await import("./generate.js");
const { withResponseBounds, ResponseLimitError } = await import("../response-bounds.js");
const store = await import("./store.js");

db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('alice', 'alice@example.test', 'alice', 'unused', 'admin', ?)").run(Date.now());

after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const table of ["api_requests", "usage"]) db.exec(`DELETE FROM ${table}`);
});

const info = {
  ref: "custom-fake/fake-model",
  providerId: "custom-fake",
  id: "fake-model",
  name: "Fake",
  format: "openai-chat" as const,
  context: 16_384,
  maxOutput: 1_024,
  reasoning: false,
  toolCall: false,
  attachments: false,
  inputModalities: ["text"],
  temperature: true,
  free: true,
} satisfies ModelInfo;

interface Fake {
  url: string;
  close: () => Promise<void>;
}

async function fakeProvider(respond: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<Fake> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => respond(req, res, body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

const sse = (res: ServerResponse, chunks: unknown[], extra = "") => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  if (extra) res.write(extra);
  res.write("data: [DONE]\n\n");
  res.end();
};

const textChunk = (content: string) => ({
  id: "chatcmpl-fake",
  object: "chat.completion.chunk",
  created: 1,
  model: "fake-model",
  choices: [{ index: 0, delta: { content }, finish_reason: null }],
});

const finishChunk = (reason: string, usage?: unknown) => ({
  id: "chatcmpl-fake",
  object: "chat.completion.chunk",
  created: 1,
  model: "fake-model",
  choices: [{ index: 0, delta: {}, finish_reason: reason }],
  ...(usage ? { usage } : {}),
});

const plan = (url: string, options: { stream: boolean; includeUsage?: boolean; maxOutputTokens?: number }) => {
  const conn = { providerId: "custom-fake", apiKey: "fake", baseURL: url, enabled: true };
  const model = { ...info, baseURL: url };
  const handle = createModel(model, conn, {
    userId: "alice",
    responseBounds: { maxBytes: 1024 * 1024, maxRecordBytes: 256 * 1024 },
  });
  return {
    userId: "alice",
    keyId: "key-a",
    requestId: "apr_generated",
    admittedAt: Date.now(),
    model,
    conn,
    handle,
    messages: handle.markCache(["", "You are a test."], [{ role: "user", content: "Hello" }]),
    maxOutputTokens: options.maxOutputTokens ?? 256,
    stream: options.stream,
    includeUsage: options.includeUsage ?? false,
    signal: new AbortController().signal,
    recheck: () => {},
  };
};

test("a buffered completion returns the exact public shape and records normalized usage", async () => {
  const fake = await fakeProvider((_req, res) =>
    sse(res, [
      textChunk("Hello"),
      textChunk(" world"),
      finishChunk("stop", { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, prompt_tokens_details: { cached_tokens: 1 }, completion_tokens_details: { reasoning_tokens: 0 } }),
    ]),
  );
  try {
    store.openApiRequest({ id: "apr_generated", userId: "alice", keyId: "key-a", modelRef: info.ref, stream: false });
    const response = await generateCompletion(plan(fake.url, { stream: false }));
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.object, "chat.completion");
    assert.equal(body.model, info.ref);
    assert.equal(body.id, "chatcmpl-generated");
    assert.deepEqual(body.choices, [{ index: 0, message: { role: "assistant", content: "Hello world" }, finish_reason: "stop", logprobs: null }]);
    assert.deepEqual(body.usage, {
      prompt_tokens: 5,
      completion_tokens: 2,
      total_tokens: 7,
      prompt_tokens_details: { cached_tokens: 1 },
      completion_tokens_details: { reasoning_tokens: 0 },
    });
    assert.equal(response.headers.get("cache-control"), "no-store");
    const row = store.apiRequestsPage("alice", { limit: 1 }).rows[0]!;
    assert.equal(row.state, "succeeded");
    assert.equal(row.usageState, "reported");
    assert.equal(row.finishReason, "stop");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM usage WHERE api_request_id = 'apr_generated'").get() as { n: number }).n, 1);
  } finally {
    await fake.close();
  }
});

test("streaming emits role, text, terminal, optional usage, and exactly one DONE", async () => {
  const fake = await fakeProvider((_req, res) =>
    sse(res, [
      textChunk("Héllo"),
      textChunk(" 😀\nworld"),
      finishChunk("stop", { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }),
    ]),
  );
  try {
    store.openApiRequest({ id: "apr_generated", userId: "alice", keyId: "key-a", modelRef: info.ref, stream: true });
    const response = await generateCompletion(plan(fake.url, { stream: true, includeUsage: true }));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
    const text = await response.text();
    assert.equal(text.endsWith("data: [DONE]\n\n"), true);
    assert.equal(text.split("data: [DONE]").length - 1, 1);
    const records = text.split("\n\n").filter((record) => record.startsWith("data: ") && record !== "data: [DONE]").map((record) => JSON.parse(record.slice(6)) as {
      choices: Array<{ delta: { role?: string; content?: string }; finish_reason: string | null }>;
      usage?: unknown;
    });
    assert.equal(records[0]!.choices[0]!.delta.role, "assistant");
    assert.equal(records.slice(1, 3).map((record) => record.choices[0]!.delta.content ?? "").join(""), "Héllo 😀\nworld");
    const terminal = records.find((record) => record.choices[0]!.finish_reason !== null)!;
    assert.equal(terminal.choices[0]!.finish_reason, "stop");
    assert.deepEqual(terminal.choices[0]!.delta, {});
    const usageRecord = records.at(-1)!;
    assert.deepEqual(usageRecord.choices, []);
    assert.deepEqual(usageRecord.usage, {
      prompt_tokens: 4,
      completion_tokens: 3,
      total_tokens: 7,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    });
    const row = store.apiRequestsPage("alice", { limit: 1 }).rows[0]!;
    assert.equal(row.state, "succeeded");
    assert.equal(row.stream, true);
  } finally {
    await fake.close();
  }
});

test("missing provider usage is null in the buffered body and in the usage chunk", async () => {
  const fake = await fakeProvider((_req, res) => sse(res, [textChunk("ok"), finishChunk("stop")]));
  try {
    store.openApiRequest({ id: "apr_generated", userId: "alice", keyId: "key-a", modelRef: info.ref, stream: false });
    const buffered = await generateCompletion(plan(fake.url, { stream: false }));
    assert.equal(((await buffered.json()) as { usage: unknown }).usage, null);
    const row = store.apiRequestsPage("alice", { limit: 1 }).rows[0]!;
    assert.equal(row.usageState, "unknown");
    assert.equal(row.usage, null);
    assert.equal(row.cost, null);
  } finally {
    await fake.close();
  }
});

test("a provider tool call fails as unsupported_output instead of a successful tools finish", async () => {
  const fake = await fakeProvider((_req, res) =>
    sse(res, [
      {
        id: "chatcmpl-fake",
        object: "chat.completion.chunk",
        created: 1,
        model: "fake-model",
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "x", arguments: "{}" } }] }, finish_reason: null }],
      },
      finishChunk("tool_calls"),
    ]),
  );
  try {
    store.openApiRequest({ id: "apr_generated", userId: "alice", keyId: "key-a", modelRef: info.ref, stream: false });
    const response = await generateCompletion(plan(fake.url, { stream: false }));
    assert.equal(response.status, 502);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, "unsupported_output");
    const row = store.apiRequestsPage("alice", { limit: 1 }).rows[0]!;
    assert.equal(row.state, "failed");
    assert.equal(row.errorCode, "unsupported_output");
  } finally {
    await fake.close();
  }
});

test("response bounds reject an endless record and a byte overflow, cancelling the source", async () => {
  let cancelled = false;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(1_024)));
    },
    cancel() {
      cancelled = true;
    },
  });
  const base = (async () => new Response(endless, { status: 200 })) as typeof fetch;
  const bounded = withResponseBounds(base, { maxBytes: 1024 * 1024, maxRecordBytes: 2_048 });
  const response = await bounded("http://fake");
  await assert.rejects(async () => {
    const reader = response.body!.getReader();
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
    }
  }, (error: unknown) => error instanceof ResponseLimitError);
  assert.equal(cancelled, true);

  let totalCancelled = false;
  let count = 0;
  const many = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode(`line ${count++}\n`));
    },
    cancel() {
      totalCancelled = true;
    },
  });
  const boundedTotal = withResponseBounds((async () => new Response(many, { status: 200 })) as typeof fetch, { maxBytes: 512, maxRecordBytes: 128 });
  const second = await boundedTotal("http://fake");
  await assert.rejects(async () => {
    const reader = second.body!.getReader();
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
    }
  }, (error: unknown) => error instanceof ResponseLimitError);
  assert.equal(totalCancelled, true);
});

test("UTF-8 pieces never split a code point and stay under the cap", () => {
  const text = "a😀b".repeat(4_000);
  const pieces = splitUtf8(text, 1_024);
  assert.ok(pieces.every((piece) => Buffer.byteLength(piece, "utf8") <= 1_024));
  assert.equal(pieces.join(""), text);
});

test("post-header provider failures emit one error without a finish or DONE", async () => {
  const fake = await fakeProvider((_req, res) => sse(res, [textChunk("partial"), finishChunk("tool_calls")]));
  try {
    store.openApiRequest({ id: "apr_generated", userId: "alice", keyId: "key-a", modelRef: info.ref, stream: true });
    const response = await generateCompletion(plan(fake.url, { stream: true }));
    const text = await response.text();
    assert.match(text, /"code":"unsupported_output"/);
    assert.equal(text.includes("[DONE]"), false);
    assert.equal(text.includes('"finish_reason":"stop"'), false);
    assert.equal(store.apiRequestsPage("alice", { limit: 1 }).rows[0]!.state, "failed");
  } finally {
    await fake.close();
  }
});

for (const mode of ["cancel", "abort", "stalled"] as const) {
  test(`${mode} consumer aborts the provider and releases the live registration`, async (t) => {
    let closed!: () => void;
    const disconnected = new Promise<void>((resolve) => { closed = resolve; });
    const fake = await fakeProvider((_req, res) => {
      res.on("close", closed);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify(textChunk("first"))}\n\n`);
    });
    try {
      store.openApiRequest({ id: "apr_generated", userId: "alice", keyId: "key-a", modelRef: info.ref, stream: true });
      const controller = new AbortController();
      let released = 0;
      if (mode === "stalled") t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
      const response = await generateCompletion({ ...plan(fake.url, { stream: true }), signal: controller.signal, onDone: () => { released++; } });
      if (mode === "cancel") await response.body!.cancel();
      else if (mode === "abort") controller.abort();
      else {
        t.mock.timers.tick(31_000);
        t.mock.timers.reset();
      }
      await Promise.race([disconnected, new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("provider was not cancelled")), 2_000);
        timer.unref();
      })]);
      assert.equal(released, 1);
      const { liveApiCallCount } = await import("./limits.js");
      assert.equal(liveApiCallCount(), 0);
      assert.notEqual(store.apiRequestsPage("alice", { limit: 1 }).rows[0]!.state, "running");
    } finally {
      await fake.close();
    }
  });
}

test("fresh-database HTTP smoke: session management, bearer models/completions, and revocation", async () => {
  const { Hono } = await import("hono");
  const { serve } = await import("@hono/node-server");
  const { csrf } = await import("hono/csrf");
  const { bodyLimit } = await import("hono/body-limit");
  const { requireUser } = await import("../auth.js");
  const { sha256 } = await import("../crypto.js");
  const { saveConnection } = await import("../catalog/providers.js");
  const { apiKeyRoutes, inferenceRoutes } = await import("./routes.js");
  const { handleAppError } = await import("../errors.js");
  const fake = await fakeProvider((req, res) => {
    if (req.url === "/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "fake-model" }] }));
    } else sse(res, [textChunk("smoke ok"), finishChunk("stop", { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 })]);
  });
  saveConnection("alice", "custom-fake", { baseURL: fake.url, apiKey: "fake", enabled: true });
  db.prepare("INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,'alice',?)").run(sha256("smoke-session"), Date.now() + 60_000);
  const app = new Hono()
    .use("/api/*", bodyLimit({ maxSize: 100 * 1024 * 1024 }))
    .use("/api/*", csrf())
    .use("/api/*", requireUser)
    .route("/api", apiKeyRoutes)
    .route("/v1", inferenceRoutes)
    .onError(handleAppError);
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const created = await fetch(`${url}/api/api-keys`, { method: "POST", headers: { cookie: "okaychat_session=smoke-session", "content-type": "application/json" }, body: JSON.stringify({ label: "Smoke", scopes: ["models:read", "chat:write"], expiresAt: null }) });
    assert.equal(created.status, 201);
    const key = await created.json() as { secret: string; key: { id: string } };
    const headers = { authorization: `Bearer ${key.secret}`, "content-type": "application/json" };
    assert.equal((await fetch(`${url}/v1/models`, { headers: { cookie: "okaychat_session=smoke-session" } })).status, 401);
    assert.equal((await fetch(`${url}/api/api-keys`, { headers })).status, 401);
    const duplicateStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${url}/v1/models`, { headers: { authorization: [headers.authorization, "Bearer invalid"] } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      request.on("error", reject);
      request.end();
    });
    assert.equal(duplicateStatus, 401);
    const models = await fetch(`${url}/v1/models`, { headers });
    assert.equal(models.status, 200);
    assert.match(await models.text(), /custom-fake\/fake-model/);
    for (const stream of [false, true]) {
      const response = await fetch(`${url}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify({ model: info.ref, messages: [{ role: "user", content: "hello" }], stream }) });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.ok(response.headers.get("x-request-id"));
      const body = await response.text();
      assert.match(body, /smoke ok/);
      if (stream) assert.match(body, /data: \[DONE\]\n\n$/);
    }
    const listed = await fetch(`${url}/api/api-keys`, { headers: { cookie: "okaychat_session=smoke-session" } });
    assert.equal((await listed.text()).includes(key.secret), false);
    assert.equal((await fetch(`${url}/api/api-keys/${key.key.id}`, { method: "DELETE", headers: { cookie: "okaychat_session=smoke-session", origin: url } })).status, 200);
    assert.equal((await fetch(`${url}/v1/models`, { headers })).status, 401);
    assert.equal((db.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT count(*) AS n FROM usage WHERE kind='api' AND api_key_id=? AND api_request_id IS NOT NULL").get(key.key.id) as { n: number }).n, 2);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fake.close();
  }
});
