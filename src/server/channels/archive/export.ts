import { readFileSync, statSync } from "node:fs";
import { db, tx } from "../../db.js";
import { AppError } from "../../errors.js";
import { sha256 } from "../../crypto.js";
import { featureAllowed } from "../../permissions/guard.js";
import { storageUsed, userStorageLimit } from "../../quota.js";
import type { ChannelReaction, ChannelRole } from "../../../shared/channels.js";
import { CHANNEL_REACTIONS } from "../../../shared/channels.js";
import {
  ROOM_ARCHIVE_FORMAT,
  ROOM_ARCHIVE_LIMITS,
  ROOM_ARCHIVE_VERSION,
  type RoomArchiveMessage,
  type RoomArchiveRoom,
  type RoomArchiveSummary,
  type RoomArchiveV1,
  type RoomArchiveErrorCode,
  type RoomArchiveWarningCode,
} from "../../../shared/room-archive.js";
import { sha256Hex, writeStoredZip } from "../../archive-zip.js";
import { channelAttachmentPath } from "../attachments.js";
import { assertChannelRole, assertRoom, channelRow } from "../access.js";
import { channelStorageBytes } from "../store.js";
import { parseImportedMeta, parseImportedProvenance } from "./history.js";
import { historyIdentityRows, roomIdentityProof } from "./identity.js";
import { exportAttachmentName, exportBody } from "./format.js";
import {
  assertJobAlive,
  failRoomJob,
  getRoomJobById,
  jobRequest,
  markReady,
  setPhase,
  stageBytes,
  stagePath,
  writeStageFile,
  type RoomArchiveJobRow,
} from "./jobs.js";

/**
 * Authorized room-only snapshot and ZIP preparation. Selection is closed over live roots (and optionally
 * their live replies); tombstones never enter, and a quote whose target is outside the selection becomes
 * `unavailable` with no id, excerpt, or author. The capture runs synchronously between queries, then the
 * database is released before compression. A missing or truncated original fails the whole export.
 */

interface MessageRow {
  id: string;
  seq: number;
  author_id: string | null;
  kind: "human" | "ai";
  body: string;
  reply_to: string | null;
  thread_root: string | null;
  created_at: number;
  edited_at: number | null;
  imported_json: string | null;
}

interface SnapshotIdentity {
  key: string;
  localId: string | null;
  displayName: string | null;
  localProof: string | null;
  email?: string;
  role: ChannelRole;
  currentRole: ChannelRole | null;
  joinedAt: number;
}

interface ExportRequest {
  selection: { mode: "all" | "roots"; rootIds?: string[]; includeReplies: boolean };
  includeEmails: boolean;
}

interface Capture {
  channel: NonNullable<ReturnType<typeof channelRow>>;
  request: ExportRequest;
  identities: SnapshotIdentity[];
  messages: RoomArchiveMessage[];
  assets: Map<string, Uint8Array>;
  warnings: Map<RoomArchiveWarningCode, WarningBucket>;
  attachmentBytes: number;
}

const keyOf = (prefix: string, value: string): string => (/^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : `${prefix}_${sha256(value).slice(0, 40)}`);

interface WarningBucket {
  count: number;
  samples: Set<string>;
}

/** Counts every occurrence but keeps only bounded samples per code. */
function warning(warnings: Map<RoomArchiveWarningCode, WarningBucket>, code: RoomArchiveWarningCode, sample: string): void {
  const bucket = warnings.get(code) ?? { count: 0, samples: new Set<string>() };
  bucket.count++;
  if (bucket.samples.size < ROOM_ARCHIVE_LIMITS.warningSamples) bucket.samples.add(sample);
  warnings.set(code, bucket);
}

function requireExportAuthority(row: RoomArchiveJobRow): NonNullable<ReturnType<typeof channelRow>> {
  if (!row.source_channel_id) throw new AppError({ code: "not_found", message: "Room not found." });
  const channel = channelRow(row.source_channel_id);
  if (!channel || channel.kind !== "room") throw new AppError({ code: "not_found", message: "Room not found." });
  if (row.authority === "owner") assertChannelRole(row.user_id, channel.id, ["owner"]);
  else {
    const account = db.prepare("SELECT role FROM users WHERE id = ?").get(row.user_id) as { role: string } | undefined;
    if (account?.role !== "admin") throw new AppError({ code: "forbidden", message: "Administrator access is required." });
  }
  assertRoom(channel);
  return channel;
}

