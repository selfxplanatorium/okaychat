import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test, type TestContext } from "node:test";
import { Hono } from "hono";

// Route-level credit enforcement on the shared fixtures: admission before any provider dispatch, the
// finite-account busy rule, external API rejection before SSE headers, schedule skipping without
// touching chat history, and unchanged unlimited behaviour.

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-credit-integration-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "credit-integration-test-secret-not-for-production";
writeFileSync(path.join(dataDir, "models-dev.json"), JSON.stringify({ data: {}, fetchedAt: Date.now() }));

const { db } = await import("./db.js");
const { saveConnection } = await import("./catalog/providers.js");
const { updateSettings } = await import("./settings.js");
const { ensureThread, currentBranch } = await import("./threads.js");
const { requireUser } = await import("./auth.js");
const { sha256 } = await import("./crypto.js");
const { chatRoutes } = await import("./chat.js");
const { runSchedule, scheduleRoutes } = await import("./schedules.js");
const { inferenceRoutes } = await import("./api-access/routes.js");
const { handleAppError } = await import("./errors.js");
const { createApiKey } = await import("./api-access/keys.js");
const { admitCreditRoot, closeCreditRoot, ensureCreditAccount, getCreditBalance, mutateCreditAccount } = await import("./credits/store.js");

const ADMIN = "credit-admin";
const ALICE = "alice";

for (const [id, role] of [[ADMIN, "admin"], [ALICE, "admin"]] as const) {
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, 'unused', ?, 1)").run(
    id,
    `${id}@example.test`,
    id,
    role,
  );
}
db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(
  sha256("alice-session"),
  ALICE,
  Date.now() + 600_000,
);
saveConnection(ALICE, "custom-test", { baseURL: "http://mock.test/v1" });
updateSettings(ALICE, { maxSteps: 1, maxSearches: 0, webTools: false, artifacts: false, generativeUI: false, subagents: false, autoCompactAt: 0 });

const app = new Hono().use(requireUser).route("/", chatRoutes).route("/", scheduleRoutes).onError(handleAppError);
const inference = new Hono().route("/v1", inferenceRoutes).onError(handleAppError);

after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec(
    `DELETE FROM token_credit_requests;
     DELETE FROM token_credit_roots;
     DELETE FROM token_credit_audit;
     DELETE FROM schedules;
     DELETE FROM messages;
     DELETE FROM threads;
     DELETE FROM usage;
     DELETE FROM api_requests;
     DELETE FROM api_keys;
     UPDATE token_credit_accounts SET credit_tokens = NULL, consumed_tokens = 0, unknown_requests = 0,
       period = period + 1, period_started_at = 1, version = version + 1;`,
  );
});

let mutationSeq = 0;
function grant(userId: string, creditTokens: number | null) {
  ensureCreditAccount(userId);
  const balance = getCreditBalance(userId);
  mutationSeq += 1;
  return mutateCreditAccount(ADMIN, userId, {
    action: creditTokens === null ? "clear" : "set",
    ...(creditTokens === null ? {} : { creditTokens }),
    expectedVersion: balance.version,
    mutationId: `00000000-0000-4000-8000-${String(mutationSeq).padStart(12, "0")}`,
    reason: "integration fixture",
  });
}

let providerCalls = 0;
function provider(t: TestContext) {
  providerCalls = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "http://mock.test/v1/models") return Response.json({ data: [{ id: "mock" }] });
    assert.equal(url, "http://mock.test/v1/chat/completions", `unexpected request to ${url}`);
    providerCalls += 1;
    const stream = JSON.parse(String(init?.body ?? "{}")).stream === true;
    const chunks = [
      { id: "r", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: null }] },
      { id: "r", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ];
    if (!stream) {
      return Response.json({
        id: "r",
        object: "chat.completion",
        created: 1,
        model: "mock",
        choices: [{ index: 0, message: { role: "assistant", content: "Done." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    }
    return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    });
  });
}

const chatBody = (threadId: string) => ({
  id: threadId,
  config: { modelName: "custom-test/mock" },
  messages: [{ id: "user-1", role: "user", parts: [{ type: "text", text: "Hello" }] }],
});
const chatRequest = (threadId: string) =>
  app.request("http://app/chat", {
    method: "POST",
    headers: { cookie: "okaychat_session=alice-session", "content-type": "application/json" },
    body: JSON.stringify(chatBody(threadId)),
  });

