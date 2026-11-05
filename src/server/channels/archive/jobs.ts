import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { afterCommit, db, tx } from "../../db.js";
import { env } from "../../env.js";
import { AppError } from "../../errors.js";
import { newId } from "../../crypto.js";
import { assertStorage, QuotaError, storageUsed, userStorageLimit } from "../../quota.js";
import { ROOM_ARCHIVE_LIMITS, type RoomArchiveErrorCode, type RoomArchiveJob, type RoomArchivePhase, type RoomArchiveProgressUnit, type RoomArchiveState, type RoomArchiveSummary } from "../../../shared/room-archive.js";
import { assertStagingCapacity, ROOM_ARCHIVE_STAGING_ROOT, roomStagingReserved } from "../../archive-staging-budget.js";
import { chargeRate } from "../rate.js";

/**
 * Durable room archive jobs. Admission reserves 256 MiB before the first byte (and the same reservation
 * is the account's quota hold), one job per account is active, one worker executes globally, and four
 * jobs may wait. Every transition is a compare-and-set; a stale or cancelled worker can never publish
 * ready/done. Nothing here holds a database transaction across I/O or compression.
 */

export interface RoomArchiveJobRow {
  id: string;
  user_id: string;
  kind: "export" | "import";
  authority: "owner" | "admin" | "importer";
  source_channel_id: string | null;
  admin_reason: string;
  state: RoomArchiveState;
  phase: RoomArchivePhase;
  cancel_requested: 0 | 1;
  reservation_bytes: number;
  staged_bytes: number;
  progress_done: number;
  progress_total: number | null;
  request_json: string | null;
  summary_json: string | null;
  review_digest: string | null;
  confirm_hash: string | null;
  target_channel_id: string | null;
  result_json: string | null;
  error_code: RoomArchiveErrorCode | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

export const ROOM_STAGE_FILES = ["upload.zip", "snapshot.json", "manifest.json", "export.zip", "promotion.json"] as const;

const TERMINAL: RoomArchiveState[] = ["done", "failed", "cancelled", "expired"];
export const isRoomJobTerminal = (state: RoomArchiveState): boolean => TERMINAL.includes(state);
const ACTIVE: RoomArchiveState[] = ["uploading", "queued", "preparing", "ready", "committing"];

export const roomArchiveRoot = (): string => ROOM_ARCHIVE_STAGING_ROOT;

export function stageDir(userId: string, jobId: string): string {
  return path.join(ROOM_ARCHIVE_STAGING_ROOT, userId, jobId);
}

/** Only server-generated names reach the filesystem; the containment check is a second lock. */
export function stagePath(userId: string, jobId: string, name: (typeof ROOM_STAGE_FILES)[number] | `assets/${string}`): string {
  const base = path.resolve(stageDir(userId, jobId));
  const file = path.resolve(base, name);
  if (!file.startsWith(`${base}${path.sep}`)) throw new AppError({ code: "validation", message: "Invalid archive stage path." });
  return file;
}

export function ensureStageDir(userId: string, jobId: string): string {
  const dir = stageDir(userId, jobId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(dir, "assets"), { recursive: true, mode: 0o700 });
  return dir;
}

function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Directory fsync is not supported everywhere; file fsync below is the durability guarantee we rely on.
  }
}

