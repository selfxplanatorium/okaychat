import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { db, tx } from "../../db.js";
import { newId } from "../../crypto.js";
import { AppError } from "../../errors.js";
import { featureAllowed } from "../../permissions/guard.js";
import { QuotaError, storageUsed, userStorageLimit } from "../../quota.js";
import { CHANNEL_LIMITS } from "../../../shared/channels.js";
import { canonicalJson } from "../../../shared/permissions.js";
import {
  ROOM_ARCHIVE_LIMITS,
  type RoomArchiveIdentity,
  type RoomArchiveSummary,
  type RoomArchiveV1,
  type RoomArchiveWarningCode,
} from "../../../shared/room-archive.js";
import { inspectZip, readZipEntry, sha256Hex, ZipFormatError, type ZipReadLimits } from "../../archive-zip.js";
import { headerDimensions, RASTER_EXTENSION, sniffRaster, type RasterMime } from "../../media/sniff.js";
import { MAX_IMAGE_PIXELS } from "../../media/store.js";
import { inspectRaster, MediaProcessingError } from "../../media/variants.js";
import { CHANNEL_MEDIA_DIR, channelAttachmentPath } from "../attachments.js";
import { assertRoom } from "../access.js";
import { audit } from "../store.js";
import { insertEvent } from "../events.js";
import { importedMetaJson, importedProvenanceJson, type ImportedMetaRow } from "./history.js";
import { recognizedLocalId, resolveRoomIdentities, type IdentityResolution } from "./identity.js";
import { readName, readRoomManifest, RoomArchiveFormatError } from "./format.js";
import {
  assertJobAlive,
  assertRoomQuotaConversion,
  failRoomJob,
  finishCleanup,
  getRoomJobById,
  jobRequest,
  markReady,
  setPhase,
  setStagedBytes,
  stageBytes,
  stagePath,
  writeStageFile,
  type RoomArchiveJobRow,
} from "./jobs.js";

/**
 * Import validation, inspection, and all-or-nothing promotion. Nothing here touches application rows
 * until the final synchronous transaction. The plan is server-normalized; archive names never become
 * paths, archive keys never become ids, and every attachment is re-sniffed (and rasters decoded) before
 * it can be inserted. Emails are discarded and never persisted.
 */

interface AssetPlan {
  hash: string;
  size: number;
  /** Sniffed storage MIME; never the archive's declared type. */
  mime: string;
  file: 0 | 1;
  width: number | null;
  height: number | null;
}

interface ImportPlan {
  v: 1;
  manifest: RoomArchiveV1;
  assets: AssetPlan[];
}

interface StoredPlan extends ImportPlan {
  /** Actual upload ZIP size, for review only. */
  zipBytes: number;
  expandedBytes: number;
  /** Count only: the email bytes were stripped before the plan was written. */
  emailsDiscarded: number;
}

interface PromotionAttachment {
  key: string;
  id: string;
  asset: string;
  ext: string;
}

interface PromotionJournal {
  v: 1;
  channelId: string;
  attachments: PromotionAttachment[];
}

const zipLimits: ZipReadLimits = {
  maxInputBytes: ROOM_ARCHIVE_LIMITS.uploadBytes,
  maxExpandedBytes: ROOM_ARCHIVE_LIMITS.expandedBytes,
  maxEntryBytes: ROOM_ARCHIVE_LIMITS.assetMaxBytes,
  maxEntries: ROOM_ARCHIVE_LIMITS.entries,
  allow: (name) => name === "manifest.json" || /^assets\/[a-f0-9]{64}$/.test(name),
};

const isSvgBytes = (bytes: Uint8Array): boolean => {
  const prefix = Buffer.from(bytes.subarray(0, Math.min(bytes.byteLength, 4096))).toString("utf8").toLowerCase();
  return prefix.includes("<svg") || (prefix.includes("<?xml") && prefix.includes("svg"));
};

const isSvgNameOrMime = (name: string, mime: string): boolean => /^image\/svg\+xml$/i.test(mime) || /\.svg$/i.test(name);

/** Sniffs one asset. Rasters decode through the shared safety limits; everything else stays opaque. */
async function sniffAsset(bytes: Uint8Array, names: string[], mimes: string[]): Promise<AssetPlan> {
  if (names.some((name) => isSvgNameOrMime(name, "")) || mimes.some((mime) => isSvgNameOrMime("", mime)) || isSvgBytes(bytes)) {
    throw new RoomArchiveFormatError("attachment_type", "SVG attachments are not accepted.", names[0]);
  }
  const raster = sniffRaster(bytes);
  if (raster) {
    const header = headerDimensions(bytes, raster);
    if (!header || header.width * header.height > MAX_IMAGE_PIXELS) {
      throw new RoomArchiveFormatError("attachment_invalid", "An image exceeds the supported pixel limit.", names[0]);
    }
    try {
      const info = await inspectRaster(Buffer.from(bytes));
      if (info.width * info.height > MAX_IMAGE_PIXELS) throw new RoomArchiveFormatError("attachment_invalid", "An image exceeds the supported pixel limit.", names[0]);
      return { hash: sha256Hex(bytes), size: bytes.byteLength, mime: raster, file: 1, width: info.width, height: info.height };
    } catch (error) {
      if (error instanceof MediaProcessingError) {
        throw new RoomArchiveFormatError("attachment_invalid", "An attached image is corrupt or unsupported.", names[0]);
      }
      throw error;
    }
  }
  const pdf = bytes.byteLength >= 5 && Buffer.from(bytes.subarray(0, 5)).toString("latin1") === "%PDF-";
  return {
    hash: sha256Hex(bytes),
    size: bytes.byteLength,
    mime: pdf ? "application/pdf" : "application/octet-stream",
    file: 0,
    width: null,
    height: null,
  };
}

