import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { Hono } from "hono";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-channel-attachments-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "channel-attachments-test-secret-not-for-production";

const { db } = await import("../db.js");
const { api } = await import("../routes.js");
const { storageUsed } = await import("../quota.js");
const { CHANNEL_MEDIA_DIR, attachmentBytes, channelAttachmentPath, purgePendingAttachments, purgeTombstonedAttachments } = await import("./attachments.js");
const { CHANNEL_LIMITS } = await import("../../shared/channels.js");
const { makeCall, seedUsers, createRoom, joinRoom, postMessage, uploadFile } = await import("./test-support.js");

const app = new Hono().route("/api", api);
const call = makeCall(app);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64");
const image = (name = "dot.png") => new File([png], name, { type: "image/png" });

before(() => {
  seedUsers(db, [
    ["alice", "Alice"],
    ["bob", "Bob"],
    ["carol", "Carol"],
    ["root", "Root", "admin"],
  ]);
});

beforeEach(() => {
  db.exec("DELETE FROM channel_rate_windows; DELETE FROM channel_attachments; DELETE FROM channel_messages; DELETE FROM channel_members; DELETE FROM channels");
  db.exec("UPDATE users SET storage_limit = NULL");
});

after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("uploads charge the room owner, not the uploader, and only members can read the bytes", async () => {
  const room = await createRoom(call, { name: "Files", visibility: "public" }, "alice");
  await joinRoom(call, room.id, "bob");
  const beforeAlice = storageUsed("alice");
  const beforeBob = storageUsed("bob");
  const attachment = await uploadFile(call, room.id, image(), "alice");
  assert.equal(attachment.image, true);
  assert.ok(storageUsed("alice") > beforeAlice);
  assert.equal(storageUsed("bob"), beforeBob);
  const bobAttachment = await uploadFile(call, room.id, image("bob.png"), "bob");
  assert.ok(storageUsed("alice") > beforeAlice + png.byteLength, "the second member's file charges the same owner");
  await postMessage(call, room.id, { body: "Alice's file", attachmentIds: [attachment.id] }, "alice");
  await postMessage(call, room.id, { body: "Bob's file", attachmentIds: [bobAttachment.id] }, "bob");

  const served = await call(attachment.url.replace("/api", ""), { user: "bob" });
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("cache-control"), "private, no-cache");
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), png);
  assert.equal((await call(attachment.url.replace("/api", ""), { user: "carol" })).status, 404);
  assert.equal((await call(bobAttachment.url.replace("/api", ""), { user: "carol" })).status, 404);

  const other = await createRoom(call, { name: "Other", visibility: "private" }, "bob");
  assert.equal((await call(attachment.url.replace("/api", ""), { user: "bob" })).status, 200);
  // Bob is a member of the other room, but the id is scoped to this room.
  assert.equal((await call(`/channels/${other.id}/attachments/${attachment.id}`, { user: "bob" })).status, 404);
});

test("a tombstoned message hides its attachment immediately but keeps the bytes until retention", async () => {
  const room = await createRoom(call, { name: "Retention", visibility: "public" }, "alice");
  const attachment = await uploadFile(call, room.id, image(), "alice");
  const posted = await postMessage(call, room.id, { body: "", attachmentIds: [attachment.id] }, "alice");
  const used = storageUsed("alice");
  assert.equal((await call(attachment.url.replace("/api", ""))).status, 200);
  assert.equal((await call(`/channels/${room.id}/messages/${posted.message.id}`, { method: "DELETE", json: { revision: posted.message.revision } })).status, 200);
  assert.equal((await call(attachment.url.replace("/api", ""))).status, 404);
  assert.equal(storageUsed("alice"), used, "the tombstoned bytes still count until purged");
  const row = db.prepare("SELECT channel_id, mime, file FROM channel_attachments WHERE id = ?").get(attachment.id) as { channel_id: string; mime: string; file: number };
  const file = channelAttachmentPath(row.channel_id, attachment.id, row.mime);
  assert.equal(existsSync(file), true);
  assert.ok(purgeTombstonedAttachments(Date.now() + CHANNEL_LIMITS.attachmentRetentionMs + 1) >= 1);
  assert.equal(existsSync(file), false);
  assert.ok(storageUsed("alice") < used);
});

test("pending uploads expire and are removed with their files", async () => {
  const room = await createRoom(call, { name: "Pending", visibility: "public" }, "alice");
  const attachment = await uploadFile(call, room.id, image(), "alice");
  const row = db.prepare("SELECT channel_id, mime FROM channel_attachments WHERE id = ?").get(attachment.id) as { channel_id: string; mime: string };
  const file = channelAttachmentPath(row.channel_id, attachment.id, row.mime);
  assert.equal(existsSync(file), true);
  assert.equal(purgePendingAttachments(Date.now() + CHANNEL_LIMITS.attachmentPendingMs + 1), 1);
  assert.equal(existsSync(file), false);
  assert.equal(attachmentBytes(room.id), 0);
});

