import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { ArchiveJob, ArchiveJobKind, ArchiveJobState, ArchiveSummary } from "../shared/chat-archive.js";
import { ARCHIVE_LIMITS } from "../shared/chat-archive.js";
import { db, tx } from "./db.js";
import { env } from "./env.js";
import { AppError } from "./errors.js";
import { newId } from "./crypto.js";
import { emitArchiveFinished } from "./outgoing-webhooks/events.js";

/**
 * Archive jobs and staging. Only server-generated ids name a staging directory; a client never supplies a
 * path. One active job per account, a 30 minute lifetime, and a global staging budget keep disk bounded.
 * Startup never promises resume: unfinished work is failed/cancelled and its bytes removed.
 */

export const ARCHIVE_ROOT = path.join(env.dataDir, "archive-staging");

interface JobRow {
  id: string;
  user_id: string;
  kind: ArchiveJobKind;
  state: ArchiveJobState;
  summary_json: string | null;
  result_json: string | null;
  error_code: string | null;
  created_at: number;
  expires_at: number;
}

const parse = <T>(value: string | null): T | undefined => {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
};

const toJob = (row: JobRow): ArchiveJob => ({
  id: row.id,
  kind: row.kind,
  state: row.state,
  expiresAt: row.expires_at,
  ...(parse<ArchiveSummary>(row.summary_json) ? { summary: parse<ArchiveSummary>(row.summary_json)! } : {}),
  ...(row.error_code ? { error: { code: row.error_code, message: errorMessage(row.error_code) } } : {}),
  ...(parse<ArchiveJob["result"]>(row.result_json) ? { result: parse<ArchiveJob["result"]>(row.result_json)! } : {}),
});

const errorMessage = (code: string): string => {
  switch (code) {
    case "invalid_archive":
      return "This file is not a valid okaychat archive.";
    case "too_large":
      return "This archive is too large to import.";
    case "unsupported_version":
      return "This archive was made by a newer version of okaychat.";
    case "import_failed":
      return "The import could not be completed.";
    case "export_failed":
      return "The export could not be prepared.";
    case "busy":
      return "Another archive job is already running.";
    default:
      return "The archive job failed.";
  }
};

export function jobDir(userId: string, jobId: string): string {
  return path.join(ARCHIVE_ROOT, userId, jobId);
}

