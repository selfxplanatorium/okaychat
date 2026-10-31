import path from "node:path";
import { tool, type ToolSet } from "ai";
import { Hono } from "hono";
import { z } from "zod";
import type { InjectionReport } from "../../shared/types.js";
import type { AppEnv } from "../auth.js";
import { newId, sha256 } from "../crypto.js";
import { db } from "../db.js";
import { env } from "../env.js";
import { assertStorage, QuotaError } from "../quota.js";
import { scanForInjection, wrapUntrusted } from "../prompt-injection.js";
import { getThread } from "../threads.js";
import { resultPaths } from "../sandbox-paths.js";
import { assertServiceAvailable, reportServiceFailure, reportServiceSuccess, serviceStatus, serviceUnavailable } from "../services.js";

// run_code executes model-written Python and Bash in the sandbox container (sandbox/runner.py). Each chat
// has its own workspace; the container wipes idle workspaces, so every produced file is copied into
// `sandbox_files` right after the run and the app serves it from SQLite. See docs/implementation/code-sandbox.md.

const MAX_TIMEOUT_S = 300;
// The runner transfers at most 50 MiB per file in either direction. Larger outputs can be neither stored nor
// downloaded, so they get no link, only a size message for the model.
const RUNNER_MAX_FILE = 50 * 1024 * 1024;
const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;
const TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pdf": "application/pdf", ".csv": "text/csv", ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg", ".flac": "audio/flac", ".m4a": "audio/mp4",
};

const DESCRIPTION = `Run Python 3.12 or Bash in this chat's private Linux sandbox and get stdout, stderr, the exit code, and the files the run created or changed.
Use it for calculations, data analysis, charts, file conversion, OCR, media processing, and checking code by running it.
- No network: runs cannot reach the internet, DNS, or any other service, so nothing can be downloaded or installed. Use what is preinstalled.
- Preinstalled Python: numpy, pandas, scipy, scikit-learn, sympy, matplotlib, pillow (+ pillow-heif for HEIC), openpyxl, python-docx, python-pptx, reportlab, pypdf, pdfplumber, ocrmypdf, csvkit, requests, beautifulsoup4, lxml, pyyaml, tabulate.
- Preinstalled CLI: ffmpeg/ffprobe, LibreOffice (soffice --headless --convert-to), pandoc, poppler (pdftotext, pdfinfo, pdftoppm), qpdf, ghostscript, tesseract (eng, ita) and ocrmypdf, rsvg-convert, graphviz (dot), exiftool, 7z, zip/unzip, xz, zstd, bsdtar, jq, sqlite3, git, ripgrep, fd, tree, bc, curl (no network). Fonts: DejaVu, Liberation, Noto (Latin, Greek, Cyrillic and more, color emoji; no full CJK). \`cat /opt/sandbox/TOOLS.md\` lists versions and tips.
- 2 CPUs and about 2 GB of memory are shared by all runs; pass thread limits such as \`ffmpeg -threads 2\` or \`ocrmypdf --jobs 2\`.
- The working directory persists between calls in this chat, but only for about 30 minutes after the last call; produced files are saved to the chat's storage automatically, so links keep working. Variables do not persist: each call is a new process, so save intermediate results to files. /tmp is private to each call and emptied when it ends.
- A file the user attached carries a \`file_id\` in its <attachment> header. Pass it in \`input_files\` to copy the file into the working directory under its name.
- Images the run writes (png, jpg, gif, webp, svg) are shown to the user, audio (mp3, wav, ogg, flac, m4a) gets a player, and every created file up to 50 MB gets a download link below the run; larger files cannot be saved, so split or compress them. To point at a file in your reply, link it as \`[label](sandbox:/mnt/data/<path>)\`; do not list every file again. Save charts with plt.savefig instead of plt.show. Do not paste file contents back unless asked.
- To check how a PDF, DOCX, XLSX, or PPTX output looks, pass its fileId to import_document, then view_artifact.
- Processes started in the background are stopped when the call ends.
- Every file a run creates or changes is kept for the user. Put scratch files in /tmp, or delete them in a later call: a file first created in this reply and then deleted from the working directory is removed from the user's files. Never rewrite a file only to keep it.`;

