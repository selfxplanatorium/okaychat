import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { Hono } from "hono";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-account-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "account-test-secret-only-not-for-production";
const { db } = await import("./db.js");
const { requireUser } = await import("./auth.js");
const { sha256 } = await import("./crypto.js");
const { accountRoutes, avatarImage, MAX_AVATAR_BYTES } = await import("./account.js");
const app = new Hono().use(requireUser).route("/account", accountRoutes);
for (const id of ["alice", "bob"]) {
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, `${id}@example.test`, id, "unused", "user", Date.now());
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(id), id, Date.now() + 60_000);
}
after(() => { db.close(); rmSync(dataDir, { recursive: true, force: true }); });
beforeEach(() => db.exec("DELETE FROM user_avatars; UPDATE users SET name = id"));

const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64");
const request = (url: string, method = "GET", body?: BodyInit, user = "alice", headers: Record<string, string> = {}) => app.request(`http://app/account${url}`, {
  method, headers: { cookie: `okaychat_session=${user}`, ...headers }, ...(body === undefined ? {} : { body }),
});
const upload = (data = image, user = "alice", mime = "image/png") => {
  const form = new FormData();
  form.set("file", new File([data], "photo.png", { type: mime }));
  return request("/avatar", "PUT", form, user);
};

test("account profile and picture require authentication", async () => {
  assert.equal((await app.request("http://app/account")).status, 401);
  assert.equal((await app.request("http://app/account/avatar")).status, 401);
});

test("display names update only the authenticated account and reject invalid input", async () => {
  const response = await request("", "PATCH", JSON.stringify({ name: "  Alice Smith  " }), "alice", { "Content-Type": "application/json" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).name, "Alice Smith");
  assert.equal((await (await request("", "GET", undefined, "bob")).json()).name, "bob");
  for (const body of [{ name: " " }, { name: "x".repeat(81) }, { name: "Alice", role: "admin" }]) {
    assert.equal((await request("", "PATCH", JSON.stringify(body), "alice", { "Content-Type": "application/json" })).status, 400);
  }
  assert.equal((await request("", "PATCH", "broken-json", "alice", { "Content-Type": "application/json" })).status, 400);
});

test("pictures persist, replace with a fresh URL, and remain isolated between accounts", async () => {
  const response = await upload();
  assert.equal(response.status, 200);
  const first = await response.json();
  assert.match(first.avatarUrl, /^\/api\/account\/avatar\?v=\d+$/);
  const picture = await request("/avatar");
  assert.equal(picture.headers.get("Content-Type"), "image/png");
  assert.equal(picture.headers.get("Cache-Control"), "private, no-store");
  assert.equal(picture.headers.get("X-Content-Type-Options"), "nosniff");
  assert.deepEqual(Buffer.from(await picture.arrayBuffer()), image);
  assert.equal((await request("/avatar", "GET", undefined, "bob")).status, 404);
  assert.equal((await (await request("", "GET", undefined, "bob")).json()).avatarUrl, undefined);
  const replacement = await (await upload()).json();
  assert.notEqual(replacement.avatarUrl, first.avatarUrl);
  await request("/avatar", "DELETE", undefined, "bob");
  assert.equal((await request("/avatar")).status, 200);
  const deleted = await request("/avatar", "DELETE");
  assert.equal((await deleted.json()).avatarUrl, undefined);
  assert.equal((await request("/avatar")).status, 404);
});

test("upload uses file bytes instead of trusting MIME and rejects unsafe or oversized files", async () => {
  assert.equal((await upload(image, "alice", "text/plain")).status, 200);
  assert.equal((await upload(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"))).status, 422);
  assert.equal((await upload(Buffer.from([137, 80, 78, 71]))).status, 422);
  assert.equal((await upload(Buffer.alloc(MAX_AVATAR_BYTES + 1))).status, 413);
  assert.equal((await request("/avatar", "PUT", "bad form", "alice", { "Content-Type": "multipart/form-data" })).status, 400);
  const huge = Buffer.from(image);
  huge.writeUInt32BE(100_000, 16);
  assert.equal((await upload(huge)).status, 422);
  assert.deepEqual(avatarImage(image), { mime: "image/png", width: 1, height: 1 });
});