function selectRows(channelId: string, request: ExportRequest): MessageRow[] {
  if (request.selection.mode === "all") {
    const roots = db
      .prepare(
        `SELECT id, seq, author_id, kind, body, reply_to, thread_root, created_at, edited_at, imported_json
         FROM channel_messages WHERE channel_id = ? AND thread_root IS NULL AND deleted_at IS NULL
         ORDER BY seq ASC LIMIT ?`,
      )
      .all(channelId, ROOM_ARCHIVE_LIMITS.messages + 1) as unknown as MessageRow[];
    if (roots.length > ROOM_ARCHIVE_LIMITS.messages) throw limit("This room has too many messages to export.");
    const replies = db
      .prepare(
        `SELECT id, seq, author_id, kind, body, reply_to, thread_root, created_at, edited_at, imported_json
         FROM channel_messages WHERE channel_id = ? AND thread_root IS NOT NULL AND deleted_at IS NULL
         ORDER BY seq ASC LIMIT ?`,
      )
      .all(channelId, ROOM_ARCHIVE_LIMITS.messages + 1) as unknown as MessageRow[];
    const rows = [...roots, ...replies].sort((a, b) => a.seq - b.seq);
    if (rows.length > ROOM_ARCHIVE_LIMITS.messages) throw limit("This room has too many messages to export.");
    return rows;
  }

  const ids = [...new Set(request.selection.rootIds ?? [])];
  if (!ids.length || ids.length > ROOM_ARCHIVE_LIMITS.roots) throw new AppError({ code: "validation", status: 422, message: "Choose between 1 and 500 messages." });
  const placeholders = ids.map(() => "?").join(",");
  const roots = db
    .prepare(
      `SELECT id, seq, author_id, kind, body, reply_to, thread_root, created_at, edited_at, imported_json
       FROM channel_messages WHERE channel_id = ? AND thread_root IS NULL AND deleted_at IS NULL AND id IN (${placeholders})`,
    )
    .all(channelId, ...ids) as unknown as MessageRow[];
  if (roots.length !== ids.length) throw new AppError({ code: "validation", status: 422, message: "A selected message is no longer available. Reload and try again." });
  const replies = request.selection.includeReplies
    ? (db
        .prepare(
          `SELECT id, seq, author_id, kind, body, reply_to, thread_root, created_at, edited_at, imported_json
           FROM channel_messages WHERE channel_id = ? AND thread_root IN (${placeholders}) AND deleted_at IS NULL
           ORDER BY seq ASC LIMIT ?`,
        )
        .all(channelId, ...ids, ROOM_ARCHIVE_LIMITS.messages + 1) as unknown as MessageRow[])
    : [];
  const perRoot = new Map<string, number>();
  for (const reply of replies) perRoot.set(reply.thread_root!, (perRoot.get(reply.thread_root!) ?? 0) + 1);
  for (const count of perRoot.values()) if (count > ROOM_ARCHIVE_LIMITS.repliesPerRoot) throw limit("A thread has too many replies to export.");
  const rows = [...roots, ...replies].sort((a, b) => a.seq - b.seq);
  if (rows.length > ROOM_ARCHIVE_LIMITS.messages) throw limit("This selection has too many messages.");
  return rows;
}

const limit = (message: string): AppError => new AppError({ code: "validation", status: 413, message, details: { reason: "limit_exceeded" } });

/** Maps an authored failure to the job's closed code without leaking a parser or SQL string. */
export function jobErrorCode(error: unknown, fallback: RoomArchiveErrorCode): RoomArchiveErrorCode {
  if (!(error instanceof AppError)) return fallback;
  const details = error.details as { reason?: unknown } | undefined;
  if (details?.reason === "asset_unavailable") return "asset_unavailable";
  if (error.status === 413) return "limit_exceeded";
  if (error.status === 409) return "busy";
  return fallback;
}

function readAttachmentBytes(row: { id: string; channel_id: string; mime: string; size: number; file: 0 | 1; data: Uint8Array | null }): Uint8Array {
  if (row.file === 1) {
    const file = channelAttachmentPath(row.channel_id, row.id, row.mime);
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      throw new AppError({ code: "not_found", status: 409, message: "An attachment in this room is missing.", details: { reason: "asset_unavailable" } });
    }
    if (size !== row.size || size < 1) {
      throw new AppError({ code: "not_found", status: 409, message: "An attachment in this room is missing.", details: { reason: "asset_unavailable" } });
    }
    return new Uint8Array(readFileSync(file));
  }
  if (!row.data || row.data.byteLength !== row.size || row.size < 1) {
    throw new AppError({ code: "not_found", status: 409, message: "An attachment in this room is missing.", details: { reason: "asset_unavailable" } });
  }
  return new Uint8Array(row.data);
}

