import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { Hono } from "hono";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-channel-dms-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "channel-dms-test-secret-not-for-production";

const { db } = await import("../db.js");
const { api } = await import("../routes.js");
const { storageUsed } = await import("../quota.js");
const { makeCall, seedUsers, createRoom, joinRoom, postMessage, uploadFile } = await import("./test-support.js");

const app = new Hono().route("/api", api);
const call = makeCall(app);

before(() => {
  seedUsers(db, [
    ["alice", "Alice"],
    ["bob", "Bob"],
    ["carol", "Carol"],
    ["dave", "Dave"],
    ["root", "Root", "admin"],
  ]);
  db.prepare("INSERT INTO user_groups (id, name, created_at, prompt_order) VALUES ('g1', 'Group one', 1, 10)").run();
  db.prepare("INSERT INTO user_group_members (group_id, user_id) VALUES ('g1','alice'), ('g1','bob'), ('g1','carol')").run();
});

beforeEach(() => {
  db.exec("DELETE FROM channel_rate_windows; DELETE FROM notifications; DELETE FROM channel_dm_blocks; DELETE FROM channel_attachments; DELETE FROM channel_messages; DELETE FROM channel_members; DELETE FROM channels");
});

after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function createDm(user: string, userIds: string[]): Promise<{ id: string; status: number; body: { channel: { id: string; kind: string; dmMembers: Array<{ id: string }> | null } } }> {
  const response = await call("/channels/dms", { method: "POST", json: { clientId: crypto.randomUUID(), userIds }, user });
  return { id: (response as unknown as { id?: string }).id ?? "", status: response.status, body: (await response.json()) as { channel: { id: string; kind: string; dmMembers: Array<{ id: string }> | null } } };
}

test("a 1:1 DM appears for both members, reuses its dm_key, and never duplicates", async () => {
  const first = await createDm("alice", ["bob"]);
  assert.equal(first.status, 201);
  assert.equal(first.body.channel.kind, "dm");
  assert.deepEqual(first.body.channel.dmMembers?.map((member) => member.id), ["alice", "bob"]);
  const again = await createDm("alice", ["bob"]);
  assert.equal(again.status, 200);
  assert.equal(again.body.channel.id, first.body.channel.id);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM channels WHERE kind = 'dm'").get().n, 1);
  for (const user of ["alice", "bob"]) {
    const sync = (await (await call("/channels/sync", { user })).json()) as { items: Array<{ id: string; kind: string; dmMembers: unknown[] }> };
    assert.ok(sync.items.some((item) => item.id === first.body.channel.id && item.kind === "dm" && item.dmMembers.length === 2));
  }
  const group = await createDm("alice", ["bob", "carol"]);
  assert.notEqual(group.body.channel.id, first.body.channel.id);
});

test("DM creation and lookup require a shared group unless the caller is an admin", async () => {
  assert.equal((await createDm("alice", ["dave"])).status, 403);
  assert.equal((await createDm("root", ["dave"])).status, 201);
  const people = async (user: string, email: string) => {
    const response = await call(`/channels/people?q=${encodeURIComponent(email)}`, { user });
    return ((await response.json()) as { items: Array<{ id: string }> }).items;
  };
  assert.deepEqual(await people("alice", "bob@example.test"), [{ id: "bob", name: "Bob" }]);
  assert.deepEqual(await people("alice", "dave@example.test"), []);
  assert.deepEqual(await people("alice", "nobody@example.test"), []);
});

test("the member cap and owner-only additions are enforced", async () => {
  const dm = await createDm("alice", ["bob"]);
  assert.equal((await call(`/channels/${dm.body.channel.id}/members`, { method: "POST", json: { userIds: ["carol"] }, user: "alice" })).status, 200);
  assert.equal((await call(`/channels/${dm.body.channel.id}/members`, { method: "POST", json: { userIds: ["dave"] }, user: "bob" })).status, 403);
  const members = db.prepare("SELECT user_id FROM channel_members WHERE channel_id = ? ORDER BY joined_at, user_id").all(dm.body.channel.id) as Array<{ user_id: string }>;
  assert.deepEqual(members.map((row) => row.user_id), ["alice", "bob", "carol"]);
});

test("adding a member rekeys the DM, so the original pair gets its own 1:1", async () => {
  const dm = await createDm("alice", ["bob"]);
  assert.equal((await call(`/channels/${dm.body.channel.id}/members`, { method: "POST", json: { userIds: ["carol"] }, user: "alice" })).status, 200);
  const pair = await createDm("alice", ["bob"]);
  assert.equal(pair.status, 201);
  assert.notEqual(pair.body.channel.id, dm.body.channel.id);
  assert.deepEqual(pair.body.channel.dmMembers?.map((member) => member.id), ["alice", "bob"]);
  const group = await createDm("bob", ["alice", "carol"]);
  assert.equal(group.status, 200);
  assert.equal(group.body.channel.id, dm.body.channel.id);
});

