import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test, type TestContext } from "node:test";
import { Hono } from "hono";
import type { UIMessage } from "ai";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-chat-compare-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "chat-compare-test-secret-only-not-for-production";
writeFileSync(path.join(dataDir, "models-dev.json"), JSON.stringify({ data: {}, fetchedAt: Date.now() }));
const { db } = await import("./db.js");
const { sha256 } = await import("./crypto.js");
const { saveConnection } = await import("./catalog/providers.js");
const { updateSettings } = await import("./settings.js");
const { ensureThread } = await import("./threads.js");
const { api } = await import("./routes.js");

db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('alice', 'alice@example.test', 'Alice', 'unused', 'admin', 1)").run();
db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256("alice"), "alice", Date.now() + 600_000);
saveConnection("alice", "custom-test", { baseURL: "http://mock.test/v1" });
updateSettings("alice", { maxSteps: 1, maxSearches: 0, webTools: false, artifacts: false, generativeUI: false, subagents: false, autoCompactAt: 0 });
const app = new Hono().route("/api", api);
after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function seedPane(threadId = "pane1") {
  db.prepare("INSERT INTO comparison_groups (id, user_id, title, prompt, created_at, updated_at) VALUES ('g1', 'alice', 'Compare', 'Question', 1, 1)").run();
  db.prepare("INSERT INTO threads (id, user_id, title, model_ref, compare_group_id, created_at, updated_at) VALUES (?, 'alice', 'Pane', 'custom-test/mock', 'g1', 1, 1)").run(threadId);
  db.prepare("INSERT INTO comparison_panes (group_id, thread_id, position, model_ref) VALUES ('g1', ?, 0, 'custom-test/mock')").run(threadId);
  return threadId;
}

beforeEach(() => {
  db.exec("DELETE FROM comparison_panes; DELETE FROM comparison_groups; DELETE FROM messages; DELETE FROM threads");
});

function provider(t: TestContext, options: { status?: number } = {}) {
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "http://mock.test/v1/models") return Response.json({ data: [{ id: "mock" }] });
    if (url !== "http://mock.test/v1/chat/completions") throw new Error(`unexpected fetch ${url}`);
    if (options.status) return new Response("provider exploded", { status: options.status });
    const chunks = [
      { id: "mock-response", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta: { role: "assistant", content: "Pane answer." }, finish_reason: null }] },
      { id: "mock-response", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ];
    return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  });
}

const user = (id = "u1", text = "Which is better?"): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });

async function ask(threadId: string, messages: UIMessage[], signal?: AbortSignal) {
  const response = await app.request("http://app/api/chat", {
    method: "POST",
    headers: { cookie: "okaychat_session=alice", "content-type": "application/json" },
    body: JSON.stringify({ id: threadId, messages, config: { modelName: "custom-test/mock" } }),
    signal,
  });
  return response;
}

const drain = async (response: Response) => {
  const text = await response.text();
  await new Promise((resolve) => setTimeout(resolve, 30));
  return text;
};

const stored = (threadId: string) =>
  db.prepare("SELECT id, parent_id, content FROM messages WHERE thread_id = ? ORDER BY created_at, rowid").all(threadId) as Array<{ id: string; parent_id: string | null; content: string }>;

test("a pane turn stores its user message and the final reply with the right parent", async (t) => {
  provider(t);
  const threadId = seedPane();
  const response = await ask(threadId, [user()]);
  assert.equal(response.status, 200);
  const body = await drain(response);
  assert.match(body, /Pane answer/);

  const rows = stored(threadId);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.id)[1]?.startsWith("msg_") || rows[1]!.id.length > 0, true);
  assert.equal(JSON.parse(rows[0]!.content).role, "user");
  assert.equal(JSON.parse(rows[1]!.content).role, "assistant");
  assert.match(rows[1]!.content, /Pane answer/);
  assert.equal(rows[1]!.parent_id, "u1");
  assert.equal(rows[0]!.parent_id, null);
  // The reply comes from the provider stream, never from the echoed client request.
  assert.doesNotMatch(rows[1]!.content, /"id"/);
});

test("resending the same user message does not duplicate or re-parent it", async (t) => {
  provider(t);
  const threadId = seedPane();
  await drain(await ask(threadId, [user()]));
  const before = stored(threadId);
  await drain(await ask(threadId, [user()]));
  const after = stored(threadId);
  assert.equal(after.filter((row) => row.id === "u1").length, 1);
  assert.equal(JSON.parse(after[0]!.content).role, "user");
  assert.equal(after[0]!.parent_id, before[0]!.parent_id);
  // The assistant id differs between runs only if the provider sends another id; the row count stays one user.
  assert.ok(after.length >= 2);
});

test("a failed turn keeps the user message so Retry works", async (t) => {
  provider(t, { status: 500 });
  const threadId = seedPane();
  const response = await ask(threadId, [user()]);
  await response.text().catch(() => "");
  const rows = stored(threadId);
  assert.deepEqual(rows.map((row) => row.id), ["u1"]);
  assert.equal(JSON.parse(rows[0]!.content).role, "user");
});

test("an aborted pane stores no partial reply", async (t) => {
  provider(t);
  const threadId = seedPane();
  const controller = new AbortController();
  const response = await ask(threadId, [user()], controller.signal);
  controller.abort();
  await response.text().catch(() => "");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const rows = stored(threadId);
  assert.deepEqual(rows.map((row) => row.id), ["u1"]);
});

test("a normal chat is still persisted only by its client", async (t) => {
  provider(t);
  ensureThread("alice", "normal");
  const response = await ask("normal", [user("n1")]);
  await drain(response);
  assert.deepEqual(stored("normal"), []);
});