function capture(row: RoomArchiveJobRow, request: ExportRequest): Capture {
  // Synchronous by design: the one writer cannot edit/tombstone an original while this section runs.
  return tx(() => {
    const channel = requireExportAuthority(row);
    if (db.prepare("SELECT 1 FROM channel_ai_runs WHERE channel_id = ? AND state IN ('queued','running')").get(channel.id)) {
      throw new AppError({ code: "conflict", status: 409, message: "A reply is running in this room. Stop or wait for it before exporting." });
    }
    const started = Date.now();
    const rows = selectRows(channel.id, request);
    const warnings = new Map<RoomArchiveWarningCode, WarningBucket>();
    const identities = new Map<string, SnapshotIdentity>();
    const byLocal = new Map<string, SnapshotIdentity>();

    const identityForLocal = (userId: string, role: ChannelRole | null, joinedAt: number): SnapshotIdentity => {
      const existing = byLocal.get(userId);
      if (existing) {
        if (role && !existing.currentRole) {
          existing.currentRole = role;
          existing.role = role;
          existing.joinedAt = Math.min(existing.joinedAt, joinedAt);
        }
        return existing;
      }
      const account = db.prepare("SELECT id, name, email FROM users WHERE id = ?").get(userId) as { id: string; name: string; email: string } | undefined;
      const identity: SnapshotIdentity = {
        key: keyOf("i", userId),
        localId: account ? userId : null,
        displayName: account?.name ?? null,
        localProof: account ? roomIdentityProof(userId) : null,
        role: role ?? "member",
        currentRole: role,
        joinedAt,
        ...(account && request.includeEmails ? { email: account.email } : {}),
      };
      byLocal.set(userId, identity);
      identities.set(identity.key, identity);
      return identity;
    };

    const members = db
      .prepare("SELECT user_id, role, joined_at FROM channel_members WHERE channel_id = ? ORDER BY joined_at ASC LIMIT ?")
      .all(channel.id, ROOM_ARCHIVE_LIMITS.members + 1) as Array<{ user_id: string; role: ChannelRole; joined_at: number }>;
    if (members.length > ROOM_ARCHIVE_LIMITS.members) throw limit("This room has too many members to export.");
    for (const member of members) identityForLocal(member.user_id, member.role, member.joined_at);

    // Historical identity rows are resolved once; a stale local link stays a distinct neutral identity.
    const historicalKey = new Map<string, string>();
    for (const historical of historyIdentityRows(channel.id)) {
      let resolved: SnapshotIdentity | null = null;
      if (historical.local_user_id && db.prepare("SELECT 1 FROM users WHERE id = ?").get(historical.local_user_id) && featureAllowed(historical.local_user_id, "channels")) {
        resolved = identityForLocal(historical.local_user_id, null, historical.historical_joined_at ?? channel.created_at);
        if (!resolved.currentRole && historical.historical_role) {
          resolved.role = historical.historical_role;
          resolved.joinedAt = Math.min(resolved.joinedAt, historical.historical_joined_at ?? channel.created_at);
        }
      }
      if (resolved) {
        historicalKey.set(historical.id, resolved.key);
        continue;
      }
      const unknown: SnapshotIdentity = {
        key: keyOf("u", historical.id),
        localId: null,
        displayName: null,
        localProof: null,
        role: historical.historical_role ?? "member",
        currentRole: null,
        joinedAt: historical.historical_joined_at ?? channel.created_at,
      };
      identities.set(unknown.key, unknown);
      historicalKey.set(historical.id, unknown.key);
    }

    const assets = new Map<string, Uint8Array>();
    const messages: RoomArchiveMessage[] = [];
    const selected = new Map(rows.map((row) => [row.id, keyOf("m", row.id)]));
    const rootKey = new Map<string, string>();
    const indexOf = new Map(rows.map((row, index) => [row.id, index]));
    let attachmentBytes = 0;
    let attachmentRefs = 0;

    rows.forEach((source, index) => {
      if (index % 100 === 0 && Date.now() - started > ROOM_ARCHIVE_LIMITS.snapshotBudgetMs) {
        throw new AppError({ code: "conflict", status: 409, message: "The room changed while it was being captured. Try again." });
      }
      const key = selected.get(source.id)!;
      const provenance = source.imported_json ? parseImportedProvenance(source.imported_json) : null;
      if (source.thread_root === null) rootKey.set(source.id, key);

      let authorKey: string | null = null;
      if (source.kind === "human") {
        if (provenance?.authorIdentityId) authorKey = historicalKey.get(provenance.authorIdentityId) ?? null;
        if (!authorKey && source.author_id) authorKey = identityForLocal(source.author_id, null, source.created_at).key;
        if (!authorKey) {
          // A deleted author stays a distinct neutral identity, never a bundled account.
          const synthetic: SnapshotIdentity = {
            key: keyOf("d", source.id),
            localId: null,
            displayName: null,
            localProof: null,
            role: "member",
            currentRole: null,
            joinedAt: source.created_at,
          };
          identities.set(synthetic.key, synthetic);
          authorKey = synthetic.key;
        }
      }

      const mentions: RoomArchiveMessage["mentions"] = [];
      if (provenance) {
        for (const mention of provenance.mentions) {
          const mapped = historicalKey.get(mention.identityId);
          if (mapped) mentions.push({ identityKey: mapped, start: mention.start, end: mention.end });
        }
      } else if (source.kind === "human") {
        const live = db.prepare("SELECT user_id, start_offset, end_offset FROM channel_mentions WHERE message_id = ? ORDER BY start_offset").all(source.id) as Array<{
          user_id: string;
          start_offset: number;
          end_offset: number;
        }>;
        for (const mention of live) {
          const identity = identityForLocal(mention.user_id, null, source.created_at);
          mentions.push({ identityKey: identity.key, start: mention.start_offset, end: mention.end_offset });
        }
      }

      const reactions: RoomArchiveMessage["reactions"] = [];
      const triples = new Map<string, number>();
      const addReaction = (identityKey: string, emoji: ChannelReaction, at: number) => {
        const triple = `${identityKey}\u0000${emoji}`;
        const existing = triples.get(triple);
        if (existing !== undefined) {
          if (at < existing) triples.set(triple, at);
          warning(warnings, "reactionProvenanceFlattened", key);
          return;
        }
        triples.set(triple, at);
        reactions.push({ identityKey, emoji, createdAt: at });
      };
      if (provenance) {
        for (const reaction of provenance.reactions) {
          const mapped = historicalKey.get(reaction.identityId);
          if (!mapped || !(CHANNEL_REACTIONS as readonly string[]).includes(reaction.emoji)) continue;
          addReaction(mapped, reaction.emoji as ChannelReaction, reaction.createdAt);
        }
      }
      for (const reaction of db.prepare("SELECT user_id, emoji, created_at FROM channel_reactions WHERE message_id = ? ORDER BY created_at").all(source.id) as Array<{
        user_id: string;
        emoji: string;
        created_at: number;
      }>) {
        if (!(CHANNEL_REACTIONS as readonly string[]).includes(reaction.emoji)) continue;
        const identity = identityForLocal(reaction.user_id, null, source.created_at);
        addReaction(identity.key, reaction.emoji as ChannelReaction, reaction.created_at);
      }

      const attachments: RoomArchiveMessage["attachments"] = [];
      const attachmentRows = db
        .prepare("SELECT id, channel_id, name, mime, size, file, data, created_at FROM channel_attachments WHERE message_id = ? AND deleted_at IS NULL ORDER BY created_at, id")
        .all(source.id) as Array<{ id: string; channel_id: string; name: string; mime: string; size: number; file: 0 | 1; data: Uint8Array | null; created_at: number }>;
      if (attachmentRows.length > ROOM_ARCHIVE_LIMITS.attachmentsPerMessage) throw limit("A message has too many attachments to export.");
      for (const attachment of attachmentRows) {
        if (attachment.size < 1 || attachment.size > ROOM_ARCHIVE_LIMITS.assetMaxBytes) throw limit("An attachment is too large to export.");
        const bytes = readAttachmentBytes(attachment);
        const hash = sha256Hex(bytes);
        if (!assets.has(hash)) assets.set(hash, bytes);
        attachmentBytes += attachment.size;
        if (attachmentBytes > ROOM_ARCHIVE_LIMITS.attachmentTotalBytes) throw limit("Attachments exceed the archive size limit.");
        if (++attachmentRefs > ROOM_ARCHIVE_LIMITS.attachmentRefs) throw limit("This selection has too many attachments.");
        attachments.push({
          key: keyOf("a", attachment.id),
          asset: hash,
          name: exportAttachmentName(attachment.name),
          declaredMime: attachment.mime.slice(0, 100) || "application/octet-stream",
          createdAt: attachment.created_at,
        });
      }

      // A quote is exported only when its target is in the selection and precedes this message.
      let quote: RoomArchiveMessage["quote"] = null;
      if (source.reply_to) {
        const targetKey = selected.get(source.reply_to);
        const targetIndex = indexOf.get(source.reply_to);
        if (targetKey && targetIndex !== undefined && targetIndex < index) quote = { kind: "message", messageKey: targetKey };
        else {
          quote = { kind: "unavailable" };
          warning(warnings, "quoteUnavailable", key);
        }
      } else if (provenance?.quoteUnavailable) {
        quote = { kind: "unavailable" };
        warning(warnings, "quoteUnavailable", key);
      }

      let threadRootKey: string | null = null;
      if (source.thread_root) {
        const root = rootKey.get(source.thread_root);
        const rootIndex = indexOf.get(source.thread_root);
        if (root && rootIndex !== undefined && rootIndex < index) threadRootKey = root;
      }

      messages.push({
        key,
        order: messages.length + 1,
        kind: source.kind,
        authorKey,
        body: exportBody(source.body, source.kind),
        createdAt: source.created_at,
        editedAt: source.edited_at,
        threadRootKey,
        quote,
        mentions,
        reactions,
        attachments,
      });
    });

    // Exactly one exported owner: the current one. A historical owner becomes a documentary member.
    const currentOwner = members.find((member) => member.role === "owner");
    for (const identity of identities.values()) {
      if (identity.role !== "owner") continue;
      if (identity.localId && currentOwner && identity.localId === currentOwner.user_id) continue;
      identity.role = "member";
      warning(warnings, "historicalRolesFlattened", identity.key);
    }
    if (![...identities.values()].some((identity) => identity.role === "owner") && currentOwner) {
      identityForLocal(currentOwner.user_id, "owner", channel.created_at).role = "owner";
    }
    if (identities.size > ROOM_ARCHIVE_LIMITS.identities) throw limit("This selection has too many participants.");

    for (const message of messages) {
      if (message.kind === "ai" && (message.authorKey !== null || message.threadRootKey !== null || message.mentions.length || message.attachments.length)) {
        throw new AppError({ code: "conflict", status: 409, message: "An assistant message cannot be exported with an author or attachment." });
      }
    }

    warning(warnings, "plaintextSensitive", channel.id);
    warning(warnings, "privateDestination", channel.id);
    warning(warnings, "rolesInactive", channel.id);
    warning(warnings, "membersNotJoined", channel.id);
    warning(warnings, "aiSettingsOmitted", channel.id);
    if (channel.ai_json) warning(warnings, "aiHistoryOnly", channel.id);
    if (request.includeEmails) warning(warnings, "emailsIncluded", channel.id);
    warning(warnings, "linksNotRewritten", channel.id);
    warning(warnings, "sourceMetadataHistorical", channel.id);
    for (const identity of identities.values()) if (identity.localId === null) warning(warnings, "unknownAuthors", identity.key);

    return { channel, request, identities: [...identities.values()], messages, assets, warnings, attachmentBytes };
  });
}