test("a zero allowance rejects the chat route before any provider dispatch", async (t) => {
  provider(t);
  grant(ALICE, 0);
  ensureThread(ALICE, "thr_zero");

  const response = await chatRequest("thr_zero");
  assert.equal(response.status, 403);
  const error = (await response.json()) as { code?: string };
  assert.equal(error.code, "token_credit_exhausted");
  assert.equal(providerCalls, 0, "no upstream request happens without an admitted root");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n, 0);
  assert.equal(currentBranch(ALICE, "thr_zero").length, 0);
});

test("a finite account with an active operation is busy instead of starting a second one", async (t) => {
  provider(t);
  grant(ALICE, 1_000);
  ensureThread(ALICE, "thr_busy");
  const held = admitCreditRoot(ALICE, "chat");
  try {
    const response = await chatRequest("thr_busy");
    assert.equal(response.status, 409);
    const body = (await response.json()) as { error?: { code?: string }; code?: string };
    assert.equal(body.error?.code ?? body.code, "token_credit_busy");
    assert.equal(providerCalls, 0);
  } finally {
    closeCreditRoot(held);
  }
});

test("the external API rejects a streaming request before SSE headers and before a receipt", async (t) => {
  provider(t);
  grant(ALICE, 0);
  const { secret } = createApiKey(ALICE, { label: "Integration", scopes: ["chat:write"], expiresAt: null });

  const response = await inference.request("http://app/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "custom-test/mock", messages: [{ role: "user", content: "Hello" }], stream: true }),
  });

  assert.equal(response.status, 403);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const text = await response.text();
  assert.ok(!text.startsWith("data:"), "a pre-stream refusal is JSON, never an SSE role frame");
  const body = JSON.parse(text) as { error: { code: string; type: string } };
  assert.equal(body.error.code, "token_credit_exhausted");
  assert.equal(body.error.type, "permission_error");
  assert.equal(providerCalls, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM api_requests").get() as { n: number }).n, 0);
});

test("an exhausted scheduled occurrence is skipped before a thread or prompt is written", async (t) => {
  provider(t);
  grant(ALICE, 0);
  const created = await app.request("http://app/schedules", {
    method: "POST",
    headers: { cookie: "okaychat_session=alice-session", "content-type": "application/json" },
    body: JSON.stringify({
      title: "Brief",
      prompt: "Say hi",
      modelRef: "custom-test/mock",
      spec: { kind: "interval", minutes: 60, timeZone: "UTC" },
    }),
  });
  assert.equal(created.status, 200, await created.clone().text());
  const { id } = (await created.json()) as { id: string };

  const row = db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as Parameters<typeof runSchedule>[0];
  await runSchedule(row);

  const after = db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as {
    thread_id: string | null;
    last_error: string | null;
    next_run_at: number | null;
  };
  assert.equal(after.thread_id, null, "a denied occurrence never creates or attaches a chat");
  assert.match(after.last_error ?? "", /allowance is exhausted/i);
  assert.ok((after.next_run_at ?? 0) > Date.now(), "the next occurrence is still calculated");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM threads").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n, 0);
  assert.equal(providerCalls, 0);
});

test("unlimited accounts keep their old concurrency and are metered per invocation", async (t) => {
  provider(t);
  grant(ALICE, null);
  ensureThread(ALICE, "thr_unlimited");

  // Unlimited accounts are not exclusive, so two roots may overlap as before.
  const first = admitCreditRoot(ALICE, "chat");
  const second = admitCreditRoot(ALICE, "chat");
  try {
    assert.equal(getCreditBalance(ALICE).activeOperations, 2);
  } finally {
    closeCreditRoot(first);
    closeCreditRoot(second);
  }

  const response = await chatRequest("thr_unlimited");
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(providerCalls, 1);
  assert.equal(getCreditBalance(ALICE).activeOperations, 0, "the turn releases its root when the stream ends");
  const usage = db.prepare("SELECT kind, input_tokens AS input, output_tokens AS output FROM usage WHERE user_id = ?").all(ALICE) as Array<{
    kind: string;
    input: number;
    output: number;
  }>;
  assert.equal(usage.length, 1);
  assert.equal(usage[0]!.kind, "chat");
  assert.equal(usage[0]!.input, 10);
  assert.equal(usage[0]!.output, 5);
});
