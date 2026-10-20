import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { Hono } from "hono";
import type { LibraryPage } from "../shared/types.js";

const directory = mkdtempSync(path.join(os.tmpdir(), "okaychat-storage-integration-"));
process.env.OKAYCHAT_DATA_DIR = directory;
process.env.OKAYCHAT_SECRET = "integration-tests-secret-only-not-for-production";
process.env.OKAYCHAT_SANDBOX_URL = "";
const { db } = await import("./db.js");
const { sha256 } = await import("./crypto.js");
const { api } = await import("./routes.js");
const { storageUsed } = await import("./quota.js");
const app = new Hono().route("/api", api);
for (const id of ["alice", "bob"]) {
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, 'unused', 'user', 1)").run(id, `${id}@test.example`, id);
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(id), id, Date.now() + 600_000);
}
after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
beforeEach(() => {
  db.prepare("INSERT OR IGNORE INTO users (id,email,name,password_hash,role,created_at) VALUES ('bob','bob@test.example','bob','unused','user',1)").run();
  db.prepare("INSERT OR IGNORE INTO sessions (token_hash,user_id,expires_at) VALUES (?, 'bob', ?)").run(sha256("bob"), Date.now() + 600_000);
  db.exec("UPDATE users SET role = 'user'; DELETE FROM skills; DELETE FROM skill_sources; DELETE FROM skill_preferences; DELETE FROM uploads; DELETE FROM threads; DELETE FROM projects; DELETE FROM memories; DELETE FROM user_avatars; UPDATE users SET storage_limit = NULL;");
});
const request = (url: string, init?: RequestInit, user = "alice") => app.request(`http://app/api${url}`, { ...init, headers: { cookie: `okaychat_session=${user}`, ...init?.headers } });
const json = (body: unknown, method = "POST") => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const file = (name: string, mime: string, content = "bytes") => {
  const form = new FormData();
  form.set("file", new File([content], name, { type: mime }));
  return { method: "POST", body: form };
};
const library = async (query = "") => await (await request(`/library${query}`)).json() as LibraryPage;

test("all attachments persist without a sandbox, count against quota, and delete frees space", async () => {
  db.prepare("UPDATE users SET storage_limit = 15 WHERE id = 'alice'").run();
  for (const [name, mime] of [["photo.png", "image/png"], ["archive.bin", "application/octet-stream"], ["code.py", "text/plain"]]) {
    const response = await request("/files/store", file(name!, mime!));
    assert.equal(response.status, 200);
  }
  assert.equal(storageUsed("alice"), 15);
  assert.equal((await request("/files/store", file("next.txt", "text/plain"))).status, 413);
  const page = await library();
  assert.deepEqual(page.items.map((item) => item.name).sort(), ["archive.bin", "code.py", "photo.png"]);
  for (const item of page.items) {
    assert.equal((await request(item.downloadUrl!.replace("/api", ""), undefined, "bob")).status, 404);
    const download = await request(item.downloadUrl!.replace("/api", ""));
    assert.equal(await download.text(), "bytes");
    assert.equal(download.headers.get("X-Content-Type-Options"), "nosniff");
  }
  const id = page.items[0]!.id.slice("upload:".length);
  assert.equal((await request(`/library/upload/${id}`, { method: "DELETE" }, "bob")).status, 404);
  assert.equal((await request(`/library/upload/${id}`, { method: "DELETE" })).status, 200);
  assert.equal(storageUsed("alice"), 10);
  assert.equal((await request("/files/store", file("next.txt", "text/plain"))).status, 200);
});

test("old attachments survive new uploads from either account", async () => {
  await request("/files/store", file("old.txt", "text/plain"));
  db.exec("UPDATE uploads SET created_at = 1");
  await request("/files/extract", file("new.txt", "text/plain"));
  await request("/files/store", file("bob.txt", "text/plain"), "bob");
  assert.deepEqual((await library()).items.map((item) => item.name).sort(), ["new.txt", "old.txt"]);
});

test("temporary attachment extraction and storage never persist, even at quota", async () => {
  db.prepare("UPDATE users SET storage_limit = 1 WHERE id = 'alice'").run();
  const stored = await request("/files/store?temporary=1", file("photo.png", "image/png"));
  assert.equal(stored.status, 200);
  assert.equal((await stored.json()).fileId, null);
  const extracted = await request("/files/extract?temporary=1", file("notes.txt", "text/plain"));
  assert.equal(extracted.status, 200);
  assert.equal((await extracted.json()).fileId, undefined);
  assert.equal(storageUsed("alice"), 0);
  assert.equal((await library()).items.length, 0);
});

test("active upload content always downloads with sandbox and nosniff headers", async () => {
  const response = await request("/files/store", file("attack.svg", "image/svg+xml", '<svg onload="alert(1)"></svg>'));
  const id = (await response.json()).fileId;
  const served = await request(`/uploads/${id}/file`);
  assert.match(served.headers.get("Content-Disposition")!, /^attachment/);
  assert.match(served.headers.get("Content-Security-Policy")!, /sandbox/);
  assert.equal(served.headers.get("X-Content-Type-Options"), "nosniff");
});

