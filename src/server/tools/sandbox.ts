import path from "node:path";
import { tool, type ToolSet } from "ai";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth.js";
import { sha256 } from "../crypto.js";
import { db } from "../db.js";
import { env } from "../env.js";
import { getThread } from "../threads.js";

// run_code executes model-written Python and Bash in the sandbox container (sandbox/runner.py). Each chat
// has its own workspace whose files persist between runs. See docs/research/code-sandbox.md.

const MAX_TIMEOUT_S = 300;
const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;
const TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".pdf": "application/pdf", ".csv": "text/csv", ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json",
};

const DESCRIPTION = `Run Python 3.12 or Bash in this chat's private Linux sandbox and get stdout, stderr, the exit code, and the files the run created or changed.
Use it for calculations, data analysis, file conversion, charts, and checking code by running it.
- The working directory persists between calls in this chat. Variables do not: each call is a new process, so save intermediate results to files.
- Preinstalled: numpy, pandas, scipy, matplotlib, sympy, scikit-learn, pillow, openpyxl, python-docx, pypdf, requests, beautifulsoup4, lxml, pyyaml, tabulate; CLI tools curl, jq, sqlite3, git, zip, unzip, ripgrep. Internet access may be blocked, so do not rely on installing packages.
- A file the user attached carries a \`file_id\` in its <attachment> header. Pass it in \`input_files\` to copy the file into the working directory under its name.
- Images the run writes (png, jpg, gif, webp, svg) are shown to the user, and every created file gets a download link. Save charts with plt.savefig instead of plt.show. Do not paste file contents back unless asked.
- Processes started in the background are stopped when the call ends.`;

export const sandboxConfigured = () => !!env.sandboxUrl && env.sandboxToken.length >= 32;

/** Stable per chat. Hashed so the sandbox never sees user or thread ids. */
export const workspaceId = (userId: string, threadId: string) => sha256(`sandbox:${userId}:${threadId}`).slice(0, 32);

interface RunnerResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stopped: string | null;
  durationMs: number;
  files: Array<{ path: string; size: number }>;
  deleted: string[];
}

export interface RunCodeResult extends Omit<RunnerResult, "files"> {
  language: "python" | "bash";
  files: Array<{ path: string; size: number; url: string; image: boolean }>;
  inputs: string[];
}

async function call(route: string, init: RequestInit = {}, timeoutMs = 30_000, signal?: AbortSignal): Promise<Response> {
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
    throw new Error(timeout.aborted ? "The code sandbox did not answer in time." : "The code sandbox is not reachable.", { cause: error });
  }
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
    const row = db.prepare("SELECT name, data FROM uploads WHERE id = ? AND user_id = ?").get(id, userId) as { name: string; data: Uint8Array } | undefined;
    if (!row) throw new Error(`Unknown file_id \`${id}\`. Use the file_id from an <attachment> header.`);
    const name = path.basename(row.name).replace(/[^\w.() -]+/g, "_").replace(/^[.\s]+/, "") || id;
    await call(`/workspaces/${ws}/files?path=${encodeURIComponent(name)}`, { method: "PUT", body: Buffer.from(row.data) }, 60_000);
    names.push(name);
  }
  return names;
}

export async function runCode(opts: { userId: string; threadId: string; language: "python" | "bash"; code: string; timeoutS?: number; inputFiles?: string[]; signal?: AbortSignal }): Promise<RunCodeResult> {
  const ws = workspaceId(opts.userId, opts.threadId);
  const inputs = await copyInputs(opts.userId, ws, opts.inputFiles ?? []);
  const timeout = Math.min(opts.timeoutS ?? 60, MAX_TIMEOUT_S);
  // Stop in the chat kills the run's processes. Without this the run would continue until its timeout.
  const cancel = () => void call(`/workspaces/${ws}/cancel`, { method: "POST" }).catch(() => {});
  opts.signal?.addEventListener("abort", cancel, { once: true });
  try {
    const res = await call(
      `/workspaces/${ws}/run`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ language: opts.language, code: opts.code, timeout }) },
      // Queueing for a free slot can take up to 30 s on the runner.
      (timeout + 45) * 1000,
    );
    const result = (await res.json()) as RunnerResult;
    const base = `/api/sandbox/${encodeURIComponent(opts.threadId)}/files?path=`;
    return {
      ...result,
      language: opts.language,
      inputs,
      // The version parameter keeps a later run that rewrites the file from changing earlier cards' cache.
      files: result.files.map((f) => ({ ...f, url: `${base}${encodeURIComponent(f.path)}&v=${Date.now().toString(36)}`, image: IMAGE.test(f.path) })),
    };
  } finally {
    opts.signal?.removeEventListener("abort", cancel);
  }
}

/** Best effort: a missing or stopped sandbox must not block deleting the chat. */
export async function deleteSandboxWorkspace(userId: string, threadId: string) {
  if (!sandboxConfigured()) return;
  await call(`/workspaces/${workspaceId(userId, threadId)}`, { method: "DELETE" }, 10_000).catch(() => {});
}

export function sandboxTools(userId: string, threadId: string, signal?: AbortSignal): ToolSet {
  return {
    run_code: tool({
      description: DESCRIPTION,
      inputSchema: z.object({
        language: z.enum(["python", "bash"]),
        code: z.string().min(1).max(200_000).describe("The full program or script"),
        timeout_seconds: z.number().int().min(1).max(MAX_TIMEOUT_S).optional().describe("Wall-clock limit. Default 60"),
        input_files: z.array(z.string()).max(20).optional().describe("file_id values of attachments to copy into the working directory first"),
      }),
      execute: ({ language, code, timeout_seconds, input_files }) =>
        runCode({ userId, threadId, language, code, timeoutS: timeout_seconds, inputFiles: input_files, signal }),
      // The model needs paths, not download URLs.
      toModelOutput: ({ output }) => ({
        type: "json",
        value: {
          exitCode: output.exitCode,
          ...(output.stopped ? { stopped: output.stopped } : {}),
          stdout: output.stdout,
          stderr: output.stderr,
          files: output.files.map((f) => ({ path: f.path, size: f.size })),
          ...(output.deleted.length ? { deleted: output.deleted } : {}),
          ...(output.inputs.length ? { inputs: output.inputs } : {}),
        },
      }),
    }),
  };
}

export const sandboxRoutes = new Hono<AppEnv>()
  .get("/sandbox", async (c) => {
    if (!sandboxConfigured()) return c.json({ configured: false, reachable: false });
    const reachable = await fetch(`${env.sandboxUrl}/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
    return c.json({ configured: true, reachable });
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
        headers: {
          "Content-Type": TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream",
          // Model-written files are untrusted. Opening one directly must never run script on our origin
          // (an SVG could). <img> ignores both headers, so inline previews still work.
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "private, max-age=300",
        },
      });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 404);
    }
  });
