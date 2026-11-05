import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { db, tx } from "../../db.js";
import { ROOM_ARCHIVE_LIMITS } from "../../../shared/room-archive.js";
import { ROOM_ARCHIVE_STAGING_ROOT, directoryBytes } from "../../archive-staging-budget.js";
import { cleanupStage, getRoomJobById, isRoomJobTerminal, requestCancel, stageDir, type RoomArchiveJobRow } from "./jobs.js";
import { readJournal, removePromotedDir } from "./import.js";
import { CHANNEL_MEDIA_DIR } from "../attachments.js";

/**
 * Startup recovery and bounded janitorial cleanup. No job resumes. A restart first fails every open job,
 * then removes only trusted, uncommitted promotion directories named by each journal, sweeps stray stage
 * folders, and releases reservations only after the bytes are actually gone. A committed room is never
 * removed by cleanup.
 */

function rowsAt(sql: string, ...params: Array<string | number>): RoomArchiveJobRow[] {
  return db.prepare(sql).all(...params) as unknown as RoomArchiveJobRow[];
}

/** Runs before the HTTP server starts accepting work. */
export function recoverRoomArchiveJobs(): void {
  const open = rowsAt("SELECT * FROM room_archive_jobs WHERE state IN ('uploading','queued','preparing','ready','committing')");
  for (const row of open) {
    db.prepare("UPDATE room_archive_jobs SET state = 'failed', error_code = 'interrupted', cancel_requested = 1, updated_at = ? WHERE id = ?").run(Date.now(), row.id);
    const latest = getRoomJobById(row.id);
    if (latest) cleanTerminal(latest, "failed");
  }

  // Done imports keep their committed room; only their stage is stale.
  for (const row of rowsAt("SELECT * FROM room_archive_jobs WHERE state = 'done' AND (reservation_bytes > 0 OR staged_bytes > 0)")) cleanTerminal(row, "done");
  for (const row of rowsAt("SELECT * FROM room_archive_jobs WHERE state IN ('failed','cancelled','expired') AND reservation_bytes > 0")) cleanTerminal(row, "failed");

  sweepStrayStage();
  sweepUncommittedPromotions();
}

function cleanTerminal(row: RoomArchiveJobRow, state: "failed" | "done"): void {
  // A done import's room directory is committed data; only a journal left by a non-done job is removed.
  if (state === "failed") {
    const journal = readJournal(row);
    if (journal) removePromotedDir(journal);
  }
  if (!cleanupStage(row.user_id, row.id)) return;
  db.prepare("UPDATE room_archive_jobs SET reservation_bytes = 0, staged_bytes = 0, updated_at = ? WHERE id = ?").run(Date.now(), row.id);
}

/** Stage directories without a job row are stale bytes. Bounded per pass. */
function sweepStrayStage(): void {
  let count = 0;
  try {
    for (const user of readdirSync(ROOM_ARCHIVE_STAGING_ROOT)) {
      const userDir = path.join(ROOM_ARCHIVE_STAGING_ROOT, user);
      for (const job of readdirSync(userDir)) {
        if (++count > 200) return;
        if (getRoomJobById(job)) continue;
        rmSync(path.join(userDir, job), { recursive: true, force: true });
      }
    }
  } catch {
    // No staging root yet.
  }
}

/** Promotion directories whose job never committed are fresh and safe to remove. */
function sweepUncommittedPromotions(): void {
  const referenced = new Set<string>();
  for (const row of rowsAt("SELECT * FROM room_archive_jobs WHERE state = 'done'")) {
    if (!row.result_json) continue;
    try {
      const result = JSON.parse(row.result_json) as { channelId?: string };
      if (result.channelId) referenced.add(result.channelId);
    } catch {
      // A malformed result has no committed directory to protect.
    }
  }
  let count = 0;
  try {
    for (const entry of readdirSync(CHANNEL_MEDIA_DIR)) {
      const id = entry;
      if (!id.startsWith("chn_")) continue;
      if (++count > 100) return;
      if (db.prepare("SELECT 1 FROM channels WHERE id = ?").get(id)) continue;
      if (referenced.has(id)) continue;
      rmSync(path.join(CHANNEL_MEDIA_DIR, id), { recursive: true, force: true });
    }
  } catch {
    // No channel media directory yet.
  }
}