export function writeStageFile(file: string, bytes: Uint8Array): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${randomBytes(6).toString("hex")}`;
  const fd = openSync(temp, "w", 0o600);
  try {
    let offset = 0;
    while (offset < bytes.byteLength) offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
  fsyncDir(path.dirname(file));
}

export function readStageFile(file: string, maxBytes: number): Uint8Array {
  const stat = statSync(file);
  if (!stat.isFile()) throw new AppError({ code: "validation", message: "An archive stage file is invalid." });
  if (stat.size > maxBytes) throw new AppError({ code: "validation", status: 413, message: "An archive stage file is too large." });
  return new Uint8Array(readFileSync(file));
}

export function stageBytes(userId: string, jobId: string): number {
  const dir = stageDir(userId, jobId);
  let total = 0;
  for (const name of ROOM_STAGE_FILES) {
    try {
      const stat = statSync(path.join(dir, name));
      if (stat.isFile()) total += stat.size;
    } catch {
      // The file is optional.
    }
  }
  try {
    for (const entry of readdirSync(path.join(dir, "assets"))) {
      try {
        const stat = statSync(path.join(dir, "assets", entry));
        if (stat.isFile()) total += stat.size;
      } catch {
        // Removed concurrently.
      }
    }
  } catch {
    // A missing assets directory has zero bytes.
  }
  return total;
}

/** Removes the job's stage. Returns false when unlink failed, so the reservation stays charged. */
export function cleanupStage(userId: string, jobId: string): boolean {
  try {
    rmSync(stageDir(userId, jobId), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export function getRoomJob(userId: string, jobId: string): RoomArchiveJobRow | undefined {
  return db.prepare("SELECT * FROM room_archive_jobs WHERE id = ? AND user_id = ?").get(jobId, userId) as RoomArchiveJobRow | undefined;
}

export function getRoomJobById(jobId: string): RoomArchiveJobRow | undefined {
  return db.prepare("SELECT * FROM room_archive_jobs WHERE id = ?").get(jobId) as RoomArchiveJobRow | undefined;
}

export function activeRoomJobFor(userId: string): RoomArchiveJobRow | undefined {
  return db
    .prepare("SELECT * FROM room_archive_jobs WHERE user_id = ? AND state IN ('uploading','queued','preparing','ready','committing') ORDER BY created_at DESC LIMIT 1")
    .get(userId) as RoomArchiveJobRow | undefined;
}

export function cleanupPendingJobFor(userId: string): RoomArchiveJobRow | undefined {
  return db
    .prepare(
      "SELECT * FROM room_archive_jobs WHERE user_id = ? AND reservation_bytes > 0 AND state IN ('done','failed','cancelled','expired') ORDER BY created_at DESC LIMIT 1",
    )
    .get(userId) as RoomArchiveJobRow | undefined;
}

const parse = <T>(value: string | null): T | null => {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
};

export function progressUnit(phase: RoomArchivePhase): RoomArchiveProgressUnit {
  if (phase === "snapshot" || phase === "commit") return "messages";
  if (phase === "validate" || phase === "inspect" || phase === "promote") return "assets";
  return "bytes";
}

export function jobProjection(row: RoomArchiveJobRow): RoomArchiveJob {
  const summary = parse<RoomArchiveSummary>(row.summary_json);
  const result = parse<{ channelId?: string }>(row.result_json);
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    phase: row.phase,
    expiresAt: row.expires_at,
    cancelRequested: row.cancel_requested === 1,
    cleanupPending: row.reservation_bytes > 0 && isRoomJobTerminal(row.state),
    progress: { unit: progressUnit(row.phase), done: row.progress_done, total: row.progress_total },
    summary,
    result: result?.channelId ? { channelId: result.channelId } : null,
    error: row.error_code ? { code: row.error_code } : null,
  };
}

export function requireOwnedJob(userId: string, jobId: string): RoomArchiveJobRow {
  const row = getRoomJob(userId, jobId);
  if (!row) throw new AppError({ code: "not_found", message: "Archive job not found." });
  return row;
}

// ---------------------------------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------------------------------

/** Six new jobs per account per hour and thirty per process-wide hour, both in durable buckets. */
export function chargeRoomArchiveAdmission(userId: string): void {
  const now = Date.now();
  const windowStart = Math.floor(now / 3_600_000) * 3_600_000;
  const global = (db.prepare("SELECT COALESCE(SUM(used), 0) AS n FROM channel_rate_windows WHERE bucket = 'archive' AND window_start = ?").get(windowStart) as { n: number }).n;
  if (global >= ROOM_ARCHIVE_LIMITS.newJobsGlobalPerHour) {
    throw new AppError({ code: "rate_limited", status: 429, message: "Too many room archives right now. Try again shortly.", retryAfterMs: windowStart + 3_600_000 - now });
  }
  chargeRate(userId, "archive");
  // Waiting jobs, not just executing ones. A full queue answers 429 before a body is read.
  const waiting = (db.prepare("SELECT COUNT(*) AS n FROM room_archive_jobs WHERE state = 'queued'").get() as { n: number }).n;
  if (waiting >= ROOM_ARCHIVE_LIMITS.queuedJobs) throw new AppError({ code: "rate_limited", status: 429, message: "The archive queue is full. Try again shortly.", retryAfterMs: 30_000 });
}

function assertNoActiveJob(userId: string): void {
  const pending = cleanupPendingJobFor(userId);
  if (pending) {
    throw new AppError({ code: "conflict", status: 409, message: "Your previous archive is still being cleaned up." });
  }
  const active = activeRoomJobFor(userId);
  if (!active) return;
  throw new AppError({ code: "conflict", status: 409, message: "Another room archive is already active for this account.", details: { reason: "busy" } });
}

export interface CreateExportJobInput {
  userId: string;
  authority: "owner" | "admin";
  channelId: string;
  selection: unknown;
  includeEmails: boolean;
  adminReason: string;
}

export function createExportJob(input: CreateExportJobInput): RoomArchiveJobRow {
  return tx(() => {
    assertNoActiveJob(input.userId);
    chargeRoomArchiveAdmission(input.userId);
    assertStagingCapacity(ROOM_ARCHIVE_LIMITS.stageReservationBytes, roomStagingReserved());
    // The reservation is the account's quota hold and is charged before any snapshot bytes exist.
    assertStorage(input.userId, ROOM_ARCHIVE_LIMITS.stageReservationBytes);
    const now = Date.now();
    const id = newId("raj");
    db.prepare(
      `INSERT INTO room_archive_jobs
        (id, user_id, kind, authority, source_channel_id, admin_reason, state, phase, cancel_requested, reservation_bytes, staged_bytes,
         progress_done, progress_total, request_json, created_at, updated_at, expires_at)
       VALUES (?, ?, 'export', ?, ?, ?, 'queued', 'snapshot', 0, ?, 0, 0, NULL, ?, ?, ?, ?)`,
    ).run(
      id,
      input.userId,
      input.authority,
      input.channelId,
      input.adminReason,
      ROOM_ARCHIVE_LIMITS.stageReservationBytes,
      JSON.stringify({ selection: input.selection, includeEmails: input.includeEmails }),
      now,
      now,
      now + ROOM_ARCHIVE_LIMITS.jobLifetimeMs,
    );
    ensureStageDir(input.userId, id);
    afterCommit(() => enqueueRoomJob(id));
    return getRoomJob(input.userId, id)!;
  });
}

export function createImportJob(userId: string): RoomArchiveJobRow {
  return tx(() => {
    assertNoActiveJob(userId);
    chargeRoomArchiveAdmission(userId);
    assertStagingCapacity(ROOM_ARCHIVE_LIMITS.stageReservationBytes, roomStagingReserved());
    assertStorage(userId, ROOM_ARCHIVE_LIMITS.stageReservationBytes);
    const now = Date.now();
    const id = newId("raj");
    db.prepare(
      `INSERT INTO room_archive_jobs
        (id, user_id, kind, authority, state, phase, cancel_requested, reservation_bytes, staged_bytes,
         progress_done, progress_total, created_at, updated_at, expires_at)
       VALUES (?, ?, 'import', 'importer', 'uploading', 'upload', 0, ?, 0, 0, NULL, ?, ?, ?)`,
    ).run(id, userId, ROOM_ARCHIVE_LIMITS.stageReservationBytes, now, now, now + Math.min(ROOM_ARCHIVE_LIMITS.awaitingUploadMs, ROOM_ARCHIVE_LIMITS.jobLifetimeMs));
    ensureStageDir(userId, id);
    return getRoomJob(userId, id)!;
  });
}

/** Upload admission is one writer: a second body while one is spooling answers 409. */
const uploads = new Map<string, AbortController>();

export function beginUpload(userId: string, jobId: string): AbortController {
  if (uploads.has(jobId)) throw new AppError({ code: "conflict", status: 409, message: "That upload is already in progress." });
  if (uploads.size >= ROOM_ARCHIVE_LIMITS.uploads) throw new AppError({ code: "rate_limited", status: 429, message: "Too many archive uploads right now.", retryAfterMs: 5_000 });
  const controller = new AbortController();
  uploads.set(jobId, controller);
  return controller;
}

export function endUpload(jobId: string): void {
  uploads.delete(jobId);
}

export function cancelUpload(jobId: string): void {
  uploads.get(jobId)?.abort();
}

// ---------------------------------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------------------------------

type Patch = Partial<Pick<RoomArchiveJobRow,
  "state" | "phase" | "cancel_requested" | "reservation_bytes" | "staged_bytes" | "progress_done" | "progress_total" |
  "summary_json" | "review_digest" | "confirm_hash" | "target_channel_id" | "result_json" | "error_code" | "expires_at">>;

export function updateJob(id: string, expected: RoomArchiveState[], patch: Patch): boolean {
  const keys = Object.keys(patch) as Array<keyof Patch>;
  if (!keys.length) return false;
  const values = keys.map((key) => patch[key] ?? null);
  const result = db
    .prepare(
      `UPDATE room_archive_jobs SET ${keys.map((key) => `${key} = ?`).join(", ")}, updated_at = ?
       WHERE id = ? AND state IN (${expected.map(() => "?").join(",")})`,
    )
    .run(...(values as Array<string | number | null>), Date.now(), id, ...expected) as { changes: number | bigint };
  return Number(result.changes) === 1;
}

export function setPhase(id: string, phase: RoomArchivePhase, done?: number, total?: number | null): boolean {
  return updateJob(id, ["queued", "preparing", "committing"], {
    phase,
    ...(done !== undefined ? { progress_done: done } : {}),
    ...(total !== undefined ? { progress_total: total } : {}),
  });
}

export function markUploaded(userId: string, jobId: string, bytes: number): boolean {
  return updateJob(jobId, ["uploading"], {
    state: "queued",
    phase: "validate",
    staged_bytes: bytes,
    progress_done: bytes,
    progress_total: bytes,
    expires_at: Date.now() + ROOM_ARCHIVE_LIMITS.jobLifetimeMs,
  });
}

/** Upload progress is a byte unit, guarded by the uploading state. */
export function setUploadProgress(jobId: string, bytes: number): void {
  updateJob(jobId, ["uploading"], { progress_done: bytes, progress_total: null });
}

export function markReady(jobId: string, summary: RoomArchiveSummary, reviewDigest: string | null): boolean {
  return updateJob(jobId, ["preparing"], { state: "ready", phase: "inspect", summary_json: JSON.stringify(summary), review_digest: reviewDigest });
}

export function markFailed(jobId: string, code: RoomArchiveErrorCode): void {
  updateJob(jobId, ["uploading", "queued", "preparing", "ready", "committing"], { state: "failed", error_code: code });
}

export function markCancelled(jobId: string): void {
  updateJob(jobId, ["uploading", "queued", "preparing", "ready", "committing"], { state: "cancelled" });
}

/** Terminal failure with immediate best-effort cleanup; a failed unlink keeps the reservation. */
export function failRoomJob(row: RoomArchiveJobRow, code: RoomArchiveErrorCode): void {
  markFailed(row.id, code);
  const latest = getRoomJobById(row.id);
  if (latest) finishCleanup(latest, "failed");
}

export function markDone(jobId: string, channelId: string, confirmHash: string | null, retainedStageBytes: number): void {
  updateJob(jobId, ["committing"], {
    state: "done",
    phase: "complete",
    result_json: JSON.stringify({ channelId }),
    confirm_hash: confirmHash,
    reservation_bytes: retainedStageBytes,
    staged_bytes: retainedStageBytes,
    error_code: null,
  });
}

export function setStagedBytes(id: string, bytes: number): boolean {
  return updateJob(id, ["preparing", "ready", "queued", "uploading"], { staged_bytes: bytes });
}

export function expireIfNeeded(row: RoomArchiveJobRow): boolean {
  if (isRoomJobTerminal(row.state)) return false;
  if (row.expires_at > Date.now()) return false;
  requestCancel(row.user_id, row.id, "expired");
  return true;
}

/** True when the runner must stop. Also flips an expired job into the cancelled path. */
export function jobShouldStop(row: RoomArchiveJobRow): boolean {
  const latest = getRoomJobById(row.id);
  if (!latest) return true;
  if (latest.cancel_requested === 1) return true;
  if (latest.state === "cancelled" || latest.state === "expired" || latest.state === "failed") return true;
  if (latest.expires_at <= Date.now()) return true;
  return false;
}

export function assertJobAlive(row: RoomArchiveJobRow): void {
  const latest = getRoomJobById(row.id);
  if (!latest) throw new AppError({ code: "not_found", message: "Archive job not found." });
  if (latest.cancel_requested === 1) throw new AppError({ code: "conflict", status: 409, message: "This archive job was cancelled." });
  if (latest.expires_at <= Date.now()) throw new AppError({ code: "not_found", status: 410, message: "This archive job expired." });
}

// ---------------------------------------------------------------------------------------------------
// Cancellation and cleanup
// ---------------------------------------------------------------------------------------------------

const controllers = new Map<string, AbortController>();
const downloadAudit = new Map<string, number>();

export function jobController(jobId: string, controller: AbortController): void {
  controllers.set(jobId, controller);
}

export function releaseController(jobId: string): void {
  controllers.delete(jobId);
}

export function requestCancel(userId: string, jobId: string, terminalState: "cancelled" | "expired" = "cancelled"): RoomArchiveJobRow {
  const row = requireOwnedJob(userId, jobId);
  db.prepare("UPDATE room_archive_jobs SET cancel_requested = 1, updated_at = ? WHERE id = ? AND user_id = ?").run(Date.now(), jobId, userId);
  controllers.get(jobId)?.abort();
  cancelUpload(jobId);
  const latest = requireOwnedJob(userId, jobId);
  // Nothing is executing for these states, so cleanup can happen synchronously and honestly.
  if (latest.state === "uploading" || latest.state === "queued" || latest.state === "ready") {
    finishCleanup(latest, terminalState);
  }
  return requireOwnedJob(userId, jobId);
}

export function finishCleanup(row: RoomArchiveJobRow, terminalState: "cancelled" | "expired" | "failed" = "cancelled"): boolean {
  const removed = cleanupStage(row.user_id, row.id);
  if (!removed) return false;
  updateJob(row.id, ["uploading", "queued", "preparing", "ready", "committing", "done", "failed", "cancelled", "expired"], {
    state: row.result_json && terminalState === "cancelled" ? "done" : terminalState,
    phase: "complete",
    reservation_bytes: 0,
    staged_bytes: 0,
  });
  return true;
}

/** Release a successful import's retained stage; never delete the committed room. */
export function releaseImportStage(row: RoomArchiveJobRow): boolean {
  if (!cleanupStage(row.user_id, row.id)) return false;
  updateJob(row.id, ["done"], { reservation_bytes: 0, staged_bytes: 0 });
  return true;
}

/** One audit row per job per minute, so repeat downloads cannot grow the table without bound. */
export function auditDownloadOnce(jobId: string): boolean {
  const last = downloadAudit.get(jobId) ?? 0;
  if (Date.now() - last < ROOM_ARCHIVE_LIMITS.downloadAuditMs) return false;
  downloadAudit.set(jobId, Date.now());
  return true;
}

// ---------------------------------------------------------------------------------------------------
// Worker: one executing task, in-process, no resume
// ---------------------------------------------------------------------------------------------------

const queue: string[] = [];
let executing = false;

export function enqueueRoomJob(jobId: string): void {
  if (queue.includes(jobId)) return;
  queue.push(jobId);
  void pump();
}

async function pump(): Promise<void> {
  if (executing) return;
  executing = true;
  try {
    while (queue.length) {
      const jobId = queue.shift()!;
      const row = getRoomJobById(jobId);
      if (!row) continue;
      if (row.state === "queued" || row.state === "preparing" || row.state === "committing") {
        const controller = new AbortController();
        jobController(jobId, controller);
        try {
          const { runRoomArchiveJob } = await import("./jobs-run.js");
          await runRoomArchiveJob(row, controller.signal);
        } catch (error) {
          if (!jobShouldStop(row)) {
            markFailed(jobId, error instanceof AppError && error.status === 413 ? "storage_quota" : "export_failed");
          }
        } finally {
          releaseController(jobId);
        }
      }
    }
  } finally {
    executing = false;
  }
}

export function archiveQueueDepth(): number {
  return queue.length;
}

export function archiveExecuting(): boolean {
  return executing;
}

/** Room-archive quota conversion: the own reservation is not double-counted; other holds still count. */
export function assertRoomQuotaConversion(userId: string, reservation: number, finalBytes: number, retainedStageBytes: number): void {
  const used = storageUsed(userId);
  const limit = userStorageLimit(userId);
  if (used - reservation + finalBytes + retainedStageBytes > limit) throw new QuotaError(used, limit);
}

export function jobRequest<T>(row: RoomArchiveJobRow): T | null {
  return parse<T>(row.request_json);
}

export function jobSummary(row: RoomArchiveJobRow): RoomArchiveSummary | null {
  return parse<RoomArchiveSummary>(row.summary_json);
}

export function activeJobStates(): RoomArchiveState[] {
  return ACTIVE;
}