function declaredMimesByHash(manifest: RoomArchiveV1): Map<string, { names: string[]; mimes: string[] }> {
  const map = new Map<string, { names: string[]; mimes: string[] }>();
  for (const message of manifest.messages) {
    for (const attachment of message.attachments) {
      const entry = map.get(attachment.asset) ?? { names: [], mimes: [] };
      entry.names.push(attachment.name);
      entry.mimes.push(attachment.declaredMime);
      map.set(attachment.asset, entry);
    }
  }
  return map;
}

const planPath = (row: RoomArchiveJobRow): string => stagePath(row.user_id, row.id, "snapshot.json");

function readPlan(row: RoomArchiveJobRow): StoredPlan {
  const file = planPath(row);
  if (!existsSync(file)) throw new RoomArchiveFormatError("invalid_archive", "The archive plan is missing.");
  const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(readFileSync(file)))) as unknown;
  if (!raw || typeof raw !== "object") throw new RoomArchiveFormatError("invalid_archive", "The archive plan is invalid.");
  const plan = raw as StoredPlan;
  if (plan.v !== 1 || !plan.manifest || !Array.isArray(plan.assets)) throw new RoomArchiveFormatError("invalid_archive", "The archive plan is invalid.");
  return plan;
}

/** Stage an upload, validate it, and write the normalized plan. No application rows are created. */
export async function prepareRoomImport(row: RoomArchiveJobRow, signal: AbortSignal): Promise<void> {
  assertJobAlive(row);
  const upload = stagePath(row.user_id, row.id, "upload.zip");
  let zipBytes = 0;
  try {
    setPhase(row.id, "validate", 0, null);
    const stat = statSync(upload);
    zipBytes = stat.size;
    if (!stat.isFile() || zipBytes < 1) throw new RoomArchiveFormatError("invalid_archive", "The uploaded archive is empty.");
    if (zipBytes > ROOM_ARCHIVE_LIMITS.uploadBytes) throw new RoomArchiveFormatError("limit_exceeded", "The archive is too large.");
    const bytes = new Uint8Array(readFileSync(upload));
    const entries = inspectZip(bytes, zipLimits);
    const manifestEntry = entries.find((entry) => entry.name === "manifest.json");
    if (!manifestEntry) throw new RoomArchiveFormatError("invalid_archive", "The archive has no manifest.");
    const manifestBytes = readZipEntry(bytes, manifestEntry, zipLimits);
    const assetEntries = new Map(entries.filter((entry) => entry.name.startsWith("assets/")).map((entry) => [entry.name.slice("assets/".length), entry]));
    const assetSizes = new Map([...assetEntries].map(([hash, entry]) => [hash, entry.size]));
    const parsed = readRoomManifest(manifestBytes, { now: Date.now(), assetSizes });
    const manifest = parsed.manifest;
    if (assetEntries.size !== manifest.assets.length) {
      throw new RoomArchiveFormatError("invalid_archive", "The archive contains an undeclared asset.");
    }
    if (signal.aborted) throw new RoomArchiveFormatError("interrupted", "The import was cancelled.");

    // Read and validate one asset at a time; only the sniffed plan stays in memory.
    const declared = declaredMimesByHash(manifest);
    const assets: AssetPlan[] = [];
    for (const asset of manifest.assets) {
      if (signal.aborted) throw new RoomArchiveFormatError("interrupted", "The import was cancelled.");
      const entry = assetEntries.get(asset.key);
      if (!entry) throw new RoomArchiveFormatError("invalid_archive", "The archive is missing an asset.", asset.key);
      const data = readZipEntry(bytes, entry, zipLimits);
      if (sha256Hex(data) !== asset.key) throw new RoomArchiveFormatError("invalid_archive", "An asset's hash does not match its bytes.", asset.key);
      const declaredForAsset = declared.get(asset.key) ?? { names: [], mimes: [] };
      const sniffed = await sniffAsset(data, declaredForAsset.names, declaredForAsset.mimes);
      if (sniffed.size !== asset.size) throw new RoomArchiveFormatError("invalid_archive", "An asset's declared size does not match its bytes.", asset.key);
      writeStageFile(stagePath(row.user_id, row.id, `assets/${asset.key}`), data);
      assets.push(sniffed);
      setPhase(row.id, "validate", assets.length, manifest.assets.length);
    }
    if (signal.aborted) throw new RoomArchiveFormatError("interrupted", "The import was cancelled.");

    // Emails are review metadata only: never stored in the plan, summary, room, or history.
    const stripped: RoomArchiveV1 = {
      ...manifest,
      identities: manifest.identities.map((identity) => {
        const withoutEmail: RoomArchiveIdentity = { key: identity.key, localId: identity.localId, displayName: identity.displayName, localProof: identity.localProof };
        return withoutEmail;
      }),
    };
    writeStageFile(stagePath(row.user_id, row.id, "manifest.json"), new TextEncoder().encode(JSON.stringify(stripped)));
    const plan: StoredPlan = {
      v: 1,
      manifest: stripped,
      assets,
      zipBytes,
      expandedBytes: [...entries].reduce((sum, entry) => sum + entry.size, 0),
      emailsDiscarded: manifest.identities.filter((identity) => "email" in identity).length,
    };
    writeStageFile(planPath(row), new TextEncoder().encode(JSON.stringify(plan)));
    setStagedBytes(row.id, stageBytes(row.user_id, row.id));
    const summary = reviewOf(row, plan, stripped.room.name);
    const digest = reviewDigest(row.user_id, plan, stripped.room.name);
    const staged = stageBytes(row.user_id, row.id);
    if (staged > ROOM_ARCHIVE_LIMITS.stageReservationBytes) throw new RoomArchiveFormatError("limit_exceeded", "The archive staging exceeds its reservation.");
    setPhase(row.id, "inspect", assets.length, assets.length);
    if (!markReady(row.id, summary, digest)) return;
    setPhase(row.id, "inspect", assets.length, assets.length);
  } catch (error) {
    if (signal.aborted) {
      const latest = getRoomJobById(row.id);
      if (latest) finishCleanup(latest, latest.expires_at <= Date.now() ? "expired" : "cancelled");
      return;
    }
    // A malformed container is the same class of failure as a malformed manifest: the file is invalid,
    // not the server. Only an unexpected internal error is import_failed.
    failRoomJob(
      row,
      error instanceof RoomArchiveFormatError
        ? error.code
        : error instanceof ZipFormatError
          ? "invalid_archive"
          : error instanceof AppError && error.status === 413
            ? "limit_exceeded"
            : "import_failed",
    );
  }
}

