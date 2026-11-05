import { readFileSync, statSync } from "node:fs";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { requireAdmin, requireUser, type AppEnv } from "../../auth.js";
import { requireFeature } from "../../permissions/guard.js";
import { featureAllowed } from "../../permissions/guard.js";
import { AppError } from "../../errors.js";
import { db } from "../../db.js";
import { ROOM_ARCHIVE_LIMITS, roomArchiveFileName, type RoomArchiveErrorCode, type RoomArchiveJob } from "../../../shared/room-archive.js";
import { accountRole, assertChannelRole, assertRoom, channelRow, notFound } from "../access.js";
import { chargeRate } from "../rate.js";
import { audit } from "../store.js";
import {
  activeRoomJobFor,
  auditDownloadOnce,
  beginUpload,
  cleanupPendingJobFor,
  createExportJob,
  createImportJob,
  endUpload,
  enqueueRoomJob,
  getRoomJob,
  getRoomJobById,
  isRoomJobTerminal,
  jobProjection,
  markUploaded,
  requestCancel,
  setUploadProgress,
  stagePath,
  writeStageFile,
  type RoomArchiveJobRow,
} from "./jobs.js";
import { beginImportCommit, confirmHashOf, inspectRoomImport, refreshReview, rosterPage } from "./import.js";

/**
 * Room archive REST. Ordinary routes require the live channels feature; admin routes require the live
 * admin role and never grant a content download. Every response is private and uncached, every job is
 * owned by the caller, and a foreign or missing id answers exactly like a missing one.
 */

const NO_STORE = { "Cache-Control": "private, no-store" };

const json = (c: Context<AppEnv>, value: unknown, status = 200) => c.json(value as never, status as never, NO_STORE);

const archiveError = (c: Context<AppEnv>, status: number, code: RoomArchiveErrorCode, message: string) =>
  c.json({ error: message, code } as never, status as never, NO_STORE);

async function readJson(c: Context<AppEnv>, maxBytes: number): Promise<unknown> {
  const reader = c.req.raw.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new AppError({ code: "validation", status: 413, message: "That request is too large." });
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const text = Buffer.concat(chunks, total).toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError({ code: "validation", message: "That request is not valid JSON." });
  }
}

const selectionSchema = z.union([
  z.strictObject({ mode: z.literal("all") }),
  z.strictObject({
    mode: z.literal("roots"),
    rootIds: z.array(z.string().min(1).max(128)).min(1).max(ROOM_ARCHIVE_LIMITS.roots),
    includeReplies: z.boolean(),
  }),
]);

const exportSchema = z.strictObject({ selection: selectionSchema, includeEmails: z.boolean().optional() });
const adminExportSchema = z.strictObject({
  selection: selectionSchema,
  includeEmails: z.boolean().optional(),
  reason: z.string().min(1).max(500),
});
const importSchema = z.strictObject({});
const inspectSchema = z.strictObject({ name: z.string().optional() });
const confirmSchema = z.strictObject({
  name: z.string().min(1).max(80),
  reviewDigest: z.string().regex(/^[a-f0-9]{64}$/),
  acceptWarnings: z.literal(true),
});
const adminCancelSchema = z.strictObject({ reason: z.string().min(1).max(500) });

/** A live admin, re-read on every request; no cached role and no fake room membership. */
function jobForUser(userId: string, jobId: string): RoomArchiveJobRow {
  const row = getRoomJob(userId, jobId);
  if (!row) throw notFound();
  return row;
}

/**
 * Reapplies the export job's original authority. A lost owner role, feature, membership, or admin role
 * cancels the job and answers the same 404 as an unknown id.
 */
function recheckExport(row: RoomArchiveJobRow): RoomArchiveJobRow {
  if (row.kind !== "export") return row;
  if (!row.source_channel_id) throw notFound();
  const channel = channelRow(row.source_channel_id);
  if (!channel || channel.kind !== "room") throw notFound();
  if (!featureAllowed(row.user_id, "channels")) {
    requestCancel(row.user_id, row.id);
    throw notFound();
  }
  if (row.authority === "owner") {
    try {
      assertChannelRole(row.user_id, channel.id, ["owner"]);
    } catch {
      requestCancel(row.user_id, row.id);
      throw notFound();
    }
  } else if (accountRole(row.user_id) !== "admin") {
    requestCancel(row.user_id, row.id);
    throw notFound();
  }
  return row;
}

