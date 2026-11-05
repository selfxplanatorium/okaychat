import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { Hono } from "hono";
import { ROOM_ARCHIVE_FORMAT, ROOM_ARCHIVE_LIMITS, ROOM_ARCHIVE_VERSION, type RoomArchiveInspectResult, type RoomArchiveJob, type RoomArchiveV1 } from "../../../shared/room-archive.js";

/**
 * Room archive lifecycle against real SQLite and a temp data directory. Jobs run through the same
 * in-process worker as production; the tests wait on the durable row, not on a timer that guesses.
 */

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-room-archive-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "room-archive-test-secret-only-not-for-production";

const { db } = await import("../../db.js");
const { sha256, newId } = await import("../../crypto.js");
const { api } = await import("../../routes.js");
const { storageUsed } = await import("../../quota.js");
const { channelStorageBytes, createRunInTx } = await import("../store.js");
const { channelRow } = await import("../access.js");
const { roomIdentityProof } = await import("./identity.js");
const { getRoomJobById, stageDir } = await import("./jobs.js");
const { recoverRoomArchiveJobs } = await import("./maintenance.js");
const { sha256Hex, writeStoredZip } = await import("../../archive-zip.js");

const app = new Hono().route("/api", api);
const call = (url: string, init: { method?: string; json?: unknown; user?: string; body?: Uint8Array; contentType?: string } = {}) =>
  app.request(`http://app/api${url}`, {
    method: init.method ?? "GET",
    headers: {
      cookie: `okaychat_session=${init.user ?? "alice"}`,
      ...(init.json !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.contentType ? { "content-type": init.contentType } : {}),
    },
    body: init.body ?? (init.json !== undefined ? JSON.stringify(init.json) : undefined),
  });
const json = async <T>(res: Response) => (await res.json()) as T;

const USERS = [
  ["alice", "Alice", "user"],
  ["bob", "Bob", "user"],
  ["carol", "Carol", "user"],
  ["root", "Root", "admin"],
] as const;

