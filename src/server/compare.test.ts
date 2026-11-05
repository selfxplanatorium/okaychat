import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test, type TestContext } from "node:test";
import { Hono } from "hono";
import type { ComparisonGroupSummary, ComparisonPaneDetail } from "../shared/compare.js";
import type { ThreadSummary } from "../shared/types.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-compare-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "compare-test-secret-only-not-for-production";
writeFileSync(path.join(dataDir, "models-dev.json"), JSON.stringify({ data: {}, fetchedAt: Date.now() }));
const { db } = await import("./db.js");
const { sha256 } = await import("./crypto.js");
const { saveConnection } = await import("./catalog/providers.js");
const { appendMessage, ensureThread, getThread } = await import("./threads.js");
const { searchMessages } = await import("./search.js");
const { markBusy } = await import("./thread-runs.js");
const { api } = await import("./routes.js");

for (const id of ["alice", "bob"]) {
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, `${id}@example.test`, id, "unused", "admin", 1);
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(id), id, Date.now() + 600_000);
  saveConnection(id, "custom-test", { baseURL: "http://mock.test/v1" });
}
const app = new Hono().route("/api", api);
after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => {
  db.exec("DELETE FROM comparison_panes; DELETE FROM comparison_groups; DELETE FROM messages; DELETE FROM artifacts; DELETE FROM threads");
});

/** A catalog answer for the custom connection; group creation never calls a model. */
const mocked = new WeakSet<TestContext>();
function catalog(t: TestContext) {
  if (mocked.has(t)) return;
  mocked.add(t);
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "http://mock.test/v1/models") return Response.json({ data: [{ id: "mock-a" }, { id: "mock-b" }, { id: "mock-c" }] });
    throw new Error(`unexpected fetch ${url}`);
  });
}