export const sandboxConfigured = () => !!env.sandboxUrl && env.sandboxToken.length >= 32;

/** The runner's /health (no token). 503 means it is up but refuses every run because isolation failed. Throws when unreachable. */
export async function sandboxHealthy(signal: AbortSignal): Promise<boolean> {
  const res = await fetch(`${env.sandboxUrl}/health`, { signal });
  await res.body?.cancel().catch(() => {});
  return res.ok;
}

/** Stable per chat. Hashed so the sandbox never sees user or thread ids. */
export const workspaceId = (userId: string, threadId: string) => sha256(`sandbox:${userId}:${threadId}`).slice(0, 32);

interface RunnerResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stopped: string | null;
  durationMs: number;
  files: Array<{ path: string; size: number; storedUrl?: string; fileId?: string; tooLarge?: boolean }>;
  deleted: string[];
}

export interface RunCodeResult extends Omit<RunnerResult, "files"> {
  language: "python" | "bash";
  files: Array<{ path: string; size: number; url: string; image: boolean; fileId?: string }>;
  inputs: string[];
  /** Outputs over the 50 MiB transfer limit. They have no link: they can be neither stored nor downloaded. */
  tooLarge?: Array<{ path: string; size: number }>;
  /** Set when produced files could not all be saved to the user's storage. */
  storageWarning?: string;
  /** Advisory scan of stdout/stderr; a program that prints an attachment can carry injection. */
  injection?: InjectionReport;
}

/**
 * One call to the runner. `guarded: false` is for cleanup (cancel, workspace delete) and for the health check,
 * which must still reach a runner the registry has just marked down.
 */
async function call(route: string, init: RequestInit = {}, timeoutMs = 30_000, signal?: AbortSignal, guarded = true): Promise<Response> {
  // A sandbox that just refused a connection or failed its probe answers at once instead of after a timeout.
  if (guarded) assertServiceAvailable("sandbox");
  const timeout = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${env.sandboxUrl}${route}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${env.sandboxToken}` },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    if (signal?.aborted) throw new Error("Cancelled.");
    if (timeout.aborted) throw new Error("The code sandbox did not answer in time.", { cause: error });
    reportServiceFailure("sandbox");
    throw serviceUnavailable("sandbox");
  }
  reportServiceSuccess("sandbox");
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ? `Sandbox: ${body.error}` : `Sandbox request failed (${res.status}).`);
  }
  return res;
}

/** Copies attachments from the uploads table into the workspace. Names are reduced to a safe basename. */
async function copyInputs(userId: string, ws: string, fileIds: string[]): Promise<string[]> {
  const names: string[] = [];
  for (const id of fileIds) {
    const row = (db.prepare("SELECT name, data FROM uploads WHERE id = ? AND user_id = ?").get(id, userId) ??
      db.prepare("SELECT path AS name, data FROM sandbox_files WHERE id = ? AND user_id = ?").get(id, userId)) as { name: string; data: Uint8Array } | undefined;
    if (!row) throw new Error(`Unknown file_id \`${id}\`. Use the file_id from an <attachment> header.`);
    const name = path.basename(row.name).replace(/[^\w.() -]+/g, "_").replace(/^[.\s]+/, "") || id;
    await call(`/workspaces/${ws}/files?path=${encodeURIComponent(name)}`, { method: "PUT", body: Buffer.from(row.data) }, 60_000);
    names.push(name);
  }
  return names;
}

/**
 * The outputs of one turn. Every file a run writes is kept; a file first stored in this turn that a later run
 * deletes from the workspace is dropped from storage too, so scratch files can be cleaned up. Files from
 * earlier turns are never removed this way: a clean-up must not break links in earlier replies.
 */
export class SandboxTurn {
  readonly created = new Set<string>();

  /** Drops this turn's stored copies of `paths`, which a run deleted from the workspace. */
  forget(userId: string, threadId: string, paths: readonly string[]): void {
    const remove = db.prepare("DELETE FROM sandbox_files WHERE user_id = ? AND thread_id = ? AND path = ?");
    for (const p of paths) {
      const id = (db.prepare("SELECT id FROM sandbox_files WHERE user_id = ? AND thread_id = ? AND path = ?").get(userId, threadId, p) as { id: string } | undefined)?.id;
      if (id && this.created.delete(id)) remove.run(userId, threadId, p);
    }
  }
}