/** One bounded janitor pass: expire, retry failed unlinks, prune receipts. */
export function runRoomArchiveMaintenance(): void {
  const now = Date.now();
  const expired = rowsAt("SELECT * FROM room_archive_jobs WHERE expires_at <= ? AND state IN ('uploading','queued','preparing','ready','committing') LIMIT 100", now);
  for (const row of expired) {
    requestCancel(row.user_id, row.id, "expired");
    const latest = getRoomJobById(row.id);
    if (latest && isRoomJobTerminal(latest.state) && latest.reservation_bytes > 0) cleanTerminal(latest, "failed");
    else if (latest && latest.state === "expired" && latest.reservation_bytes > 0) cleanTerminal(latest, "failed");
  }

  // A failed unlink is retried before the account may start a new job.
  for (const row of rowsAt("SELECT * FROM room_archive_jobs WHERE reservation_bytes > 0 AND state IN ('done','failed','cancelled','expired') LIMIT 100")) {
    cleanTerminal(row, row.state === "done" ? "done" : "failed");
  }

  pruneReceipts(now);
}

function pruneReceipts(now: number): void {
  tx(() => {
    const cutoff = now - ROOM_ARCHIVE_LIMITS.receiptRetentionMs;
    const stale = rowsAt(
      "SELECT * FROM room_archive_jobs WHERE state IN ('done','failed','cancelled','expired') AND reservation_bytes = 0 AND updated_at < ? ORDER BY updated_at ASC LIMIT 100",
      cutoff,
    );
    if (stale.length) db.prepare(`DELETE FROM room_archive_jobs WHERE id IN (${stale.map(() => "?").join(",")})`).run(...stale.map((row) => row.id));
    // At most 100 terminal receipts per account; only cleanup-complete rows are candidates.
    const accounts = db
      .prepare(
        `SELECT user_id, COUNT(*) AS n FROM room_archive_jobs WHERE state IN ('done','failed','cancelled','expired')
         GROUP BY user_id HAVING n > ? LIMIT 20`,
      )
      .all(ROOM_ARCHIVE_LIMITS.terminalReceiptsPerAccount) as Array<{ user_id: string; n: number }>;
    let budget = 100;
    for (const account of accounts) {
      if (budget <= 0) break;
      const excess = Math.min(budget, account.n - ROOM_ARCHIVE_LIMITS.terminalReceiptsPerAccount);
      const victims = rowsAt(
        `SELECT * FROM room_archive_jobs WHERE user_id = ? AND state IN ('done','failed','cancelled','expired')
         AND reservation_bytes = 0 ORDER BY updated_at ASC LIMIT ?`,
        account.user_id,
        excess,
      );
      if (victims.length) {
        db.prepare(`DELETE FROM room_archive_jobs WHERE id IN (${victims.map(() => "?").join(",")})`).run(...victims.map((row) => row.id));
        budget -= victims.length;
      }
    }
  });
}

export function startRoomArchiveMaintenance(): void {
  runRoomArchiveMaintenance();
  const timer = setInterval(runRoomArchiveMaintenance, 60_000);
  timer.unref?.();
}

/** Account deletion: both stage roots and any uncommitted promotion directories must go. */
export function removeRoomArchiveFilesForUser(userId: string): void {
  rmSync(path.join(ROOM_ARCHIVE_STAGING_ROOT, userId), { recursive: true, force: true });
  for (const row of rowsAt("SELECT * FROM room_archive_jobs WHERE user_id = ?")) {
    const journal = readJournal(row);
    if (journal && row.state !== "done") removePromotedDir(journal);
  }
}

export const roomArchiveStageBytes = (): number => directoryBytes(ROOM_ARCHIVE_STAGING_ROOT);
