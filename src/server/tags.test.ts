import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { Hono } from "hono";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-tags-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "tags-test-secret-only-not-for-production";
const { db } = await import("./db.js");
const { sha256 } = await import("./crypto.js");
const { api } = await import("./routes.js");

for (const id of ["alice", "bob"]) {
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, `${id}@example.test`, id, "unused", "user", 1);
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(id), id, Date.now() + 600_000);
}
const app = new Hono().route("/api", api);
after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => {
  db.exec("DELETE FROM thread_tags; DELETE FROM tag_filter_presets; DELETE FROM comparison_groups; DELETE FROM threads");
  const thread = db.prepare("INSERT INTO threads (id, user_id, status, compare_group_id, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)");
  thread.run("t1", "alice", "regular", null);
  thread.run("t2", "alice", "archived", null);
  thread.run("t3", "alice", "regular", "g1");
  thread.run("t4", "bob", "regular", null);
  const tag = db.prepare("INSERT INTO thread_tags (thread_id, tag, created_at) VALUES (?, ?, 1)");
  for (const [threadId, value] of [["t1", "alpha"], ["t1", "beta"], ["t2", "alpha"], ["t3", "alpha"], ["t4", "alpha"]]) tag.run(threadId, value);
});

const call = (url: string, init: { method?: string; json?: unknown; user?: string } = {}) =>
  app.request(`http://app/api${url}`, {
    method: init.method ?? "GET",
    headers: { cookie: `okaychat_session=${init.user ?? "alice"}`, ...(init.json !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });

test("counts exclude archived chats, comparison panes, and other accounts", async () => {
  const result = (await (await call("/tags")).json()) as { tags: Array<{ tag: string; count: number }> };
  assert.deepEqual(result.tags, [
    { tag: "alpha", count: 1 },
    { tag: "beta", count: 1 },
  ]);
});

test("presets are owned, unique per account, renameable, and capped", async () => {
  const created = await call("/tag-filters", { method: "POST", json: { name: "Mine", filter: { tags: ["alpha"], match: "all" } } });
  assert.equal(created.status, 201);
  const preset = ((await created.json()) as { preset: { id: string; name: string } }).preset;
  assert.equal(preset.name, "Mine");

  assert.equal((await call("/tag-filters", { method: "POST", json: { name: "Mine", filter: { tags: [] } } })).status, 409);
  const bobList = (await (await call("/tag-filters", { user: "bob" })).json()) as { presets: unknown[] };
  assert.deepEqual(bobList.presets, []);

  const renamed = await call(`/tag-filters/${preset.id}`, { method: "PATCH", json: { name: "Renamed" } });
  assert.equal(((await renamed.json()) as { preset: { name: string } }).preset.name, "Renamed");
  assert.equal((await call(`/tag-filters/${preset.id}`, { method: "PATCH", json: { filter: "nope" } })).status, 400);
  // A foreign id answers like a missing one and leaves the row alone.
  assert.equal((await call(`/tag-filters/${preset.id}`, { method: "DELETE", user: "bob" })).status, 200);
  const list = (await (await call("/tag-filters")).json()) as { presets: unknown[] };
  assert.equal(list.presets.length, 1);

  for (let index = 0; index < 49; index++) {
    const response = await call("/tag-filters", { method: "POST", json: { name: `Filter ${index}`, filter: { tags: [] } } });
    assert.equal(response.status, 201);
  }
  assert.equal((await call("/tag-filters", { method: "POST", json: { name: "One too many", filter: { tags: [] } } })).status, 409);
});

test("tag writes reject invalid text, hidden chats, and foreign chats", async () => {
  assert.equal((await call("/threads/t1", { method: "PATCH", json: { tags: ["ok", "not ok/slash"] } })).status, 400);
  assert.equal((await call("/threads/t1", { method: "PATCH", json: { tags: Array.from({ length: 11 }, (_, index) => `t${index}`) } })).status, 400);
  assert.equal((await call("/threads/t3", { method: "PATCH", json: { tags: ["alpha"] } })).status, 400);
  assert.equal((await call("/threads/t4", { method: "PATCH", json: { tags: ["alpha"] } })).status, 404);
  assert.equal((await call("/threads/t1", { method: "PATCH", json: { tags: ["Alpha", "beta"] } })).status, 200);
  const rows = db.prepare("SELECT tag FROM thread_tags WHERE thread_id = 't1' ORDER BY tag").all() as Array<{ tag: string }>;
  assert.deepEqual(rows.map((row) => row.tag), ["alpha", "beta"]);
});
