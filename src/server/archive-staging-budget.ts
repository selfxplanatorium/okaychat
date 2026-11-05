import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { db } from "./db.js";
import { env } from "./env.js";
import { AppError } from "./errors.js";
import { ROOM_ARCHIVE_LIMITS } from "../shared/room-archive.js";

/**
 * One physical staging budget for personal chat archives and room archives. Room jobs hold a durable
 * 256 MiB reservation before their first byte; personal archive jobs reserve the same worst case at
 * admission. Both read this helper, so simultaneous jobs cannot each pass a per-feature check and then
 * fill the disk together.
 */

export const PERSONAL_ARCHIVE_STAGING_ROOT = path.join(env.dataDir, "archive-staging");
export const ROOM_ARCHIVE_STAGING_ROOT = path.join(env.dataDir, "room-archive-staging");

export function directoryBytes(dir: string): number {
  try {
    let total = 0;
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      const stat = statSync(file);
      total += stat.isDirectory() ? directoryBytes(file) : stat.size;
    }
    return total;
  } catch {
    return 0;
  }
}

export function personalStagingBytes(): number {
  return directoryBytes(PERSONAL_ARCHIVE_STAGING_ROOT);
}

/** Outstanding room reservations, including cleanup-pending receipts. */
export function roomStagingReserved(): number {
  return (db.prepare("SELECT COALESCE(SUM(reservation_bytes), 0) AS n FROM room_archive_jobs").get() as { n: number }).n;
}

export function roomStagingReservedFor(userId: string): number {
  return (db.prepare("SELECT COALESCE(SUM(reservation_bytes), 0) AS n FROM room_archive_jobs WHERE user_id = ?").get(userId) as { n: number }).n;
}

export function stagingFullError(): AppError {
  return new AppError({
    code: "storage_quota",
    status: 413,
    message: "Archive staging is full right now. Try again after another archive finishes.",
    details: { reason: "staging_full" },
  });
}

/**
 * Admission for a new job of `incomingBytes`. `otherRoom` excludes the row being converted when the
 * caller re-checks itself.
 */
export function assertStagingCapacity(incomingBytes: number, otherRoom = roomStagingReserved()): void {
  if (personalStagingBytes() + otherRoom + incomingBytes > ROOM_ARCHIVE_LIMITS.globalStagingBytes) throw stagingFullError();
}
