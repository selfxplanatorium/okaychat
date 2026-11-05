import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { Hono } from "hono";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-channel-threads-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "channel-threads-test-secret-not-for-production";

const { db } = await import("../db.js");
const { api } = await import("../routes.js");
const { buildSnapshot } = await import("./ai.js");
const { channelRow } = await import("./access.js");
const { makeCall, seedUsers, createRoom, joinRoom, postMessage } = await import("./test-support.js");

const app = new Hono().route("/api", api);
const call = makeCall(app);

before(() => {
  seedUsers(db, [
    ["alice", "Alice"],
    ["bob", "Bob"],
    ["carol", "Carol"],
    ["dave", "Dave"],
  ]);
});

beforeEach(() => {
  db.exec("DELETE FROM channel_rate_windows; DELETE FROM notifications; DELETE FROM channel_thread_reads; DELETE FROM channel_thread_state; DELETE FROM channel_attachments; DELETE FROM channel_messages; DELETE FROM channel_members; DELETE FROM channels");
});

after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function roomWithMembers(): Promise<string> {
  const room = await createRoom(call, { name: "Threads", visibility: "public" }, "alice");
  await joinRoom(call, room.id, "bob");
  await joinRoom(call, room.id, "carol");
  await joinRoom(call, room.id, "dave");
  return room.id;
}

test("a reply updates the root badge and a reply-to-reply stays in the same thread", async () => {
  const id = await roomWithMembers();
  const root = await postMessage(call, id, { body: "Root" }, "alice");
  const first = await postMessage(call, id, { body: "First reply", threadRootId: root.message.id }, "bob");
  assert.equal(first.message.threadRootId, root.message.id);
  const second = await postMessage(call, id, { body: "Second reply", threadRootId: root.message.id, replyTo: first.message.id }, "carol");
  assert.equal(second.message.threadRootId, root.message.id);
  const detail = (await (await call(`/channels/${id}/messages/${root.message.id}`)).json()) as {
    message: { thread: { replyCount: number; lastReplySeq: number } | null };
  };
  assert.deepEqual(detail.message.thread && [detail.message.thread.replyCount, detail.message.thread.lastReplySeq], [2, second.message.seq]);
  // A reply cannot become a root.
  assert.equal(
    (await call(`/channels/${id}/messages`, { method: "POST", json: { clientId: crypto.randomUUID(), body: "Nested", threadRootId: first.message.id } })).status,
    422,
  );
});

test("thread pages order ascending, page backwards, and focus a requested reply", async () => {
  const id = await roomWithMembers();
  const root = await postMessage(call, id, { body: "Root" }, "alice");
  const replies = [];
  for (let i = 0; i < 4; i++) replies.push(await postMessage(call, id, { body: `Reply ${i}`, threadRootId: root.message.id }, "bob"));
  const page = (await (await call(`/channels/${id}/messages/${root.message.id}/thread`)).json()) as {
    root: { id: string };
    items: Array<{ id: string; seq: number }>;
    hasMore: boolean;
    focusId: string | null;
  };
  assert.equal(page.root.id, root.message.id);
  assert.deepEqual(page.items.map((item) => item.seq), replies.map((item) => item.message.seq));
  assert.equal(page.hasMore, false);
  assert.equal(page.focusId, null);

  const older = (await (await call(`/channels/${id}/messages/${replies[2]!.message.id}/thread?limit=2`)).json()) as {
    items: Array<{ seq: number }>;
    hasMore: boolean;
    nextBeforeSeq: number | null;
    focusId: string | null;
  };
  assert.deepEqual(older.items.map((item) => item.seq), [replies[2]!.message.seq, replies[3]!.message.seq]);
  assert.equal(older.focusId, replies[2]!.message.id);
  assert.equal(older.hasMore, true);
  assert.equal(older.nextBeforeSeq, replies[2]!.message.seq);

  const before = (await (await call(`/channels/${id}/messages/${root.message.id}/thread?beforeSeq=${replies[2]!.message.seq}&limit=2`)).json()) as {
    items: Array<{ seq: number }>;
  };
  assert.deepEqual(before.items.map((item) => item.seq), [replies[0]!.message.seq, replies[1]!.message.seq]);
});

test("a focus jump loads the page containing an old reply", async () => {
  const id = await roomWithMembers();
  const root = await postMessage(call, id, { body: "Root" }, "alice");
  const replies = [];
  for (let i = 0; i < 35; i++) replies.push(await postMessage(call, id, { body: `Reply ${i}`, threadRootId: root.message.id }, "bob"));
  const page = (await (await call(`/channels/${id}/messages/${root.message.id}/thread?focus=${replies[0]!.message.id}&limit=30`)).json()) as {
    items: Array<{ id: string }>;
    focusId: string | null;
    hasMore: boolean;
  };
  assert.equal(page.focusId, replies[0]!.message.id);
  assert.ok(page.items.some((item) => item.id === replies[0]!.message.id), "the oldest reply is reachable by focus");

  const middle = (await (await call(`/channels/${id}/messages/${root.message.id}/thread?focus=${replies[20]!.message.id}&limit=10`)).json()) as {
    items: Array<{ id: string }>;
    hasMore: boolean;
  };
  assert.ok(middle.items.some((item) => item.id === replies[20]!.message.id), "a middle reply is on the returned page");
  assert.equal(middle.hasMore, true);
});

