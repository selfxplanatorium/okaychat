import assert from "node:assert/strict";
import { test } from "node:test";
import { ARCHIVE_LIMITS, archiveWithinLimits, isAssetHash, isArchiveKey } from "./chat-archive.js";
import type { ArchiveManifest } from "./chat-archive.js";

const manifest = (chats: ArchiveManifest["chats"]): ArchiveManifest => ({ format: "okaychat.chat-archive", version: 1, exportedAt: 1, chats, assets: [] });

const chat = (messages: number) => ({
  key: "chat_1",
  title: "Chat",
  createdAt: 1,
  updatedAt: 2,
  status: "regular" as const,
  modelRef: null,
  selectedLeaf: null,
  messages: Array.from({ length: messages }, (_, index) => ({
    key: `m${index}`,
    parentKey: index ? `m${index - 1}` : null,
    createdAt: index,
    role: "user" as const,
    parts: [{ type: "text" as const, text: "x" }],
  })),
  artifacts: [],
  assistant: null,
});

test("archive keys and asset hashes have exact shapes", () => {
  assert.equal(isArchiveKey("chat_1"), true);
  assert.equal(isArchiveKey("../evil"), false);
  assert.equal(isArchiveKey("a".repeat(101)), false);
  assert.equal(isAssetHash("a".repeat(64)), true);
  assert.equal(isAssetHash("A".repeat(64)), false);
});

test("manifest container limits are checked before deep validation", () => {
  assert.equal(archiveWithinLimits(manifest([chat(2)])), null);
  assert.match(archiveWithinLimits(manifest(Array.from({ length: ARCHIVE_LIMITS.chats + 1 }, (_, index) => ({ ...chat(1), key: `chat_${index}` })))) ?? "", /too many chats/);
  assert.match(archiveWithinLimits(manifest([chat(ARCHIVE_LIMITS.messages + 1)])) ?? "", /too many messages/);
  const manyParts = chat(1);
  manyParts.messages[0]!.parts = Array.from({ length: ARCHIVE_LIMITS.partsPerMessage + 1 }, () => ({ type: "text" as const, text: "x" }));
  assert.match(archiveWithinLimits(manifest([manyParts])) ?? "", /too many parts/);
});
