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

const { default: sharp } = await import("sharp");
// A valid PNG: the server fully decodes and re-encodes pictures, so a corrupt fixture would be refused.
const image = await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } } }).png().toBuffer();
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
  // Re-encoded on the server (metadata stripped, bounded size), served with a validator that is only
  // answered after the owner lookup.
  assert.equal(picture.headers.get("Content-Type"), "image/webp");
  assert.equal(picture.headers.get("Cache-Control"), "private, no-cache");
  assert.equal(picture.headers.get("X-Content-Type-Options"), "nosniff");
  const etag = picture.headers.get("ETag")!;
  assert.equal((await sharp(Buffer.from(await picture.arrayBuffer())).metadata()).format, "webp");
  assert.equal((await request("/avatar", "GET", undefined, "alice", { "If-None-Match": etag })).status, 304);
  // Another account with the cached validator gets no 304 and no bytes.
  assert.equal((await request("/avatar", "GET", undefined, "bob", { "If-None-Match": etag })).status, 404);
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

test("replacing a picture frees the old bytes only when nothing else holds them", async () => {
  const { storeUpload } = await import("./files.js");
  const { getMedia, readMedia } = await import("./media/store.js");
  const { storageUsed } = await import("./quota.js");
  const noisy = await sharp({ create: { width: 512, height: 512, channels: 3, noise: { type: "gaussian", mean: 128, sigma: 60 } } }).png().toBuffer();
  const plain = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#336699" } }).png().toBuffer();
  assert.equal((await upload(noisy)).status, 200);
  const first = db.prepare("SELECT media_id FROM user_avatars WHERE user_id = 'alice'").get() as { media_id: string };
  const old = getMedia(first.media_id)!;
  // The same bytes uploaded as a file: one media row, two references.
  const held = storeUpload("alice", "kept.webp", "image/webp", readMedia(old));
  db.prepare("UPDATE users SET storage_limit = ? WHERE id = 'alice'").run(storageUsed("alice"));
  // A smaller picture would fit only if the old one were freed, but the upload still holds it.
  assert.equal((await upload(plain)).status, 413);
  assert.equal((db.prepare("SELECT media_id FROM user_avatars WHERE user_id = 'alice'").get() as { media_id: string }).media_id, old.id);
  // Without the other reference the replacement is net shrinkage and fits at a full quota.
  db.prepare("DELETE FROM uploads WHERE id = ?").run(held);
  assert.equal((await upload(plain)).status, 200);
  assert.equal(getMedia(old.id), undefined, "the replaced original is released after the commit");
  db.prepare("UPDATE users SET storage_limit = NULL WHERE id = 'alice'").run();
});