/** A fresh review for the requested name: identity resolution, warnings, final quota, preview, digest. */
export function inspectRoomImport(row: RoomArchiveJobRow, requestedName?: string): { summary: RoomArchiveSummary; reviewDigest: string; plan: StoredPlan } {
  assertJobAlive(row);
  const plan = readPlan(row);
  const name = requestedName === undefined ? plan.manifest.room.name : readName(requestedName, "room");
  const summary = reviewOf(row, plan, name);
  return { summary, reviewDigest: reviewDigest(row.user_id, plan, name), plan };
}

function reviewDigest(userId: string, plan: StoredPlan, name: string): string {
  const resolution = resolveRoomIdentities(plan.manifest.identities);
  return sha256Hex(
    new TextEncoder().encode(
      canonicalJson({
        plan: {
          room: plan.manifest.room,
          selection: plan.manifest.selection,
          identities: plan.manifest.identities,
          members: plan.manifest.members,
          messages: plan.manifest.messages,
          assets: plan.manifest.assets,
        },
        identities: plan.manifest.identities.map((identity) => [identity.key, resolution.local.get(identity.key) ?? null]),
        name,
      }),
    ),
  );
}

/**
 * Approximate destination bytes for the review. Identity ids are allocated at confirmation and have a
 * fixed generated length, so the estimate uses that exact width; the commit recomputes the real figure
 * from the inserted ids inside the transaction and rechecks quota there.
 */
const ID_PLACEHOLDER = "i".repeat(21);

