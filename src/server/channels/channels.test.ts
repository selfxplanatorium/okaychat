import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { Hono } from "hono";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-channels-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "channels-test-secret-only-not-for-production";

const { db } = await import("../db.js");
const { sha256 } = await import("../crypto.js");
const { api } = await import("../routes.js");

const app = new Hono().route("/api", api);
const call = (url: string, init: { method?: string; json?: unknown; user?: string } = {}) =>
  app.request(`http://app/api${url}`, {
    method: init.method ?? "GET",
    headers: { cookie: `okaychat_session=${init.user ?? "alice"}`, ...(init.json !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });

const createRoom = async (input: Record<string, unknown>, user = "alice") => {
  const response = await call("/channels", { method: "POST", json: { clientId: crypto.randomUUID(), ...input }, user });
  return { response, body: (await response.json()) as { channel: { id: string; revision: number } } };
};

before(() => {
  for (const [id, name] of [["alice", "Alice"], ["bob", "Bob"], ["carol", "Carol"], ["root", "Root"]]) {
    db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, 'unused', ?, 1)").run(
      id,
      `${id}@example.test`,
      name,
      id === "root" ? "admin" : "user",
    );
    db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(id), id, Date.now() + 3_600_000);
  }
  db.prepare("INSERT INTO user_groups (id, name, created_at, prompt_order) VALUES ('g1', 'Group one', 1, 10)").run();
  db.prepare("INSERT INTO user_group_members (group_id, user_id) VALUES ('g1', 'bob'), ('g1', 'alice')").run();
});

after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("public rooms are discoverable, joinable, searchable, and counted as unread", async () => {
  const { response, body } = await createRoom({ name: "General", visibility: "public" });
  assert.equal(response.status, 201);
  const roomId = body.channel.id;

  const discover = (await (await call("/channels?scope=discover", { user: "bob" })).json()) as { items: Array<{ id: string }> };
  assert.ok(discover.items.some((item) => item.id === roomId));

  assert.equal((await call(`/channels/${roomId}/join`, { method: "POST", json: {}, user: "bob" })).status, 200);

  const clientId = crypto.randomUUID();
  const posted = await call(`/channels/${roomId}/messages`, {
    method: "POST",
    json: { clientId, body: "Hello @Bob", mentions: [{ userId: "bob", start: 6, end: 10 }] },
  });
  assert.equal(posted.status, 201);
  const first = (await posted.json()) as { message: { id: string } };

  const sync = (await (await call("/channels/sync", { user: "bob" })).json()) as {
    items: Array<{ id: string; unread: number; mentionsUnread: number; membership: { readSeq: number } | null }>;
  };
  const joined = sync.items.find((item) => item.id === roomId)!;
  assert.equal(joined.unread, 1);
  assert.equal(joined.mentionsUnread, 1);

  const search = (await (await call(`/channels/search?q=Hello&channelId=${roomId}`, { user: "bob" })).json()) as { items: Array<{ messageId: string }> };
  assert.equal(search.items.length, 1);

  const read = (await (await call(`/channels/${roomId}/read`, { method: "POST", json: { throughSeq: 1 }, user: "bob" })).json()) as {
    unread: number;
    mentionsUnread: number;
  };
  assert.equal(read.unread, 0);
  assert.equal(read.mentionsUnread, 0);

  // Replaying the same client id returns the stored projection instead of a second message.
  const replay = await call(`/channels/${roomId}/messages`, {
    method: "POST",
    json: { clientId, body: "Hello @Bob", mentions: [{ userId: "bob", start: 6, end: 10 }] },
  });
  assert.equal(replay.status, 200);
  assert.equal(((await replay.json()) as { message: { id: string } }).message.id, first.message.id);
});

test("private rooms never appear in discover, search, or a nonmember read", async () => {
  const { body } = await createRoom({ name: "Secret", visibility: "private" });
  const roomId = body.channel.id;
  const discover = (await (await call("/channels?scope=discover", { user: "carol" })).json()) as { items: Array<{ id: string }> };
  assert.ok(!discover.items.some((item) => item.id === roomId));
  assert.equal((await call(`/channels/${roomId}`, { user: "carol" })).status, 404);
  assert.equal((await call(`/channels/${roomId}/messages`, { user: "carol" })).status, 404);
  assert.equal((await call(`/channels/${roomId}/join`, { method: "POST", json: {}, user: "carol" })).status, 404);
  // The owner sees it.
  assert.equal((await call(`/channels/${roomId}`)).status, 200);
});

