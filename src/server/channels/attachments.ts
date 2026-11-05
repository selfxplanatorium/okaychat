import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { Context } from "hono";
import { afterCommit, db, tx } from "../db.js";
import { env } from "../env.js";
import { AppError } from "../errors.js";
import { assertStorage } from "../quota.js";
import { CHANNEL_LIMITS } from "../../shared/channels.js";
import { headerDimensions, RASTER_EXTENSION, sniffRaster, type RasterMime } from "../media/sniff.js";
import { MAX_IMAGE_PIXELS, MEDIA_CACHE_DIR } from "../media/store.js";
import { serveImage } from "../media/variants.js";
import { assertChannelMember, assertWritable, notFound, type ChannelRow } from "./access.js";
import { chargeRate } from "./rate.js";

/**
 * Channel attachments are room-owned bytes. Raster originals live under dataDir/channel-media/<room>/;
 * everything else stays a BLOB in `channel_attachments`. The room owner is charged at upload, and the
 * URL is the only thing a client sees: every read re-checks membership and the live message.
 */

export interface AttachmentRow {
  id: string;
  channel_id: string;
  message_id: string | null;
  uploader_id: string | null;
  owner_id: string;
  name: string;
  mime: string;
  size: number;
  file: 0 | 1;
  data: Uint8Array | null;
  width: number | null;
  height: number | null;
  created_at: number;
  deleted_at: number | null;
}

export const CHANNEL_MEDIA_DIR = path.join(env.dataDir, "channel-media");
export const channelAttachmentPath = (channelId: string, id: string, mime: string) =>
  path.join(CHANNEL_MEDIA_DIR, channelId, `${id}.${RASTER_EXTENSION[mime as RasterMime] ?? "bin"}`);

/** Write-then-rename with an fsync, so a crash leaves either the complete file or a stray temp file for GC. */
function writeDurably(file: string, data: Uint8Array): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${randomBytes(6).toString("hex")}`;
  const fd = openSync(temp, "w", 0o600);
  try {
    let offset = 0;
    while (offset < data.byteLength) offset += writeSync(fd, data, offset, data.byteLength - offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
}

const displayName = (raw: string): string => {
  const clean = raw.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, CHANNEL_LIMITS.attachmentNameChars);
  return clean || "file";
};

const isSvg = (name: string, mime: string): boolean => /^image\/svg\+xml$/i.test(mime) || /\.svg$/i.test(name);

/** A declared "image" that is not a sniffed raster is opaque bytes, exactly like files.ts. */
const opaqueMime = (name: string, mime: string): string =>
  mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif|bmp|heic|tiff?)$/i.test(name) ? "application/octet-stream" : mime || "application/octet-stream";

export function storeChannelAttachment(userId: string, channel: ChannelRow, input: { name: string; mime: string; data: Uint8Array }): AttachmentRow {
  assertWritable(channel);
  const name = displayName(input.name);
  const declared = input.mime.slice(0, 200);
  if (!input.data.byteLength) throw new AppError({ code: "validation", status: 422, message: "That file is empty.", details: { reason: "attachment_type" } });
  if (input.data.byteLength > CHANNEL_LIMITS.attachmentBytes) {
    throw new AppError({ code: "validation", status: 413, message: "That file is too large." });
  }
  if (isSvg(name, declared)) {
    throw new AppError({ code: "validation", status: 422, message: "SVG files cannot be attached.", details: { reason: "attachment_type" } });
  }
  const raster = sniffRaster(input.data);
  const dimensions = raster ? headerDimensions(input.data, raster) : null;
  if (dimensions && dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) {
    throw new AppError({ code: "validation", status: 422, message: `This image has more than ${MAX_IMAGE_PIXELS / 1_000_000} megapixels.` });
  }
  const roomBytes = (
    db.prepare("SELECT COUNT(*) AS n FROM channel_attachments WHERE channel_id = ?").get(channel.id) as { n: number }
  ).n;
  if (roomBytes >= CHANNEL_LIMITS.attachmentsPerRoom) {
    throw new AppError({ code: "conflict", status: 409, message: "This room has reached its attachment limit." });
  }
  const pending = (
    db.prepare("SELECT COUNT(*) AS n FROM channel_attachments WHERE uploader_id = ? AND message_id IS NULL").get(userId) as { n: number }
  ).n;
  if (pending >= CHANNEL_LIMITS.attachmentPendingPerUser) {
    throw new AppError({ code: "conflict", status: 409, message: "You have too many unattached files. Send or remove one first." });
  }
  // Charge the rate before any byte or row exists, so a 429 leaves nothing behind.
  chargeRate(userId, "attach");
  // The owner pays, so the quota check must run before the first byte is written.
  assertStorage(channel.owner_id, input.data.byteLength);
  const row: AttachmentRow = {
    id: `cat_${randomBytes(12).toString("base64url")}`,
    channel_id: channel.id,
    message_id: null,
    uploader_id: userId,
    owner_id: channel.owner_id,
    name,
    mime: raster ?? opaqueMime(name, declared),
    size: input.data.byteLength,
    file: raster ? 1 : 0,
    data: raster ? null : Buffer.from(input.data),
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
    created_at: Date.now(),
    deleted_at: null,
  };
  const file = raster ? channelAttachmentPath(channel.id, row.id, row.mime) : null;
  if (file) writeDurably(file, input.data);
  try {
    db.prepare(
      `INSERT INTO channel_attachments (id, channel_id, message_id, uploader_id, owner_id, name, mime, size, file, data, width, height, created_at, deleted_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      row.id,
      row.channel_id,
      row.uploader_id,
      row.owner_id,
      row.name,
      row.mime,
      row.size,
      row.file,
      raster ? null : Buffer.from(input.data),
      row.width,
      row.height,
      row.created_at,
    );
  } catch (error) {
    if (file) rmSync(file, { force: true });
    throw error;
  }
  return row;
}