function manifestOf(capture: Capture, exportedAt: number): RoomArchiveV1 {
  const room: RoomArchiveRoom = {
    key: keyOf("r", capture.channel.id),
    name: capture.channel.name,
    description: capture.channel.description,
    icon: capture.channel.icon as RoomArchiveRoom["icon"],
    visibility: capture.channel.visibility,
    archivedAt: capture.channel.archived_at,
    createdAt: capture.channel.created_at,
    updatedAt: capture.channel.updated_at,
  };
  return {
    format: ROOM_ARCHIVE_FORMAT,
    version: ROOM_ARCHIVE_VERSION,
    exportedAt,
    room,
    selection: { mode: capture.request.selection.mode, includedReplies: capture.request.selection.mode === "all" ? true : capture.request.selection.includeReplies },
    identities: capture.identities.map((identity) => ({
      key: identity.key,
      localId: identity.localId,
      displayName: identity.displayName,
      localProof: identity.localProof,
      ...(identity.email ? { email: identity.email } : {}),
    })),
    members: capture.identities.map((identity) => ({ identityKey: identity.key, role: identity.role, joinedAt: identity.joinedAt })),
    messages: capture.messages,
    assets: [...capture.assets].map(([hash, bytes]) => ({ key: hash, size: bytes.byteLength })),
  };
}