function finalStorageBytes(plan: StoredPlan, name: string, meta: string): number {
  let bytes = Buffer.byteLength(name, "utf8") + Buffer.byteLength(plan.manifest.room.description, "utf8") + Buffer.byteLength(meta, "utf8");
  for (const message of plan.manifest.messages) {
    bytes += Buffer.byteLength(message.body, "utf8");
    bytes += Buffer.byteLength(
      importedProvenanceJson({
        v: 1,
        authorIdentityId: message.authorKey ? ID_PLACEHOLDER : null,
        quoteUnavailable: message.quote?.kind === "unavailable",
        mentions: message.mentions.map((mention) => ({ identityId: ID_PLACEHOLDER, start: mention.start, end: mention.end })),
        reactions: message.reactions.map((reaction) => ({ identityId: ID_PLACEHOLDER, emoji: reaction.emoji, createdAt: reaction.createdAt })),
      }),
      "utf8",
    );
    for (const attachment of message.attachments) bytes += plan.assets.find((asset) => asset.hash === attachment.asset)?.size ?? 0;
  }
  bytes += plan.manifest.identities.length * ROOM_ARCHIVE_LIMITS.identityReservationBytes;
  return bytes;
}
function reviewOf(row: RoomArchiveJobRow, plan: StoredPlan, name: string): RoomArchiveSummary {
  const manifest = plan.manifest;
  const resolution = resolveRoomIdentities(manifest.identities);
  const unknownAuthors = resolution.unknownKeys.length;
  const roots = manifest.messages.filter((message) => message.threadRootKey === null).length;
  const warnings = new Map<RoomArchiveWarningCode, { count: number; samples: Set<string> }>();
  const add = (code: RoomArchiveWarningCode, sample: string, times = 1) => {
    const bucket = warnings.get(code) ?? { count: 0, samples: new Set<string>() };
    bucket.count += times;
    if (bucket.samples.size < ROOM_ARCHIVE_LIMITS.warningSamples) bucket.samples.add(sample);
    warnings.set(code, bucket);
  };
  add("plaintextSensitive", manifest.room.key);
  add("privateDestination", manifest.room.key);
  add("rolesInactive", manifest.room.key);
  add("membersNotJoined", manifest.room.key);
  add("aiSettingsOmitted", manifest.room.key);
  add("sourceMetadataHistorical", manifest.room.key);
  add("linksNotRewritten", manifest.room.key);
  add("quoteUnavailable", manifest.room.key, manifest.messages.filter((message) => message.quote?.kind === "unavailable").length);
  add("aiHistoryOnly", manifest.room.key, manifest.messages.filter((message) => message.kind === "ai").length);
  if (unknownAuthors) add("unknownAuthors", manifest.room.key, unknownAuthors);
  const emailsDiscarded = plan.emailsDiscarded;
  if (emailsDiscarded) add("emailsDiscarded", manifest.room.key, emailsDiscarded);
  if (manifest.members.some((member) => member.role === "owner") && manifest.members.filter((member) => member.role === "owner").length > 1) {
    add("historicalRolesFlattened", manifest.room.key);
  }
  const preview = manifest.messages.slice(0, ROOM_ARCHIVE_LIMITS.previewMessages).map((message) => {
    const identity = message.authorKey ? manifest.identities.find((entry) => entry.key === message.authorKey) : undefined;
    const local = identity ? resolution.local.get(identity.key) ?? null : null;
    const authorLabel: RoomArchiveSummary["preview"][number]["authorLabel"] =
      message.kind === "ai"
        ? { kind: "ai" }
        : local
          ? { kind: "known", id: local, name: (db.prepare("SELECT name FROM users WHERE id = ?").get(local) as { name: string } | undefined)?.name ?? local }
          : { kind: "unknown" };
    return {
      kind: message.kind,
      authorLabel,
      createdAt: message.createdAt,
      bodyExcerpt: [...message.body].slice(0, ROOM_ARCHIVE_LIMITS.previewBodyCodePoints).join(""),
    };
  });
  const metaPreview = importedMetaJson({
    v: 1,
    sourceCreatedAt: manifest.room.createdAt,
    sourceUpdatedAt: manifest.room.updatedAt,
    sourceArchivedAt: manifest.room.archivedAt,
    sourceVisibility: manifest.room.visibility,
    importedAt: Date.now(),
  } satisfies ImportedMetaRow);
  const estimated = finalStorageBytes(plan, name, metaPreview);
  const attachmentBytes = manifest.messages.reduce((sum, message) => sum + message.attachments.reduce((inner, attachment) => inner + (plan.assets.find((asset) => asset.hash === attachment.asset)?.size ?? 0), 0), 0);
  return {
    name,
    sourceVisibility: manifest.room.visibility,
    sourceArchived: manifest.room.archivedAt !== null,
    roots,
    replies: manifest.messages.length - roots,
    attachments: manifest.messages.reduce((sum, message) => sum + message.attachments.length, 0),
    distinctAssets: plan.assets.length,
    members: manifest.members.length,
    identities: manifest.identities.length,
    recognizedAuthors: manifest.identities.length - unknownAuthors,
    unknownAuthors,
    zipBytes: plan.zipBytes,
    expandedBytes: plan.expandedBytes,
    attachmentBytes,
    finalStorageBytes: estimated,
    temporaryReservationBytes: row.reservation_bytes,
    quotaUsedBytes: storageUsed(row.user_id),
    quotaLimitBytes: userStorageLimit(row.user_id),
    warnings: [...warnings].map(([code, bucket]) => ({ code, count: bucket.count, sampleKeys: [...bucket.samples] })),
    preview,
  };
}

/** Persist a review at confirm time and hand back a job ready for the committing CAS. */
export function refreshReview(row: RoomArchiveJobRow, name: string): { digest: string; summary: RoomArchiveSummary } {
  const plan = readPlan(row);
  const summary = reviewOf(row, plan, name);
  const digest = reviewDigest(row.user_id, plan, name);
  db.prepare("UPDATE room_archive_jobs SET summary_json = ?, review_digest = ?, updated_at = ? WHERE id = ? AND state = 'ready'").run(
    JSON.stringify(summary),
    digest,
    Date.now(),
    row.id,
  );
  return { digest, summary };
}

