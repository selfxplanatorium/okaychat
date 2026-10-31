import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, test } from "node:test";
import type { ModelInfo } from "../shared/types.js";
import type { Connection } from "./catalog/providers.js";

// llm.ts pulls in the catalog and env, so the retry tests set up an isolated data directory first.
const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-retry-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "retry-test-secret-only-not-for-production";
const { generateText } = await import("ai");
const { createModel } = await import("./llm.js");
const { computeRetryDelay, createRetryingFetch, PROVIDER_RETRY_POLICY, sleep } = await import("./retry.js");
const { db } = await import("./db.js");

after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const ok = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
const status = (code: number, headers: Record<string, string> = {}, body = "{}") =>
  new Response(body, { status: code, headers: { "content-type": "application/json", ...headers } });

test("delay grows exponentially, is capped, jittered, and respects a bounded Retry-After", () => {
  assert.equal(computeRetryDelay(1, undefined, () => 0), 800);
  assert.equal(computeRetryDelay(1, undefined, () => 1), 1_200);
  assert.equal(computeRetryDelay(2, undefined, () => 0), 1_600);
  assert.equal(computeRetryDelay(3, undefined, () => 0), null);
  assert.equal(computeRetryDelay(1, 4_000, () => 0), 4_000);
  assert.equal(computeRetryDelay(1, 30_001, () => 0), null);
  assert.equal(computeRetryDelay(1, undefined, () => 1, { ...PROVIDER_RETRY_POLICY, maxDelayMs: 900 }), 900);
});

test("a wait rejects as soon as the caller aborts", async () => {
  const controller = new AbortController();
  const waiting = sleep(60_000, controller.signal);
  controller.abort();
  await assert.rejects(waiting, (error: { name?: string }) => error.name === "AbortError");
});

test("a 429 then a success waits, reports one retry, and clears the notice", async () => {
  const waits: number[] = [];
  const notices: unknown[] = [];
  let calls = 0;
  const fake = async () => (++calls === 1 ? status(429, { "retry-after": "2" }) : ok());
  const wrapper = createRetryingFetch({
    fetchImpl: fake as typeof fetch,
    sleep: async (ms) => { waits.push(ms); },
    onRetry: (notice) => notices.push(notice),
  });
  const response = await wrapper("https://provider.test/v1/chat/completions", { method: "POST", body: "{}" });
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [2_000]);
  assert.deepEqual(notices, [
    { attempt: 1, delayMs: 2_000, code: "provider_rate_limit" },
    { attempt: 0, delayMs: 0, code: "unknown", status: "done" },
  ]);
});

test("permanent statuses are never retried", async () => {
  for (const code of [400, 401, 402, 403, 404, 413, 422]) {
    let calls = 0;
    const wrapper = createRetryingFetch({ fetchImpl: (async () => { calls++; return status(code); }) as typeof fetch, sleep: async () => {} });
    const response = await wrapper("https://provider.test/v1/chat/completions", { method: "POST", body: "{}" });
    assert.equal(response.status, code);
    assert.equal(calls, 1, `HTTP ${code}`);
  }
});

test("a quota refusal served as 429 is not retried", async () => {
  let calls = 0;
  const body = JSON.stringify({ error: { message: "You exceeded your current quota", code: "insufficient_quota" } });
  const wrapper = createRetryingFetch({ fetchImpl: (async () => { calls++; return status(429, {}, body); }) as typeof fetch, sleep: async () => {} });
  const response = await wrapper("https://provider.test/v1/chat/completions", { method: "POST", body: "{}" });
  assert.equal(response.status, 429);
  assert.equal(calls, 1);
});

test("three attempts cap a repeatedly overloaded provider", async () => {
  const waits: number[] = [];
  let calls = 0;
  const wrapper = createRetryingFetch({
    fetchImpl: (async () => { calls++; return status(503); }) as typeof fetch,
    sleep: async (ms) => { waits.push(ms); },
    random: () => 0.5,
  });
  const response = await wrapper("https://provider.test/v1/chat/completions", { method: "POST", body: "{}" });
  assert.equal(response.status, 503);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1_000, 2_000]);
});

test("network failures retry, but an aborted wait stops immediately", async () => {
  let calls = 0;
  const wrapper = createRetryingFetch({
    fetchImpl: (async () => {
      calls++;
      if (calls < 3) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
      return ok();
    }) as typeof fetch,
    sleep: async () => {},
    random: () => 0.5,
  });
  assert.equal((await wrapper("https://provider.test/v1/chat/completions", { method: "POST", body: "{}" })).status, 200);
  assert.equal(calls, 3);

  const controller = new AbortController();
  let abortedCalls = 0;
  const aborting = createRetryingFetch({
    fetchImpl: (async () => { abortedCalls++; throw new TypeError("fetch failed"); }) as typeof fetch,
    sleep: async () => {
      controller.abort();
      throw new DOMException("The request was stopped.", "AbortError");
    },
  });
  await assert.rejects(aborting("https://provider.test/v1/chat/completions", { method: "POST", body: "{}", signal: controller.signal }), (error: { name?: string }) => error.name === "AbortError");
  assert.equal(abortedCalls, 1);
});

test("a non-replayable request body is never retried", async () => {
  let calls = 0;
  const body = new ReadableStream({ start(controller) { controller.close(); } });
  const wrapper = createRetryingFetch({ fetchImpl: (async () => { calls++; return status(503); }) as typeof fetch, sleep: async () => {} });
  const response = await wrapper("https://provider.test/v1/chat/completions", { method: "POST", body });
  assert.equal(response.status, 503);
  assert.equal(calls, 1);
});

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("the model factory uses the retrying provider boundary", async () => {
  const model: ModelInfo = {
    ref: "mock/model",
    providerId: "mock",
    id: "model",
    name: "Mock",
    format: "openai-chat",
    baseURL: "https://provider.test/v1",
    context: 8_192,
    maxOutput: 1_000,
    reasoning: false,
    toolCall: false,
    attachments: false,
    inputModalities: ["text"],
    temperature: true,
    free: true,
  };
  const conn: Connection = { providerId: "mock", apiKey: "test-key", enabled: true };
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) return status(429, { "retry-after": "1" }, JSON.stringify({ error: { message: "slow down", type: "rate_limit_exceeded" } }));
    return Response.json({
      id: "completion-1",
      object: "chat.completion",
      created: 1,
      model: "model",
      choices: [{ index: 0, message: { role: "assistant", content: "recovered" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  }) as typeof fetch;
  const handle = createModel(model, conn, { userId: "user", retry: { sleep: async () => {}, random: () => 0.5 } });
  const result = await generateText({ model: handle.model, prompt: "hello", maxRetries: 0, providerOptions: handle.providerOptions });
  assert.equal(result.text, "recovered");
  assert.equal(calls, 2);
});