function summaryOf(capture: Capture, manifest: RoomArchiveV1, zip: Uint8Array, staged: number, reservation: number): RoomArchiveSummary {
  const roots = manifest.messages.filter((message) => message.threadRootKey === null).length;
  const recognized = capture.identities.filter((identity) => identity.localId !== null).length;
  const importedMeta = parseImportedMeta(capture.channel.imported_meta_json);
  const preview = manifest.messages.slice(0, ROOM_ARCHIVE_LIMITS.previewMessages).map((message) => {
    const identity = message.authorKey ? capture.identities.find((entry) => entry.key === message.authorKey) : undefined;
    const authorLabel: RoomArchiveSummary["preview"][number]["authorLabel"] =
      message.kind === "ai"
        ? { kind: "ai" }
        : identity?.localId
          ? { kind: "known", id: identity.localId, name: identity.displayName ?? identity.localId }
          : { kind: "unknown" };
    return {
      kind: message.kind,
      authorLabel,
      createdAt: message.createdAt,
      bodyExcerpt: [...message.body].slice(0, ROOM_ARCHIVE_LIMITS.previewBodyCodePoints).join(""),
    };
  });
  return {
    name: capture.channel.name,
    sourceVisibility: importedMeta?.sourceVisibility ?? capture.channel.visibility,
    sourceArchived: (importedMeta?.sourceArchivedAt ?? capture.channel.archived_at) !== null,
    roots,
    replies: manifest.messages.length - roots,
    attachments: manifest.messages.reduce((sum, message) => sum + message.attachments.length, 0),
    distinctAssets: manifest.assets.length,
    members: manifest.members.length,
    identities: manifest.identities.length,
    recognizedAuthors: recognized,
    unknownAuthors: manifest.identities.length - recognized,
    zipBytes: zip.byteLength,
    expandedBytes: manifest.assets.reduce((sum, asset) => sum + asset.size, 0) + Buffer.byteLength(JSON.stringify(manifest)),
    attachmentBytes: capture.attachmentBytes,
    finalStorageBytes: channelStorageBytes(capture.channel.id),
    temporaryReservationBytes: reservation,
    quotaUsedBytes: storageUsed(capture.channel.owner_id),
    quotaLimitBytes: userStorageLimit(capture.channel.owner_id),
    warnings: [...capture.warnings].map(([code, bucket]) => ({ code, count: bucket.count, sampleKeys: [...bucket.samples] })),
    preview,
  };
}