export function attachmentRow(channelId: string, attachmentId: string): AttachmentRow | undefined {
  return db.prepare("SELECT * FROM channel_attachments WHERE channel_id = ? AND id = ?").get(channelId, attachmentId) as AttachmentRow | undefined;
}

export function removeAttachmentFile(row: Pick<AttachmentRow, "id" | "channel_id" | "mime" | "file">): void {
  if (row.file !== 1) return;
  rmSync(channelAttachmentPath(row.channel_id, row.id, row.mime), { force: true });
}

/** Validates and stamps the caller's pending files in the message transaction. */
export function bindAttachments(channel: ChannelRow, uploaderId: string, messageId: string, ids: string[] | undefined): void {
  const unique = [...new Set(ids ?? [])];
  if (!unique.length) return;
  if (unique.length > CHANNEL_LIMITS.attachmentsPerMessage) {
    throw new AppError({ code: "validation", status: 422, message: "Too many attachments on one message." });
  }
  const rows = db
    .prepare(`SELECT * FROM channel_attachments WHERE channel_id = ? AND id IN (${unique.map(() => "?").join(",")})`)
    .all(channel.id, ...unique) as unknown as AttachmentRow[];
  if (rows.length !== unique.length) {
    throw new AppError({ code: "validation", status: 422, message: "An attachment is no longer available.", details: { reason: "attachment" } });
  }
  for (const row of rows) {
    if (row.message_id !== null || row.deleted_at !== null || row.uploader_id !== uploaderId) {
      throw new AppError({ code: "validation", status: 422, message: "An attachment is no longer available.", details: { reason: "attachment" } });
    }
    if (row.owner_id !== channel.owner_id) {
      throw new AppError({ code: "conflict", status: 409, message: "This room changed owner. Remove the file and upload it again.", details: { reason: "owner_changed" } });
    }
  }
  for (const row of rows) {
    const result = db.prepare("UPDATE channel_attachments SET message_id = ? WHERE id = ? AND message_id IS NULL").run(messageId, row.id);
    if (Number(result.changes) !== 1) {
      throw new AppError({ code: "validation", status: 422, message: "An attachment is no longer available.", details: { reason: "attachment" } });
    }
  }
}

export function deletePendingAttachment(userId: string, channelId: string, attachmentId: string): void {
  tx(() => {
    const row = db
      .prepare("SELECT * FROM channel_attachments WHERE channel_id = ? AND id = ? AND uploader_id = ? AND message_id IS NULL")
      .get(channelId, attachmentId, userId) as AttachmentRow | undefined;
    if (!row) throw notFound();
    db.prepare("DELETE FROM channel_attachments WHERE id = ?").run(row.id);
    afterCommit(() => removeAttachmentFile(row));
  });
}

