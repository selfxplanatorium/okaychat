import assert from "node:assert/strict";
import { test } from "node:test";
import { zipSync } from "fflate";
import { ROOM_ARCHIVE_FORMAT, ROOM_ARCHIVE_LIMITS, ROOM_ARCHIVE_VERSION, type RoomArchiveV1 } from "../../../shared/room-archive.js";
import { inspectZip, readZipEntry, sha256Hex, writeStoredZip, type ZipReadLimits } from "../../archive-zip.js";
import { readRoomManifest, RoomArchiveFormatError, scanManifestJson, validateRoomManifest } from "./format.js";

/**
 * Strict room manifest and container checks. Every fixture is built in memory, so these tests are
 * deterministic and never touch the database, the network, or the filesystem.
 */

const now = Date.UTC(2026, 0, 2, 3, 4, 5);
const text = (value: string) => new TextEncoder().encode(value);
const asset = text("archive asset");
const assetHash = sha256Hex(asset);

const base = (): RoomArchiveV1 => ({
  format: ROOM_ARCHIVE_FORMAT,
  version: ROOM_ARCHIVE_VERSION,
  exportedAt: now,
  room: {
    key: "room_1",
    name: "Archive room",
    description: "",
    icon: "hash",
    visibility: "private",
    archivedAt: null,
    createdAt: 1,
    updatedAt: 2,
  },
  selection: { mode: "all", includedReplies: true },
  identities: [],
  members: [],
  messages: [],
  assets: [],
});

const options = (sizes: Array<[string, number]> = []) => ({ now, assetSizes: new Map(sizes) });
const fails = (fn: () => unknown, code?: string) => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof RoomArchiveFormatError, `expected a format error, got ${String(error)}`);
    if (code) assert.equal(error.code, code);
    return error;
  }
  assert.fail("expected the archive to be rejected");
};

const withMessage = (manifest: RoomArchiveV1, over: Partial<RoomArchiveV1["messages"][number]> = {}) => {
  const message = {
    key: `m${manifest.messages.length + 1}`,
    order: manifest.messages.length + 1,
    kind: "human" as const,
    authorKey: null,
    body: "hello",
    createdAt: 10,
    editedAt: null,
    threadRootKey: null,
    quote: null,
    mentions: [],
    reactions: [],
    attachments: [],
    ...over,
  };
  manifest.messages.push(message);
  return message;
};

test("an empty room is valid and round trips through the strict reader", () => {
  const manifest = base();
  const zip = writeStoredZip([{ name: "manifest.json", bytes: text(JSON.stringify(manifest)) }]);
  const parsed = readRoomManifest(readZipEntry(zip, inspectZip(zip, zipLimits())[0]!, zipLimits()), options());
  assert.deepEqual(parsed.manifest.room, manifest.room);
  assert.equal(parsed.stats.roots, 0);
});

test("messages, threads, quotes, mentions and reactions keep their dense order", () => {
  const manifest = base();
  manifest.identities = [{ key: "id_a", localId: null, displayName: null, localProof: null }];
  manifest.members = [{ identityKey: "id_a", role: "owner", joinedAt: 1 }];
  const root = withMessage(manifest, { body: "Hello @A", mentions: [{ identityKey: "id_a", start: 6, end: 8 }], reactions: [{ identityKey: "id_a", emoji: "👍", createdAt: 11 }] });
  const reply = withMessage(manifest, { threadRootKey: root.key, quote: { kind: "message", messageKey: root.key }, createdAt: 12 });
  withMessage(manifest, { body: "second", quote: { kind: "unavailable" }, createdAt: 13 });
  const parsed = validateRoomManifest(manifest, options());
  assert.deepEqual(parsed.manifest.messages.map((message) => message.order), [1, 2, 3]);
  assert.equal(parsed.manifest.messages[1]!.quote?.kind, "message");
  assert.equal(parsed.stats.roots, 2);
  assert.equal(parsed.stats.replies, 1);
  assert.equal(parsed.stats.mentionRows, 1);
  assert.equal(parsed.stats.reactionRows, 1);
  assert.equal(reply.threadRootKey, root.key);
});

