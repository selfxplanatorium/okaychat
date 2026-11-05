import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import type { ArchiveJob } from "../shared/chat-archive.js";
import { ARCHIVE_LIMITS } from "../shared/chat-archive.js";
import type { AppEnv } from "./auth.js";
import { archiveFileName, ArchiveFormatError, readArchive, writeArchive } from "./archive-format.js";
import { buildArchive, archiveSummary } from "./archive-export.js";
import { commitArchive, previewArchive } from "./archive-import.js";
import { beginCommit, cancelJob, createJob, getJobRow, jobDir, removeJobDir, resetToReady, setDone, setFailed, setReady, setSummary } from "./archive-jobs.js";
import { listModels } from "./catalog/providers.js";
import { AppError } from "./errors.js";
import { threadBusy } from "./thread-runs.js";
import { notify } from "./notifications.js";

/**
 * Portable archive API. Every response is private and uncached; every job is owned by the caller, and a
 * foreign id answers exactly like a missing one. Import validation happens before any database write.
 */

const exportBody = z.object({
  threads: z
    .array(z.object({ id: z.string().min(1).max(200), selectedLeaf: z.string().min(1).max(200).optional() }))
    .min(1)
    .max(ARCHIVE_LIMITS.chats),
});

const confirmBody = z.object({ chatKeys: z.array(z.string().min(1).max(100)).min(1).max(ARCHIVE_LIMITS.chats) });

const privateHeaders = { "Cache-Control": "private, no-store" };

function expiry(userId: string, jobId: string) {
  const row = getJobRow(userId, jobId);
  if (!row) throw new AppError({ code: "not_found", message: "Archive job not found." });
  if (row.expires_at <= Date.now() && row.state !== "done") {
    removeJobDir(userId, jobId);
    throw new AppError({ code: "not_found", message: "This archive job expired. Upload it again." });
  }
  return row;
}

const jobJson = (row: NonNullable<ReturnType<typeof getJobRow>>): ArchiveJob => {
  const summary = row.summary_json ? (JSON.parse(row.summary_json) as ArchiveJob["summary"]) : undefined;
  const result = row.result_json ? (JSON.parse(row.result_json) as ArchiveJob["result"]) : undefined;
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    expiresAt: row.expires_at,
    ...(summary ? { summary } : {}),
    ...(result ? { result } : {}),
    ...(row.error_code ? { error: { code: row.error_code, message: row.error_code } } : {}),
  };
};

/** One durable notice per failed import job; retries of the same job keep the single row. */
function notifyImportFailed(userId: string, jobId: string): void {
  try {
    notify({
      userId,
      kind: "import",
      level: "error",
      titleKey: "import.failed",
      bodyKey: "import.failedBody",
      actionPath: "/library",
      sourceKey: `archive:import:${jobId}`,
    });
  } catch {
    // A notice must never fail the job.
  }
}