const megabytes = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/**
 * Saves a run's produced files into the user's storage (same SQLite bytes as other user files) before
 * the sandbox wipes the workspace. Rewriting a file replaces its stored copy instead of piling up
 * versions. Best effort: a file that cannot be stored for another reason keeps its direct sandbox URL,
 * which works while the workspace lives. Files over the transfer limit are marked `tooLarge`.
 */
async function storeOutputs(userId: string, threadId: string, ws: string, files: RunnerResult["files"], turn?: SandboxTurn): Promise<string | undefined> {
  let warning: string | undefined;
  for (const file of files) {
    if (file.size > RUNNER_MAX_FILE) {
      file.tooLarge = true;
      continue;
    }
    try {
      const res = await call(`/workspaces/${ws}/files?path=${encodeURIComponent(file.path)}`, {}, 60_000);
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = res.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > RUNNER_MAX_FILE) {
          await reader.cancel();
          file.tooLarge = true;
          file.size = size;
          break;
        }
        chunks.push(value);
      }
      if (file.tooLarge) continue;
      const data = Buffer.concat(chunks, size);
      const previous = db.prepare("SELECT length(data) AS size FROM sandbox_files WHERE user_id = ? AND thread_id = ? AND path = ?")
        .get(userId, threadId, file.path) as { size: number } | undefined;
      assertStorage(userId, data.byteLength - (previous?.size ?? 0));
      const ext = path.extname(file.path).toLowerCase();
      const stored = db.prepare(
        `INSERT INTO sandbox_files (id, user_id, thread_id, path, mime, data, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, thread_id, path) DO UPDATE SET mime = excluded.mime, data = excluded.data, size = excluded.size, created_at = excluded.created_at RETURNING id`,
      ).get(newId("sbf"), userId, threadId, file.path, TYPES[ext] ?? "application/octet-stream", data, data.byteLength, Date.now()) as { id: string };
      file.fileId = stored.id;
      if (!previous) turn?.created.add(stored.id);
      file.size = data.byteLength;
      // Bust previously cached versions when a later run replaces this path.
      file.storedUrl = `/api/sandbox/${encodeURIComponent(threadId)}/stored?path=${encodeURIComponent(file.path)}&v=${Date.now().toString(36)}`;
    } catch (error) {
      if (error instanceof QuotaError) {
        warning = `Sandbox: ${error.message}`;
        continue;
      }
      warning ??= `Some files could not be saved to chat storage and only live in the sandbox until it is wiped.`;
    }
  }
  return warning;
}