test("format, version, unknown fields, timestamps and identities are strict", () => {
  const wrong = base() as unknown as Record<string, unknown>;
  wrong.format = "okaychat.chat-archive";
  fails(() => validateRoomManifest(wrong, options()), "wrong_format");
  const future = base();
  future.version = 2 as never;
  fails(() => validateRoomManifest(future, options()), "unsupported_version");
  const unknown = base() as unknown as Record<string, unknown>;
  unknown.extra = true;
  fails(() => validateRoomManifest(unknown, options()));
  const overflow = base();
  overflow.exportedAt = now + 86_400_001;
  fails(() => validateRoomManifest(overflow, options()));
  const memberless = base();
  memberless.identities = [{ key: "id_a", localId: null, displayName: null, localProof: null }];
  fails(() => validateRoomManifest(memberless, options()));
  const badProof = base();
  badProof.identities = [{ key: "id_a", localId: "alice", displayName: "Alice", localProof: "not-a-proof" }];
  badProof.members = [{ identityKey: "id_a", role: "owner", joinedAt: 1 }];
  fails(() => validateRoomManifest(badProof, options()));
});

test("text, names, and mention spans reject what cannot be represented", () => {
  const crlf = base();
  withMessage(crlf, { body: "line\r\nnext" });
  fails(() => validateRoomManifest(crlf, options()));
  const control = base();
  withMessage(control, { body: "bell\u0007" });
  fails(() => validateRoomManifest(control, options()));
  const image = base();
  withMessage(image, { body: "![x](https://example.test/a.png)" });
  fails(() => validateRoomManifest(image, options()));
  const empty = base();
  withMessage(empty, { body: "   " });
  fails(() => validateRoomManifest(empty, options()));
  const noOwner = base();
  noOwner.members = [];
  noOwner.identities = [];
  assert.doesNotThrow(() => validateRoomManifest(noOwner, options()));
  const twoOwners = base();
  twoOwners.identities = [
    { key: "id_a", localId: null, displayName: null, localProof: null },
    { key: "id_b", localId: null, displayName: null, localProof: null },
  ];
  twoOwners.members = [
    { identityKey: "id_a", role: "owner", joinedAt: 1 },
    { identityKey: "id_b", role: "owner", joinedAt: 1 },
  ];
  fails(() => validateRoomManifest(twoOwners, options()));

  const split = base();
  split.identities = [{ key: "id_a", localId: null, displayName: null, localProof: null }];
  split.members = [{ identityKey: "id_a", role: "owner", joinedAt: 1 }];
  withMessage(split, { body: "a😀b", mentions: [{ identityKey: "id_a", start: 1, end: 2 }] });
  fails(() => validateRoomManifest(split, options()));
});

test("attachments, assets and the repeated-reference byte cap are enforced", () => {
  const manifest = base();
  manifest.assets = [{ key: assetHash, size: asset.byteLength }];
  const first = withMessage(manifest, { attachments: [{ key: "a1", asset: assetHash, name: "note.txt", declaredMime: "text/plain", createdAt: 11 }] });
  assert.doesNotThrow(() => validateRoomManifest(manifest, options([[assetHash, asset.byteLength]])));
  assert.equal(first.attachments.length, 1);

  const unsafe = base();
  unsafe.assets = [{ key: assetHash, size: asset.byteLength }];
  withMessage(unsafe, { attachments: [{ key: "a1", asset: assetHash, name: "../escape", declaredMime: "text/plain", createdAt: 11 }] });
  fails(() => validateRoomManifest(unsafe, options([[assetHash, asset.byteLength]])));

  const unreferenced = base();
  unreferenced.assets = [{ key: assetHash, size: asset.byteLength }];
  fails(() => validateRoomManifest(unreferenced, options([[assetHash, asset.byteLength]])));

  // Seven 10 MiB references to one deduplicated asset exceed the 64 MiB logical attachment cap.
  const tenMiB = 10 * 1024 * 1024;
  const repeated = base();
  repeated.assets = [{ key: assetHash, size: tenMiB }];
  const attachment = (index: number) => ({ key: `a${index}`, asset: assetHash, name: `f${index}.bin`, declaredMime: "application/octet-stream", createdAt: 11 });
  withMessage(repeated, { attachments: [1, 2, 3, 4, 5].map(attachment) });
  withMessage(repeated, { attachments: [6, 7].map(attachment) });
  fails(() => validateRoomManifest(repeated, options([[assetHash, tenMiB]])), "limit_exceeded");
});