export const roomArchiveRoutes = new Hono<AppEnv>()
  .use("*", requireUser)
  .post("/room-archives/imports", requireFeature("channels"), async (c) => {
    const userId = c.get("user").id;
    const parsed = importSchema.safeParse(await readJson(c, ROOM_ARCHIVE_LIMITS.requestBytes));
    if (!parsed.success) return archiveError(c, 400, "invalid_archive", "That request is invalid.");
    const row = createImportJob(userId);
    return json(c, { jobId: row.id, expiresAt: row.expires_at, uploadUrl: `/api/room-archives/${encodeURIComponent(row.id)}/upload` }, 201);
  })
  .put("/room-archives/:jobId/upload", requireFeature("channels"), async (c) => {
    const userId = c.get("user").id;
    const row = jobForUser(userId, c.req.param("jobId"));
    if (row.kind !== "import" || row.state !== "uploading") {
      return archiveError(c, 409, "busy", "This job is not waiting for an upload.");
    }
    const type = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/zip") return archiveError(c, 415, "invalid_archive", "Upload a ZIP archive.");
    const declared = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > ROOM_ARCHIVE_LIMITS.uploadBytes) {
      return archiveError(c, 413, "limit_exceeded", "This archive is too large.");
    }
    const controller = beginUpload(userId, row.id);
    const abort = () => controller.abort();
    c.req.raw.signal.addEventListener("abort", abort, { once: true });
    const reader = c.req.raw.body?.getReader();
    if (!reader) {
      endUpload(row.id);
      return archiveError(c, 400, "invalid_archive", "The upload was empty.");
    }
    // Cancelling the job must wake a pending read, including a client that stops sending bytes.
    const stopReading = () => { void reader.cancel().catch(() => {}); };
    controller.signal.addEventListener("abort", stopReading, { once: true });
    const deadline = setTimeout(() => controller.abort(), ROOM_ARCHIVE_LIMITS.uploadDeadlineMs);
    if (controller.signal.aborted || c.req.raw.signal.aborted) controller.abort();
    if (controller.signal.aborted) stopReading();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let lastTick = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > ROOM_ARCHIVE_LIMITS.uploadBytes) {
          controller.abort();
          await reader.cancel().catch(() => {});
          requestCancel(userId, row.id);
          return archiveError(c, 413, "limit_exceeded", "This archive is too large.");
        }
        chunks.push(value);
        const now = Date.now();
        if (now - lastTick > 250 || total % (256 * 1024) === 0) {
          lastTick = now;
          setUploadProgress(row.id, total);
        }
      }
      if (controller.signal.aborted) throw new Error("aborted");
      if (!total) {
        requestCancel(userId, row.id);
        return archiveError(c, 400, "invalid_archive", "The upload was empty.");
      }
      const bytes = new Uint8Array(total);
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.byteLength;
      }
      writeStageFile(stagePath(userId, row.id, "upload.zip"), bytes);
      if (!markUploaded(userId, row.id, total)) return archiveError(c, 409, "busy", "This job is no longer waiting for an upload.");
      // The durable transition is queued; only the worker enqueues, never the HTTP request.
      enqueueRoomJob(row.id);
      const latest = getRoomJob(userId, row.id)!;
      return json(c, { jobId: row.id, expiresAt: latest.expires_at }, 202);
    } catch {
      requestCancel(userId, row.id);
      return archiveError(c, 400, "invalid_archive", "The upload did not complete.");
    } finally {
      clearTimeout(deadline);
      controller.signal.removeEventListener("abort", stopReading);
      c.req.raw.signal.removeEventListener("abort", abort);
      endUpload(row.id);
    }
  })
  .get("/room-archives", requireFeature("channels"), (c) => {
    const userId = c.get("user").id;
    const row = activeRoomJobFor(userId) ?? cleanupPendingJobFor(userId);
    if (!row) return json(c, { job: null });
    if (row.expires_at <= Date.now() && !isRoomJobTerminal(row.state)) {
      requestCancel(userId, row.id, "expired");
      return archiveError(c, 410, "expired", "This archive job expired.");
    }
    return json(c, { job: jobProjection(recheckExport(row)) });
  })
  .get("/room-archives/:jobId", requireFeature("channels"), (c) => {
    const userId = c.get("user").id;
    chargeRate(userId, "archive_read");
    let row = jobForUser(userId, c.req.param("jobId"));
    if (!isRoomJobTerminal(row.state) && row.expires_at <= Date.now()) {
      requestCancel(userId, row.id, "expired");
      return archiveError(c, 410, "expired", "This archive job expired.");
    }
    if (row.state === "expired") return archiveError(c, 410, "expired", "This archive job expired.");
    row = recheckExport(row);
    return json(c, { job: jobProjection(row) });
  })
  .get("/room-archives/:jobId/identities", requireFeature("channels"), (c) => {
    const userId = c.get("user").id;
    const row = jobForUser(userId, c.req.param("jobId"));
    if (row.kind !== "import" || row.state !== "ready") return archiveError(c, 409, "not_ready", "The archive is not ready for review.");
    const after = c.req.query("after") ?? null;
    if (after !== null && (after.length === 0 || after.length > 200)) return archiveError(c, 400, "invalid_archive", "Invalid roster cursor.");
    const requested = Number(c.req.query("limit") ?? ROOM_ARCHIVE_LIMITS.rosterPage);
    const limit = Math.min(ROOM_ARCHIVE_LIMITS.rosterPageMax, Math.max(1, Number.isFinite(requested) ? Math.floor(requested) : ROOM_ARCHIVE_LIMITS.rosterPage));
    const page = rosterPage(row, after, limit);
    return json(c, {
      items: page.items.map((item) => ({ key: item.key, historicalName: item.historicalName, role: item.role, recognizedName: item.recognizedName })),
      nextAfter: page.nextAfter,
    });
  })
  .post("/room-archives/:jobId/inspect", requireFeature("channels"), async (c) => {
    const userId = c.get("user").id;
    const row = jobForUser(userId, c.req.param("jobId"));
    if (row.kind !== "import" || row.state !== "ready") return archiveError(c, 409, "not_ready", "The archive is not ready for review.");
    const parsed = inspectSchema.safeParse(await readJson(c, ROOM_ARCHIVE_LIMITS.requestBytes));
    if (!parsed.success) return archiveError(c, 400, "invalid_archive", "That request is invalid.");
    try {
      const result = inspectRoomImport(row, parsed.data.name);
      const stored = refreshReview(row, result.summary.name);
      return json(c, { summary: result.summary, reviewDigest: stored.digest });
    } catch (error) {
      if (error instanceof AppError) return archiveError(c, error.status, error.status === 413 ? "storage_quota" : "invalid_archive", error.message);
      return archiveError(c, 422, "invalid_archive", "The review could not be refreshed.");
    }
  })
  .post("/room-archives/:jobId/confirm", requireFeature("channels"), async (c) => {
    const userId = c.get("user").id;
    chargeRate(userId, "archive_confirm");
    let row = jobForUser(userId, c.req.param("jobId"));
    if (row.kind !== "import") return archiveError(c, 409, "not_ready", "This job is not an import.");
    const parsed = confirmSchema.safeParse(await readJson(c, ROOM_ARCHIVE_LIMITS.requestBytes));
    if (!parsed.success) return archiveError(c, 400, "invalid_archive", "Confirm the reviewed import first.");
    if (row.state === "done") {
      if (row.confirm_hash !== confirmHashOf(parsed.data.name, parsed.data.reviewDigest)) {
        return archiveError(c, 409, "review_changed", "This import already completed with a different review.");
      }
      return json(c, { jobId: row.id, result: jobProjection(row).result });
    }
    if (row.state === "committing") {
      if (row.confirm_hash !== confirmHashOf(parsed.data.name, parsed.data.reviewDigest)) {
        return archiveError(c, 409, "review_changed", "This import is already finishing with a different review.");
      }
      return json(c, { jobId: row.id }, 202);
    }
    if (row.state !== "ready") return archiveError(c, 409, "not_ready", "The archive is not ready to import.");
    // Confirm only the review the user actually saw. Recomputing with the submitted name would accept a
    // digest that was never the stored review.
    if (row.review_digest !== null && row.review_digest !== parsed.data.reviewDigest) {
      let changed: { summary: ReturnType<typeof inspectRoomImport>["summary"]; reviewDigest: string };
      try {
        changed = inspectRoomImport(row, parsed.data.name);
      } catch {
        return archiveError(c, 409, "review_changed", "This review changed. Inspect the archive again.");
      }
      return c.json(
        { error: "This review changed. Review the updated summary and confirm again.", code: "review_changed", summary: changed.summary, reviewDigest: changed.reviewDigest } as never,
        409 as never,
        NO_STORE,
      );
    }
    let fresh: { summary: ReturnType<typeof inspectRoomImport>["summary"]; reviewDigest: string };
    try {
      fresh = inspectRoomImport(row, parsed.data.name);
    } catch (error) {
      if (error instanceof AppError) return archiveError(c, error.status, error.status === 413 ? "storage_quota" : "invalid_archive", error.message);
      return archiveError(c, 422, "invalid_archive", "The archive could not be rechecked.");
    }
    if (fresh.reviewDigest !== parsed.data.reviewDigest) {
      return c.json(
        { error: "This review changed. Review the updated summary and confirm again.", code: "review_changed", summary: fresh.summary, reviewDigest: fresh.reviewDigest } as never,
        409 as never,
        NO_STORE,
      );
    }
    try {
      beginImportCommit(row, parsed.data.name, fresh.reviewDigest);
    } catch (error) {
      if (error instanceof AppError) return archiveError(c, error.status, "busy", error.message);
      throw error;
    }
    enqueueRoomJob(row.id);
    row = getRoomJob(userId, row.id)!;
    return json(c, { jobId: row.id }, 202);
  })
  .get("/room-archives/:jobId/download", requireFeature("channels"), (c) => {
    const userId = c.get("user").id;
    let row = jobForUser(userId, c.req.param("jobId"));
    if (row.kind !== "export") return archiveError(c, 409, "not_ready", "This job has no download.");
    // Authority is checked before state so a revoked owner sees the same 404 as an unknown id.
    row = recheckExport(row);
    if (row.state !== "ready") return archiveError(c, 409, "not_ready", "This archive is not ready to download.");
    if (row.expires_at <= Date.now()) return archiveError(c, 410, "expired", "This archive has expired.");
    const file = stagePath(userId, row.id, "export.zip");
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return archiveError(c, 409, "not_ready", "The archive file is no longer available.");
    }
    if (auditDownloadOnce(row.id)) audit(userId, row.source_channel_id, "export.download", row.id, row.admin_reason);
    const bytes = readFileSync(file);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${roomArchiveFileName()}"`,
        "Content-Length": String(size),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  })
  .delete("/room-archives/:jobId", requireFeature("channels"), (c) => {
    const userId = c.get("user").id;
    const row = jobForUser(userId, c.req.param("jobId"));
    if (row.kind === "import" && row.state === "done") {
      const result = jobProjection(row).result;
      return json(c, { imported: true, channelId: result?.channelId ?? null });
    }
    if (row.state === "cancelled" || row.state === "expired") return json(c, { cancelled: true });
    const latest = requestCancel(userId, row.id);
    if (isRoomJobTerminal(latest.state)) return json(c, { cancelled: true });
    return json(c, { cancelRequested: true }, 202);
  });