export const archiveRoutes = new Hono<AppEnv>()
  .post("/chat-archives/exports", async (c) => {
    const userId = c.get("user").id;
    const parsed = exportBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: `Choose between 1 and ${ARCHIVE_LIMITS.chats} chats.` }, 400);
    // Waiting receipts and active turns have not finished storing; an archive must not capture a half turn.
    if (parsed.data.threads.some((thread) => threadBusy(thread.id))) return c.json({ error: "A selected chat is busy. Finish or stop its reply first." }, 409);
    const job = createJob(userId, "export");
    try {
      const built = buildArchive({ userId, threads: parsed.data.threads });
      const zip = writeArchive(built.manifest, built.assets);
      const file = path.join(jobDir(userId, job.id), "archive.okaychat.zip");
      writeFileSync(file, zip, { mode: 0o600 });
      const summary = archiveSummary(built);
      setSummary(userId, job.id, summary);
      setReady(userId, job.id);
      try {
        notify({
          userId,
          kind: "export",
          level: "success",
          titleKey: "export.ready",
          bodyKey: "export.readyBody",
          params: { chats: summary.chats.length },
          actionPath: "/library",
          sourceKey: `archive:export:${job.id}`,
        });
      } catch {
        // A notice must never fail the job.
      }
      return c.json({ jobId: job.id, expiresAt: job.expires_at }, 202, privateHeaders);
    } catch (error) {
      setFailed(userId, job.id, error instanceof AppError ? "export_failed" : "export_failed");
      try {
        notify({
          userId,
          kind: "export",
          level: "error",
          titleKey: "export.failed",
          bodyKey: "export.failedBody",
          actionPath: "/library",
          sourceKey: `archive:export:${job.id}`,
        });
      } catch {
        // A notice must never fail the job.
      }
      return c.json({ error: error instanceof AppError ? error.message : "The export could not be prepared." }, error instanceof AppError ? (error.status as 400) : 500, privateHeaders);
    }
  })
  .post("/chat-archives/imports", async (c) => {
    const userId = c.get("user").id;
    const declared = Number(c.req.header("content-length") ?? "0");
    // Content-Length is advisory; the real byte count below is authoritative too.
    if (declared > ARCHIVE_LIMITS.uploadBytes) return c.json({ error: "This archive is too large." }, 413, privateHeaders);
    const job = createJob(userId, "import");
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (!bytes.byteLength || bytes.byteLength > ARCHIVE_LIMITS.uploadBytes) {
      setFailed(userId, job.id, "too_large");
      removeJobDir(userId, job.id);
      notifyImportFailed(userId, job.id);
      return c.json({ error: "This archive is too large or empty." }, 413, privateHeaders);
    }
    const file = path.join(jobDir(userId, job.id), "archive.okaychat.zip");
    writeFileSync(file, bytes, { mode: 0o600 });
    try {
      const read = readArchive(bytes);
      const models = new Set((await listModels(userId)).map((model) => model.ref));
      const preview = previewArchive(read.manifest, read.assets, models);
      setSummary(userId, job.id, preview.summary);
      setReady(userId, job.id);
      return c.json({ jobId: job.id, expiresAt: job.expires_at }, 202, privateHeaders);
    } catch (error) {
      setFailed(userId, job.id, error instanceof ArchiveFormatError ? "invalid_archive" : "import_failed");
      removeJobDir(userId, job.id);
      notifyImportFailed(userId, job.id);
      return c.json({ jobId: job.id, expiresAt: job.expires_at }, 202, privateHeaders);
    }
  })
  .get("/chat-archives/:jobId", (c) => {
    const userId = c.get("user").id;
    try {
      const row = expiry(userId, c.req.param("jobId"));
      return c.json(jobJson(row), 200, privateHeaders);
    } catch (error) {
      if (error instanceof AppError) {
        const expired = /expired/i.test(error.message);
        return c.json({ error: error.message, ...(expired ? { code: "expired" } : {}) }, expired ? 410 : 404, privateHeaders);
      }
      throw error;
    }
  })
  .get("/chat-archives/:jobId/download", (c) => {
    const userId = c.get("user").id;
    const row = expiry(userId, c.req.param("jobId"));
    if (row.kind !== "export" || row.state !== "ready") return c.json({ error: "This archive is not ready to download." }, 409, privateHeaders);
    try {
      const bytes = readFileSync(path.join(jobDir(userId, row.id), "archive.okaychat.zip"));
      return new Response(bytes, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${archiveFileName()}"`,
          "Content-Length": String(bytes.byteLength),
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return c.json({ error: "The archive file is no longer available." }, 409, privateHeaders);
    }
  })
  .post("/chat-archives/:jobId/confirm", async (c) => {
    const userId = c.get("user").id;
    const jobId = c.req.param("jobId");
    const parsed = confirmBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Choose at least one chat." }, 400, privateHeaders);
    const row = expiry(userId, jobId);
    if (row.kind !== "import") return c.json({ error: "This job is not an import." }, 409, privateHeaders);
    if (row.state === "done") {
      const result = row.result_json ? (JSON.parse(row.result_json) as ArchiveJob["result"]) : undefined;
      const keys = new Set(result?.threads.map((thread) => thread.archiveKey) ?? []);
      if (parsed.data.chatKeys.every((key) => keys.has(key))) return c.json(result, 200, privateHeaders);
      return c.json({ error: "This import already completed with a different selection." }, 409, privateHeaders);
    }
    if (row.state === "failed" || row.state === "cancelled") return c.json({ error: "This import is no longer available." }, 409, privateHeaders);
    if (!beginCommit(userId, jobId)) {
      const latest = getJobRow(userId, jobId);
      return c.json({ error: latest?.state === "done" ? "This import already completed." : "Another import is in progress." }, 409, privateHeaders);
    }
    try {
      const read = readArchive(new Uint8Array(readFileSync(path.join(jobDir(userId, jobId), "archive.okaychat.zip"))));
      const models = new Set((await listModels(userId)).map((model) => model.ref));
      const result = commitArchive({ userId, manifest: read.manifest, assets: read.assets, keys: parsed.data.chatKeys, availableModels: models });
      setDone(userId, jobId, result);
      try {
        notify({
          userId,
          kind: "import",
          level: "success",
          titleKey: "import.done",
          bodyKey: "import.doneBody",
          params: { chats: result.threads.length },
          actionPath: "/library",
          sourceKey: `archive:import:${jobId}`,
        });
      } catch {
        // A notice must never fail the job.
      }
      // The bytes are no longer needed; the done row keeps the id map for an idempotent confirmation.
      removeJobDir(userId, jobId);
      return c.json(result, 200, privateHeaders);
    } catch (error) {
      if (error instanceof AppError && error.code === "storage_quota") {
        // The archive stays ready while its TTL is valid, so the user can free space and retry.
        resetToReady(userId, jobId);
        return c.json({ error: error.message }, 413, privateHeaders);
      }
      setFailed(userId, jobId, "import_failed");
      notifyImportFailed(userId, jobId);
      return c.json({ error: "The import could not be completed." }, 409, privateHeaders);
    }
  })
  .delete("/chat-archives/:jobId", (c) => {
    const userId = c.get("user").id;
    const row = expiry(userId, c.req.param("jobId"));
    if (row.state === "committing") return c.json({ error: "The import is finishing. Wait for it to complete." }, 409, privateHeaders);
    const result = cancelJob(userId, row.id);
    return c.json({ ok: true, imported: result.imported }, 200, privateHeaders);
  });
