import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { Hono } from "hono";
import { MAX_JOB_BYTES, MAX_OUTPUT_BYTES, type Health, type RenderJob, type RenderResult } from "./api.js";
import { config } from "./config.js";
import { executablePath, htmlToPdf, JobError, renderStats, screenshotHtml } from "./render.js";
import { scraplingFetch, scraplingReady } from "./scrapling.js";
import { screenshotDocxPage, screenshotPdfPage } from "./viewers.js";

// The worker's HTTP API (see api.ts). It runs fixed job types on bytes the app sends; it has no access to app
// data, so it cannot look anything up by id, and a job's result goes back only on the request that started it.

let token: { value: string; mtime: number } | null = null;

/** The app writes the token; reread it when the file changes, so a new token works without a restart. */
function currentToken(): string | null {
  if (!config.tokenFile) return null;
  try {
    const mtime = statSync(config.tokenFile).mtimeMs;
    if (token?.mtime !== mtime) token = { value: readFileSync(config.tokenFile, "utf8").trim(), mtime };
    return token.value.length >= 32 ? token.value : null;
  } catch {
    return null;
  }
}

const digest = (value: string) => createHash("sha256").update(value).digest();

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

function decode(file: unknown): Uint8Array {
  if (typeof file !== "string" || !file) throw new JobError("The job carries no file.", 400);
  return new Uint8Array(Buffer.from(file, "base64"));
}

const page = (n: unknown) => (Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 10_000 ? (n as number) : 1);
const width = (n: unknown, fallback: number) => (Number.isInteger(n) && (n as number) >= 100 && (n as number) <= 2000 ? (n as number) : fallback);

async function render(job: RenderJob, signal: AbortSignal): Promise<RenderResult> {
  switch (job.kind) {
    case "pdf": {
      if (typeof job.html !== "string") throw new JobError("The job carries no HTML.", 400);
      const pdf = await htmlToPdf(job.html, job.pdf ?? {}, signal);
      if (pdf.byteLength > MAX_OUTPUT_BYTES) throw new JobError("The PDF would be over 50 MB.", 413);
      return { pdf: base64(pdf) };
    }
    case "screenshot": {
      if (typeof job.html !== "string") throw new JobError("The job carries no HTML.", 400);
      const shot = await screenshotHtml(
        job.html,
        {
          network: job.network === "cdn" ? "cdn" : "offline",
          width: width(job.width, 1000),
          maxHeight: Math.min(Number(job.maxHeight) || 1800, 4000),
          contentSelector: typeof job.contentSelector === "string" ? job.contentSelector : undefined,
        },
        signal,
      );
      return { png: base64(shot.png), width: shot.width, height: shot.height, errors: shot.errors };
    }
    case "pdf-page":
    case "docx-page": {
      const shoot = job.kind === "pdf-page" ? screenshotPdfPage : screenshotDocxPage;
      const shot = await shoot(decode(job.file), page(job.page), signal);
      return { png: base64(shot.png), width: shot.width, height: shot.height, label: shot.label, errors: shot.errors };
    }
    default:
      throw new JobError("Unknown job kind.", 400);
  }
}

/** Render slots the dispatcher is using now. A slot takes one job; then it exits and reports unhealthy until restarted. */
const busy = new Set<string>();
/** render role: set once this process has taken its job, when it exits afterwards. */
let served = false;

