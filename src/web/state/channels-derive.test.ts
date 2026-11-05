import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChannelMessage, ChannelSummary } from "@shared/channels";
import { capMessages, mergeRoomMessages, mergeMessage, mergeMessages, nextUnreadAfter, totalUnread } from "./channels-derive";
import { dmTitle, dmsOf, mergeThread, roomsOf, threadLabel } from "./channels-derive";

const message = (id: string, seq: number, revision = 1, deleted = false): ChannelMessage => ({
  id,
  channelId: "c",
  seq,
  kind: "human",
  author: { id: "u", name: "U" },
  body: deleted ? "" : `body ${id}`,
  replyTo: null,
  mentions: [],
  reactions: [],
  revision,
  createdAt: seq,
  editedAt: null,
  deletedAt: deleted ? 1 : null,
  aiRun: null,
  threadRootId: null,
  thread: null,
  attachments: [],
});

const room = (id: string, unread: number): ChannelSummary => ({
  id,
  name: id,
  description: "",
  icon: "hash",
  visibility: "public",
  ownerId: "u",
  archivedAt: null,
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  membership: { role: "member", readSeq: 0, notifyMode: "mentions" },
  memberCount: 1,
  unread,
  mentionsUnread: 0,
  ai: null,
  capabilities: { post: true, moderate: false, manage: false, requestAi: false, attach: true, thread: true },
  kind: "room",
  dmMembers: null,
  threadsUnread: 0,
});

test("a stale HTTP response cannot resurrect deleted or newer text", () => {
  const current = message("m", 1, 4, true);
  assert.equal(mergeMessage(current, message("m", 1, 3)).revision, 4);
  assert.equal(mergeMessage(current, message("m", 1, 5)).body, "body m");
  assert.equal(mergeMessages([current], [message("m", 1, 2)]).length, 1);
});

test("merge sorts, dedupes, caps, and counts unread", () => {
  assert.deepEqual(mergeMessages([message("a", 2)], [message("b", 1), message("a", 2)]).map((m) => m.seq), [1, 2]);
  const capped = capMessages([1, 2, 3].map((seq) => message(`m${seq}`, seq)), 2);
  assert.deepEqual(capped.map((m) => m.seq), [2, 3]);
  assert.equal(totalUnread([room("a", 3), room("b", 4)]), 7);
  assert.equal(nextUnreadAfter([room("a", 1), room("b", 0), room("c", 2)], "a")?.id, "c");
});

const dm = (id: string, members: Array<{ id: string; name: string }>): ChannelSummary => ({
  ...room(id, 0),
  kind: "dm",
  name: "",
  dmMembers: members,
});

test("rooms and DMs split cleanly, and a DM title uses the other members", () => {
  const a = room("a", 0);
  const b = dm("b", [{ id: "u", name: "Me" }, { id: "v", name: "Vera" }]);
  const c = dm("c", [{ id: "u", name: "Me" }, { id: "v", name: "Vera" }, { id: "w", name: "Wes" }]);
  const gone = dm("d", [{ id: "u", name: "Me" }]);
  assert.deepEqual(roomsOf([a, b, c]).map((item) => item.id), ["a"]);
  assert.deepEqual(dmsOf([a, b, c]).map((item) => item.id), ["b", "c"]);
  assert.equal(dmTitle(b, "u"), "Vera");
  assert.match(dmTitle(c, "u"), /Vera/);
  assert.match(dmTitle(c, "u"), /Wes/);
  assert.equal(dmTitle(gone, "u"), "Deleted account");
});

test("thread labels and merges never move a cursor backwards or drop loaded replies", () => {
  assert.equal(threadLabel(null), "none");
  assert.equal(threadLabel({ replyCount: 2, lastReplySeq: 3, lastReplyAt: 1, unread: 0 }), "replies");
  assert.equal(threadLabel({ replyCount: 2, lastReplySeq: 3, lastReplyAt: 1, unread: 1 }), "unread");
  const root = message("root", 1);
  const page = {
    root,
    items: [message("r1", 2)],
    focusId: null,
    nextBeforeSeq: 2,
    hasMore: false,
    readSeq: 2,
    replyCount: 1,
    channelRevision: 1,
    cursor: "c",
  };
  const merged = mergeThread({ root: null, items: [message("r2", 3)], nextBeforeSeq: null, hasMore: false, readSeq: 3, replyCount: 1, openedAt: 1 }, page);
  assert.deepEqual(merged.items.map((item) => item.seq), [2, 3]);
  assert.equal(merged.readSeq, 3, "a page with an older cursor never lowers the read position");
  assert.equal(merged.root?.id, "root");
});

test("reply invalidations never enter the room timeline or advance its newest sequence", () => {
  const root = message("root", 1);
  const reply = { ...message("reply", 5), threadRootId: root.id };
  assert.deepEqual(mergeRoomMessages([root], [reply]), [root]);
  assert.deepEqual(mergeRoomMessages([root, reply], [{ ...reply, revision: 2, body: "edited" }]), [root]);
});
