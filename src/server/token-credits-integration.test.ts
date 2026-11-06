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
const { creditRoutes, resetCreditRouteLimits } = await import("./credits/routes.js");
const { adminRoutes } = await import("./admin.js");
const { createEmbedder } = await import("./knowledge/embeddings.js");
const { generateImage } = await import("./tools/image.js");
const { transcribe } = await import("./speech/engines.js");
const { withUnmeteredRoot } = await import("./credits/admission.js");

const ADMIN = "credit-admin";
const ALICE = "alice";
const BOB = "bob";

for (const [id, role] of [[ADMIN, "admin"], [ALICE, "admin"], [BOB, "user"]] as const) {
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
for (const [user, token] of [[ADMIN, "admin-session"], [BOB, "bob-session"]] as const) {
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(token), user, Date.now() + 600_000);
}
saveConnection(ALICE, "custom-test", { baseURL: "http://mock.test/v1" });
saveConnection(ALICE, "openai", { apiKey: "test-key" });
updateSettings(ALICE, { maxSteps: 1, maxSearches: 0, webTools: false, artifacts: false, generativeUI: false, subagents: false, autoCompactAt: 0 });

const app = new Hono().use(requireUser).route("/", chatRoutes).route("/", scheduleRoutes).route("/", creditRoutes).route("/", adminRoutes).onError(handleAppError);
const inference = new Hono().route("/v1", inferenceRoutes).onError(handleAppError);

after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetCreditRouteLimits();
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

test("a finite chat is debited its reported tokens and the next turn is refused", async (t) => {
  provider(t);
  grant(ALICE, 10);
  ensureThread(ALICE, "thr_debit");
  const first = await chatRequest("thr_debit");
  assert.equal(first.status, 200);
  await first.text();
  const balance = getCreditBalance(ALICE);
  assert.equal(balance.consumedTokens, 15, "input plus output, overshoot allowed for the admitted turn");
  assert.equal(balance.remainingTokens, 0);
  assert.equal(balance.status, "exhausted");
  assert.equal(balance.activeOperations, 0);
  const second = await chatRequest("thr_debit");
  assert.equal(second.status, 403);
  assert.equal(((await second.json()) as { code: string }).code, "token_credit_exhausted");
  assert.equal(providerCalls, 1);
});