/** Runs one export job. The database is not held while compression, hashing, or file I/O run. */
export async function prepareRoomExport(row: RoomArchiveJobRow, signal: AbortSignal): Promise<void> {
  assertJobAlive(row);
  const request = jobRequest<ExportRequest>(row);
  if (!request) {
    failRoomJob(row, "export_failed");
    return;
  }
  let captured: Capture;
  try {
    setPhase(row.id, "snapshot", 0, null);
    captured = capture(row, request);
  } catch (error) {
    if (signal.aborted) {
      const latest = getRoomJobById(row.id);
      if (latest) {
        const { finishCleanup } = await import("./jobs.js");
        finishCleanup(latest, latest.expires_at <= Date.now() ? "expired" : "cancelled");
      }
      return;
    }
    failRoomJob(row, jobErrorCode(error, "export_failed"));
    return;
  }

  setPhase(row.id, "zip", 0, captured.identities.length + captured.messages.length);
  if (signal.aborted) return;
  const manifest = manifestOf(captured, Date.now());
  const files: Array<{ name: string; bytes: Uint8Array }> = [{ name: "manifest.json", bytes: new TextEncoder().encode(JSON.stringify(manifest)) }];
  for (const [hash, bytes] of captured.assets) files.push({ name: `assets/${hash}`, bytes });
  let zip: Uint8Array;
  try {
    zip = writeStoredZip(files, new Date(manifest.exportedAt));
  } catch {
    failRoomJob(row, "export_failed");
    return;
  }
  if (zip.byteLength > ROOM_ARCHIVE_LIMITS.outputBytes || stageBytes(row.user_id, row.id) + zip.byteLength > ROOM_ARCHIVE_LIMITS.stageReservationBytes) {
    failRoomJob(row, "limit_exceeded");
    return;
  }
  if (signal.aborted) return;
  writeStageFile(stagePath(row.user_id, row.id, "export.zip"), zip);
  const staged = stageBytes(row.user_id, row.id);
  if (!markReady(row.id, summaryOf(captured, manifest, zip, staged, row.reservation_bytes), null)) return;
  setPhase(row.id, "download", staged, staged);
}