test("leaving transfers ownership, and the last member deletes the conversation and frees storage", async () => {
  const dm = await createDm("alice", ["bob", "carol"]);
  assert.equal((await call(`/channels/${dm.body.channel.id}/leave`, { method: "POST", json: {}, user: "alice" })).status, 200);
  const owner = db.prepare("SELECT owner_id FROM channels WHERE id = ?").get(dm.body.channel.id) as { owner_id: string };
  assert.equal(owner.owner_id, "bob");
  assert.equal((await call(`/channels/${dm.body.channel.id}/leave`, { method: "POST", json: {}, user: "bob" })).status, 200);
  assert.equal((await call(`/channels/${dm.body.channel.id}/leave`, { method: "POST", json: {}, user: "carol" })).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM channels WHERE id = ?").get(dm.body.channel.id).n, 0);
});

test("blocking leaves a 2-member DM and blocks creation both ways; group DMs stay", async () => {
  const pair = await createDm("alice", ["bob"]);
  const group = await createDm("alice", ["bob", "carol"]);
  assert.equal((await call(`/channels/dm-blocks/${"bob"}`, { method: "POST", json: {}, user: "alice" })).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM channel_members WHERE channel_id = ?").get(pair.body.channel.id).n, 1, "the blocker leaves; the other member keeps the conversation");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM channels WHERE id = ?").get(group.body.channel.id).n, 1, "a group DM is untouched");
  assert.equal((await createDm("alice", ["bob"])).status, 409);
  assert.equal((await createDm("bob", ["alice"])).status, 409);
  const blocks = (await (await call("/channels/dm-blocks", { user: "alice" })).json()) as { items: Array<{ id: string }> };
  assert.deepEqual(blocks.items.map((item) => item.id), ["bob"]);
  assert.equal((await call(`/channels/dm-blocks/${"bob"}`, { method: "DELETE", user: "alice" })).status, 200);
  // Unblocking restores messaging; the old conversation is still there, so the caller must be added back.
  assert.equal((await createDm("alice", ["bob"])).status, 409);
});

test("DMs stay out of discovery, search, admin lists, and room-only routes", async () => {
  const dm = await createDm("alice", ["bob"]);
  await postMessage(call, dm.body.channel.id, { body: "Secret words" }, "alice");
  const discover = (await (await call("/channels?scope=discover", { user: "carol" })).json()) as { items: Array<{ id: string }> };
  assert.ok(!discover.items.some((item) => item.id === dm.body.channel.id));
  const search = (await (await call("/channels/search?q=Secret", { user: "bob" })).json()) as { items: Array<{ channelId: string }> };
  assert.ok(!search.items.some((item) => item.channelId === dm.body.channel.id), "global search is rooms only");
  const inRoom = (await (await call(`/channels/search?q=Secret&channelId=${dm.body.channel.id}`, { user: "bob" })).json()) as { items: unknown[] };
  assert.equal(inRoom.items.length, 1, "a member can search their own DM");

  assert.equal((await call(`/admin/channels/${dm.body.channel.id}/messages?reason=cleanup`, { user: "root" })).status, 404);
  assert.equal((await call(`/admin/channels/${dm.body.channel.id}/moderate`, { method: "POST", user: "root", json: { action: "archive", revision: 1, reason: "cleanup" } })).status, 404);
  const adminList = (await (await call("/admin/channels", { user: "root" })).json()) as { items: Array<{ id: string }> };
  assert.ok(!adminList.items.some((item) => item.id === dm.body.channel.id));

  assert.equal((await call(`/channels/${dm.body.channel.id}/join`, { method: "POST", json: {}, user: "carol" })).status, 403);
  assert.equal((await call(`/channels/${dm.body.channel.id}`, { method: "PATCH", user: "alice", json: { revision: 1, name: "Nope" } })).status, 403);
  assert.equal((await call(`/channels/${dm.body.channel.id}/archive`, { method: "POST", user: "alice", json: { revision: 1, archived: true } })).status, 403);
  assert.equal((await call(`/channels/${dm.body.channel.id}/ai-runs`, { method: "POST", user: "alice", json: { clientId: crypto.randomUUID(), sourceId: "x" } })).status, 403);
});

test("AI is refused on both DM entry points", async () => {
  const dm = await createDm("alice", ["bob"]);
  const posted = await postMessage(call, dm.body.channel.id, { body: "Question" }, "alice");
  const response = await call(`/channels/${dm.body.channel.id}/messages`, {
    method: "POST",
    user: "alice",
    json: { clientId: crypto.randomUUID(), body: "Ask", requestAi: true },
  });
  assert.equal(response.status, 422);
  assert.equal(
    (await call(`/channels/${dm.body.channel.id}/ai-runs`, { method: "POST", user: "alice", json: { clientId: crypto.randomUUID(), sourceId: posted.message.id } })).status,
    403,
  );
});

test("DM notices reach every other member by default", async () => {
  const dm = await createDm("alice", ["bob", "carol"]);
  await postMessage(call, dm.body.channel.id, { body: "Hello" }, "alice");
  const rows = db.prepare("SELECT user_id FROM notifications WHERE channel_id = ? ORDER BY user_id").all(dm.body.channel.id) as Array<{ user_id: string }>;
  assert.deepEqual(rows.map((row) => row.user_id), ["bob", "carol"]);
});

test("deleting a DM owner removes it without an audit row and frees its attachments", async () => {
  const dm = await createDm("alice", ["bob"]);
  const file = new File([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64")], "dot.png", { type: "image/png" });
  await uploadFile(call, dm.body.channel.id, file, "alice");
  const used = storageUsed("alice");
  assert.equal((await call(`/channels/${dm.body.channel.id}`, { method: "DELETE", user: "alice", json: { revision: 1 } })).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM channels WHERE id = ?").get(dm.body.channel.id).n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM channel_moderation_audit WHERE channel_id = ?").get(dm.body.channel.id).n, 0);
  assert.ok(storageUsed("alice") < used);
});