const session = (token: string) => ({ cookie: `okaychat_session=${token}`, "content-type": "application/json" });
const uuid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("credit routes: own balance, admin set/reset/audit, CAS conflicts and non-admin denial", async () => {
  const own = await app.request("http://app/credits", { headers: session("bob-session") });
  assert.equal(own.status, 200);
  assert.equal(own.headers.get("cache-control"), "no-store");
  const unlimited = (await own.json()) as { creditTokens: number | null; status: string };
  assert.equal(unlimited.creditTokens, null);
  assert.equal(unlimited.status, "unlimited");

  const denied = await app.request(`http://app/admin/users/${ADMIN}/credits`, { headers: session("bob-session") });
  assert.equal(denied.status, 403);
  const deniedWrite = await app.request(`http://app/admin/users/${BOB}/credits`, {
    method: "PATCH", headers: session("bob-session"),
    body: JSON.stringify({ creditTokens: 0, expectedVersion: 1, mutationId: uuid(1), reason: "self" }),
  });
  assert.equal(deniedWrite.status, 403);

  const before = (await (await app.request(`http://app/admin/users/${BOB}/credits`, { headers: session("admin-session") })).json()) as { version: number };
  const extra = await app.request(`http://app/admin/users/${BOB}/credits`, {
    method: "PATCH", headers: session("admin-session"),
    body: JSON.stringify({ creditTokens: 100, expectedVersion: before.version, mutationId: uuid(2), reason: "grant", extra: 1 }),
  });
  assert.equal(extra.status, 400, "unknown keys are refused");
  const omitted = await app.request(`http://app/admin/users/${BOB}/credits`, {
    method: "PATCH", headers: session("admin-session"),
    body: JSON.stringify({ expectedVersion: before.version, mutationId: uuid(3), reason: "grant" }),
  });
  assert.equal(omitted.status, 400, "omission never clears a limit");

  const set = await app.request(`http://app/admin/users/${BOB}/credits`, {
    method: "PATCH", headers: session("admin-session"),
    body: JSON.stringify({ creditTokens: 100, expectedVersion: before.version, mutationId: uuid(4), reason: "grant" }),
  });
  assert.equal(set.status, 200);
  const { balance } = (await set.json()) as { balance: { creditTokens: number; version: number; remainingTokens: number } };
  assert.equal(balance.creditTokens, 100);
  assert.equal(balance.remainingTokens, 100);

  const stale = await app.request(`http://app/admin/users/${BOB}/credits`, {
    method: "PATCH", headers: session("admin-session"),
    body: JSON.stringify({ creditTokens: 50, expectedVersion: before.version, mutationId: uuid(5), reason: "stale" }),
  });
  assert.equal(stale.status, 409);
  assert.equal(((await stale.json()) as { code: string }).code, "conflict");

  const held = admitCreditRoot(BOB, "chat");
  try {
    const busy = await app.request(`http://app/admin/users/${BOB}/credits/reset`, {
      method: "POST", headers: session("admin-session"),
      body: JSON.stringify({ expectedVersion: balance.version, mutationId: uuid(6), reason: "reset", acknowledgeUnknown: false }),
    });
    assert.equal(busy.status, 409);
    assert.equal(((await busy.json()) as { code: string }).code, "token_credit_busy");
  } finally {
    closeCreditRoot(held);
  }
  const reset = await app.request(`http://app/admin/users/${BOB}/credits/reset`, {
    method: "POST", headers: session("admin-session"),
    body: JSON.stringify({ expectedVersion: balance.version, mutationId: uuid(7), reason: "reset", acknowledgeUnknown: false }),
  });
  assert.equal(reset.status, 200);
  const afterReset = ((await reset.json()) as { balance: { creditTokens: number; consumedTokens: number; period: number } }).balance;
  assert.equal(afterReset.creditTokens, 100, "reset keeps the allowance");
  assert.equal(afterReset.consumedTokens, 0);

  const page = await app.request(`http://app/admin/users/${BOB}/credits/audit?limit=1`, { headers: session("admin-session") });
  assert.equal(page.status, 200);
  const first = (await page.json()) as { rows: Array<{ id: number; action: string; actorId: string }>; nextCursor: number | null };
  assert.equal(first.rows.length, 1);
  assert.equal(first.rows[0]!.action, "reset");
  assert.equal(first.rows[0]!.actorId, ADMIN);
  assert.notEqual(first.nextCursor, null);
  const next = (await (await app.request(`http://app/admin/users/${BOB}/credits/audit?limit=1&before=${first.nextCursor}`, { headers: session("admin-session") })).json()) as { rows: Array<{ action: string }>; nextCursor: number | null };
  assert.deepEqual(next.rows.map((row) => row.action), ["set"]);
  assert.equal(next.nextCursor, null);
  const badCursor = await app.request(`http://app/admin/users/${BOB}/credits/audit?before=-1`, { headers: session("admin-session") });
  assert.equal(badCursor.status, 400);

  const selfView = (await (await app.request("http://app/credits", { headers: session("bob-session") })).json()) as Record<string, unknown>;
  assert.equal(selfView.creditTokens, 100);
  assert.ok(!("reason" in selfView) && !JSON.stringify(selfView).includes("grant"), "the self view carries no audit reasons");

  const list = (await (await app.request("http://app/admin/users", { headers: session("admin-session") })).json()) as Array<{ id: string; tokenCredits: { creditTokens: number | null } }>;
  assert.equal(list.find((user) => user.id === BOB)?.tokenCredits.creditTokens, 100);
  assert.equal(list.find((user) => user.id === ADMIN)?.tokenCredits.creditTokens, null);

  const missing = await app.request("http://app/admin/users/nobody/credits", { headers: session("admin-session") });
  assert.equal(missing.status, 404);
});

test("finite accounts are refused unpriced services before any network or CLI call", async (t) => {
  provider(t);
  grant(ALICE, 1_000);
  const embedder = createEmbedder(ALICE, { provider: "openai", model: "text-embedding-3-small" })!;
  await assert.rejects(embedder.embed(["hello"]), (error: { code?: string }) => error.code === "token_credit_unmetered");
  await assert.rejects(
    generateImage({ userId: ALICE, threadId: "thr_img", service: { def: { credential: "codex", name: "Codex" }, model: null } as never, prompt: "a cat", references: [] }),
    (error: { code?: string }) => error.code === "token_credit_unmetered",
  );
  await assert.rejects(
    transcribe(ALICE, { audio: new Uint8Array(8), mime: "audio/webm", filename: "a.webm" }, { engine: "openai" } as never),
    (error: { code?: string }) => error.code === "token_credit_unmetered",
  );
  assert.equal(providerCalls, 0);
  assert.equal(getCreditBalance(ALICE).activeOperations, 0);

  // Unlimited unpriced work holds a nonexclusive root while it runs, so the allowance cannot change under it.
  grant(ALICE, null);
  await withUnmeteredRoot(ALICE, "mcp", async () => {
    assert.equal(getCreditBalance(ALICE).activeOperations, 1);
    const balance = getCreditBalance(ALICE);
    assert.throws(() => mutateCreditAccount(ADMIN, ALICE, { action: "set", creditTokens: 5, expectedVersion: balance.version, mutationId: uuid(99), reason: "during work" }),
      (error: { code?: string }) => error.code === "token_credit_busy");
  });
  assert.equal(getCreditBalance(ALICE).activeOperations, 0);
});