before(() => {
  for (const [id, name, role] of USERS) {
    db.prepare("INSERT OR IGNORE INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, 'unused', ?, 1)").run(id, `${id}@example.test`, name, role);
    db.prepare("INSERT OR IGNORE INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(id), id, Date.now() + 3_600_000);
  }
  db.prepare("INSERT OR IGNORE INTO user_groups (id, name, created_at, prompt_order) VALUES ('g_archive', 'Archive test group', 1, 10)").run();
  db.prepare("INSERT OR IGNORE INTO user_group_members (group_id, user_id) VALUES ('g_archive', 'alice'), ('g_archive', 'bob')").run();
});

beforeEach(() => {
  for (const [id, name, role] of USERS) {
    db.prepare("INSERT OR IGNORE INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, 'unused', ?, 1)").run(id, `${id}@example.test`, name, role);
    db.prepare("INSERT OR IGNORE INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(id), id, Date.now() + 3_600_000);
  }
  db.exec(`
    DELETE FROM room_archive_jobs;
    DELETE FROM channel_import_identities;
    DELETE FROM channel_rate_windows;
    DELETE FROM channel_moderation_audit;
    DELETE FROM channel_ai_runs;
    DELETE FROM channel_reactions;
    DELETE FROM channel_mentions;
    DELETE FROM channel_attachments;
    DELETE FROM channel_thread_reads;
    DELETE FROM channel_thread_state;
    DELETE FROM channel_messages;
    DELETE FROM channel_invites;
    DELETE FROM channel_exclusions;
    DELETE FROM channel_members;
    DELETE FROM channel_groups;
    DELETE FROM channel_dm_blocks;
    DELETE FROM channel_events;
    DELETE FROM channels;
    UPDATE users SET storage_limit = NULL;
  `);
  rmSync(path.join(dataDir, "channel-media"), { recursive: true, force: true });
  rmSync(path.join(dataDir, "room-archive-staging"), { recursive: true, force: true });
});

after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function waitJob(jobId: string, accept: (job: RoomArchiveJob) => boolean, timeout = 10_000): Promise<RoomArchiveJob> {
  const started = Date.now();
  let latest: RoomArchiveJob | null = null;
  while (Date.now() - started < timeout) {
    const row = getRoomJobById(jobId);
    if (!row) throw new Error("job disappeared");
    latest = {
      id: row.id,
      kind: row.kind,
      state: row.state,
      phase: row.phase,
      expiresAt: row.expires_at,
      cancelRequested: row.cancel_requested === 1,
      cleanupPending: row.reservation_bytes > 0 && ["done", "failed", "cancelled", "expired"].includes(row.state),
      progress: { unit: "bytes", done: row.progress_done, total: row.progress_total },
      summary: row.summary_json ? (JSON.parse(row.summary_json) as RoomArchiveJob["summary"]) : null,
      result: row.result_json ? (JSON.parse(row.result_json) as RoomArchiveJob["result"]) : null,
      error: row.error_code ? { code: row.error_code } : null,
    };
    if (accept(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`job did not settle: ${JSON.stringify(latest)}`);
}

const ready = (job: RoomArchiveJob) => job.state === "ready" || job.state === "failed" || job.state === "cancelled" || job.state === "expired";
const done = (job: RoomArchiveJob) => job.state === "done" || job.state === "failed" || job.state === "ready" || job.state === "cancelled";

async function createRoom(user = "alice", name = "Archive room", visibility: "public" | "private" = "public"): Promise<string> {
  const res = await call("/channels", { method: "POST", user, json: { clientId: crypto.randomUUID(), name, visibility, icon: "hash" } });
  assert.equal(res.status, 201, await res.clone().text());
  return (await json<{ channel: { id: string } }>(res)).channel.id;
}

async function post(roomId: string, user: string, body: string, extra: Record<string, unknown> = {}): Promise<{ id: string; revision: number; seq: number }> {
  const res = await call(`/channels/${roomId}/messages`, { method: "POST", user, json: { clientId: crypto.randomUUID(), body, ...extra } });
  assert.equal(res.status, 201, await res.clone().text());
  return (await json<{ message: { id: string; revision: number; seq: number } }>(res)).message;
}

function addAttachment(roomId: string, messageId: string, name: string, bytes: Buffer): string {
  const id = newId("cat");
  db.prepare(
    `INSERT INTO channel_attachments (id, channel_id, message_id, uploader_id, owner_id, name, mime, size, file, data, created_at)
     VALUES (?, ?, ?, 'alice', 'alice', ?, 'application/octet-stream', ?, 0, ?, 1)`,
  ).run(id, roomId, messageId, name, bytes.byteLength, bytes);
  return id;
}

async function exportRoom(roomId: string, user = "alice", selection: unknown = { mode: "all" }, includeEmails = false, admin = false) {
  const url = admin ? `/admin/channels/${roomId}/archive-exports` : `/channels/${roomId}/archive-exports`;
  const payload = admin ? { selection, includeEmails, reason: "Audited export" } : { selection, includeEmails };
  const res = await call(url, { method: "POST", user, json: payload });
  assert.equal(res.status, 202, await res.clone().text());
  const { jobId } = await json<{ jobId: string }>(res);
  const job = await waitJob(jobId, ready);
  assert.equal(job.state, "ready", JSON.stringify(job.error));
  return { jobId, job };
}

async function download(jobId: string, user = "alice"): Promise<Uint8Array> {
  const res = await call(`/room-archives/${jobId}/download`, { user });
  assert.equal(res.status, 200, await res.clone().text());
  return new Uint8Array(await res.arrayBuffer());
}

async function startImport(zip: Uint8Array, user = "bob"): Promise<string> {
  const created = await call("/room-archives/imports", { method: "POST", user, json: {} });
  assert.equal(created.status, 201, await created.clone().text());
  const { jobId } = await json<{ jobId: string }>(created);
  const upload = await call(`/room-archives/${jobId}/upload`, { method: "PUT", user, body: zip, contentType: "application/zip" });
  assert.equal(upload.status, 202, await upload.clone().text());
  return jobId;
}

async function inspect(jobId: string, user = "bob", name?: string): Promise<RoomArchiveInspectResult> {
  const res = await call(`/room-archives/${jobId}/inspect`, { method: "POST", user, json: name === undefined ? {} : { name } });
  assert.equal(res.status, 200, await res.clone().text());
  return json<RoomArchiveInspectResult>(res);
}

async function confirm(jobId: string, name: string, reviewDigest: string, user = "bob"): Promise<RoomArchiveJob> {
  const res = await call(`/room-archives/${jobId}/confirm`, { method: "POST", user, json: { name, reviewDigest, acceptWarnings: true } });
  assert.equal(res.status, 202, await res.clone().text());
  return waitJob(jobId, done);
}

function manifestFixture(overrides: Partial<RoomArchiveV1> = {}): { manifest: RoomArchiveV1; assets: Map<string, Uint8Array> } {
  const attachment = new TextEncoder().encode("imported attachment");
  const hash = sha256Hex(attachment);
  const aliceProof = roomIdentityProof("alice");
  const bobProof = roomIdentityProof("bob");
  const manifest: RoomArchiveV1 = {
    format: ROOM_ARCHIVE_FORMAT,
    version: ROOM_ARCHIVE_VERSION,
    exportedAt: Date.now(),
    room: {
      key: "room_source",
      name: "Imported room",
      description: "A historical room",
      icon: "hash",
      visibility: "public",
      archivedAt: 5_000,
      createdAt: 1_000,
      updatedAt: 4_000,
    },
    selection: { mode: "all", includedReplies: true },
    identities: [
      { key: "id_alice", localId: "alice", displayName: "Alice", localProof: aliceProof },
      { key: "id_bob", localId: "bob", displayName: "Bob", localProof: bobProof },
    ],
    members: [
      { identityKey: "id_alice", role: "owner", joinedAt: 1_000 },
      { identityKey: "id_bob", role: "member", joinedAt: 1_500 },
    ],
    messages: [
      {
        key: "m1",
        order: 1,
        kind: "human",
        authorKey: "id_alice",
        body: "Imported hello @Bob",
        createdAt: 2_000,
        editedAt: null,
        threadRootKey: null,
        quote: null,
        mentions: [{ identityKey: "id_bob", start: 15, end: 19 }],
        reactions: [{ identityKey: "id_bob", emoji: "👍", createdAt: 2_100 }],
        attachments: [{ key: "a1", asset: hash, name: "note.txt", declaredMime: "text/plain", createdAt: 2_050 }],
      },
      {
        key: "m2",
        order: 2,
        kind: "human",
        authorKey: "id_bob",
        body: "Imported reply",
        createdAt: 3_000,
        editedAt: null,
        threadRootKey: "m1",
        quote: { kind: "message", messageKey: "m1" },
        mentions: [],
        reactions: [],
        attachments: [],
      },
      {
        key: "m3",
        order: 3,
        kind: "ai",
        authorKey: null,
        body: "Imported AI answer",
        createdAt: 4_000,
        editedAt: null,
        threadRootKey: null,
        quote: null,
        mentions: [],
        reactions: [],
        attachments: [],
      },
    ],
    assets: [{ key: hash, size: attachment.byteLength }],
    ...overrides,
  };
  return { manifest, assets: new Map([[hash, attachment]]) };
}

function zipOf(manifest: RoomArchiveV1, assets: Map<string, Uint8Array> = new Map()): Uint8Array {
  const files = [{ name: "manifest.json", bytes: new TextEncoder().encode(JSON.stringify(manifest)) }];
  for (const [hash, bytes] of assets) files.push({ name: `assets/${hash}`, bytes });
  return writeStoredZip(files);
}

async function importFixture(overrides: Partial<RoomArchiveV1> = {}, user = "bob") {
  const fixture = manifestFixture(overrides);
  const jobId = await startImport(zipOf(fixture.manifest, fixture.assets), user);
  const job = await waitJob(jobId, ready);
  assert.equal(job.state, "ready", JSON.stringify(job.error));
  return { jobId, job, fixture };
}

function sourceRoomFixture(): Promise<{ roomId: string; root: string; reply: string; second: string; ai: string; attachmentBytes: Buffer }> {
  return (async () => {
    const roomId = await createRoom();
    assert.equal((await call(`/channels/${roomId}/join`, { method: "POST", user: "bob", json: {} })).status, 200);
    const root = await post(roomId, "alice", "Hello @Bob 🚀", { mentions: [{ userId: "bob", start: 6, end: 10 }] });
    const reply = await post(roomId, "bob", "Thread reply", { threadRootId: root.id, replyTo: root.id });
    const second = await post(roomId, "alice", "Second root", { replyTo: root.id });
    const ai = newId("cmsg");
    db.prepare(
      `INSERT INTO channel_messages (id, channel_id, seq, author_id, kind, body, reply_to, thread_root, client_id, request_hash, revision, created_at, edited_at, deleted_at)
       VALUES (?, ?, ?, NULL, 'ai', 'AI answer', NULL, NULL, NULL, NULL, 1, ?, NULL, NULL)`,
    ).run(ai, roomId, 4, 2_500);
    db.prepare("UPDATE channels SET next_seq = 5 WHERE id = ?").run(roomId);
    // Backdated timestamps survive the round trip.
    db.prepare("UPDATE channel_messages SET created_at = 1000 WHERE id = ?").run(root.id);
    db.prepare("UPDATE channel_messages SET created_at = 2000 WHERE id = ?").run(reply.id);
    db.prepare("UPDATE channel_messages SET created_at = 3000 WHERE id = ?").run(second.id);
    const bytes = Buffer.from("same attachment bytes");
    addAttachment(roomId, root.id, "first.txt", bytes);
    addAttachment(roomId, root.id, "second.txt", bytes);
    assert.equal((await call(`/channels/${roomId}/messages/${root.id}/reactions/${encodeURIComponent("👍")}`, { method: "PUT", user: "bob" })).status, 200);
    return { roomId, root: root.id, reply: reply.id, second: second.id, ai, attachmentBytes: bytes };
  })();
}

test("export and import preserve messages, threads, quotes, mentions, reactions and attachments", async () => {
  const source = await sourceRoomFixture();
  const exported = await exportRoom(source.roomId);
  const zip = await download(exported.jobId);
  const { readZipAll } = await import("../../archive-zip.js");
  const limits = {
    maxInputBytes: ROOM_ARCHIVE_LIMITS.uploadBytes,
    maxExpandedBytes: ROOM_ARCHIVE_LIMITS.expandedBytes,
    maxEntryBytes: ROOM_ARCHIVE_LIMITS.assetMaxBytes,
    maxEntries: ROOM_ARCHIVE_LIMITS.entries,
    allow: (name: string) => name === "manifest.json" || /^assets\/[a-f0-9]{64}$/.test(name),
  };
  const entries = readZipAll(zip, limits);
  const manifest = JSON.parse(new TextDecoder().decode(entries.get("manifest.json"))) as RoomArchiveV1;
  assert.equal(manifest.format, ROOM_ARCHIVE_FORMAT);
  assert.equal(manifest.room.name, "Archive room");
  assert.equal(manifest.selection.includedReplies, true);
  assert.deepEqual(manifest.messages.map((message) => message.order), [1, 2, 3, 4]);
  assert.equal(manifest.messages[0]!.createdAt, 1_000);
  assert.equal(manifest.messages[1]!.threadRootKey, manifest.messages[0]!.key);
  assert.equal(manifest.messages[1]!.quote?.kind, "message");
  assert.equal(manifest.messages[0]!.mentions.length, 1);
  assert.equal(manifest.messages[0]!.reactions[0]?.emoji, "👍");
  assert.equal(manifest.messages[0]!.attachments.length, 2);
  assert.equal(manifest.messages[0]!.attachments[0]!.asset, manifest.messages[0]!.attachments[1]!.asset);
  assert.equal(manifest.assets.length, 1);
  assert.equal(manifest.messages[3]!.kind, "ai");
  assert.equal(manifest.messages[3]!.authorKey, null);

  const imported = await startImport(zip);
  const importedJob = await waitJob(imported, ready);
  assert.equal(importedJob.state, "ready", JSON.stringify(importedJob.error));
  const review = await inspect(imported, "bob", "Imported copy");
  assert.equal(review.summary.roots, 3);
  assert.equal(review.summary.replies, 1);
  assert.equal(review.summary.attachments, 2);
  assert.equal(review.summary.distinctAssets, 1);
  assert.equal(review.summary.recognizedAuthors, 2);
  assert.equal(review.summary.unknownAuthors, 0);
  assert.equal(review.summary.name, "Imported copy");
  assert.ok(review.summary.warnings.some((warning) => warning.code === "privateDestination"));
  assert.equal(review.summary.preview.length, 4);

  const finished = await confirm(imported, "Imported copy", review.reviewDigest);
  assert.equal(finished.state, "done", JSON.stringify(finished.error));
  const channelId = finished.result?.channelId;
  assert.ok(channelId);
  assert.notEqual(channelId, source.roomId);

  const room = db.prepare("SELECT * FROM channels WHERE id = ?").get(channelId) as Record<string, unknown>;
  assert.equal(room.kind, "room");
  assert.equal(room.visibility, "private");
  assert.equal(room.owner_id, "bob");
  assert.equal(room.name, "Imported copy");
  assert.equal(room.ai_json, null);
  assert.equal(room.archived_at, null);
  assert.ok(room.imported_meta_json);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM channel_members WHERE channel_id = ?").get(channelId) as { n: number }).n, 1);
  const messages = db.prepare("SELECT * FROM channel_messages WHERE channel_id = ? ORDER BY seq").all(channelId) as Array<Record<string, unknown>>;
  assert.deepEqual(messages.map((message) => message.seq), [1, 2, 3, 4]);
  assert.deepEqual(messages.map((message) => message.body), ["Hello @Bob 🚀", "Thread reply", "Second root", "AI answer"]);
  assert.ok(messages.every((message) => message.author_id === null));
  assert.ok(messages.every((message) => message.imported_json !== null));
  assert.equal(messages[1]!.thread_root, messages[0]!.id);
  assert.equal(messages[1]!.reply_to, messages[0]!.id);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM channel_thread_state WHERE channel_id = ?").get(channelId) as { n: number }).n, 1);
  const attachments = db.prepare("SELECT * FROM channel_attachments WHERE channel_id = ? ORDER BY name").all(channelId) as Array<Record<string, unknown>>;
  assert.equal(attachments.length, 2);
  assert.ok(attachments.every((attachment) => attachment.owner_id === "bob" && attachment.uploader_id === null));
  assert.deepEqual([...new Set(attachments.map((attachment) => Buffer.from(attachment.data as Uint8Array).toString()))], ["same attachment bytes"]);

  // The history projection resolves recognized local accounts and keeps historical relations separate.
  const history = await json<{ items: Array<{ id: string; body: string; imported?: boolean; historicalAuthor?: { kind: string; name?: string }; historicalMentions?: unknown[]; historicalReactions?: unknown[] }> }>(
    await call(`/channels/${channelId}/messages`, { user: "bob" }),
  );
  const root = history.items.find((item) => item.body === "Hello @Bob 🚀")!;
  assert.equal(root.imported, true);
  assert.equal(root.historicalAuthor?.kind, "known");
  assert.equal(root.historicalAuthor?.name, "Alice");
  assert.equal(root.historicalMentions?.length, 1);
  assert.equal(root.historicalReactions?.length, 1);

  // No personal chat, upload, artifact, or image row was created by the import.
  for (const table of ["threads", "messages", "uploads", "artifacts", "images"]) {
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    assert.equal(count, 0, table);
  }
  // Quota counts the imported room, its provenance, identity reservations, and attachment bytes.
  assert.equal(storageUsed("bob"), channelStorageBytes(channelId));

  // A re-export keeps the allowed semantic data and exactly one owner.
  const reExported = await exportRoom(channelId, "bob");
  const reZip = await download(reExported.jobId, "bob");
  const reEntries = readZipAll(reZip, limits);
  const reManifest = JSON.parse(new TextDecoder().decode(reEntries.get("manifest.json"))) as RoomArchiveV1;
  assert.deepEqual(reManifest.messages.map((message) => message.body), manifest.messages.map((message) => message.body));
  assert.equal(reManifest.messages[1]!.quote?.kind, "message");
  assert.equal(reManifest.messages[0]!.mentions.length, 1);
  assert.equal(reManifest.messages[0]!.reactions[0]?.emoji, "👍");
  assert.equal(reManifest.messages[0]!.attachments.length, 2);
  assert.equal(reManifest.members.filter((member) => member.role === "owner").length, 1);
  assert.ok(reManifest.assets.length === 1);
});

test("only the live owner, or an audited admin override, may export a room; DMs never export", async () => {
  const roomId = await createRoom();
  await call(`/channels/${roomId}/join`, { method: "POST", user: "bob", json: {} });
  assert.equal((await call(`/channels/${roomId}/archive-exports`, { method: "POST", user: "bob", json: { selection: { mode: "all" } } })).status, 403);
  assert.equal((await call(`/channels/${roomId}/archive-exports`, { method: "POST", user: "carol", json: { selection: { mode: "all" } } })).status, 404);
  assert.equal((await call(`/channels/${roomId}/archive-exports`, { method: "POST", user: "root", json: { selection: { mode: "all" } } })).status, 404);
  assert.equal((await call(`/admin/channels/${roomId}/archive-exports`, { method: "POST", user: "root", json: { selection: { mode: "all" } } })).status, 400);

  const dm = await json<{ channel: { id: string } }>(
    await call("/channels/dms", { method: "POST", user: "alice", json: { clientId: crypto.randomUUID(), userIds: ["bob"] } }),
  );
  assert.equal((await call(`/channels/${dm.channel.id}/archive-exports`, { method: "POST", user: "alice", json: { selection: { mode: "all" } } })).status, 403);
  const dmAdmin = await call(`/admin/channels/${dm.channel.id}/archive-exports`, { method: "POST", user: "root", json: { selection: { mode: "all" }, reason: "DM check" } });
  assert.equal(dmAdmin.status, 404);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM channel_moderation_audit WHERE action LIKE 'export%'").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM room_archive_jobs").get() as { n: number }).n, 0);

  const adminExport = await exportRoom(roomId, "root", { mode: "all" }, false, true);
  assert.equal((await call(`/room-archives/${adminExport.jobId}`, { user: "root" })).status, 200);
  const audit = db.prepare("SELECT action, reason FROM channel_moderation_audit WHERE action = 'export.admin'").get() as { action: string; reason: string };
  assert.equal(audit.reason, "Audited export");

  const ownerExport = await exportRoom(roomId, "alice");
  assert.equal((await call(`/room-archives/${ownerExport.jobId}`, { user: "bob" })).status, 404);
  assert.equal((await call(`/room-archives/${ownerExport.jobId}/download`, { user: "bob" })).status, 404);
  assert.equal((await call(`/room-archives/${ownerExport.jobId}`, { method: "DELETE", user: "bob" })).status, 404);
  // Losing the owner role revokes a ready download on the next read.
  db.prepare("UPDATE channel_members SET role = 'member' WHERE channel_id = ? AND user_id = 'alice'").run(roomId);
  assert.equal((await call(`/room-archives/${ownerExport.jobId}`, { user: "alice" })).status, 404);
  assert.equal((await call(`/room-archives/${ownerExport.jobId}/download`, { user: "alice" })).status, 404);

  // Deleting the source room cancels its pending export and removes the staged bytes.
  const doomed = await createRoom("alice", "Doomed room");
  const doomedExport = await exportRoom(doomed, "alice");
  const detail = await json<{ channel: { revision: number } }>(await call(`/channels/${doomed}`, { user: "alice" }));
  assert.equal((await call(`/channels/${doomed}`, { method: "DELETE", user: "alice", json: { revision: detail.channel.revision } })).status, 200);
  const cancelledJob = getRoomJobById(doomedExport.jobId)!;
  assert.equal(cancelledJob.state, "cancelled");
  assert.equal(cancelledJob.reservation_bytes, 0);
  assert.equal(existsSync(stageDir("alice", doomedExport.jobId)), false);
  assert.equal((await call(`/room-archives/${doomedExport.jobId}`, { user: "alice" })).status, 404);
});

test("strict format, version and container failures never create a room", async () => {
  const cases: Array<{ zip: Uint8Array; code: string }> = [];
  const wrongFormat = manifestFixture();
  wrongFormat.manifest.format = "okaychat.chat-archive" as never;
  cases.push({ zip: zipOf(wrongFormat.manifest, wrongFormat.assets), code: "wrong_format" });
  const wrongVersion = manifestFixture();
  wrongVersion.manifest.version = 9 as never;
  cases.push({ zip: zipOf(wrongVersion.manifest, wrongVersion.assets), code: "unsupported_version" });
  const extraField = manifestFixture();
  (extraField.manifest as unknown as Record<string, unknown>).extra = true;
  cases.push({ zip: zipOf(extraField.manifest, extraField.assets), code: "invalid_archive" });
  const duplicateKey = new TextEncoder().encode(JSON.stringify(manifestFixture().manifest).replace('"format":', '"format":"duplicate","format":'));
  cases.push({ zip: writeStoredZip([{ name: "manifest.json", bytes: duplicateKey }]), code: "invalid_archive" });
  const missingAsset = manifestFixture();
  cases.push({
    zip: writeStoredZip([{ name: "manifest.json", bytes: new TextEncoder().encode(JSON.stringify(missingAsset.manifest)) }]),
    code: "invalid_archive",
  });
  const hashMismatch = manifestFixture();
  hashMismatch.assets = new Map([[[...hashMismatch.assets.keys()][0]!, new TextEncoder().encode("different bytes")]]);
  cases.push({ zip: zipOf(hashMismatch.manifest, hashMismatch.assets), code: "invalid_archive" });
  const undeclared = manifestFixture();
  undeclared.assets.set("b".repeat(64), new TextEncoder().encode("extra"));
  cases.push({ zip: zipOf(undeclared.manifest, undeclared.assets), code: "invalid_archive" });
  const traversal = await import("fflate").then(({ zipSync }) =>
    zipSync({ "../evil": new TextEncoder().encode("x"), "manifest.json": new TextEncoder().encode("{}") }),
  );
  cases.push({ zip: traversal, code: "invalid_archive" });

  for (const [index, item] of cases.entries()) {
    const jobId = await startImport(item.zip);
    const job = await waitJob(jobId, ready);
    assert.equal(job.state, "failed", `case ${index}`);
    assert.equal(job.error?.code, item.code, `case ${index}: ${JSON.stringify(job.error)}`);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM channels WHERE kind = 'room' AND owner_id = 'bob'").get() as { n: number }).n, 0);
    await call(`/room-archives/${jobId}`, { method: "DELETE", user: "bob" });
    db.prepare("DELETE FROM channel_rate_windows").run();
  }
});

test("unknown and tampered identities stay neutral and never gain native authority", async () => {
  const ghost = manifestFixture({
    identities: [{ key: "id_ghost", localId: "ghost", displayName: "Ghost Name", localProof: "A".repeat(43) }],
    members: [{ identityKey: "id_ghost", role: "owner", joinedAt: 1_000 }],
    messages: [
      {
        key: "m1",
        order: 1,
        kind: "human",
        authorKey: "id_ghost",
        body: "Ghost wrote this",
        createdAt: 2_000,
        editedAt: null,
        threadRootKey: null,
        quote: null,
        mentions: [],
        reactions: [],
        attachments: [],
      },
    ],
  });
  ghost.manifest.assets = [];
  ghost.assets.clear();
  const jobId = await startImport(zipOf(ghost.manifest, ghost.assets));
  const job = await waitJob(jobId, ready);
  assert.equal(job.state, "ready", JSON.stringify(job.error));
  const review = await inspect(jobId);
  assert.equal(review.summary.recognizedAuthors, 0);
  assert.equal(review.summary.unknownAuthors, 1);
  const roster = await json<{ items: Array<{ historicalName: string | null; recognizedName: string | null }> }>(await call(`/room-archives/${jobId}/identities`, { user: "bob" }));
  assert.equal(roster.items[0]?.historicalName, "Ghost Name");
  assert.equal(roster.items[0]?.recognizedName, null);
  const finished = await confirm(jobId, review.summary.name, review.reviewDigest);
  assert.equal(finished.state, "done");
  const channelId = finished.result!.channelId;
  const history = await json<{ items: Array<{ id: string; body: string; historicalAuthor?: { kind: string }; imported?: boolean }> }>(
    await call(`/channels/${channelId}/messages`, { user: "bob" }),
  );
  const imported = history.items.find((item) => item.body === "Ghost wrote this")!;
  assert.equal(imported.imported, true);
  assert.equal(imported.historicalAuthor?.kind, "unknown");
  const edit = await call(`/channels/${channelId}/messages/${imported.id}`, { method: "PATCH", user: "bob", json: { revision: 1, body: "rewritten" } });
  assert.equal(edit.status, 409);
  assert.match((await edit.json() as { error: string }).error, /read-only/i);

  // The AI path refuses an imported source before model resolution.
  const channel = channelRow(channelId)!;
  assert.throws(
    () =>
      createRunInTx("bob", channel, { messageId: imported.id, seq: 1 }, {
        clientId: crypto.randomUUID(),
        requestHash: "hash",
        modelRef: "test/model",
        configJson: "{}",
        inputEnc: "{}",
        reservedBytes: 1_024,
      }),
    (error: { details?: { reason?: string } }) => error.details?.reason === "imported_source",
  );

  // A valid proof is recognized, and deleting the account neutralizes it immediately.
  const known = manifestFixture({
    messages: [
      {
        key: "m1",
        order: 1,
        kind: "human",
        authorKey: "id_alice",
        body: "Recognized author",
        createdAt: 2_000,
        editedAt: null,
        threadRootKey: null,
        quote: null,
        mentions: [],
        reactions: [],
        attachments: [],
      },
    ],
  });
  known.manifest.assets = [];
  known.assets.clear();
  const knownJob = await startImport(zipOf(known.manifest, known.assets));
  const knownReady = await waitJob(knownJob, ready);
  const knownReview = await inspect(knownJob);
  assert.equal(knownReview.summary.recognizedAuthors, 2);
  const knownDone = await confirm(knownJob, knownReview.summary.name, knownReview.reviewDigest);
  const knownChannel = knownDone.result!.channelId;
  const before = await json<{ items: Array<{ body: string; historicalAuthor?: { kind: string; id?: string } }> }>(await call(`/channels/${knownChannel}/messages`, { user: "bob" }));
  assert.deepEqual(before.items.find((item) => item.body === "Recognized author")?.historicalAuthor, { kind: "known", id: "alice", name: "Alice" });
  db.prepare("DELETE FROM users WHERE id = 'alice'").run();
  const afterDelete = await json<{ items: Array<{ body: string; historicalAuthor?: { kind: string } }> }>(await call(`/channels/${knownChannel}/messages`, { user: "bob" }));
  assert.equal(afterDelete.items.find((item) => item.body === "Recognized author")?.historicalAuthor?.kind, "unknown");
});

test("one active job per account, quota admission, cancellation, TTL and recovery are enforced", async () => {
  db.prepare("UPDATE users SET storage_limit = 1000 WHERE id = 'bob'").run();
  const denied = await call("/room-archives/imports", { method: "POST", user: "bob", json: {} });
  assert.equal(denied.status, 413);
  db.prepare("UPDATE users SET storage_limit = NULL WHERE id = 'bob'").run();

  const first = await call("/room-archives/imports", { method: "POST", user: "bob", json: {} });
  assert.equal(first.status, 201);
  const firstId = (await json<{ jobId: string }>(first)).jobId;
  assert.equal((await call("/room-archives/imports", { method: "POST", user: "bob", json: {} })).status, 409);
  assert.ok(existsSync(stageDir("bob", firstId)));
  const cancelled = await call(`/room-archives/${firstId}`, { method: "DELETE", user: "bob" });
  assert.equal(cancelled.status, 200);
  assert.deepEqual(await json(cancelled), { cancelled: true });
  assert.equal(existsSync(stageDir("bob", firstId)), false);
  assert.equal((db.prepare("SELECT reservation_bytes FROM room_archive_jobs WHERE id = ?").get(firstId) as { reservation_bytes: number }).reservation_bytes, 0);

  const expiring = await call("/room-archives/imports", { method: "POST", user: "bob", json: {} });
  const expiringId = (await json<{ jobId: string }>(expiring)).jobId;
  db.prepare("UPDATE room_archive_jobs SET expires_at = ? WHERE id = ?").run(Date.now() - 1, expiringId);
  assert.equal((await call(`/room-archives/${expiringId}`, { user: "bob" })).status, 410);
  assert.equal((db.prepare("SELECT state FROM room_archive_jobs WHERE id = ?").get(expiringId) as { state: string }).state, "expired");

  // Recovery marks an interrupted job failed, releases its reservation, and removes its stage.
  const interrupted = await call("/room-archives/imports", { method: "POST", user: "bob", json: {} });
  const interruptedId = (await json<{ jobId: string }>(interrupted)).jobId;
  db.prepare("UPDATE room_archive_jobs SET state = 'preparing' WHERE id = ?").run(interruptedId);
  recoverRoomArchiveJobs();
  const recovered = db.prepare("SELECT state, error_code, reservation_bytes FROM room_archive_jobs WHERE id = ?").get(interruptedId) as { state: string; error_code: string; reservation_bytes: number };
  assert.equal(recovered.state, "failed");
  assert.equal(recovered.error_code, "interrupted");
  assert.equal(recovered.reservation_bytes, 0);
  assert.equal(existsSync(stageDir("bob", interruptedId)), false);
});

test("a quota failure rolls the import back atomically and stays retryable", async () => {
  const { jobId } = await importFixture();
  const review = await inspect(jobId);
  const roomsBefore = (db.prepare("SELECT COUNT(*) AS n FROM channels WHERE kind = 'room'").get() as { n: number }).n;
  const contentBytes = storageUsed("bob") - ROOM_ARCHIVE_LIMITS.stageReservationBytes;
  db.prepare("UPDATE users SET storage_limit = ? WHERE id = 'bob'").run(contentBytes + 100);
  const failed = await confirm(jobId, review.summary.name, review.reviewDigest);
  assert.equal(failed.state, "ready");
  assert.equal(failed.error?.code, "storage_quota");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM channels WHERE kind = 'room'").get() as { n: number }).n, roomsBefore);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM channel_messages").get() as { n: number }).n, 0);

  db.prepare("UPDATE users SET storage_limit = NULL WHERE id = 'bob'").run();
  const retryReview = await inspect(jobId);
  const done = await confirm(jobId, retryReview.summary.name, retryReview.reviewDigest);
  assert.equal(done.state, "done", JSON.stringify(done.error));
  assert.ok(done.result?.channelId);
  // A repeated exact confirm returns the same result and never creates a second room.
  const replay = await call(`/room-archives/${jobId}/confirm`, { method: "POST", user: "bob", json: { name: retryReview.summary.name, reviewDigest: retryReview.reviewDigest, acceptWarnings: true } });
  assert.equal(replay.status, 200);
  assert.deepEqual((await json<{ result: { channelId: string } }>(replay)).result.channelId, done.result!.channelId);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM channels WHERE kind = 'room'").get() as { n: number }).n, roomsBefore + 1);
});

