import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { newId } from "../crypto.js";
import { afterCommit, db } from "../db.js";
import { env } from "../env.js";
import { AppError } from "../errors.js";
import { assertStorage } from "../quota.js";
import { headerDimensions, RASTER_EXTENSION, sniffRaster, type RasterMime } from "./sniff.js";

// Raster originals live as files under dataDir/media/<userId>/<id>.<ext>; SQLite holds only metadata
// (owner, digest, type, size, header dimensions). Uploads, saved run_code outputs, and the profile picture
// point at a media row through `media_id`. Generated and MCP images keep their older images/ files.
// See docs/implementation/media.md.

export const MEDIA_DIR = path.join(env.dataDir, "media");
export const MEDIA_CACHE_DIR = path.join(env.dataDir, "media-cache");
/** Header bound checked before anything is stored; decoding has its own limit in variants.ts. */
export const MAX_IMAGE_PIXELS = 100_000_000;

export interface MediaRow {
  id: string;
  user_id: string;
  sha256: string;
  mime: RasterMime;
  size: number;
  width: number | null;
  height: number | null;
  created_at: number;
}

export const mediaPath = (row: Pick<MediaRow, "id" | "user_id" | "mime">) =>
  path.join(MEDIA_DIR, row.user_id, `${row.id}.${RASTER_EXTENSION[row.mime] ?? "bin"}`);

export const getMedia = (id: string): MediaRow | undefined =>
  db.prepare("SELECT * FROM media WHERE id = ?").get(id) as MediaRow | undefined;

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

/**
 * Stores a raster original for `userId`, or returns the account's existing copy of the same bytes. Identical
 * bytes are never shared across accounts. `charge` runs only when new bytes are written, before the write,
 * so a quota error leaves nothing behind. Synchronous so it can run inside a SQLite transaction; if that
 * transaction later rolls back, the file stays as an orphan that `collectMediaGarbage` removes.
 */