test("thread read cursors are monotonic and the room dot follows the newest reply author", async () => {
  const id = await roomWithMembers();
  const root = await postMessage(call, id, { body: "Root" }, "alice");
  await call(`/channels/${id}/read`, { method: "POST", json: { throughSeq: root.message.seq }, user: "carol" });
  const first = await postMessage(call, id, { body: "First", threadRootId: root.message.id }, "bob");
  const second = await postMessage(call, id, { body: "Second", threadRootId: root.message.id }, "bob");
  const thread = (await (await call(`/channels/${id}/messages/${root.message.id}/thread`, { user: "alice" })).json()) as {
    root: { thread: { unread: number } };
    readSeq: number;
  };
  assert.equal(thread.root.thread.unread, 2);
  const read = (await (await call(`/channels/${id}/threads/${root.message.id}/read`, { method: "POST", json: { throughSeq: second.message.seq }, user: "alice" })).json()) as {
    readSeq: number;
    unread: number;
  };
  assert.equal(read.readSeq, second.message.seq);
  assert.equal(read.unread, 0);
  const again = (await (await call(`/channels/${id}/threads/${root.message.id}/read`, { method: "POST", json: { throughSeq: first.message.seq }, user: "alice" })).json()) as {
    readSeq: number;
  };
  assert.equal(again.readSeq, second.message.seq, "a lower cursor never moves back");

  const dot = async (user: string) => {
    const sync = (await (await call("/channels/sync", { user })).json()) as { items: Array<{ id: string; threadsUnread: number; unread: number }> };
    const item = sync.items.find((row) => row.id === id)!;
    return { threadsUnread: item.threadsUnread, unread: item.unread };
  };
  assert.equal((await dot("carol")).threadsUnread, 1);
  assert.equal((await dot("carol")).unread, 0, "replies never count as room unread");
  await postMessage(call, id, { body: "Carol's reply", threadRootId: root.message.id }, "carol");
  assert.equal((await dot("carol")).threadsUnread, 0, "your own newest reply hides the dot");
});

test("a threaded post cannot request AI and replies never enter the room transcript", async () => {
  const id = await roomWithMembers();
  const root = await postMessage(call, id, { body: "Visible question" }, "alice");
  const reply = await postMessage(call, id, { body: "Hidden reply", threadRootId: root.message.id }, "bob");
  assert.equal(
    (await call(`/channels/${id}/messages`, { method: "POST", json: { clientId: crypto.randomUUID(), body: "Ask", threadRootId: root.message.id, requestAi: true } })).status,
    422,
  );
  const snapshot = buildSnapshot(channelRow(id)!, root.message.id, "alice");
  assert.ok(!snapshot.entries.some((entry) => entry.messageId === reply.message.id));
});

test("thread replies notify the root author and mentions, never notify_mode all", async () => {
  const id = await roomWithMembers();
  // Dave opts into every message; the thread rule must still skip him.
  db.prepare("UPDATE channel_members SET notify_mode = 'all' WHERE channel_id = ? AND user_id = 'dave'").run(id);
  const root = await postMessage(call, id, { body: "Root" }, "bob");
  db.exec("DELETE FROM notifications");
  await postMessage(call, id, { body: "Reply @Carol", mentions: [{ userId: "carol", start: 6, end: 12 }], threadRootId: root.message.id }, "alice");
  const rows = db.prepare("SELECT user_id FROM notifications WHERE channel_id = ? ORDER BY user_id").all(id) as Array<{ user_id: string }>;
  assert.deepEqual(rows.map((row) => row.user_id), ["bob", "carol"]);
});

test("a thread has a bounded reply count", async () => {
  const id = await roomWithMembers();
  const root = await postMessage(call, id, { body: "Root" }, "alice");
  const insert = db.prepare(
    "INSERT INTO channel_messages (id, channel_id, seq, author_id, kind, body, thread_root, revision, created_at) VALUES (?, ?, ?, 'bob', 'human', 'reply', ?, 1, ?)",
  );
  const channel = channelRow(id)!;
  db.exec("BEGIN");
  for (let i = 0; i < 500; i++) insert.run(`cmsg_cap_${i}`, id, channel.next_seq + i, root.message.id, Date.now());
  db.prepare("UPDATE channels SET next_seq = ? WHERE id = ?").run(channel.next_seq + 500, id);
  db.exec("COMMIT");
  assert.equal(
    (await call(`/channels/${id}/messages`, { method: "POST", json: { clientId: crypto.randomUUID(), body: "Over", threadRootId: root.message.id } })).status,
    409,
  );
});

test("editing a reply emits its root id for thread invalidation", async () => {
  const id = await roomWithMembers();
  const root = await postMessage(call, id, { body: "Root" }, "alice");
  const reply = await postMessage(call, id, { body: "Reply", threadRootId: root.message.id }, "bob");
  const response = await call(`/channels/${id}/messages/${reply.message.id}`, {
    method: "PATCH", user: "bob", json: { revision: 1, body: "Edited reply" },
  });
  assert.equal(response.status, 200);
  const event = db.prepare("SELECT root_id FROM channel_events WHERE entity_id = ? AND kind = 'message.changed' ORDER BY id DESC LIMIT 1").get(reply.message.id);
  assert.equal(event.root_id, root.message.id);
});