test("sandbox outputs are listed, previewed, downloaded, and deleted only by their owner", async () => {
  await request("/threads", json({ id: "thread-a" }));
  // Use the same ownership schema as run_code after a successful run.
  const thread = db.prepare("SELECT id FROM threads WHERE user_id = 'alice' LIMIT 1").get()!.id;
  db.prepare("INSERT INTO sandbox_files (id, user_id, thread_id, path, mime, data, size, created_at) VALUES ('out-a', 'alice', ?, 'out/report.txt', 'text/plain', ?, 6, 1)")
    .run(thread, Buffer.from("report"));
  const item = (await library()).items[0]!;
  assert.equal(item.id, "sandbox:out-a");
  assert.equal(item.size, 6);
  assert.equal(await (await request(item.downloadUrl!.replace("/api", ""))).text(), "report");
  assert.equal((await request(item.previewUrl!.replace("/api", ""))).status, 200);
  assert.equal((await request(item.previewUrl!.replace("/api", ""), undefined, "bob")).status, 404);
  assert.equal((await request(`/library/sandbox/out-a`, { method: "DELETE" }, "bob")).status, 404);
  assert.equal(storageUsed("alice"), 6);
  assert.equal((await request(`/library/sandbox/out-a`, { method: "DELETE" })).status, 200);
  assert.equal(storageUsed("alice"), 0);
  assert.equal((await library()).items.length, 0);
});

test("project attachment originals live in the library and project writes enforce quota", async () => {
  const created = await request("/projects", json({ name: "Project" }));
  const project = (await created.json()).id;
  db.prepare("UPDATE users SET storage_limit = 9 WHERE id = 'alice'").run();
  assert.equal((await request(`/projects/${project}/files`, file("pinned.txt", "text/plain"))).status, 413);
  assert.equal(storageUsed("alice"), 0);
  db.prepare("UPDATE users SET storage_limit = 10 WHERE id = 'alice'").run();
  assert.equal((await request(`/projects/${project}/files`, file("pinned.txt", "text/plain"))).status, 200);
  assert.equal(storageUsed("alice"), 10, "original bytes and extracted project text both count");
  const page = await library(`?project=${project}`);
  assert.equal(page.items[0]!.name, "pinned.txt");
  await request(`/projects/${project}`, { method: "DELETE" });
  assert.equal(storageUsed("alice"), 5, "the original survives until explicitly deleted in Library");
});

test("memory writes enforce account quota and replacement avatars charge only net growth", async () => {
  db.prepare("UPDATE users SET storage_limit = 1 WHERE id = 'alice'").run();
  assert.equal((await request("/memory", json({ content: "Remember this." }))).status, 413);
  assert.equal(storageUsed("alice"), 0);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64");
  db.prepare("UPDATE users SET storage_limit = ? WHERE id = 'alice'").run(png.length);
  const upload = () => { const body = new FormData(); body.set("file", new File([png], "avatar.png", { type: "image/png" })); return request("/account/avatar", { method: "PUT", body }); };
  assert.equal((await upload()).status, 200);
  assert.equal((await upload()).status, 200);
  assert.equal(storageUsed("alice"), png.length);
});

test("account deletion cascades persistent attachments and skill files", async () => {
  db.prepare("UPDATE users SET role = 'admin' WHERE id = 'alice'").run();
  await request("/files/store", file("bob.txt", "text/plain"), "bob");
  await request("/skills", json({ name: "bob-skill", description: "Bob skill", body: "Body", files: [{ name: "ref.md", content: "Reference" }] }), "bob");
  assert.ok(storageUsed("bob") > 0);
  assert.equal((await request("/admin/users/bob", { method: "DELETE" })).status, 200);
  assert.equal(storageUsed("bob"), 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM skill_files").get()!.n, 0);
});

test("skills created by the agent appear as downloadable Library packages and deletion frees their reference bytes", async () => {
  const response = await request("/skills", json({ name: "library-skill", description: "Reusable steps", body: "Instructions", files: [{ name: "refs/a.md", content: "Reference" }] }));
  const skill = await response.json();
  db.prepare("UPDATE skills SET origin = 'conversation' WHERE id = ?").run(skill.id);
  const page = await library();
  const item = page.items.find((entry) => entry.id === `skill:${skill.id}`)!;
  assert.equal(item.name, "library-skill.zip");
  assert.equal(item.source, "generated");
  assert.equal(item.size, storageUsed("alice"));
  assert.equal((await request(item.downloadUrl!.replace("/api", ""), undefined, "bob")).status, 404);
  const archive = await request(item.downloadUrl!.replace("/api", ""));
  const { unzipSync } = await import("fflate");
  const files = unzipSync(new Uint8Array(await archive.arrayBuffer()));
  assert.match(new TextDecoder().decode(files["SKILL.md"]), /Instructions/);
  assert.equal(new TextDecoder().decode(files["refs/a.md"]), "Reference");
  assert.equal((await request(`/library/skill/${skill.id}`, { method: "DELETE" })).status, 200);
  assert.equal(storageUsed("alice"), 0);
});

test("saving an anonymous image to normal history stores bytes once without changing its message parts", async () => {
  const { appendMessage, ensureThread, listMessages } = await import("./threads.js");
  ensureThread("alice", "saved-anonymous");
  const content = { role: "user", parts: [{ type: "file", mediaType: "image/png", filename: "saved.png", url: "data:image/png;base64,Ynl0ZXM=" }] };
  const row = { id: "saved-message", parent_id: null, format: "ai-sdk/v6", content };
  appendMessage("alice", "saved-anonymous", row);
  appendMessage("alice", "saved-anonymous", row);
  assert.equal(storageUsed("alice"), 5);
  assert.deepEqual(listMessages("alice", "saved-anonymous")[0]!.content, content);
  const item = (await library()).items[0]!;
  assert.equal(item.name, "saved.png");
  assert.equal(item.threadId, "saved-anonymous");
  await request(`/library/upload/${item.id.slice("upload:".length)}`, { method: "DELETE" });
  appendMessage("alice", "saved-anonymous", row);
  assert.equal(storageUsed("alice"), 0, "replaying the same message must not resurrect a deleted file");
});