export async function runCode(opts: { userId: string; threadId: string; language: "python" | "bash"; code: string; timeoutS?: number; inputFiles?: string[]; signal?: AbortSignal; turn?: SandboxTurn }): Promise<RunCodeResult> {
  opts.signal?.throwIfAborted();
  if (opts.threadId.startsWith("tmp_") || !getThread(opts.userId, opts.threadId)) throw new Error("Chat not found");
  const ws = workspaceId(opts.userId, opts.threadId);
  const inputs = await copyInputs(opts.userId, ws, opts.inputFiles ?? []);
  opts.signal?.throwIfAborted();
  const timeout = Math.min(opts.timeoutS ?? 60, MAX_TIMEOUT_S);
  // The job id lets a cancel reach the run even while it still queues, or before its request arrives.
  const job = newId("job");
  // Stop in the chat kills the run's processes. Without this the run would continue until its timeout.
  const cancel = () =>
    void call(`/workspaces/${ws}/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ job }) }, 30_000, undefined, false).catch(() => {});
  opts.signal?.addEventListener("abort", cancel, { once: true });
  try {
    let res: Response;
    try {
      res = await call(
        `/workspaces/${ws}/run`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ language: opts.language, code: opts.code, timeout, job }) },
        // Queueing for a free slot can take up to 30 s on the runner.
        (timeout + 45) * 1000,
      );
    } catch (error) {
      // Giving up on the answer must also stop the run, or it would start or keep running unseen.
      cancel();
      throw error;
    }
    const result = (await res.json()) as RunnerResult;
    const results = resultPaths(result.files.map((f) => f.path));
    result.files = result.files.filter((f) => results.has(f.path));
    // The sandbox wipes idle workspaces, so produced files move into the user's storage right away.
    const storageWarning = await storeOutputs(opts.userId, opts.threadId, ws, result.files, opts.turn);
    opts.turn?.forget(opts.userId, opts.threadId, result.deleted ?? []);
    const base = `/api/sandbox/${encodeURIComponent(opts.threadId)}/files?path=`;
    const tooLarge = result.files.filter((f) => f.tooLarge).map((f) => ({ path: f.path, size: f.size }));
    const sizeWarning = tooLarge.length
      ? `Not saved and not downloadable, over the 50 MB limit per file: ${tooLarge.map((f) => `${f.path} (${megabytes(f.size)})`).join(", ")}. Make them smaller (compress, lower the resolution or bitrate, or split them into parts under 50 MB) in another run.`
      : undefined;
    const warning = [sizeWarning, storageWarning].filter(Boolean).join(" ");
    return {
      ...result,
      language: opts.language,
      inputs,
      files: result.files
        .filter((f) => !f.tooLarge)
        .map(({ tooLarge: _, ...f }) => ({ ...f, url: f.storedUrl ?? `${base}${encodeURIComponent(f.path)}&v=${Date.now().toString(36)}`, image: IMAGE.test(f.path) })),
      ...(tooLarge.length ? { tooLarge } : {}),
      ...(warning ? { storageWarning: warning } : {}),
    };
  } finally {
    opts.signal?.removeEventListener("abort", cancel);
  }
}

/**
 * Converts a presentation to PDF with the sandbox's LibreOffice, in the chat's workspace jail. The bytes come
 * from the caller (already ownership-checked) and the PDF never appears among the chat's files.
 */
export async function convertToPdf(userId: string, threadId: string, name: string, data: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
  if (!sandboxConfigured()) throw serviceUnavailable("sandbox");
  if (data.byteLength > RUNNER_MAX_FILE) throw new Error(`\`${name}\` is ${megabytes(data.byteLength)}; files over 50 MB cannot be converted.`);
  const ws = workspaceId(userId, threadId);
  const job = newId("job");
  try {
    const res = await call(`/workspaces/${ws}/convert?name=${encodeURIComponent(path.basename(name))}&job=${job}`, { method: "POST", body: Buffer.from(data) }, 180_000, signal);
    return new Uint8Array(await res.arrayBuffer());
  } catch (error) {
    void call(`/workspaces/${ws}/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ job }) }, 30_000, undefined, false).catch(() => {});
    throw error;
  }
}

/** Best effort: a missing or stopped sandbox must not block deleting the chat. */
export async function deleteSandboxWorkspace(userId: string, threadId: string) {
  if (!sandboxConfigured()) return;
  await call(`/workspaces/${workspaceId(userId, threadId)}`, { method: "DELETE" }, 10_000, undefined, false).catch(() => {});
}

export function sandboxTools(userId: string, threadId: string, signal?: AbortSignal, turn?: SandboxTurn): ToolSet {
  return {
    run_code: tool({
      description: DESCRIPTION,
      inputSchema: z.object({
        language: z.enum(["python", "bash"]),
        code: z.string().min(1).max(200_000).describe("The full program or script"),
        timeout_seconds: z.number().int().min(1).max(MAX_TIMEOUT_S).optional().describe("Wall-clock limit. Default 60"),
        input_files: z.array(z.string()).max(20).optional().describe("file_id values of attachments or fileId values of earlier saved outputs to copy into the working directory first (using safe basenames), even after scratch space expires"),
      }),
      execute: async ({ language, code, timeout_seconds, input_files }) => {
        const output = await runCode({ userId, threadId, language, code, timeoutS: timeout_seconds, inputFiles: input_files, signal, turn });
        // File paths and copied input names come from attachments or earlier program output, so scan the
        // whole object, not only stdout/stderr.
        const injection = scanForInjection(
          [output.stdout, output.stderr, ...output.files.map((f) => f.path), ...output.deleted, ...output.inputs].join("\n"),
        );
        return injection.flagged ? { ...output, injection } : output;
      },
      // The model needs paths, not download URLs. Program output is third-party data as well: a run can
      // print an attached document. The whole useful object sits in one quoted envelope, so a controlled
      // path or input name cannot add lines outside it.
      toModelOutput: ({ output }) => ({
        type: "text",
        value: wrapUntrusted(
          JSON.stringify({
            exitCode: output.exitCode,
            ...(output.stopped ? { stopped: output.stopped } : {}),
            stdout: output.stdout,
            stderr: output.stderr,
            files: output.files.map((f) => ({ path: f.path, size: f.size, ...(f.fileId ? { fileId: f.fileId } : {}) })),
            ...(output.deleted.length ? { deleted: output.deleted } : {}),
            ...(output.inputs.length ? { inputs: output.inputs } : {}),
            ...(output.tooLarge?.length ? { tooLarge: output.tooLarge } : {}),
            ...(output.storageWarning ? { storageWarning: output.storageWarning } : {}),
          }),
          { kind: "code_output", name: `${output.language ?? "code"} run` },
        ).text,
      }),
    }),
  };
}

/** Model-written files are untrusted. Opening one directly must never run script on our origin (an SVG
 * could). <img> ignores both headers, so inline previews still work. */
const downloadHeaders = (name: string, mime: string, preview = false) => ({
  "Content-Type": mime,
  "Content-Disposition": `${preview && (mime === "application/pdf" || /^image\/(png|jpeg|gif|webp)$/.test(mime)) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "private, no-store",
});

export const sandboxRoutes = new Hono<AppEnv>()
  // The registry's cached probe, so Settings → General and /api/services never probe the runner twice.
  .get("/sandbox", async (c) => {
    if (!sandboxConfigured()) return c.json({ configured: false, reachable: false });
    const status = await serviceStatus("sandbox");
    return c.json({
      configured: true,
      reachable: status?.state === "up" || status?.state === "degraded",
      // The runner is up but refuses every run because its isolation check failed. No raw worker text.
      refuses: status?.reasonKey === "refuses",
    });
  })
  .get("/sandbox/:threadId/files", async (c) => {
    const user = c.get("user");
    const threadId = c.req.param("threadId");
    const file = c.req.query("path");
    if (!sandboxConfigured() || !file || !getThread(user.id, threadId)) return c.json({ error: "Not found" }, 404);
    try {
      const res = await call(`/workspaces/${workspaceId(user.id, threadId)}/files?path=${encodeURIComponent(file)}`, {}, 60_000);
      const name = path.basename(file);
      return new Response(res.body, {
        headers: downloadHeaders(name, TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream"),
      });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 404);
    }
  })
  // Which outputs of this chat are still stored, so a reply lists only files that can be opened.
  .get("/sandbox/:threadId/outputs", (c) => {
    const user = c.get("user");
    const threadId = c.req.param("threadId");
    if (!getThread(user.id, threadId)) return c.json({ error: "Not found" }, 404);
    const rows = db.prepare("SELECT path FROM sandbox_files WHERE user_id = ? AND thread_id = ?").all(user.id, threadId) as Array<{ path: string }>;
    return c.json({ paths: rows.map((r) => r.path) });
  })
  // The durable copy of a produced file, stored in SQLite right after the run. The sandbox wipes idle
  // workspaces, so this route, not the proxy above, backs the download URLs the model hands out.
  .get("/sandbox/:threadId/stored", (c) => {
    const user = c.get("user");
    const threadId = c.req.param("threadId");
    const file = c.req.query("path");
    if (!file || !getThread(user.id, threadId)) return c.json({ error: "Not found" }, 404);
    const row = db
      .prepare("SELECT path, mime, data FROM sandbox_files WHERE user_id = ? AND thread_id = ? AND path = ?")
      .get(user.id, threadId, file) as { path: string; mime: string; data: Uint8Array } | undefined;
    if (!row) return c.json({ error: "Not found" }, 404);
    // Rows saved before a type was known carry octet-stream, which some browsers refuse to play.
    const mime = row.mime === "application/octet-stream" ? (TYPES[path.extname(row.path).toLowerCase()] ?? row.mime) : row.mime;
    return new Response(new Uint8Array(row.data), { headers: downloadHeaders(path.basename(row.path), mime, c.req.query("preview") === "1") });
  });