function directoryBytes(dir: string): number {
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

export function stagingBytes(): number {
  return directoryBytes(ARCHIVE_ROOT);
}

/** 0700 directories and 0600 files: staging is private to this process's user. */
export function ensureJobDir(userId: string, jobId: string): string {
  const dir = jobDir(userId, jobId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function removeJobDir(userId: string, jobId: string): void {
  rmSync(jobDir(userId, jobId), { recursive: true, force: true });
}

/** Reserves a job row before any bytes are accepted. One active job per account, by the partial index. */
export function createJob(userId: string, kind: ArchiveJobKind): JobRow {
  const active = db.prepare("SELECT id FROM archive_jobs WHERE user_id = ? AND state IN ('preparing', 'ready', 'committing')").get(userId);
  if (active) throw new AppError({ code: "rate_limited", message: errorMessage("busy") });
  if (stagingBytes() >= ARCHIVE_LIMITS.stagingTotalBytes) throw new AppError({ code: "storage_quota", message: "Archive staging is full. Try again shortly." });
  const now = Date.now();
  const id = newId("arc");
  db.prepare(
    `INSERT INTO archive_jobs (id, user_id, kind, state, created_at, expires_at) VALUES (?, ?, ?, 'preparing', ?, ?)`,
  ).run(id, userId, kind, now, now + ARCHIVE_LIMITS.jobLifetimeMs);
  ensureJobDir(userId, id);
  return getJobRow(userId, id)!;
}

export function getJobRow(userId: string, jobId: string): JobRow | undefined {
  return db.prepare("SELECT * FROM archive_jobs WHERE id = ? AND user_id = ?").get(jobId, userId) as JobRow | undefined;
}

/** A foreign or missing job answers the same 404. An expired job answers 410 so the client re-uploads. */
export function getJob(userId: string, jobId: string): ArchiveJob {
  const row = getJobRow(userId, jobId);
  if (!row) throw new AppError({ code: "not_found", message: "Archive job not found." });
  if (row.expires_at <= Date.now() && row.state !== "done") {
    expireJob(userId, row.id);
    throw new AppError({ code: "not_found", message: "This archive job expired. Upload it again." });
  }
  return toJob(row);
}

export function setSummary(userId: string, jobId: string, summary: ArchiveSummary): void {
  db.prepare("UPDATE archive_jobs SET summary_json = ? WHERE id = ? AND user_id = ?").run(JSON.stringify(summary), jobId, userId);
}

export function setReady(userId: string, jobId: string): void {
  tx(() => {
    const row = db.prepare("SELECT kind, state, summary_json FROM archive_jobs WHERE id = ? AND user_id = ?").get(jobId, userId) as
      | { kind: ArchiveJobKind; state: ArchiveJobState; summary_json: string | null }
      | undefined;
    const changed = db.prepare("UPDATE archive_jobs SET state = 'ready' WHERE id = ? AND user_id = ? AND state = 'preparing'").run(jobId, userId);
    if (!changed.changes || !row || row.kind !== "export") return;
    const summary = parse<ArchiveSummary>(row.summary_json);
    // Export success is readiness, not a download. Only this transition publishes a terminal event;
    // preview-ready imports and later expiry/downloads stay silent.
    emitArchiveFinished({ userId, kind: "export", jobId, outcome: "completed", chatCount: summary?.chats.length ?? 0, failureCode: null });
  });
}

export function setFailed(userId: string, jobId: string, code = "import_failed"): void {
  tx(() => {
    const row = db.prepare("SELECT kind, state FROM archive_jobs WHERE id = ? AND user_id = ?").get(jobId, userId) as
      | { kind: ArchiveJobKind; state: ArchiveJobState }
      | undefined;
    const changed = db.prepare(
      "UPDATE archive_jobs SET state = 'failed', error_code = ? WHERE id = ? AND user_id = ? AND state IN ('preparing', 'ready', 'committing')",
    ).run(code, jobId, userId);
    if (!changed.changes || !row) return;
    const failureCode = row.kind === "import" && (code === "invalid_archive" || code === "unsupported_version" || code === "too_large")
      ? "invalid_archive"
      : "archive_error";
    emitArchiveFinished({ userId, kind: row.kind, jobId, outcome: "failed", chatCount: 0, failureCode });
  });
}

export function setDone(userId: string, jobId: string, result: NonNullable<ArchiveJob["result"]>): void {
  tx(() => {
    const changed = db.prepare("UPDATE archive_jobs SET state = 'done', result_json = ? WHERE id = ? AND user_id = ?").run(JSON.stringify(result), jobId, userId);
    if (!changed.changes) return;
    // Import completion is this commit: chats and the job result are already written in the caller's
    // transaction (the route wraps commitArchive and setDone together).
    emitArchiveFinished({
      userId,
      kind: "import",
      jobId,
      outcome: "completed",
      chatCount: result.threads.length,
      failureCode: null,
    });
  });
}

export function beginCommit(userId: string, jobId: string): boolean {
  const result = db.prepare("UPDATE archive_jobs SET state = 'committing' WHERE id = ? AND user_id = ? AND state = 'ready'").run(jobId, userId);
  return result.changes === 1;
}

/** Returns a committing job to ready after a quota failure, so the TTL still allows a retry. */
export function resetToReady(userId: string, jobId: string): void {
  db.prepare("UPDATE archive_jobs SET state = 'ready' WHERE id = ? AND user_id = ? AND state = 'committing'").run(jobId, userId);
}

export function expireJob(userId: string, jobId: string): void {
  db.prepare("UPDATE archive_jobs SET state = 'cancelled' WHERE id = ? AND user_id = ? AND state IN ('preparing', 'ready')").run(jobId, userId);
  removeJobDir(userId, jobId);
}

/** Idempotent cancel. A completed import keeps its chats; only staging goes away. */
export function cancelJob(userId: string, jobId: string): { imported: boolean } {
  const row = getJobRow(userId, jobId);
  if (!row) throw new AppError({ code: "not_found", message: "Archive job not found." });
  if (row.state === "committing") throw new AppError({ code: "conflict", message: "The import is finishing. Wait for it to complete." });
  db.prepare("UPDATE archive_jobs SET state = 'cancelled' WHERE id = ? AND user_id = ? AND state IN ('preparing', 'ready')").run(jobId, userId);
  removeJobDir(userId, jobId);
  return { imported: row.state === "done" };
}

function purgeStaging(userId: string, jobId: string): void {
  removeJobDir(userId, jobId);
}

/**
 * Startup: no job survives a restart. Prepared files expire and are removed; open work is failed so the
 * account can start a new job immediately instead of waiting for the TTL.
 */
export function resetArchiveJobsAtStartup(): void {
  const rows = db.prepare("SELECT id, user_id, state, kind FROM archive_jobs").all() as Array<{ id: string; user_id: string; state: ArchiveJobState; kind: ArchiveJobKind }>;
  for (const row of rows) {
    tx(() => {
      if (row.state === "preparing" || row.state === "committing") {
        const errorCode = row.kind === "export" ? "export_failed" : "import_failed";
        const changed = db
          .prepare("UPDATE archive_jobs SET state = 'failed', error_code = ? WHERE id = ? AND state IN ('preparing','committing')")
          .run(errorCode, row.id);
        if (changed.changes) {
          // A success that already reached `ready` is never rewritten into a failure: its staging file
          // expiring later is not a new outcome. Only genuinely unfinished work publishes interrupted.
          emitArchiveFinished({ userId: row.user_id, kind: row.kind, jobId: row.id, outcome: "failed", chatCount: 0, failureCode: "interrupted" });
        }
      } else if (row.state === "ready") {
        db.prepare("UPDATE archive_jobs SET state = 'cancelled' WHERE id = ?").run(row.id);
      }
    });
    if (row.state !== "done") purgeStaging(row.user_id, row.id);
  }
  // Any directory left without a live job is stale bytes.
  try {
    for (const user of readdirSync(ARCHIVE_ROOT)) {
      for (const job of readdirSync(path.join(ARCHIVE_ROOT, user))) {
        if (!getJobRow(user, job)) rmSync(path.join(ARCHIVE_ROOT, user, job), { recursive: true, force: true });
      }
    }
  } catch {
    // No staging directory yet.
  }
}

/** One sweep every 60 s; unref'd so it never holds the process open. */
export function startArchiveMaintenance(): void {
  const sweep = setInterval(() => {
    const now = Date.now();
    const expired = db
      .prepare("SELECT id, user_id FROM archive_jobs WHERE expires_at <= ? AND state IN ('preparing', 'ready', 'committing')")
      .all(now) as Array<{ id: string; user_id: string }>;
    for (const row of expired) expireJob(row.user_id, row.id);
  }, 60_000);
  sweep.unref();
}

/** Removes a deleted account's jobs (users cascade removes the rows; the bytes must go too). */
export function removeArchiveStagingForUser(userId: string): void {
  rmSync(path.join(ARCHIVE_ROOT, userId), { recursive: true, force: true });
}