export function putMedia(userId: string, data: Uint8Array, charge?: (bytes: number) => void): { media: MediaRow; created: boolean } {
  const mime = sniffRaster(data);
  if (!mime) throw new AppError({ code: "validation", status: 422, message: "This file is not a PNG, JPEG, WebP, GIF, or AVIF image." });
  const sha256 = createHash("sha256").update(data).digest("hex");
  const existing = db.prepare("SELECT * FROM media WHERE user_id = ? AND sha256 = ? AND size = ? ORDER BY created_at LIMIT 1").get(userId, sha256, data.byteLength) as MediaRow | undefined;
  if (existing && existsSync(mediaPath(existing))) return { media: existing, created: false };
  const size = headerDimensions(data, mime);
  if (size && size.width * size.height > MAX_IMAGE_PIXELS) {
    throw new AppError({ code: "validation", status: 422, message: `This image has more than ${MAX_IMAGE_PIXELS / 1_000_000} megapixels.` });
  }
  charge?.(data.byteLength);
  const row: MediaRow = { id: newId("med"), user_id: userId, sha256, mime, size: data.byteLength, width: size?.width || null, height: size?.height || null, created_at: Date.now() };
  const file = mediaPath(row);
  writeDurably(file, data);
  try {
    db.prepare("INSERT INTO media (id, user_id, sha256, mime, size, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(row.id, row.user_id, row.sha256, row.mime, row.size, row.width, row.height, row.created_at);
  } catch (error) {
    rmSync(file, { force: true });
    throw error;
  }
  return { media: row, created: true };
}

/** Bytes of a media original. A missing file throws, so callers answer "not found" rather than serving nothing. */
export function readMedia(row: Pick<MediaRow, "id" | "user_id" | "mime">): Buffer {
  return readFileSync(mediaPath(row));
}

const REFERENCES = [
  "SELECT 1 FROM uploads WHERE media_id = @id",
  "SELECT 1 FROM sandbox_files WHERE media_id = @id",
  "SELECT 1 FROM user_avatars WHERE media_id = @id",
].join(" UNION ALL ");

export const mediaReferenced = (id: string): boolean => !!db.prepare(`${REFERENCES} LIMIT 1`).get({ id });

/**
 * Bytes a replacement frees when one row stops pointing at `previous`: its BLOB, plus the media original
 * when that row is its only reference. A media row another upload, output, or avatar still holds frees
 * nothing. Call before the row is changed.
 */
export function reclaimableBytes(previous: { mediaId?: string | null; blobBytes?: number } | undefined): number {
  if (!previous) return 0;
  let freed = previous.blobBytes ?? 0;
  if (previous.mediaId) {
    const holders = (db.prepare(`SELECT count(*) AS n FROM (${REFERENCES})`).get({ id: previous.mediaId }) as { n: number }).n;
    if (holders <= 1) freed += getMedia(previous.mediaId)?.size ?? 0;
  }
  return freed;
}

/**
 * Charges one replacement by net growth: new unique bytes minus what the replaced reference frees. Pass the
 * result as `putMedia`'s `charge`; for a non-image replacement call it with the new byte count. A dedup to
 * media the account already holds writes nothing and is never refused.
 */
export function chargeReplacement(userId: string, previous: { mediaId?: string | null; blobBytes?: number } | undefined): (bytes: number) => void {
  const freed = reclaimableBytes(previous);
  return (bytes) => {
    assertStorage(userId, bytes - freed);
  };
}

/**
 * Deletes a media row and its files once nothing points at it. Safe to call after every reference removal,
 * but only after the transaction that removed the reference has committed: a rollback would otherwise
 * restore a reference to a deleted file.
 */
export function releaseMedia(id: string | null | undefined): void {
  if (!id) return;
  // Inside a transaction this waits for the commit: a rollback restores the reference, and its file must still exist.
  afterCommit(() => {
    if (!mediaReferenced(id)) dropMedia(id);
  });
}

function dropMedia(id: string): void {
  const row = getMedia(id);
  if (!row) return;
  // Metadata first: a crash afterwards leaves an orphan file for GC, never a row without bytes.
  db.prepare("DELETE FROM media WHERE id = ?").run(id);
  rmSync(mediaPath(row), { force: true });
  removeVariants(row.user_id, id);
}

export const VARIANTS = { thumb: 256, medium: 640, large: 1280 } as const;
export type VariantName = keyof typeof VARIANTS;
export const isVariant = (value: unknown): value is VariantName => typeof value === "string" && Object.hasOwn(VARIANTS, value);

export const variantPath = (userId: string, key: string, variant: VariantName, kind: "webp" | "orig") =>
  path.join(MEDIA_CACHE_DIR, userId, `${key}.${variant}.${kind}`);

/** Drops the regenerable variants of one original (media id or generated image id). */
export function removeVariants(userId: string, key: string): void {
  for (const variant of Object.keys(VARIANTS) as VariantName[]) {
    rmSync(variantPath(userId, key, variant, "webp"), { force: true });
    rmSync(variantPath(userId, key, variant, "orig"), { force: true });
  }
}

/** Account deletion: every original and derivative of the user. */
export function removeUserMedia(userId: string): void {
  rmSync(path.join(MEDIA_DIR, userId), { recursive: true, force: true });
  rmSync(path.join(MEDIA_CACHE_DIR, userId), { recursive: true, force: true });
}

interface OwnedFile {
  name: string;
  mime: string;
  data: Uint8Array;
}

/** An upload's bytes, from its media file or its legacy BLOB. Only the caller's own rows. */
export function readUpload(userId: string, id: string): (OwnedFile & { mediaId: string | null }) | undefined {
  const row = db.prepare("SELECT name, mime, data, media_id FROM uploads WHERE id = ? AND user_id = ?").get(id, userId) as
    | { name: string; mime: string; data: Uint8Array; media_id: string | null }
    | undefined;
  if (!row) return undefined;
  if (!row.media_id) return { name: row.name, mime: row.mime, data: row.data, mediaId: null };
  const media = getMedia(row.media_id);
  if (!media || media.user_id !== userId) return undefined;
  try {
    return { name: row.name, mime: media.mime, data: readMedia(media), mediaId: media.id };
  } catch {
    return undefined;
  }
}

/** A saved run_code output's bytes, by id. Only the caller's own rows. */
export function readSandboxFile(userId: string, id: string): (OwnedFile & { path: string }) | undefined {
  const row = db.prepare("SELECT path, mime, data, media_id FROM sandbox_files WHERE id = ? AND user_id = ?").get(id, userId) as
    | { path: string; mime: string; data: Uint8Array; media_id: string | null }
    | undefined;
  return row ? sandboxBytes(userId, row) : undefined;
}

export function sandboxBytes(userId: string, row: { path: string; mime: string; data: Uint8Array; media_id: string | null }): (OwnedFile & { path: string }) | undefined {
  if (!row.media_id) return { name: row.path, path: row.path, mime: row.mime, data: row.data };
  const media = getMedia(row.media_id);
  if (!media || media.user_id !== userId) return undefined;
  try {
    return { name: row.path, path: row.path, mime: media.mime, data: readMedia(media) };
  } catch {
    return undefined;
  }
}
