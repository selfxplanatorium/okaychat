import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { Hono } from "hono";
import type { Note, NotePage, NoteSummary } from "../shared/notes.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-notes-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "notes-test-secret-only-not-for-production";
process.env.OKAYCHAT_STORAGE_LIMIT = "10000000";
writeFileSync(path.join(dataDir, "models-dev.json"), JSON.stringify({ data: {}, fetchedAt: Date.now() }));

const { db } = await import("./db.js");
const { sha256 } = await import("./crypto.js");
const { api } = await import("./routes.js");
const { ensureThread } = await import("./threads.js");
const { storageUsed } = await import("./quota.js");
const { createNote, getNote, updateNote, deleteNote } = await import("./notes/store.js");

const app = new Hono().route("/api", api);
after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const UUID = "11111111-1111-4111-8111-111111111111";
const UUID2 = "22222222-2222-4222-8222-222222222222";

const call = (url: string, init: { method?: string; json?: unknown; user?: string } = {}) =>
  app.request(`http://app/api${url}`, {
    method: init.method ?? "GET",
    headers: { cookie: `okaychat_session=${init.user ?? "alice"}`, ...(init.json !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
const json = async <T>(res: Response) => (await res.json()) as T;

const write = (over: Partial<{ title: string; body: string; favorite: boolean; pinned: boolean; tags: string[]; projectId: string | null }> = {}) => ({
  title: "Plan",
  body: "First line\nSecond line",
  favorite: false,
  pinned: false,
  tags: ["work", "ideas"],
  projectId: null,
  ...over,
});

beforeEach(() => {
  db.exec("DELETE FROM notes; DELETE FROM note_tags; DELETE FROM permission_policies; DELETE FROM projects; DELETE FROM artifacts; DELETE FROM messages; DELETE FROM threads; UPDATE users SET storage_limit = NULL");
  for (const id of ["alice", "bob"]) {
    db.prepare("INSERT OR IGNORE INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, `${id}@example.test`, id, "unused", "user", 1);
    db.prepare("INSERT OR IGNORE INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(id), id, Date.now() + 600_000);
  }
  db.prepare("INSERT INTO projects (id, user_id, name, instructions, created_at) VALUES ('p1', 'alice', 'Project', '', 1)").run();
  ensureThread("alice", "t1", "p1");
  db.prepare("INSERT INTO threads (id, user_id, created_at, updated_at) VALUES ('t2', 'alice', 1, 1)").run();
  db.prepare("INSERT INTO threads (id, user_id, created_at, updated_at) VALUES ('t3', 'bob', 1, 1)").run();
});

test("notes round trip, normalize tags, and charge only their own bytes", async () => {
  const before = storageUsed("alice");
  const res = await call("/notes", { method: "POST", json: { ...write({ title: "  Café  ", body: "Héllo\nworld", tags: ["Work", " work ", "ideas"] }), requestId: UUID } });
  assert.equal(res.status, 201, await res.clone().text());
  const { note } = await json<{ note: Note }>(res);
  assert.equal(note.title, "Café");
  assert.equal(note.body, "Héllo\nworld");
  assert.deepEqual(note.tags, ["ideas", "work"]);
  assert.equal(note.favorite, false);
  assert.equal(note.pinned, false);
  assert.equal(storageUsed("alice") - before, Buffer.byteLength("Café") + Buffer.byteLength("Héllo\nworld"));

  const detail = await json<{ note: Note }>(await call(`/notes/${note.id}`));
  assert.deepEqual(detail.note, note);
});

test("empty title and body are allowed and survive", async () => {
  const res = await call("/notes", { method: "POST", json: { ...write({ title: "", body: "" }), requestId: UUID } });
  assert.equal(res.status, 201);
  const { note } = await json<{ note: Note }>(res);
  assert.equal(note.title, "");
  assert.equal(note.body, "");
});

test("a no-op update keeps the revision and updated_at, and a stale write conflicts", async () => {
  const { note } = await json<{ note: Note }>(await call("/notes", { method: "POST", json: { ...write(), requestId: UUID } }));
  const noop = await json<{ note: Note }>(await call(`/notes/${note.id}`, { method: "PUT", json: { ...write(), revision: note.revision } }));
  assert.equal(noop.note.revision, note.revision);
  assert.equal(noop.note.updatedAt, note.updatedAt);

  const changed = await json<{ note: Note }>(await call(`/notes/${note.id}`, { method: "PUT", json: { ...write({ body: "changed" }), revision: note.revision } }));
  assert.equal(changed.note.revision, note.revision + 1);
  const stale = await call(`/notes/${note.id}`, { method: "PUT", json: { ...write({ body: "stale" }), revision: note.revision } });
  assert.equal(stale.status, 409);
});

test("create retries are idempotent per request id, and a reused key with different text conflicts", async () => {
  const first = await call("/notes", { method: "POST", json: { ...write(), requestId: UUID } });
  const again = await call("/notes", { method: "POST", json: { ...write(), requestId: UUID } });
  assert.equal(first.status, 201);
  assert.equal(again.status, 200);
  const a = await json<{ note: Note }>(first);
  const b = await json<{ note: Note }>(again);
  assert.equal(a.note.id, b.note.id);
  const reused = await call("/notes", { method: "POST", json: { ...write({ body: "other" }), requestId: UUID } });
  assert.equal(reused.status, 409);
});

test("notes are account-scoped and project links are owned", async () => {
  const { note } = await json<{ note: Note }>(await call("/notes", { method: "POST", json: { ...write(), requestId: UUID } }));
  assert.equal((await call(`/notes/${note.id}`, { user: "bob" })).status, 404);
  const foreign = await call("/notes", { method: "POST", json: { ...write({ projectId: "missing" }), requestId: UUID2 } });
  assert.equal(foreign.status, 404);
});

test("search is literal prefix AND over title and body; punctuation-only queries are empty", async () => {
  await call("/notes", { method: "POST", json: { ...write({ title: "Alpha project", body: "beta gamma" }), requestId: UUID } });
  await call("/notes", { method: "POST", json: { ...write({ title: "Gamma note", body: "alpha only" }), requestId: UUID2 } });

  const alpha = await json<NotePage>(await call("/notes?q=alpha"));
  assert.equal(alpha.items.length, 2);
  const both = await json<NotePage>(await call("/notes?q=alpha%20beta"));
  assert.equal(both.items.length, 1);
  const punct = await json<NotePage>(await call("/notes?q=%22%22%20OR%20*"));
  assert.equal(punct.items.length, 0);
  const quoted = await json<NotePage>(await call(`/notes?q=${encodeURIComponent('"alpha" OR *')}`));
  // Operators are literal words, never FTS grammar.
  assert.equal(quoted.items.length, 0);
});

test("tags combine with favorite and project filters and summaries omit the body", async () => {
  await call("/notes", { method: "POST", json: { ...write({ title: "One", body: "x".repeat(200), favorite: true, tags: ["a", "b"], projectId: "p1" }), requestId: UUID } });
  await call("/notes", { method: "POST", json: { ...write({ title: "Two", body: "y", tags: ["a"], projectId: null }), requestId: UUID2 } });

  const all = await json<NotePage>(await call("/notes?tag=a&tag=b&tagMatch=all"));
  assert.deepEqual(all.items.map((item) => item.title), ["One"]);
  const any = await json<NotePage>(await call("/notes?tag=a&tagMatch=any&favorite=1"));
  assert.deepEqual(any.items.map((item) => item.title), ["One"]);
  const unlinked = await json<NotePage>(await call("/notes?projectId=none"));
  assert.deepEqual(unlinked.items.map((item) => item.title), ["Two"]);
  const summary = all.items[0] as NoteSummary;
  assert.equal("body" in summary, false);
  assert.equal([...summary.excerpt].length, 160);
});

test("pinned ordering and cursors are filter-bound", async () => {
  for (let index = 0; index < 3; index++) {
    await call("/notes", { method: "POST", json: { ...write({ title: `N${index}`, body: `${index}` }), requestId: `3333333${index}-3333-4333-8333-333333333333` } });
  }
  const first = await json<NotePage>(await call("/notes?limit=1"));
  assert.equal(first.items.length, 1);
  assert.ok(first.nextCursor);
  const second = await json<NotePage>(await call(`/notes?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`));
  assert.notEqual(second.items[0]!.id, first.items[0]!.id);
  const mismatched = await call(`/notes?limit=1&favorite=1&cursor=${encodeURIComponent(first.nextCursor!)}`);
  assert.equal(mismatched.status, 400);
});

test("a message source copies only text parts and survives the source chat", async () => {
  const content = JSON.stringify({
    role: "assistant",
    parts: [
      { type: "reasoning", text: "secret reasoning" },
      { type: "text", text: "## Heading\n\nBody text" },
      { type: "tool-web_search", input: { q: "x" }, output: "tool output" },
      { type: "text", text: "Second paragraph" },
    ],
  });
  db.prepare("INSERT INTO messages (id, thread_id, format, content, bytes, created_at) VALUES ('m1', 't1', 'ai-sdk/v6', ?, 0, 1)").run(content);
  const res = await call("/notes/from-source", {
    method: "POST",
    json: { requestId: UUID, source: { kind: "message", threadId: "t1", messageId: "m1" } },
  });
  assert.equal(res.status, 201, await res.clone().text());
  const { note } = await json<{ note: Note }>(res);
  assert.equal(note.body, "## Heading\n\nBody text\n\nSecond paragraph");
  assert.equal(note.title, "Heading");
  assert.equal(note.projectId, "p1");
  assert.equal(note.sourceAvailable, true);
  db.prepare("DELETE FROM threads WHERE id = 't1'").run();
  const after = await json<{ note: Note }>(await call(`/notes/${note.id}`));
  assert.equal(after.note.sourceAvailable, false);
  assert.equal(after.note.body, note.body);
});

test("artifact sources require Markdown and the exact version", async () => {
  db.prepare("INSERT INTO artifacts (thread_id, id, version, title, kind, language, content, created_at) VALUES ('t2', 'a1', 1, 'Old', 'markdown', NULL, 'old body', 1)").run();
  db.prepare("INSERT INTO artifacts (thread_id, id, version, title, kind, language, content, created_at) VALUES ('t2', 'a1', 2, 'New', 'markdown', NULL, '# New body', 2)").run();
  db.prepare("INSERT INTO artifacts (thread_id, id, version, title, kind, language, content, created_at) VALUES ('t2', 'c1', 1, 'Code', 'code', 'ts', 'const x = 1', 3)").run();
  const old = await json<{ note: Note }>(await call("/notes/from-source", { method: "POST", json: { requestId: UUID, source: { kind: "artifact", threadId: "t2", artifactId: "a1", version: 1 } } }));
  assert.equal(old.note.body, "old body");
  const unsupported = await call("/notes/from-source", { method: "POST", json: { requestId: UUID2, source: { kind: "artifact", threadId: "t2", artifactId: "c1", version: 1 } } });
  assert.equal(unsupported.status, 400);
  const missingVersion = await call("/notes/from-source", { method: "POST", json: { requestId: "44444444-4444-4444-8444-444444444444", source: { kind: "artifact", threadId: "t2", artifactId: "a1", version: 9 } } });
  assert.equal(missingVersion.status, 404);
});

test("quota charges growth, allows shrinking and deleting, and rolls back a rejected create", async () => {
  const { note } = await json<{ note: Note }>(await call("/notes", { method: "POST", json: { ...write(), requestId: UUID } }));
  const used = storageUsed("alice");
  db.prepare("UPDATE users SET storage_limit = ? WHERE id = 'alice'").run(used + 2);
  const tooBig = await call("/notes", { method: "POST", json: { ...write({ body: "a longer body" }), requestId: UUID2 } });
  assert.equal(tooBig.status, 413);
  assert.equal(storageUsed("alice"), used);
  const shrink = await call(`/notes/${note.id}`, { method: "PUT", json: { ...write({ body: "x" }), revision: note.revision } });
  assert.equal(shrink.status, 200);
  const deleted = await call(`/notes/${note.id}`, { method: "DELETE", json: { revision: note.revision + 1 } });
  assert.equal(deleted.status, 200);
  assert.equal(storageUsed("alice"), used - Buffer.byteLength("Plan") - Buffer.byteLength("First line\nSecond line"));
});

test("the account feature guard covers list, search, tags, source copy, and delete", async () => {
  const { note } = await json<{ note: Note }>(await call("/notes", { method: "POST", json: { ...write(), requestId: UUID } }));
  db.prepare("INSERT INTO permission_policies (subject_kind, subject_id, model_ref, document, updated_at) VALUES ('everyone', '', '', ?, 1)").run(JSON.stringify({ version: 1, features: { notes: false } }));
  assert.equal((await call("/notes")).status, 403);
  assert.equal((await call("/notes/tags")).status, 403);
  assert.equal((await call(`/notes/${note.id}`)).status, 403);
  assert.equal((await call(`/notes/${note.id}`, { method: "DELETE", json: { revision: 1 } })).status, 403);
  assert.equal((await call("/notes/from-source", { method: "POST", json: { requestId: UUID2, source: { kind: "message", threadId: "t1", messageId: "m1" } } })).status, 403);
});

test("store writes never bump a chat's activity timestamp", async () => {
  const before = (db.prepare("SELECT updated_at FROM threads WHERE id = 't1'").get() as { updated_at: number }).updated_at;
  createNote("alice", UUID, write({ projectId: "p1" }));
  const note = db.prepare("SELECT id FROM notes LIMIT 1").get() as { id: string };
  updateNote("alice", note.id, 1, write({ title: "Changed", projectId: "p1" }));
  deleteNote("alice", note.id, 2);
  assert.equal((db.prepare("SELECT updated_at FROM threads WHERE id = 't1'").get() as { updated_at: number }).updated_at, before);
});

test("delete removes tags and FTS rows", async () => {
  const note = createNote("alice", UUID, write());
  assert.equal((db.prepare("SELECT count(*) AS n FROM note_tags").get() as { n: number }).n, 2);
  deleteNote("alice", note.note.id, 1);
  assert.equal((db.prepare("SELECT count(*) AS n FROM note_tags").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT count(*) AS n FROM notes_fts WHERE notes_fts MATCH 'Plan'").get() as { n: number }).n, 0);
  assert.throws(() => getNote("alice", note.note.id));
});
