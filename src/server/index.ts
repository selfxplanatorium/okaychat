import { chatgptHelperRoutes } from "./chatgpt-oauth-routes.js";
import { existsSync } from "node:fs";
import { startMediaMaintenance } from "./media/maintenance.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { csrf } from "hono/csrf";
import { logger } from "hono/logger";
import { authRoutes } from "./auth.js";
import { warmCatalog } from "./catalog/providers.js";
import { probeRenderer } from "./documents/render.js";
import { handleAppError } from "./errors.js";
import { env } from "./env.js";
import { resumeKnowledgeIngestion } from "./knowledge/jobs.js";
import { startMemoryWorker } from "./memory-learn.js";
import { api, mcpOAuthCallback } from "./routes.js";
import { generationBusy, interruptOpenRuns } from "./generation-runs.js";
import { initEvaluations } from "./evaluations/worker.js";
import { setUnresolvedRunReader } from "./thread-runs.js";
import { resetArchiveJobsAtStartup, startArchiveMaintenance } from "./archive-jobs.js";
import { publicShareRoutes } from "./shares.js";
import { startRecordingPurge } from "./speech/config.js";
import { startCompareMaintenance } from "./compare.js";
import { initChannelWorker } from "./channels/worker.js";
import { startChannelMaintenance } from "./channels/maintenance.js";
import { initCustomTools, startCustomToolMaintenance } from "./custom-tools/maintenance.js";
import { speechToken, speechWorkerConfigured } from "./speech/worker.js";
import { voiceWebSocketServer } from "./voice/routes.js";

const app = new Hono();
// Capability-bearing OAuth requests and query strings never enter the request logger.
app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/chatgpt")) return next();
  return logger()(c, next);
});
// Cross-site form posts (which skip the CORS preflight) cannot reach the API, including login and logout.
// Browsers send Sec-Fetch-Site; the Origin comparison covers clients that do not.
const publicOrigin = process.env.OKAYCHAT_PUBLIC_URL ? new URL(process.env.OKAYCHAT_PUBLIC_URL).origin : undefined;
// Upper bound for any request body. Chat and message bodies carry inline attachments (several 25 MB files,
// base64-encoded); upload routes set tighter limits of their own.
app.use("/api/*", bodyLimit({ maxSize: 100 * 1024 * 1024, onError: (c) => c.json({ error: "Request is too large." }, 413) }));
app.use("/api/*", csrf({ origin: (origin, c) => origin === new URL(c.req.url).origin || origin === publicOrigin }));
app.onError(handleAppError);
// Applied to every response that did not set its own. A script CSP is not possible here: artifact frames
// use srcdoc, which inherits the parent's policy, and they load libraries from public CDNs.
app.use("*", async (c, next) => {
  await next();
  const headers = c.res.headers;
  if (!headers.has("Content-Security-Policy")) headers.set("Content-Security-Policy", "frame-ancestors 'self'");
  if (!headers.has("X-Content-Type-Options")) headers.set("X-Content-Type-Options", "nosniff");
  if (!headers.has("Referrer-Policy")) headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  // The app frames its own PDF previews, so same-origin framing stays allowed.
  headers.set("X-Frame-Options", "SAMEORIGIN");
});
app.get("/api/health", (c) => c.json({ ok: true, version: env.version }));
app.route("/api/auth", authRoutes);
app.route("/api/mcp/oauth/callback", mcpOAuthCallback);
app.route("/api/public/shares", publicShareRoutes);
app.route("/api/chatgpt/helper", chatgptHelperRoutes);
app.route("/api", api);

// Production: serve the built SPA. In dev, Vite serves it and proxies /api here.
const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web");
if (existsSync(webDir)) {
  const root = path.relative(process.cwd(), webDir);
  app.use(
    "/*",
    serveStatic({
      root,
      // Built by scripts/compress-web.mjs, so no request spends CPU on compression.
      precompressed: true,
      onFound: (filePath, c) => {
        // Hashed file names change with their content, so browsers never need to ask again.
        if (filePath.includes("/assets/")) c.header("Cache-Control", "public, max-age=31536000, immutable");
        // The service worker and manifest must revalidate, or installed apps keep an old shell after a deploy.
        else if (/\/(sw\.js|index\.html|manifest\.webmanifest)(\.(br|gz))?$/.test(filePath)) c.header("Cache-Control", "no-cache");
      },
    }),
  );
  app.get("*", serveStatic({ root, path: "index.html", precompressed: true, onFound: (_path, c) => void c.header("Cache-Control", "no-cache") }));
}

// The first page load after a restart must not wait for the 6 MB catalog or the OpenCode Go model list.
void warmCatalog().catch(() => {});

// `/api/voice/call` upgrades through this server; the codec lives in voice/ws.ts so no `ws` dependency is needed.
serve({ fetch: app.fetch, port: env.port, hostname: env.host, websocket: { server: voiceWebSocketServer } }, (info) => {
  console.log(`okaychat listening on http://${env.host}:${info.port}`);
  // Receipts are a ledger, not restart-safe generation: an open row from a previous process is interrupted,
  // never resumed or billed again. Waiting rows still gate config edits and schedules until cancelled.
  interruptOpenRuns();
  // Evaluation runs never resume: work from a previous process is marked failed, never re-dispatched.
  initEvaluations();
  setUnresolvedRunReader(generationBusy);
  // Archive jobs never resume across a restart: open work fails, prepared bytes expire, staging is swept.
  resetArchiveJobsAtStartup();
  startArchiveMaintenance();
  startMemoryWorker();
  startRecordingPurge();
  startCompareMaintenance();
  // Channel AI work never resumes: open rows become interrupted, keeping their last checkpoint.
  initChannelWorker();
  startChannelMaintenance();
  // Moves legacy image BLOBs/inline chat images to files in small steps, then collects orphaned media.
  startMediaMaintenance();
  initCustomTools();
  startCustomToolMaintenance();
  // Rows keep queued/extracting/embedding state across a restart; resuming spends no idle timer.
  resumeKnowledgeIngestion();
  // The worker reads this file; writing it at start lets the worker authenticate before the first request.
  if (speechWorkerConfigured()) speechToken();
  probeRenderer();
});