test("review changes and imported edit guards are enforced at confirm and edit time", async () => {
  const { jobId } = await importFixture();
  const first = await inspect(jobId, "bob", "First name");
  const second = await inspect(jobId, "bob", "Second name");
  assert.notEqual(first.reviewDigest, second.reviewDigest);
  const stale = await call(`/room-archives/${jobId}/confirm`, { method: "POST", user: "bob", json: { name: "First name", reviewDigest: first.reviewDigest, acceptWarnings: true } });
  assert.equal(stale.status, 409);
  assert.equal(((await stale.json()) as { code: string }).code, "review_changed");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM channels WHERE owner_id = 'bob'").get() as { n: number }).n, 0);
  const done = await confirm(jobId, "Second name", second.reviewDigest);
  assert.equal(done.state, "done");
  const channelId = done.result!.channelId;
  // Even a recognized imported author who joins the room cannot edit imported history.
  db.prepare("INSERT INTO channel_members (channel_id, user_id, role, read_seq, notify_mode, joined_at) VALUES (?, 'alice', 'member', 0, 'mentions', ?)").run(channelId, Date.now());
  const message = db.prepare("SELECT id FROM channel_messages WHERE channel_id = ? ORDER BY seq LIMIT 1").get(channelId) as { id: string };
  const edit = await call(`/channels/${channelId}/messages/${message.id}`, { method: "PATCH", user: "alice", json: { revision: 1, body: "forged" } });
  assert.equal(edit.status, 409);
  assert.match(((await edit.json()) as { error: string }).error, /read-only/i);
});
