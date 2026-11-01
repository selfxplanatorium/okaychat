import { readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { db, tx } from "../db.js";
import { env } from "../env.js";
import { AppError } from "../errors.js";
import { messageBytes } from "../quota.js";
import { normalizeImages } from "./refs.js";
import { sniffRaster } from "./sniff.js";
import { MEDIA_CACHE_DIR, MEDIA_DIR, mediaReferenced, putMedia, releaseMedia } from "./store.js";

// Moves legacy image BLOBs and inline chat images into the media store, one row at a time, and collects
// files no row points at. Started from index.ts, never on import. Every step is idempotent: a row is
// rewritten only after its file is durably written, and a crash in between leaves an orphan file that GC
// removes after the grace period. The original BLOB or data URL is replaced in the same transaction that
// records the media reference, never before. See docs/implementation/media.md.

const IMAGE_DIR = path.join(env.dataDir, "images");
const GRACE_MS = 60 * 60_000;
const CACHE_BUDGET = Math.max(64, Number(process.env.OKAYCHAT_MEDIA_CACHE_MB) || 1024) * 1024 * 1024;

const cursor = (key: string): number =>
  Number((db.prepare("SELECT value FROM server_settings WHERE key = ?").get(`media_migration:${key}`) as { value: string } | undefined)?.value ?? 0);
const setCursor = (key: string, rowid: number) =>
  db.prepare("INSERT INTO server_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(`media_migration:${key}`, String(rowid));

let skipped = 0;
const MAX_SKIP_LOGS = 20;

/**
 * A row whose bytes fail image validation for good (over the pixel bound): it keeps its BLOB or inline data
 * and the cursor moves past it, so it cannot block later rows. Only the table, rowid, and our own reason are
 * logged, never content, and only the first few.
 */
function skip(table: string, rowid: number, error: AppError): void {
  skipped++;
  if (skipped <= MAX_SKIP_LOGS) console.warn(`[media] left ${table} row ${rowid} as it was: ${error.message}`);
  else if (skipped === MAX_SKIP_LOGS + 1) console.warn("[media] more rows left as they were; not logging each");
}

const permanent = (error: unknown): error is AppError => error instanceof AppError && error.code === "validation";

/** Image BLOBs of uploads, run_code outputs, and avatars. One row in memory at a time. */
function migrateBlobs(table: "uploads" | "sandbox_files" | "user_avatars", limit: number): number {
  const key = table;
  const after = cursor(key);
  const owner = "user_id";
  const rows = db.prepare(`SELECT rowid, ${owner} AS user_id FROM ${table} WHERE rowid > ? AND media_id IS NULL AND length(data) > 0 ORDER BY rowid LIMIT ?`)
    .all(after, limit) as Array<{ rowid: number; user_id: string }>;
  for (const { rowid, user_id } of rows) {
    const row = db.prepare(`SELECT data FROM ${table} WHERE rowid = ? AND media_id IS NULL`).get(rowid) as { data: Uint8Array } | undefined;
    const mime = row ? sniffRaster(row.data) : null;
    try {
      tx(() => {
        if (row && mime) {
          // Already charged as a BLOB; moving it must not fail on quota.
          const { media } = putMedia(user_id, row.data);
          db.prepare(`UPDATE ${table} SET media_id = ?, mime = ?, data = x'' WHERE rowid = ? AND media_id IS NULL`).run(media.id, media.mime, rowid);
        }
        setCursor(key, rowid);
      });
    } catch (error) {
      // Anything else (disk full, I/O, a locked database) rolls back with the cursor and is retried later.
      if (!permanent(error)) throw error;
      skip(table, rowid, error);
      setCursor(key, rowid);
    }
  }
  return rows.length;
}

/** Inline raster images in stored user and assistant messages become `okaychat-upload:` references. */
function migrateMessages(limit: number): number {
  const after = cursor("messages");
  const rows = db.prepare(`SELECT m.rowid, m.thread_id, t.user_id FROM messages m JOIN threads t ON t.id = m.thread_id
    WHERE m.rowid > ? AND m.content LIKE '%data:image/%' ORDER BY m.rowid LIMIT ?`).all(after, limit) as Array<{ rowid: number; thread_id: string; user_id: string }>;
  for (const { rowid, thread_id, user_id } of rows) {
    tx(() => {
      const row = db.prepare("SELECT content FROM messages WHERE rowid = ?").get(rowid) as { content: string } | undefined;
      let content: unknown;
      try {
        content = row ? JSON.parse(row.content) : undefined;
      } catch {
        content = undefined;
      }
      if (content) {
        // A part over the pixel bound stays inline; the rest of the message still moves.
        const next = normalizeImages(user_id, thread_id, content, { keepInvalid: true });
        if (next !== content) {
          const json = JSON.stringify(next);
          // The same accounting as appendMessage: references and any remaining inline attachments (a PDF the
          // uploads table already charges) are counted once.
          db.prepare("UPDATE messages SET content = ?, bytes = ? WHERE rowid = ?").run(json, messageBytes(json), rowid);
        }
      }
      setCursor("messages", rowid);
    });
  }
  return rows.length;
}

/** One bounded step of the migration. Returns how many rows it looked at; 0 means done. */
export function migrateMediaBatch(limit = 10): number {
  for (const table of ["uploads", "sandbox_files", "user_avatars"] as const) {
    const n = migrateBlobs(table, limit);
    if (n) return n;
  }
  return migrateMessages(limit);
}

const listDir = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};
const olderThan = (file: string, cutoff: number) => {
  try {
    return statSync(file).mtimeMs < cutoff;
  } catch {
    return false;
  }
};

/**
 * Removes media rows nothing points at, files without a row (crash leftovers, deleted accounts), and
 * previews of deleted originals, then trims the preview cache to its budget, oldest first. Files younger
 * than the grace period are never touched, so an upload between its file write and its commit is safe.
 */
export function collectMediaGarbage(now = Date.now()): { media: number; files: number; previews: number } {
  const cutoff = now - GRACE_MS;
  let media = 0;
  for (const { id } of db.prepare("SELECT id FROM media WHERE created_at < ?").all(cutoff) as Array<{ id: string }>) {
    if (mediaReferenced(id)) continue;
    releaseMedia(id);
    media++;
  }
  const users = new Set((db.prepare("SELECT id FROM users").all() as Array<{ id: string }>).map((u) => u.id));
  const hasMedia = db.prepare("SELECT 1 FROM media WHERE id = ? AND user_id = ?");
  const hasImage = db.prepare("SELECT 1 FROM images WHERE id = ? AND user_id = ?");
  let files = 0;
  for (const [root, exists] of [[MEDIA_DIR, hasMedia], [IMAGE_DIR, hasImage]] as const) {
    for (const user of listDir(root)) {
      const dir = path.join(root, user);
      if (!users.has(user)) {
        if (olderThan(dir, cutoff)) rmSync(dir, { recursive: true, force: true });
        continue;
      }
      for (const name of listDir(dir)) {
        const id = name.split(".")[0]!;
        const file = path.join(dir, name);
        if ((name.includes(".tmp-") || !exists.get(id, user)) && olderThan(file, cutoff)) {
          rmSync(file, { force: true });
          files++;
        }
      }
    }
  }
  let previews = 0;
  const cached: Array<{ file: string; size: number; mtime: number }> = [];
  for (const user of listDir(MEDIA_CACHE_DIR)) {
    const dir = path.join(MEDIA_CACHE_DIR, user);
    for (const name of listDir(dir)) {
      const file = path.join(dir, name);
      const id = name.split(".")[0]!;
      if (!users.has(user) || (!hasMedia.get(id, user) && !hasImage.get(id, user)) || name.includes(".tmp-")) {
        if (olderThan(file, cutoff)) rmSync(file, { force: true }), previews++;
        continue;
      }
      try {
        const stat = statSync(file);
        cached.push({ file, size: stat.size, mtime: stat.mtimeMs });
      } catch { /* Removed meanwhile. */ }
    }
  }
  let total = cached.reduce((sum, f) => sum + f.size, 0);
  if (total > CACHE_BUDGET) {
    // Previews regenerate on the next request, so evicting the oldest is always safe.
    for (const f of cached.sort((a, b) => a.mtime - b.mtime)) {
      if (total <= CACHE_BUDGET * 0.8) break;
      rmSync(f.file, { force: true });
      total -= f.size;
      previews++;
    }
  }
  return { media, files, previews };
}

let timer: NodeJS.Timeout | undefined;

/** Runs the migration in small steps between other work, then GC now and every six hours. */
export function startMediaMaintenance(): void {
  let total = 0;
  const step = () => {
    let moved = 0;
    try {
      moved = migrateMediaBatch();
      total += moved;
    } catch (error) {
      console.error("[media] migration step failed; retrying later:", (error as Error).message);
      setTimeout(step, 60_000).unref();
      return;
    }
    if (moved) return void setImmediate(step);
    if (total) console.log(`[media] legacy image migration finished (${total} rows checked, ${skipped} left as they were); VACUUM offline to reclaim database space`);
    try {
      collectMediaGarbage();
    } catch (error) {
      console.error("[media] garbage collection failed:", (error as Error).message);
    }
  };
  setImmediate(step);
  timer ??= setInterval(() => {
    try {
      collectMediaGarbage();
    } catch (error) {
      console.error("[media] garbage collection failed:", (error as Error).message);
    }
  }, 6 * 60 * 60_000);
  timer.unref();
}
