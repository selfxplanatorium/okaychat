import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { Hono } from "hono";

// Quota computation and enforcement. The storage default comes from the env, the per-user override
// from the users table; write paths answer 413 and tools throw so the model sees the reason.
const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-quota-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "quota-test-secret-only-not-for-production";
process.env.OKAYCHAT_STORAGE_LIMIT = "1000000";
const { db } = await import("./db.js");
const { requireUser } = await import("./auth.js");
const { sha256 } = await import("./crypto.js");
const { ensureThread } = await import("./threads.js");
const { accountRoutes } = await import("./account.js");
const { fileRoutes } = await import("./files.js");
const { fontRoutes } = await import("./fonts.js");
const { adminRoutes } = await import("./admin.js");
const { artifactTools } = await import("./artifacts.js");
const { storageUsed, userStorageLimit } = await import("./quota.js");
const { api } = await import("./routes.js");

for (const [id, role] of [["alice", "user"], ["bob", "user"], ["root", "admin"]] as const) {
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, `${id}@example.test`, id, "unused", role, Date.now());
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(id), id, Date.now() + 600_000);
}
const app = new Hono()
  .route("/", api)
  .route("/", fileRoutes)
  .route("/", fontRoutes)
  .route("/account", accountRoutes)
  .route("/", adminRoutes);
after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => {
  db.exec("DELETE FROM sandbox_files; DELETE FROM uploads; DELETE FROM artifacts; DELETE FROM user_fonts; DELETE FROM user_avatars; DELETE FROM images; DELETE FROM memories; DELETE FROM project_files; DELETE FROM projects; UPDATE users SET storage_limit = NULL");
  ensureThread("alice", "thr_alice");
});

const as = (user: string, url: string, init?: RequestInit) => app.request(`http://app${url}`, { ...init, headers: { Cookie: `okaychat_session=${user}`, ...init?.headers } });
const insert = (sql: string, ...args: unknown[]) => db.prepare(sql).run(...args);

test("used bytes cover every kind of user storage and nobody else's", () => {
  insert("INSERT INTO uploads (id, user_id, name, mime, data, created_at) VALUES ('u1', 'alice', 'a.csv', 'text/csv', ?, ?)", Buffer.alloc(10), Date.now());
  ensureThread("bob", "thr_bob");
  insert("INSERT INTO artifacts (thread_id, id, version, title, kind, language, content, data, size, created_at) VALUES ('thr_alice', 'doc', 1, 'Doc', 'pdf', NULL, 'abc', ?, 5, ?)", Buffer.alloc(5), Date.now());
  insert("INSERT INTO artifacts (thread_id, id, version, title, kind, language, content, data, size, created_at) VALUES ('thr_bob', 'doc', 1, 'Doc', 'code', 'py', 'longer content', NULL, 0, ?)", Date.now());
  insert("INSERT INTO user_fonts (id, user_id, family, filename, mime, data, created_at) VALUES ('f1', 'alice', 'My Font', 'f.ttf', 'font/ttf', ?, ?)", Buffer.alloc(20), Date.now());
  insert("INSERT INTO user_avatars (user_id, mime, data, updated_at) VALUES ('alice', 'image/png', ?, ?)", Buffer.alloc(30), Date.now());
  insert("INSERT INTO images (id, user_id, thread_id, prompt, size, created_at) VALUES ('i1', 'alice', 'thr_alice', 'cat', 40, ?)", Date.now());
  insert("INSERT INTO sandbox_files (id, user_id, thread_id, path, mime, data, size, created_at) VALUES ('s1', 'alice', 'thr_alice', 'out.png', 'image/png', ?, 50, ?)", Buffer.alloc(50), Date.now());
  insert("INSERT INTO memories (id, user_id, scope, content_enc, content_hash, source, created_at, updated_at) VALUES ('m1', 'alice', '', 'cipher', 'h', 'test', ?, ?)", Date.now(), Date.now());
  insert("INSERT INTO projects (id, user_id, name, created_at) VALUES ('p1', 'alice', 'P', ?)", Date.now());
  insert("INSERT INTO project_files (id, project_id, name, content, created_at) VALUES ('pf1', 'p1', 'notes.md', 'notes', ?)", Date.now());
  // uploads 10 + artifacts 3+5 + fonts 20 + avatar 30 + images 40 + sandbox 50 + memories 6 + project files 5
  assert.equal(storageUsed("alice"), 169);
  assert.equal(storageUsed("bob"), 14);
});