test("binding checks uploader, room and the live owner", async () => {
  const first = await createRoom(call, { name: "Bind", visibility: "public" }, "alice");
  const second = await createRoom(call, { name: "Elsewhere", visibility: "public" }, "alice");
  await joinRoom(call, first.id, "bob");
  const bobsFile = await uploadFile(call, first.id, image("bob.png"), "bob");
  // Another uploader cannot bind it.
  assert.equal((await call(`/channels/${first.id}/messages`, { method: "POST", json: { clientId: crypto.randomUUID(), body: "x", attachmentIds: [bobsFile.id] } })).status, 422);
  // Another room cannot bind it.
  assert.equal((await call(`/channels/${second.id}/messages`, { method: "POST", json: { clientId: crypto.randomUUID(), body: "x", attachmentIds: [bobsFile.id] } })).status, 422);

  const alicesFile = await uploadFile(call, first.id, image("alice.png"), "alice");
  // A direct ownership change that did not reach the attachment row is the case the guard protects.
  db.prepare("UPDATE channels SET owner_id = 'bob' WHERE id = ?").run(first.id);
  assert.equal((await call(`/channels/${first.id}/messages`, { method: "POST", json: { clientId: crypto.randomUUID(), body: "x", attachmentIds: [alicesFile.id] } })).status, 409);
});

test("SVG is refused and a fake image is stored and served as an opaque download", async () => {
  const room = await createRoom(call, { name: "Types", visibility: "public" }, "alice");
  const svg = new File([Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>")], "logo.svg", { type: "image/svg+xml" });
  assert.equal((await call(`/channels/${room.id}/attachments`, { method: "POST", body: form(svg) })).status, 422);
  const fake = new File([Buffer.from("plain text pretending to be a PNG")], "notes.png", { type: "image/png" });
  const uploaded = await uploadFile(call, room.id, fake);
  assert.equal(uploaded.image, false);
  assert.equal(uploaded.mime, "application/octet-stream");
  await postMessage(call, room.id, { body: "Fake", attachmentIds: [uploaded.id] });
  const served = await call(uploaded.url.replace("/api", ""));
  assert.equal(served.headers.get("content-type"), "application/octet-stream");
  assert.match(served.headers.get("content-disposition") ?? "", /^attachment/);
  assert.equal(served.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  assert.equal(served.headers.get("x-content-type-options"), "nosniff");
  assert.equal(served.headers.get("cache-control"), "private, no-store");
});

test("quota and per-room limits leave no row or file", async () => {
  const room = await createRoom(call, { name: "Limits", visibility: "public" }, "alice");
  db.prepare("UPDATE users SET storage_limit = 10 WHERE id = 'alice'").run();
  const response = await call(`/channels/${room.id}/attachments`, { method: "POST", body: form(image()) });
  assert.equal(response.status, 413);
  assert.equal(attachmentBytes(room.id), 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM channel_attachments").get().n, 0);

  db.prepare("UPDATE users SET storage_limit = NULL WHERE id = 'alice'").run();
  const insert = db.prepare("INSERT INTO channel_attachments (id, channel_id, message_id, uploader_id, owner_id, name, mime, size, file, data, created_at) VALUES (?, ?, NULL, 'alice', 'alice', 'f', 'text/plain', 1, 0, ?, 1)");
  db.exec("BEGIN");
  for (let i = 0; i < CHANNEL_LIMITS.attachmentsPerRoom; i++) insert.run(`cat_fill_${i}`, room.id, Buffer.from("x"));
  db.exec("COMMIT");
  assert.equal((await call(`/channels/${room.id}/attachments`, { method: "POST", body: form(image()) })).status, 409);
});

test("deleting a room removes its media directory after commit", async () => {
  const room = await createRoom(call, { name: "Gone", visibility: "public" }, "alice");
  const attachment = await uploadFile(call, room.id, image(), "alice");
  const row = db.prepare("SELECT mime FROM channel_attachments WHERE id = ?").get(attachment.id) as { mime: string };
  const dir = path.join(CHANNEL_MEDIA_DIR, room.id);
  assert.equal(existsSync(dir), true);
  const detail = (await (await call(`/channels/${room.id}`)).json()) as { channel: { revision: number } };
  assert.equal((await call(`/channels/${room.id}`, { method: "DELETE", json: { revision: detail.channel.revision } })).status, 200);
  assert.equal(existsSync(channelAttachmentPath(room.id, attachment.id, row.mime)), false);
  assert.equal(existsSync(dir), false);
});

test("an attachment-only message is accepted, and it cannot request AI", async () => {
  const room = await createRoom(call, { name: "Only files", visibility: "public" }, "alice");
  const attachment = await uploadFile(call, room.id, image(), "alice");
  const posted = await postMessage(call, room.id, { body: "", attachmentIds: [attachment.id] }, "alice");
  assert.equal(posted.message.threadRootId, null);
  const { postHumanMessage } = await import("./store.js");
  assert.throws(
    () => postHumanMessage("alice", room.id, { clientId: crypto.randomUUID(), body: "", attachmentIds: [attachment.id], requestAi: true, requestHash: "h" }, () => ({ runId: "x" })),
    /text before asking/,
  );
});

function form(file: File): FormData {
  const body = new FormData();
  body.set("file", file);
  return body;
}