test("group rooms follow live group membership and close on group removal", async () => {
  const { response, body } = await createRoom({ name: "Group room", visibility: "group", groupIds: ["g1"] });
  assert.equal(response.status, 201);
  const roomId = body.channel.id;
  assert.equal((await call(`/channels/${roomId}/join`, { method: "POST", json: {}, user: "bob" })).status, 200);
  assert.equal((await call(`/channels/${roomId}/messages`, { user: "bob" })).status, 200);
  assert.equal((await call(`/channels/${roomId}`, { user: "carol" })).status, 404);

  db.prepare("DELETE FROM user_group_members WHERE group_id = 'g1' AND user_id = 'bob'").run();
  // Eligibility is checked on every read, so a stale session cannot keep reading the room.
  assert.equal((await call(`/channels/${roomId}/messages`, { user: "bob" })).status, 404);
  assert.equal((await call(`/channels/${roomId}`, { user: "bob" })).status, 404);
});

test("admin moderation is separate from room membership and requires a reason", async () => {
  const { body } = await createRoom({ name: "Moderated", visibility: "private" });
  const roomId = body.channel.id;
  assert.equal((await call("/admin/channels", { user: "carol" })).status, 403);
  assert.equal((await call(`/admin/channels/${roomId}/messages`, { user: "root" })).status, 400);
  assert.equal((await call(`/admin/channels/${roomId}/messages?reason=cleanup`, { user: "root" })).status, 200);
  // Inspection did not fabricate membership.
  assert.equal((await call(`/channels/${roomId}`, { user: "root" })).status, 404);
});

test("a tampered event cursor is rejected and a fresh sync cursor is usable", async () => {
  const sync = (await (await call("/channels/sync")).json()) as { cursor: string };
  assert.equal((await call(`/channels/changes?cursor=${encodeURIComponent(sync.cursor)}`)).status, 200);
  assert.equal((await call("/channels/changes?cursor=not-a-cursor")).status, 400);
  const tampered = `${sync.cursor.slice(0, -2)}aa`;
  assert.equal((await call(`/channels/changes?cursor=${encodeURIComponent(tampered)}`)).status, 400);
});

test("a tombstoned quote is unavailable and deleting a room removes replies cleanly", async () => {
  const { body } = await createRoom({ name: "Quotes", visibility: "public" });
  const roomId = body.channel.id;
  const first = (await (await call(`/channels/${roomId}/messages`, {
    method: "POST",
    json: { clientId: crypto.randomUUID(), body: "Original" },
  })).json()) as { message: { id: string; revision: number; seq: number } };
  const second = (await (await call(`/channels/${roomId}/messages`, {
    method: "POST",
    json: { clientId: crypto.randomUUID(), body: "Reply", replyTo: first.message.id },
  })).json()) as { message: { id: string } };

  assert.equal(
    (await call(`/channels/${roomId}/messages/${first.message.id}`, { method: "DELETE", json: { revision: first.message.revision } })).status,
    200,
  );
  const reply = (await (await call(`/channels/${roomId}/messages/${second.message.id}`)).json()) as {
    message: { body: string; replyTo: { deleted: boolean; excerpt: string } | null };
  };
  assert.equal(reply.message.body, "Reply");
  assert.equal(reply.message.replyTo?.deleted, true);
  assert.equal(reply.message.replyTo?.excerpt, "");

  const detail = (await (await call(`/channels/${roomId}`)).json()) as { channel: { revision: number } };
  assert.equal((await call(`/channels/${roomId}`, { method: "DELETE", json: { revision: detail.channel.revision } })).status, 200);
  assert.equal((await call(`/channels/${roomId}/messages`)).status, 404);
});

test("event polling advances through visible invalidations and hides other rooms", async () => {
  const sync = (await (await call("/channels/sync")).json()) as { items: Array<{ id: string; visibility: string }> };
  const roomId = sync.items.find((room) => room.visibility === "private")!.id;
  const bobCursor = ((await (await call("/channels/sync", { user: "bob" })).json()) as { cursor: string }).cursor;
  const aliceCursor = ((await (await call("/channels/sync")).json()) as { cursor: string }).cursor;
  await call(`/channels/${roomId}/messages`, { method: "POST", json: { clientId: crypto.randomUUID(), body: "private event" } });
  const bob = (await (await call(`/channels/changes?cursor=${encodeURIComponent(bobCursor)}`, { user: "bob" })).json()) as {
    events: Array<{ event: { channelId?: string } }>;
    cursor: string;
  };
  // Bob is not a member: nothing about the private room reaches him, but his cursor still advanced.
  assert.ok(!bob.events.some((frame) => frame.event.channelId === roomId));
  assert.notEqual(bob.cursor, bobCursor);
  const alice = (await (await call(`/channels/changes?cursor=${encodeURIComponent(aliceCursor)}`)).json()) as { events: Array<{ event: { channelId?: string } }> };
  assert.ok(alice.events.some((frame) => frame.event.channelId === roomId));
});