test("count caps fail before the graph is walked", () => {
  const manifest = base();
  for (let index = 0; index < ROOM_ARCHIVE_LIMITS.messages + 1; index++) {
    manifest.messages.push({
      key: `m${index + 1}`,
      order: index + 1,
      kind: "human",
      authorKey: null,
      body: "x",
      createdAt: 10,
      editedAt: null,
      threadRootKey: null,
      quote: null,
      mentions: [],
      reactions: [],
      attachments: [],
    });
  }
  fails(() => validateRoomManifest(manifest, options()), "limit_exceeded");
});

test("the lexical pass rejects duplicate keys, excessive depth, and lone surrogates", () => {
  assert.throws(() => scanManifestJson(text('{"a":1,"a":2}')), /repeats an object property/);
  assert.throws(() => scanManifestJson(text(`${"[".repeat(ROOM_ARCHIVE_LIMITS.manifestDepth + 1)}0${"]".repeat(ROOM_ARCHIVE_LIMITS.manifestDepth + 1)}`)), /nested too deeply/);
  assert.throws(() => scanManifestJson(text('{"a":"\\ud800"}')), /invalid Unicode/);
  assert.throws(() => scanManifestJson(new Uint8Array([0xff, 0xfe])), /valid UTF-8/);
  assert.throws(() => scanManifestJson(text("\ufeff{}")), /byte order mark/);
});

const zipLimits = (over: Partial<ZipReadLimits> = {}): ZipReadLimits => ({
  maxInputBytes: ROOM_ARCHIVE_LIMITS.uploadBytes,
  maxExpandedBytes: ROOM_ARCHIVE_LIMITS.expandedBytes,
  maxEntryBytes: ROOM_ARCHIVE_LIMITS.assetMaxBytes,
  maxEntries: ROOM_ARCHIVE_LIMITS.entries,
  allow: (name) => name === "manifest.json" || /^assets\/[a-f0-9]{64}$/.test(name),
  ...over,
});

test("the container rejects traversal, unexpected names, expansion bombs and header lies", () => {
  const valid = writeStoredZip([{ name: "manifest.json", bytes: text("{}") }]);
  assert.equal(inspectZip(valid, zipLimits()).length, 1);
  assert.throws(() => inspectZip(zipSync({ "../evil": text("x"), "manifest.json": text("{}") }), zipLimits()), /escapes its folder/);
  assert.throws(() => inspectZip(zipSync({ "notes.txt": text("x") }), zipLimits()), /unexpected entry/);
  assert.throws(() => inspectZip(valid, zipLimits({ maxExpandedBytes: 1 })), /expands beyond/);
  assert.throws(() => inspectZip(new Uint8Array([...valid, 0]), zipLimits()), /trailing data|complete ZIP|inconsistent/);
  const lying = new Uint8Array(valid);
  new DataView(lying.buffer).setUint32(22, 99, true);
  assert.throws(() => inspectZip(lying, zipLimits()), /local header disagrees/);
});

test("a corrupted stored entry fails its CRC", () => {
  const zip = writeStoredZip([{ name: "manifest.json", bytes: text("{}") }]);
  const dataOffset = 30 + "manifest.json".length;
  const corrupted = new Uint8Array(zip);
  corrupted[dataOffset] = corrupted[dataOffset]! ^ 0xff;
  const entry = inspectZip(corrupted, zipLimits())[0]!;
  assert.throws(() => readZipEntry(corrupted, entry, zipLimits()), /integrity check/);
});
