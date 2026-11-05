import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { Hono } from "hono";
import type { ThreadSummary } from "../shared/types.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-threads-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "threads-test-secret-only-not-for-production";
writeFileSync(path.join(dataDir, "models-dev.json"), JSON.stringify({ data: {}, fetchedAt: Date.now() }));
const { db } = await import("./db.js");
const { sha256 } = await import("./crypto.js");
const { api } = await import("./routes.js");
const { appendMessage, getThread, listThreads } = await import("./threads.js");
const { startTestWorker } = await import("../browser/test-worker.js");
const worker = await startTestWorker();

const app = new Hono().route("/api", api);
for (const id of ["alice", "bob"]) {
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, `${id}@example.test`, id, "unused", "user", 1);
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(id), id, Date.now() + 600_000);
}
after(async () => {
  await worker.close();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const thread = (id: string, user: string, opts: { title?: string; status?: string; projectId?: string } = {}) =>
  db.prepare("INSERT INTO threads (id, user_id, project_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1000, 1000)")
    .run(id, user, opts.projectId ?? null, opts.title ?? null, opts.status ?? "regular");
beforeEach(() => {
  db.exec("DELETE FROM messages; DELETE FROM threads; DELETE FROM projects;");
  db.prepare("INSERT INTO projects (id, user_id, name, created_at) VALUES ('p_alice', 'alice', 'Atlas', 1)").run();
  db.prepare("INSERT INTO projects (id, user_id, name, created_at) VALUES ('p_bob', 'bob', 'Secret', 1)").run();
  thread("t1", "alice", { title: "Trip / plans: Ünïcode" });
  thread("t2", "alice", { status: "archived", projectId: "p_alice" });
  thread("t9", "bob");
});

const call = (url: string, init: { method?: string; json?: unknown; user?: string } = {}) =>
  app.request(`http://app/api${url}`, {
    method: init.method ?? "GET",
    headers: { cookie: `okaychat_session=${init.user ?? "alice"}`, ...(init.json !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
const patch = (id: string, json: unknown, user = "alice") => call(`/threads/${id}`, { method: "PATCH", json, user });
const ids = async (url: string) => ((await (await call(url)).json()) as ThreadSummary[]).map((t) => t.id).sort();

const store = (threadId: string, id: string, parent: string | null, role: "user" | "assistant", parts: unknown[]) =>
  appendMessage("alice", threadId, { id, parent_id: parent, format: "ai-sdk/v6", content: { role, parts } });

test("pin and project patches persist without moving the chat's last activity", async () => {
  assert.equal((await patch("t1", { pinned: true, projectId: "p_alice", title: "Renamed", status: "archived" })).status, 200);
  const t1 = getThread("alice", "t1")!;
  assert.deepEqual([t1.pinned, t1.projectId, t1.title, t1.status, t1.updatedAt], [true, "p_alice", "Renamed", "archived", 1000]);
  assert.equal((await patch("t1", { projectId: null, pinned: false })).status, 200);
  assert.deepEqual([getThread("alice", "t1")!.projectId, getThread("alice", "t1")!.pinned], [null, false]);
});

test("a foreign or missing project is rejected and leaves the chat unchanged", async () => {
  const response = await patch("t1", { projectId: "p_bob", pinned: true });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Project not found" });
  assert.deepEqual([getThread("alice", "t1")!.projectId, getThread("alice", "t1")!.pinned], [null, false]);
  assert.equal((await patch("t9", { pinned: true })).status, 404);
  assert.equal((await patch("t1", { pinned: "yes" })).status, 400);
});

test("appending a message still bumps last activity", () => {
  store("t1", "m1", null, "user", [{ type: "text", text: "hi" }]);
  assert.ok(getThread("alice", "t1")!.updatedAt > 1000);
});

test("the thread list filters by status, combined with project", async () => {
  assert.deepEqual(await ids("/threads"), ["t1", "t2"]);
  assert.deepEqual(await ids("/threads?status=regular"), ["t1"]);
  assert.deepEqual(await ids("/threads?status=archived"), ["t2"]);
  assert.deepEqual(await ids("/threads?status=archived&project=p_alice"), ["t2"]);
  assert.deepEqual(await ids("/threads?status=archived&project=none"), []);
  assert.equal((await call("/threads?status=deleted")).status, 400);
});

test("thread lists include all chats beyond 500, with ownership, ordering and filters intact", async () => {
  db.exec("BEGIN");
  try {
    for (let i = 0; i < 1200; i++) {
      thread(`bulk_${i}`, "alice", { projectId: "p_alice", status: i < 600 ? "regular" : "archived" });
      db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(2000 + i, `bulk_${i}`);
    }
    thread("foreign", "bob", { projectId: "p_bob" });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const list = await (await call("/threads")).json() as ThreadSummary[];
  assert.equal(list.length, 1202);
  assert.equal(list[0]!.id, "bulk_1199");
  assert.ok(list.every((row, i) => i === 0 || list[i - 1]!.updatedAt >= row.updatedAt));
  assert.ok(!list.some((row) => row.id === "foreign" || row.id === "t9"));
  assert.equal((await ids("/threads?project=p_alice&status=regular")).length, 600);
  assert.equal((await ids("/threads?project=p_alice&status=archived")).length, 601);
  assert.deepEqual(await ids("/threads?project=none"), ["t1"]);
});

test("a title regenerated without text comes from the stored user messages", async () => {
  store("t1", "m1", null, "user", [{ type: "text", text: '<attachment name="a.pdf" file_id="upl_1"></attachment>' }, { type: "text", text: "Plan a trip to Lisbon\nwith kids" }]);
  store("t1", "m2", "m1", "assistant", [{ type: "text", text: "Assistant words never title" }]);
  const response = await call("/threads/t1/title", { method: "POST", json: {} });
  assert.deepEqual(await response.json(), { title: "Plan a trip to Lisbon" });
  assert.equal(getThread("alice", "t1")!.title, "Plan a trip to Lisbon");
  assert.equal(getThread("alice", "t1")!.updatedAt > 1000, true, "appendMessage bumped it, not the title");
  assert.equal((await call("/threads/t9/title", { method: "POST", json: { text: "steal" } })).status, 404);
  assert.deepEqual(await (await call("/threads/tmp_x/title", { method: "POST", json: { text: "x" } })).json(), { title: "Temporary chat" });
});

test("markdown export contains the current branch's visible text only", async () => {
  store("t1", "m1", null, "user", [
    { type: "file", mediaType: "image/png", filename: "photo.png", url: "data:image/png;base64,AA==" },
    { type: "text", text: '<attachment name="photo.png" file_id="upl_1"></attachment>' },
    { type: "text", text: "What is this?" },
  ]);
  store("t1", "old", "m1", "assistant", [{ type: "text", text: "Abandoned branch" }]);
  store("t1", "m2", "m1", "assistant", [
    { type: "reasoning", text: "secret thoughts" },
    { type: "tool-web_search", toolCallId: "c1", state: "output-available", input: { query: "q" }, output: { results: [] } },
    { type: "data-progress", data: { step: 1 } },
    { type: "text", text: "A **cat**." },
  ]);
  const response = await call("/threads/t1/export?format=markdown");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.match(response.headers.get("content-disposition")!, /^attachment; filename="Trip plans Unicode\.md"; filename\*=UTF-8''Trip%20plans%20%C3%9C/);
  assert.equal(await response.text(), "# Trip / plans: Ünïcode\n\n## You\n\n_Image: photo.png_\n\nWhat is this?\n\n## Assistant\n\nA **cat**.\n");
});

test("export checks ownership, temporary ids, and the format", async () => {
  assert.equal((await call("/threads/t9/export?format=markdown")).status, 404);
  assert.equal((await call("/threads/tmp_x/export?format=markdown")).status, 400);
  assert.equal((await call("/threads/t1/export?format=docx")).status, 400);
  assert.equal((await call("/threads/t1/export")).status, 400);
});

test("pdf export prints through the shared renderer", { skip: !worker.available && "Chromium is not installed" }, async () => {
  store("t1", "m1", null, "user", [{ type: "text", text: "| a | b |\n| - | - |\n| 1 | 2 |\n\n```js\nconsole.log(1)\n```" }]);
  const response = await call("/threads/t1/export?format=pdf");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
});

test("branching copies the chain up to a message into a new chat and leaves the source alone", async () => {
  store("t1", "u1", null, "user", [{ type: "text", text: "first" }]);
  store("t1", "a1", "u1", "assistant", [{ type: "text", text: "answer" }]);
  store("t1", "a1b", "u1", "assistant", [{ type: "text", text: "other answer" }]);
  store("t1", "u2", "a1", "user", [{ type: "text", text: "second" }]);
  const res = await call("/threads/t1/branch", { method: "POST", json: { messageId: "a1", modelRef: "openai/gpt-x" } });
  assert.equal(res.status, 200);
  const fork = (await res.json()) as ThreadSummary;
  assert.notEqual(fork.id, "t1");
  assert.deepEqual([fork.title, fork.modelRef, fork.branchedFrom], ["Trip / plans: Ünïcode", "openai/gpt-x", { id: "t1", title: "Trip / plans: Ünïcode" }]);
  const rows = (await (await call(`/threads/${fork.id}/messages`)).json()) as Array<{ id: string; parent_id: string | null }>;
  assert.deepEqual(rows.map((r) => [r.id, r.parent_id]), [["u1", null], ["a1", "u1"]]);
  assert.equal(((await (await call("/threads/t1/messages")).json()) as unknown[]).length, 4);
  assert.equal((await call("/threads/t1/branch", { method: "POST", json: { messageId: "missing" } })).status, 404);
  assert.equal((await call("/threads/t1/branch", { method: "POST", json: { messageId: "a1" }, user: "bob" })).status, 404);
  await call("/threads/t1", { method: "DELETE" });
  assert.equal(getThread("alice", fork.id)!.branchedFrom, null);
});

test("message list returns stored JSON unchanged and hides other users' threads", async () => {
  const content = { role: "user", parts: [{ type: "text", text: "quote \" and Ünïcode  " }], metadata: { custom: { n: 1 } } };
  appendMessage("alice", "t1", { id: "m1", parent_id: null, format: "ai-sdk/v6", content });
  appendMessage("alice", "t1", { id: "m2", parent_id: "m1", format: "ai-sdk/v6", content: { role: "assistant", parts: [] } });
  const res = await call("/threads/t1/messages");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  assert.deepEqual(await res.json(), [
    { id: "m1", parent_id: null, format: "ai-sdk/v6", content },
    { id: "m2", parent_id: "m1", format: "ai-sdk/v6", content: { role: "assistant", parts: [] } },
  ]);
  assert.deepEqual(await (await call("/threads/t1/messages", { user: "bob" })).json(), []);
});

test("tags round-trip, never move the chat's activity, and copy to a fork", async () => {
  store("t1", "m1", null, "user", [{ type: "text", text: "hello" }]);
  const activity = getThread("alice", "t1")!.updatedAt;
  assert.equal((await patch("t1", { tags: ["Release Notes", "release notes", "bad/slash"] })).status, 400, "invalid text is refused, not silently dropped");
  assert.equal((await patch("t1", { tags: ["Release Notes", "release notes"] })).status, 200);
  const tagged = getThread("alice", "t1")!;
  assert.deepEqual(tagged.tags, ["release notes"]);
  assert.equal(tagged.updatedAt, activity, "tagging is metadata, not message activity");
  assert.deepEqual((await patch("t1", { tags: [] })).status, 200);
  assert.deepEqual(getThread("alice", "t1")!.tags, []);

  await patch("t1", { tags: ["release"] });
  const branch = (await (await call("/threads/t1/branch", { method: "POST", json: { messageId: "m1" } })).json()) as { id: string };
  assert.deepEqual(getThread("alice", branch.id)!.tags, ["release"]);
  // The fork's labels are its own.
  await patch(branch.id, { tags: ["fork"] });
  assert.deepEqual(getThread("alice", "t1")!.tags, ["release"]);
});

test("hidden comparison panes stay out of the sidebar and cannot be tagged", async () => {
  db.prepare("INSERT INTO comparison_groups (id, user_id, title, prompt, created_at, updated_at) VALUES ('g1', 'alice', 'Compare', 'Prompt', 1, 1)").run();
  db.prepare("UPDATE threads SET compare_group_id = 'g1' WHERE id = 't1'").run();
  assert.deepEqual((await ids("/threads")).includes("t1"), false);
  assert.deepEqual(listThreads("alice", undefined, undefined, { comparisonGroupId: "g1" }).map((thread) => thread.id), ["t1"]);
  assert.equal((await patch("t1", { tags: ["nope"] })).status, 400);
  assert.equal(getThread("alice", "t1")!.compareGroupId, "g1");
});