async function slotReady(slot: string): Promise<boolean> {
  try {
    return (await fetch(`${slot}/health`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

async function takeSlot(signal: AbortSignal): Promise<string> {
  const deadline = Date.now() + config.queueMs;
  for (;;) {
    for (const slot of config.slots) {
      if (busy.has(slot)) continue;
      busy.add(slot);
      if (await slotReady(slot)) return slot;
      busy.delete(slot);
    }
    if (signal.aborted) throw new JobError("Cancelled.", 499);
    if (Date.now() > deadline) throw new JobError("The browser worker is busy; try again.", 503);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Passes a job to a loopback server and its answer back unchanged. Aborting the caller aborts the job there. */
async function relay(url: string, body: ArrayBuffer, signal: AbortSignal): Promise<Response> {
  const res = await fetch(url, { method: "POST", body, headers: { "Content-Type": "application/json" }, signal });
  return new Response(res.body, { status: res.status, headers: { "Content-Type": res.headers.get("Content-Type") ?? "application/json" } });
}

const failure = (error: unknown) => {
  if (error instanceof JobError) return Response.json({ error: error.message, model: error.status === 422 }, { status: error.status });
  if (error instanceof SyntaxError) return Response.json({ error: "The job is not valid JSON." }, { status: 400 });
  // Messages only, never job contents.
  console.error("browser job failed:", String((error as Error).message).slice(0, 200));
  return Response.json({ error: "The page could not be rendered." }, { status: 500 });
};

/**
 * One HTTP app per role (config.ts). Only `all` and `dispatch` accept requests from outside the container, and only
 * with the token. `render` and `fetch` listen on loopback, where the firewall lets only the dispatcher's user in.
 */
export function createWorker(role = config.role) {
  const local = { render: role === "all" || role === "render", fetch: role === "all" || role === "fetch" };
  const app = new Hono();
  app.get("/health", async (c) => {
    const stats = renderStats();
    const slotsReady = role === "dispatch" ? (await Promise.all(config.slots.map(async (slot) => busy.has(slot) || (await slotReady(slot))))).filter(Boolean).length : undefined;
    const health: Health = {
      ok:
        role === "render" ? !!executablePath() && !served
        : role === "fetch" ? scraplingReady()
        : role === "dispatch" ? !!currentToken() && !!executablePath() && slotsReady! > 0
        : !!executablePath() && !!currentToken(),
      chromium: !!executablePath(),
      scrapling: role === "dispatch" ? !!config.fetchUrl && (await slotReady(config.fetchUrl)) : local.fetch && scraplingReady(),
      egressEnforced: config.egressEnforced,
      running: stats.running,
      waiting: stats.waiting,
      ...(slotsReady !== undefined ? { slotsReady, slots: config.slots.length } : {}),
    };
    return c.json(health, health.ok ? 200 : 503);
  });
  app.use("/v1/*", async (c, next) => {
    if (role === "all" || role === "dispatch") {
      const expected = currentToken();
      if (!expected) return c.json({ error: "The browser worker has no token yet." }, 503);
      const supplied = c.req.header("Authorization")?.replace(/^Bearer /, "") ?? "";
      if (!timingSafeEqual(digest(supplied), digest(expected))) return c.json({ error: "Unauthorized" }, 401);
    }
    if (Number(c.req.header("Content-Length") ?? 0) > MAX_JOB_BYTES) return c.json({ error: "The job is too large." }, 413);
    await next();
  });
  app.post("/v1/render", async (c) => {
    // The app's request ends when its caller gives up; the job stops with it.
    const signal = c.req.raw.signal;
    try {
      if (local.render) {
        if (role === "render") served = true;
        return c.json(await render((await c.req.json()) as RenderJob, signal));
      }
      const body = await c.req.arrayBuffer();
      const slot = await takeSlot(signal);
      try {
        return await relay(`${slot}/v1/render`, body, signal);
      } finally {
        busy.delete(slot);
      }
    } catch (error) {
      return failure(error);
    }
  });
  app.post("/v1/fetch", async (c) => {
    if (!local.fetch) {
      try {
        return await relay(`${config.fetchUrl}/v1/fetch`, await c.req.arrayBuffer(), c.req.raw.signal);
      } catch {
        return c.json({ title: null });
      }
    }
    const { url } = (await c.req.json().catch(() => ({}))) as { url?: unknown };
    if (typeof url !== "string" || !/^https?:\/\//i.test(url) || url.length > 4096) return c.json({ error: "Pass an http or https URL." }, 400);
    const page = await scraplingFetch(url, c.req.raw.signal);
    return c.json(page ?? { title: null });
  });
  return app;
}