/** The roster sample: escaped historical names, never emails, proofs, or local ids. */
export function rosterPage(row: RoomArchiveJobRow, after: string | null, limit: number): { items: Array<{ key: string; historicalName: string | null; role: "owner" | "moderator" | "member" | null; recognizedName: string | null }>; nextAfter: string | null } {
  const plan = readPlan(row);
  const resolution = resolveRoomIdentities(plan.manifest.identities);
  const sorted = [...plan.manifest.identities].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const start = after ? sorted.findIndex((identity) => identity.key > after) : 0;
  const slice = start < 0 ? [] : sorted.slice(start, start + limit + 1);
  const page = slice.slice(0, limit);
  return {
    items: page.map((identity) => {
      const local = resolution.local.get(identity.key) ?? null;
      const member = plan.manifest.members.find((entry) => entry.identityKey === identity.key);
      return {
        key: identity.key,
        historicalName: identity.displayName,
        role: member?.role ?? null,
        recognizedName: local ? (db.prepare("SELECT name FROM users WHERE id = ?").get(local) as { name: string } | undefined)?.name ?? null : null,
      };
    }),
    nextAfter: slice.length > limit ? page.at(-1)!.key : null,
  };
}

// ---------------------------------------------------------------------------------------------------
// Promotion and the final transaction
// ---------------------------------------------------------------------------------------------------

function mediaDir(channelId: string): string {
  return path.join(CHANNEL_MEDIA_DIR, channelId);
}

export function removePromotedDir(journal: PromotionJournal): void {
  rmSync(mediaDir(journal.channelId), { recursive: true, force: true });
}

function writeJournal(row: RoomArchiveJobRow, journal: PromotionJournal): void {
  writeStageFile(stagePath(row.user_id, row.id, "promotion.json"), new TextEncoder().encode(JSON.stringify(journal)));
}

export function readJournal(row: RoomArchiveJobRow): PromotionJournal | null {
  const file = stagePath(row.user_id, row.id, "promotion.json");
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(readFileSync(file)))) as PromotionJournal;
    if (value.v !== 1 || typeof value.channelId !== "string" || !Array.isArray(value.attachments)) return null;
    return value;
  } catch {
    return null;
  }
}

/** All destination ids and raster files exist before the first row is visible. */
function promote(row: RoomArchiveJobRow, plan: StoredPlan, name: string, existing: PromotionJournal | null): { journal: PromotionJournal; targetChannelId: string } {
  const digest = reviewDigest(row.user_id, plan, name);
  if (row.review_digest !== digest) {
    throw new AppError({ code: "conflict", status: 409, message: "This review changed. Inspect the archive again.", details: { reason: "review_changed" } });
  }
  const targetChannelId = existing?.channelId ?? newId("chn");
  const journal: PromotionJournal = existing ?? { v: 1, channelId: targetChannelId, attachments: [] };
  writeJournal(row, journal);
  const byHash = new Map(plan.assets.map((asset) => [asset.hash, asset]));
  for (const message of plan.manifest.messages) {
    for (const attachment of message.attachments) {
      const asset = byHash.get(attachment.asset);
      if (!asset) throw new RoomArchiveFormatError("invalid_archive", "An attachment asset is missing.", attachment.key);
      if (asset.file !== 1) {
        const source = stagePath(row.user_id, row.id, `assets/${asset.hash}`);
        if (!existsSync(source) || statSync(source).size !== asset.size) {
          throw new RoomArchiveFormatError("invalid_archive", "An attachment original is missing.", attachment.key);
        }
        continue;
      }
      const id = journal.attachments.find((entry) => entry.key === attachment.key)?.id ?? newId("cat");
      const source = stagePath(row.user_id, row.id, `assets/${asset.hash}`);
      if (!existsSync(source)) throw new RoomArchiveFormatError("invalid_archive", "An attachment original is missing.", attachment.key);
      if (statSync(source).size !== asset.size) throw new RoomArchiveFormatError("invalid_archive", "An attachment original changed.", attachment.key);
      const ext = RASTER_EXTENSION[asset.mime as RasterMime] ?? "bin";
      if (!journal.attachments.some((entry) => entry.key === attachment.key)) journal.attachments.push({ key: attachment.key, id, asset: asset.hash, ext });
      // Persist the destination before writing so recovery can remove a partial promotion.
      writeJournal(row, journal);
      writeStageFile(channelAttachmentPath(targetChannelId, id, asset.mime), new Uint8Array(readFileSync(source)));
    }
  }
  // The journal is durable before any destination row can exist and before the media dir is trusted.
  writeJournal(row, journal);
  return { journal, targetChannelId };
}

export interface ConfirmResultPayload {
  channelId: string;
}