/** Owner export admission. DMs answer the existing room-only 403; inaccessible ids answer 404. */
export const roomArchiveChannelRoutes = new Hono<AppEnv>()
  .use("*", requireUser)
  .use("*", requireFeature("channels"))
  .post("/:id/archive-exports", async (c) => {
    const userId = c.get("user").id;
    const { channel } = assertChannelRole(userId, c.req.param("id"), ["owner"]);
    assertRoom(channel);
    const parsed = exportSchema.safeParse(await readJson(c, ROOM_ARCHIVE_LIMITS.selectionBytes));
    if (!parsed.success) return archiveError(c, 400, "invalid_archive", "Choose the whole room or up to 500 messages.");
    const row = createExportJob({
      userId,
      authority: "owner",
      channelId: channel.id,
      selection: parsed.data.selection,
      includeEmails: parsed.data.includeEmails === true,
      adminReason: "",
    });
    audit(userId, channel.id, "export", row.id, "");
    return json(c, { jobId: row.id, expiresAt: row.expires_at }, 202);
  });

/** Admin export is an explicit, audited override; a DM or missing id is 404 before any audit row. */
export const roomArchiveAdminRoutes = new Hono<AppEnv>()
  .use("*", requireUser)
  .use("*", requireAdmin)
  .post("/channels/:id/archive-exports", async (c) => {
    const userId = c.get("user").id;
    const channel = channelRow(c.req.param("id"));
    if (!channel || channel.kind !== "room") throw notFound();
    const parsed = adminExportSchema.safeParse(await readJson(c, ROOM_ARCHIVE_LIMITS.selectionBytes));
    if (!parsed.success) return archiveError(c, 400, "invalid_archive", "Choose the whole room or up to 500 messages, with a reason.");
    const row = createExportJob({
      userId,
      authority: "admin",
      channelId: channel.id,
      selection: parsed.data.selection,
      includeEmails: parsed.data.includeEmails === true,
      adminReason: parsed.data.reason,
    });
    audit(userId, channel.id, "export.admin", row.id, parsed.data.reason);
    return json(c, { jobId: row.id, expiresAt: row.expires_at }, 202);
  })
  .get("/room-archives", (c) => {
    const after = c.req.query("after") ?? null;
    const state = c.req.query("state") ?? null;
    const allowedStates = new Set(["uploading", "queued", "preparing", "ready", "committing", "done", "failed", "cancelled", "expired"]);
    if (state && !allowedStates.has(state)) return archiveError(c, 400, "invalid_archive", "Invalid state filter.");
    const params: Array<string | number> = [];
    let where = "1=1";
    if (state) {
      where += " AND state = ?";
      params.push(state);
    }
    if (after) {
      const [created, id] = after.split(":");
      if (!created || !id || !Number.isSafeInteger(Number(created))) return archiveError(c, 400, "invalid_archive", "Invalid cursor.");
      where += " AND (created_at < ? OR (created_at = ? AND id < ?))";
      params.push(Number(created), Number(created), id);
    }
    const rows = dbRows(where, params, 51);
    const page = rows.slice(0, 50);
    return json(c, {
      items: page.map(operationalJob),
      nextCursor: rows.length > 50 && page.length ? `${page.at(-1)!.created_at}:${page.at(-1)!.id}` : null,
    });
  })
  .delete("/room-archives/:jobId", async (c) => {
    const userId = c.get("user").id;
    const row = getRoomJobById(c.req.param("jobId"));
    if (!row) throw notFound();
    const parsed = adminCancelSchema.safeParse(await readJson(c, ROOM_ARCHIVE_LIMITS.requestBytes));
    if (!parsed.success) return archiveError(c, 400, "invalid_archive", "A reason is required.");
    audit(userId, row.source_channel_id, "archive.adminCancel", row.id, parsed.data.reason);
    if (row.state === "done" && row.kind === "import") {
      return json(c, { imported: true, channelId: jobProjection(row).result?.channelId ?? null });
    }
    const latest = requestCancel(row.user_id, row.id);
    return isRoomJobTerminal(latest.state) ? json(c, { cancelled: true }) : json(c, { cancelRequested: true }, 202);
  });

function dbRows(where: string, params: Array<string | number>, limit: number): RoomArchiveJobRow[] {
  return db
    .prepare(`SELECT * FROM room_archive_jobs WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...params, limit) as unknown as RoomArchiveJobRow[];
}

/** Operational fields only: no summary, preview, roster, names, manifest, files, or download link. */
function operationalJob(row: RoomArchiveJobRow): {
  id: string;
  userId: string;
  kind: "export" | "import";
  authority: string;
  state: string;
  phase: string;
  cancelRequested: boolean;
  cleanupPending: boolean;
  progress: RoomArchiveJob["progress"];
  error: RoomArchiveJob["error"];
  sourceChannelId: string | null;
  reservationBytes: number;
  stagedBytes: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
} {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    authority: row.authority,
    state: row.state,
    phase: row.phase,
    cancelRequested: row.cancel_requested === 1,
    cleanupPending: row.reservation_bytes > 0 && isRoomJobTerminal(row.state),
    progress: jobProjection(row).progress,
    error: row.error_code ? { code: row.error_code } : null,
    sourceChannelId: row.source_channel_id,
    reservationBytes: row.reservation_bytes,
    stagedBytes: row.staged_bytes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}
