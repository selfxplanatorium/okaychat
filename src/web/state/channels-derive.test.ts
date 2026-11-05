import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChannelMessage, ChannelSummary } from "@shared/channels";
import { capMessages, mergeMessage, mergeMessages, nextUnreadAfter, totalUnread } from "./channels-derive";

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
  capabilities: { post: true, moderate: false, manage: false, requestAi: false },
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