/**
 * Final synchronous conversion. Everything that could fail before a visible row (authority, digest,
 * stage integrity, quota, caps) is checked first; the insert, history, thread state, event, audit, and
 * done receipt share one transaction. A rollback leaves no room, FTS row, event, or result id.
 */
export function commitImport(row: RoomArchiveJobRow, name: string, journal: PromotionJournal, signal: AbortSignal): ConfirmResultPayload {
  if (signal.aborted) throw new AppError({ code: "conflict", status: 409, message: "This import was cancelled." });
  assertJobAlive(row);
  if (!featureAllowed(row.user_id, "channels")) {
    throw new AppError({ code: "forbidden", message: "Your administrator has disabled team channels for this account." });
  }
  if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get(row.user_id)) throw new AppError({ code: "not_found", message: "Account not found." });
  const plan = readPlan(row);
  const manifest = plan.manifest;
  const resolution = resolveRoomIdentities(manifest.identities);
  const digest = reviewDigest(row.user_id, plan, name);
  if (digest !== row.review_digest) {
    throw new AppError({ code: "conflict", status: 409, message: "This review changed. Inspect the archive again.", details: { reason: "review_changed" } });
  }

  // Caps match native creation; the importer becomes the only member and holder of one owner role.
  const roomTotal = (db.prepare("SELECT COUNT(*) AS n FROM channels WHERE kind = 'room'").get() as { n: number }).n;
  const owned = (db.prepare("SELECT COUNT(*) AS n FROM channels WHERE kind = 'room' AND owner_id = ?").get(row.user_id) as { n: number }).n;
  const joined = (
    db.prepare("SELECT COUNT(*) AS n FROM channel_members m JOIN channels c ON c.id = m.channel_id WHERE c.kind = 'room' AND m.user_id = ?").get(row.user_id) as { n: number }
  ).n;
  if (roomTotal >= CHANNEL_LIMITS.roomsTotal) throw new AppError({ code: "conflict", status: 409, message: "This server has reached its room limit.", details: { reason: "capacity" } });
  if (owned >= CHANNEL_LIMITS.roomsOwned) throw new AppError({ code: "conflict", status: 409, message: "You own too many rooms.", details: { reason: "capacity" } });
  if (joined >= CHANNEL_LIMITS.roomsJoined) throw new AppError({ code: "conflict", status: 409, message: "You have joined too many rooms.", details: { reason: "capacity" } });
  if (manifest.messages.length > CHANNEL_LIMITS.messagesPerRoom) throw new AppError({ code: "conflict", status: 409, message: "The imported room exceeds the message limit." });

  // Room messages are inserted in dense archive order; seq is assigned 1..N so threads stay contiguous.
  const identityIds = new Map(manifest.identities.map((identity) => [identity.key, newId("cimp")]));
  const messageIds = new Map(manifest.messages.map((message) => [message.key, newId("cmsg")]));
  const attachmentIds = new Map<string, string>();
  for (const message of manifest.messages) {
    for (const attachment of message.attachments) {
      const promoted = journal.attachments.find((entry) => entry.key === attachment.key);
      attachmentIds.set(attachment.key, promoted?.id ?? newId("cat"));
    }
  }

  const now = Date.now();
  const meta = importedMetaJson({
    v: 1,
    sourceCreatedAt: manifest.room.createdAt,
    sourceUpdatedAt: manifest.room.updatedAt,
    sourceArchivedAt: manifest.room.archivedAt,
    sourceVisibility: manifest.room.visibility,
    importedAt: now,
  } satisfies ImportedMetaRow);

  // Exact logical bytes, including the canonical provenance JSON with the freshly allocated ids.
  let finalBytes = Buffer.byteLength(name, "utf8") + Buffer.byteLength(manifest.room.description, "utf8") + Buffer.byteLength(meta, "utf8");
  const provenanceByMessage = new Map<string, string>();
  for (const message of manifest.messages) {
    const provenance = importedProvenanceJson({
      v: 1,
      authorIdentityId: message.authorKey ? identityIds.get(message.authorKey) ?? null : null,
      quoteUnavailable: message.quote?.kind === "unavailable",
      mentions: message.mentions.map((mention) => ({ identityId: identityIds.get(mention.identityKey) ?? "", start: mention.start, end: mention.end })),
      reactions: message.reactions.map((reaction) => ({ identityId: identityIds.get(reaction.identityKey) ?? "", emoji: reaction.emoji, createdAt: reaction.createdAt })),
    });
    provenanceByMessage.set(message.key, provenance);
    finalBytes += Buffer.byteLength(message.body, "utf8") + Buffer.byteLength(provenance, "utf8");
    for (const attachment of message.attachments) finalBytes += plan.assets.find((asset) => asset.hash === attachment.asset)?.size ?? 0;
  }
  finalBytes += manifest.identities.length * ROOM_ARCHIVE_LIMITS.identityReservationBytes;
  if (finalBytes > ROOM_ARCHIVE_LIMITS.finalRoomBytes) {
    throw new AppError({ code: "conflict", status: 413, message: "This room is larger than an import may create.", details: { reason: "limit_exceeded" } });
  }
  const retainedStageBytes = stageBytes(row.user_id, row.id);
  assertRoomQuotaConversion(row.user_id, row.reservation_bytes, finalBytes, retainedStageBytes);
  const assetByHash = new Map(plan.assets.map((asset) => [asset.hash, asset]));

  return tx(() => {
    // A cancel that arrived before the synchronous section is honored; nothing is visible yet.
    const current = db.prepare("SELECT state, cancel_requested FROM room_archive_jobs WHERE id = ?").get(row.id) as
      | { state: string; cancel_requested: number }
      | undefined;
    if (!current || current.state !== "committing" || current.cancel_requested === 1) {
      throw new AppError({ code: "conflict", status: 409, message: "This import was cancelled." });
    }
    const channelId = journal.channelId;
    db.prepare(
      `INSERT INTO channels (id, owner_id, name, description, icon, visibility, ai_json, revision, next_seq, archived_at, created_at, updated_at, kind, dm_key, imported_meta_json)
       VALUES (?, ?, ?, ?, ?, 'private', NULL, 1, ?, NULL, ?, ?, 'room', NULL, ?)`,
    ).run(channelId, row.user_id, name, manifest.room.description, manifest.room.icon, manifest.messages.length + 1, now, now, meta);

    db.prepare("INSERT INTO channel_members (channel_id, user_id, role, read_seq, notify_mode, joined_at) VALUES (?, ?, 'owner', ?, 'mentions', ?)").run(
      channelId,
      row.user_id,
      manifest.messages.length,
      now,
    );

    for (const identity of manifest.identities) {
      const member = manifest.members.find((entry) => entry.identityKey === identity.key);
      db.prepare(
        "INSERT INTO channel_import_identities (id, channel_id, local_user_id, historical_role, historical_joined_at) VALUES (?, ?, ?, ?, ?)",
      ).run(identityIds.get(identity.key)!, channelId, resolution.local.get(identity.key) ?? null, member?.role ?? null, member?.joinedAt ?? null);
    }

    const threadState = new Map<string, { count: number; lastSeq: number; lastAt: number }>();
    manifest.messages.forEach((message, index) => {
      const seq = index + 1;
      const id = messageIds.get(message.key)!;
      const provenance = provenanceByMessage.get(message.key)!;
      const replyTo = message.quote?.kind === "message" ? messageIds.get(message.quote.messageKey) ?? null : null;
      const threadRoot = message.threadRootKey ? messageIds.get(message.threadRootKey) ?? null : null;
      db.prepare(
        `INSERT INTO channel_messages
          (id, channel_id, seq, author_id, kind, body, reply_to, thread_root, client_id, request_hash, revision, created_at, edited_at, deleted_at, imported_json)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, 1, ?, ?, NULL, ?)`,
      ).run(id, channelId, seq, message.kind, message.body, replyTo, threadRoot, message.createdAt, message.editedAt, provenance);
      if (threadRoot) {
        const state = threadState.get(threadRoot) ?? { count: 0, lastSeq: 0, lastAt: 0 };
        state.count++;
        state.lastSeq = seq;
        state.lastAt = message.createdAt;
        threadState.set(threadRoot, state);
      }
      for (const attachment of message.attachments) {
        const asset = assetByHash.get(attachment.asset);
        if (!asset) throw new RoomArchiveFormatError("invalid_archive", "An attachment asset is missing.", attachment.key);
        const attachmentId = attachmentIds.get(attachment.key)!;
        const file = asset.file === 1;
        const data = file ? null : new Uint8Array(readFileSync(stagePath(row.user_id, row.id, `assets/${asset.hash}`)));
        if (data && data.byteLength !== asset.size) throw new RoomArchiveFormatError("invalid_archive", "An attachment changed during import.", attachment.key);
        db.prepare(
          `INSERT INTO channel_attachments (id, channel_id, message_id, uploader_id, owner_id, name, mime, size, file, data, width, height, created_at, deleted_at)
           VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        ).run(
          attachmentId,
          channelId,
          id,
          row.user_id,
          attachment.name,
          asset.mime,
          asset.size,
          file ? 1 : 0,
          data ? Buffer.from(data) : null,
          asset.width,
          asset.height,
          attachment.createdAt,
        );
      }
    });

    for (const [rootId, state] of threadState) {
      db.prepare(
        "INSERT INTO channel_thread_state (root_id, channel_id, reply_count, last_seq, last_at, last_author_id) VALUES (?, ?, ?, ?, ?, NULL)",
      ).run(rootId, channelId, state.count, state.lastSeq, state.lastAt);
      db.prepare("INSERT INTO channel_thread_reads (root_id, user_id, channel_id, read_seq, updated_at) VALUES (?, ?, ?, ?, ?)").run(
        rootId,
        row.user_id,
        channelId,
        state.lastSeq,
        now,
      );
    }

    audit(row.user_id, channelId, "import", null, "");
    insertEvent({ channelId, kind: "channel.changed", entityId: channelId, version: 1 });
    db.prepare(
      `UPDATE room_archive_jobs
       SET state = 'done', phase = 'complete', result_json = ?, reservation_bytes = ?, staged_bytes = ?, review_digest = ?, confirm_hash = ?, updated_at = ?
       WHERE id = ? AND state = 'committing'`,
    ).run(JSON.stringify({ channelId }), retainedStageBytes, retainedStageBytes, digest, confirmHashOf(name, digest), now, row.id);
    return { channelId };
  });
}

/** Job-side commit: reads the plan/journal, commits, then releases the stage without touching the room. */
export async function commitRoomImport(row: RoomArchiveJobRow, signal: AbortSignal): Promise<void> {
  const request = jobRequest<{ name: string; reviewDigest: string }>(row);
  if (!request) {
    failRoomJob(row, "import_failed");
    return;
  }
  // A first attempt has no journal yet: promotion creates it. A retry reuses the one left by an earlier
  // quota/capacity failure so two promoted directories can never exist.
  let journal = readJournal(row);
  try {
    setPhase(row.id, "promote", 0, null);
    const plan = readPlan(row);
    if (signal.aborted) {
      const latest = getRoomJobById(row.id);
      if (latest) finishCleanup(latest, "cancelled");
      if (journal) removePromotedDir(journal);
      return;
    }
    const { journal: verified, targetChannelId } = promote(row, plan, request.name, journal);
    if (journal && targetChannelId !== journal.channelId) removePromotedDir(journal);
    journal = verified;
    setPhase(row.id, "commit", 0, plan.manifest.messages.length);
    commitImport(row, request.name, verified, signal);
    const latest = getRoomJobById(row.id);
    if (latest) {
      // The transaction wrote the done receipt with the retained-stage reservation. Cleanup is best effort.
      cleanupAfterCommit(latest);
    }
  } catch (error) {
    const latest = getRoomJobById(row.id);
    if (!latest) return;
    if (signal.aborted || latest.cancel_requested === 1) {
      if (journal) removePromotedDir(journal);
      finishCleanup(latest, latest.expires_at <= Date.now() ? "expired" : "cancelled");
      return;
    }
    if (journal) removePromotedDir(journal);
    if (error instanceof QuotaError) {
      resetToReadyAfterFailure(latest, "storage_quota");
      return;
    }
    if (error instanceof AppError && (error.details as { reason?: string } | undefined)?.reason === "capacity") {
      resetToReadyAfterFailure(latest, "capacity");
      return;
    }
    if (error instanceof AppError && error.status === 413) {
      resetToReadyAfterFailure(latest, "storage_quota");
      return;
    }
    failRoomJob(latest, error instanceof RoomArchiveFormatError ? error.code : "import_failed");
  }
}

function cleanupAfterCommit(row: RoomArchiveJobRow): boolean {
  try {
    rmSync(stagePath(row.user_id, row.id, "upload.zip"), { force: true });
  } catch {
    // The janitor retries the whole stage.
  }
  try {
    rmSync(path.dirname(stagePath(row.user_id, row.id, "upload.zip")), { recursive: true, force: true });
    db.prepare("UPDATE room_archive_jobs SET reservation_bytes = 0, staged_bytes = 0, updated_at = ? WHERE id = ? AND state = 'done'").run(Date.now(), row.id);
    return true;
  } catch {
    return false;
  }
}

function resetToReadyAfterFailure(row: RoomArchiveJobRow, code: "storage_quota" | "capacity"): void {
  const updated = db
    .prepare(
      `UPDATE room_archive_jobs SET state = 'ready', phase = 'inspect', error_code = ?, reservation_bytes = ?, updated_at = ?
       WHERE id = ? AND state = 'committing'`,
    )
    .run(code, ROOM_ARCHIVE_LIMITS.stageReservationBytes, Date.now(), row.id);
  if (Number(updated.changes) === 1) {
    // Staging is retained so the user can free space and retry inspect/confirm within the TTL.
    void row;
  }
}

/** Confirm CAS: ready -> committing with the exact reviewed name and digest. */
export function beginImportCommit(row: RoomArchiveJobRow, name: string, digest: string): void {
  refreshReview(row, name);
  const hash = sha256Hex(new TextEncoder().encode(canonicalJson({ name, digest })));
  const updated = db
    .prepare(
      `UPDATE room_archive_jobs SET state = 'committing', phase = 'promote', request_json = ?, confirm_hash = ?, updated_at = ?
       WHERE id = ? AND state = 'ready' AND cancel_requested = 0`,
    )
    .run(JSON.stringify({ name, reviewDigest: digest }), hash, Date.now(), row.id);
  if (Number(updated.changes) !== 1) throw new AppError({ code: "conflict", status: 409, message: "This import is no longer ready." });
}

export function confirmHashOf(name: string, digest: string): string {
  return sha256Hex(new TextEncoder().encode(canonicalJson({ name, digest })));
}