/** Raster and PDF render inline; everything else downloads, so a crafted file cannot script on our origin. */
function disposition(inline: boolean, name: string): string {
  return `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function serveChannelAttachment(c: Context, userId: string, channelId: string, attachmentId: string): Promise<Response> {
  assertChannelMember(userId, channelId);
  const row = db
    .prepare(
      `SELECT a.*, m.id AS live_message FROM channel_attachments a
       LEFT JOIN channel_messages m ON m.id = a.message_id
       WHERE a.channel_id = ? AND a.id = ?`,
    )
    .get(channelId, attachmentId) as (AttachmentRow & { live_message: string | null }) | undefined;
  if (!row || row.deleted_at !== null || row.message_id === null || !row.live_message) return c.json({ error: "Not found" }, 404);
  const live = db.prepare("SELECT deleted_at FROM channel_messages WHERE id = ?").get(row.message_id) as { deleted_at: number | null } | undefined;
  if (!live || live.deleted_at !== null) return c.json({ error: "Not found" }, 404);
  const forceDownload = c.req.query("download") === "1";
  if (row.file === 1) {
    return serveImage(
      c,
      { namespace: `ch-${channelId}`, key: row.id, file: channelAttachmentPath(channelId, row.id, row.mime), mime: row.mime, size: row.size, etag: row.id },
      { headers: { "Content-Disposition": disposition(!forceDownload, row.name), "Content-Security-Policy": "default-src 'none'; sandbox" } },
    );
  }
  const inline = !forceDownload && row.mime === "application/pdf";
  return new Response(new Uint8Array(row.data as unknown as Uint8Array) as unknown as BodyInit, {
    headers: {
      "Content-Type": row.mime || "application/octet-stream",
      "Content-Disposition": disposition(inline, row.name),
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}

function purgeRows(where: string, args: Array<string | number>, batch = 200): number {
  return tx(() => {
    const rows = db
      .prepare(`SELECT * FROM channel_attachments WHERE ${where} ORDER BY created_at LIMIT ?`)
      .all(...args, batch) as unknown as AttachmentRow[];
    if (!rows.length) return 0;
    db.prepare(`DELETE FROM channel_attachments WHERE id IN (${rows.map(() => "?").join(",")})`).run(...rows.map((row) => row.id));
    afterCommit(() => {
      for (const row of rows) removeAttachmentFile(row);
    });
    return rows.length;
  });
}

export function purgePendingAttachments(now: number): number {
  return purgeRows("message_id IS NULL AND created_at < ?", [now - CHANNEL_LIMITS.attachmentPendingMs]);
}

export function purgeTombstonedAttachments(now: number): number {
  return purgeRows("deleted_at IS NOT NULL AND deleted_at < ?", [now - CHANNEL_LIMITS.attachmentRetentionMs]);
}

/** Removes whole directories of deleted rooms and orphan files older than a day. Bounded per pass. */
export function collectAttachmentGarbage(): void {
  if (!existsSync(CHANNEL_MEDIA_DIR)) return;
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let dirs = 0;
  for (const entry of readdirSync(CHANNEL_MEDIA_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (++dirs > 200) break;
    const channelId = entry.name;
    const dir = path.join(CHANNEL_MEDIA_DIR, channelId);
    if (!db.prepare("SELECT 1 FROM channels WHERE id = ?").get(channelId)) {
      rmSync(dir, { recursive: true, force: true });
      continue;
    }
    for (const name of readdirSync(dir)) {
      const id = name.slice(0, name.indexOf("."));
      if (!id) continue;
      if (db.prepare("SELECT 1 FROM channel_attachments WHERE id = ?").get(id)) continue;
      try {
        if (statSync(path.join(dir, name)).mtimeMs < cutoff) rmSync(path.join(dir, name), { force: true });
      } catch {
        // A file removed by a concurrent purge is already gone.
      }
    }
  }
}

export function removeChannelMedia(channelId: string): void {
  rmSync(path.join(CHANNEL_MEDIA_DIR, channelId), { recursive: true, force: true });
  rmSync(path.join(MEDIA_CACHE_DIR, `ch-${channelId}`), { recursive: true, force: true });
}

export function attachmentBytes(channelId: string): number {
  return (db.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM channel_attachments WHERE channel_id = ?").get(channelId) as { n: number }).n;
}