const call = (url: string, init: { method?: string; json?: unknown; user?: string } = {}) =>
  app.request(`http://app/api${url}`, {
    method: init.method ?? "GET",
    headers: { cookie: `okaychat_session=${init.user ?? "alice"}`, ...(init.json !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });

const refs = (...ids: string[]) => ids.map((id) => ({ ref: `custom-test/${id}` }));

async function makeGroup(t: TestContext, models = refs("mock-a", "mock-b"), extra: Record<string, unknown> = {}) {
  catalog(t);
  const response = await call("/compare", { method: "POST", json: { prompt: "Which answer is better?", models, ...extra } });
  return { response, body: (await response.json()) as { group: ComparisonGroupSummary; panes: ComparisonPaneDetail[] } };
}

test("a comparison creates hidden pane chats with their own models", async (t) => {
  const { response, body } = await makeGroup(t);
  assert.equal(response.status, 201);
  assert.equal(body.group.paneCount, 2);
  assert.equal(body.group.prompt, "Which answer is better?");
  assert.equal(body.panes.length, 2);
  assert.deepEqual(body.panes.map((pane) => pane.modelRef), ["custom-test/mock-a", "custom-test/mock-b"]);
  for (const pane of body.panes) {
    const thread = getThread("alice", pane.threadId)!;
    assert.equal(thread.compareGroupId, body.group.id);
    assert.equal(thread.modelRef, pane.modelRef);
  }
  // Hidden everywhere the sidebar, the archive selector, and the schedule picker look.
  const listed = (await (await call("/threads")).json()) as ThreadSummary[];
  assert.deepEqual(listed, []);
  // Pane text never reaches the spotlight.
  appendMessage("alice", body.panes[0]!.threadId, { id: "p1", parent_id: null, format: "ai-sdk/v6", content: { role: "assistant", parts: [{ type: "text", text: "quasar relay" }] } });
  assert.deepEqual(searchMessages("alice", "quasar"), []);

  // Three panes are allowed.
  const three = await makeGroup(t, refs("mock-a", "mock-b", "mock-c"));
  assert.equal(three.response.status, 201);
  assert.equal(three.body.panes.length, 3);
});

test("model choices are validated before any write", async (t) => {
  catalog(t);
  assert.equal((await call("/compare", { method: "POST", json: { prompt: "x", models: refs("mock-a", "mock-a") } })).status, 400);
  assert.equal((await call("/compare", { method: "POST", json: { prompt: "x", models: refs("mock-a") } })).status, 400);
  assert.equal((await call("/compare", { method: "POST", json: { prompt: "x", models: refs("mock-a", "mock-b", "mock-c", "mock-a") } })).status, 400);
  assert.equal((await call("/compare", { method: "POST", json: { prompt: "", models: refs("mock-a", "mock-b") } })).status, 400);
  assert.equal((await call("/compare", { method: "POST", json: { prompt: "x", models: [{ ref: "n8n/missing" }, { ref: "custom-test/mock-b" }] } })).status, 400);
  assert.equal((await call("/compare", { method: "POST", json: { prompt: "x", models: refs("custom-test/missing", "mock-b") } })).status, 400);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM comparison_groups").get() as { n: number }).n, 0);
});

test("starting from a chat copies its branch and artifacts into every pane", async (t) => {
  ensureThread("alice", "source");
  appendMessage("alice", "source", { id: "s1", parent_id: null, format: "ai-sdk/v6", content: { role: "user", parts: [{ type: "text", text: "Shared history" }] } });
  appendMessage("alice", "source", {
    id: "s2",
    parent_id: "s1",
    format: "ai-sdk/v6",
    content: {
      role: "assistant",
      parts: [
        { type: "text", text: "Shared answer" },
        { type: "tool-create_artifact", toolName: "create_artifact", state: "output-available", output: { id: "art", title: "Doc", kind: "markdown", version: 1 } },
      ],
    },
  });
  db.prepare("INSERT INTO artifacts (thread_id, id, version, title, kind, language, content, created_at, data, size) VALUES ('source', 'art', 1, 'Doc', 'markdown', NULL, 'Body', 1, x'', 0)").run();
  const { response, body } = await makeGroup(t, refs("mock-a", "mock-b"), { sourceThreadId: "source" });
  assert.equal(response.status, 201);
  for (const pane of body.panes) {
    assert.deepEqual(pane.messages.map((message) => message.id), ["s1", "s2"]);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE thread_id = ?").get(pane.threadId) as { n: number }).n, 1);
  }
  assert.equal(body.group.sourceThreadId, "source");
});

test("the group cap refuses more work until an old comparison is deleted", async (t) => {
  catalog(t);
  for (let index = 0; index < 20; index++) {
    db.prepare("INSERT INTO comparison_groups (id, user_id, title, prompt, created_at, updated_at) VALUES (?, 'alice', 'Old', 'Prompt', 1, 1)").run(`g${index}`);
  }
  const response = await call("/compare", { method: "POST", json: { prompt: "x", models: refs("mock-a", "mock-b") } });
  assert.equal(response.status, 409);
  assert.match(((await response.json()) as { error: string }).error, /Delete an old comparison/);
});

test("promoting a pane leaves a normal chat, and the last two panes end the group", async (t) => {
  const { body } = await makeGroup(t, refs("mock-a", "mock-b", "mock-c"));
  const first = body.panes[0]!;
  const promoted = await call(`/compare/${body.group.id}/panes/${first.threadId}/promote`, { method: "POST" });
  assert.equal(promoted.status, 200);
  const result = (await promoted.json()) as { thread: ThreadSummary; group: ComparisonGroupSummary | null };
  assert.equal(result.thread.id, first.threadId);
  assert.equal(getThread("alice", first.threadId)!.compareGroupId, null);
  assert.equal(result.group?.paneCount, 2);

  const second = body.panes[1]!;
  const ended = (await (await call(`/compare/${body.group.id}/panes/${second.threadId}/promote`, { method: "POST" })).json()) as {
    thread: ThreadSummary;
    group: ComparisonGroupSummary | null;
  };
  assert.equal(ended.group, null);
  assert.equal(getThread("alice", body.panes[2]!.threadId)!.compareGroupId, null);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM comparison_groups").get() as { n: number }).n, 0);
  // Both promoted and remaining panes are ordinary sidebar chats now.
  const listed = (await (await call("/threads")).json()) as ThreadSummary[];
  assert.equal(listed.length, 3);
});

test("a busy pane refuses promotion and deletion", async (t) => {
  const { body } = await makeGroup(t);
  const release = markBusy(body.panes[0]!.threadId);
  assert.equal((await call(`/compare/${body.group.id}/panes/${body.panes[0]!.threadId}/promote`, { method: "POST" })).status, 409);
  assert.equal((await call(`/compare/${body.group.id}`, { method: "DELETE" })).status, 409);
  release();
  assert.equal((await call(`/compare/${body.group.id}`, { method: "DELETE" })).status, 200);
});

test("deleting a comparison removes its pane chats, messages, and rows", async (t) => {
  const { body } = await makeGroup(t);
  appendMessage("alice", body.panes[0]!.threadId, { id: "p1", parent_id: null, format: "ai-sdk/v6", content: { role: "user", parts: [{ type: "text", text: "Answer me" }] } });
  assert.equal((await call(`/compare/${body.group.id}`, { method: "DELETE" })).status, 200);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM comparison_groups").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM comparison_panes").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM threads").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n, 0);
});

test("every route is owner-scoped", async (t) => {
  const { body } = await makeGroup(t);
  assert.equal((await call(`/compare/${body.group.id}`, { user: "bob" })).status, 404);
  assert.equal((await call(`/compare/${body.group.id}/panes/${body.panes[0]!.threadId}/promote`, { method: "POST", user: "bob" })).status, 404);
  assert.equal((await call(`/compare/${body.group.id}`, { method: "DELETE", user: "bob" })).status, 404);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM comparison_groups").get() as { n: number }).n, 1);
});