test("the storage endpoint reports the user's usage, their limit, and the default", async () => {
  const res = await as("alice", "/storage");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { used: number; limit: number; defaultLimit: number };
  assert.equal(body.used, 0);
  assert.equal(body.limit, 1_000_000);
  assert.equal(body.defaultLimit, 1_000_000);
  assert.equal(userStorageLimit("alice"), 1_000_000);
  insert("UPDATE users SET storage_limit = 500 WHERE id = 'alice'");
  assert.equal(userStorageLimit("alice"), 500);
  assert.equal(((await (await as("alice", "/storage")).json()) as { limit: number }).limit, 500);
});

const form = (body: BodyInit, name = "f.pdf", type = "application/pdf") => {
  const bodyForm = new FormData();
  bodyForm.set("file", new File([body], name, { type }));
  return bodyForm;
};

test("uploads are rejected with 413 when they would pass the limit, allowed up to it", async () => {
  insert("UPDATE users SET storage_limit = 100 WHERE id = 'alice'");
  // Exactly at the limit fits. `f.pdf` is importable, so the bytes are actually stored.
  let res = await as("alice", "/files/store", { method: "POST", body: form(Buffer.alloc(100)) });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { fileId: string }).fileId.slice(0, 4), "upl_");
  // One more byte does not.
  res = await as("alice", "/files/store", { method: "POST", body: form(Buffer.alloc(100)) });
  assert.equal(res.status, 413);
  assert.match(((await res.json()) as { error: string }).error, /Storage quota exceeded/);
  // Another user's limit is untouched.
  res = await as("bob", "/files/store", { method: "POST", body: form(Buffer.alloc(100)) });
  assert.equal(res.status, 200);
});

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64");
const ttf = Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.alloc(16)]);

test("fonts and profile pictures are rejected with 413 too", async () => {
  insert("UPDATE users SET storage_limit = 10 WHERE id = 'alice'");
  const fontRes = await as("alice", "/fonts", { method: "POST", body: form(ttf, "F.ttf", "font/ttf") });
  assert.equal(fontRes.status, 413);
  assert.match(((await fontRes.json()) as { error: string }).error, /Storage quota exceeded/);
  const avatarRes = await as("alice", "/account/avatar", { method: "PUT", body: form(png, "photo.png", "image/png") });
  assert.equal(avatarRes.status, 413);
});

test("artifact and document tools fail with a clear message instead of writing", async () => {
  insert("UPDATE users SET storage_limit = 10 WHERE id = 'alice'");
  const tool = artifactTools("thr_alice", "alice").create_artifact!;
  await assert.rejects(
    async () => tool.execute!({ id: "big", title: "Big", kind: "markdown", content: "x".repeat(100) }, { toolCallId: "1", messages: [] }),
    /Storage quota exceeded/,
  );
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM artifacts").get() as { n: number }).n, 0);
});

test("admins see each user's usage and can set or reset a per-user limit", async () => {
  insert("INSERT INTO uploads (id, user_id, name, mime, data, created_at) VALUES ('u2', 'alice', 'a.txt', 'text/plain', ?, ?)", Buffer.alloc(7), Date.now());
  let res = await as("root", "/admin/users");
  assert.equal(res.status, 200);
  const users = (await res.json()) as Array<{ id: string; storageUsed: number; storageLimit: number | null }>;
  assert.equal(users.find((u) => u.id === "alice")?.storageUsed, 7);
  assert.equal(users.find((u) => u.id === "alice")?.storageLimit, null);
  // Non-admins cannot reach this.
  assert.equal((await as("alice", "/admin/users")).status, 403);
  res = await as("root", "/admin/users/alice", { method: "PATCH", body: JSON.stringify({ storageLimit: 2_000_000 }), headers: { "Content-Type": "application/json" } });
  assert.equal(res.status, 200);
  assert.equal(userStorageLimit("alice"), 2_000_000);
  // null removes the override, falling back to the default.
  res = await as("root", "/admin/users/alice", { method: "PATCH", body: JSON.stringify({ storageLimit: null }), headers: { "Content-Type": "application/json" } });
  assert.equal(res.status, 200);
  assert.equal(userStorageLimit("alice"), 1_000_000);
  assert.equal((await as("root", "/admin/users/alice", { method: "PATCH", body: JSON.stringify({ storageLimit: 0 }), headers: { "Content-Type": "application/json" } })).status, 400);
});
