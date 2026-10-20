import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { HTTPException } from "hono/http-exception";
import { authRoutes } from "./auth.js";
import { warmCatalog } from "./catalog/providers.js";
import { env } from "./env.js";
import { notePublicOrigin } from "./mcp/manager.js";
import { api, mcpOAuthCallback } from "./routes.js";
import { publicShareRoutes } from "./shares.js";

const app = new Hono();
app.use("/api/*", logger());
app.use("/api/*", async (c, next) => {
  const proto = c.req.header("x-forwarded-proto");
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host");
  if (host) notePublicOrigin(`${proto ?? new URL(c.req.url).protocol.replace(":", "")}://${host}`);
  await next();
});
app.onError((error, c) => {
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  console.error(`[${c.req.method} ${c.req.path}]`, error);
  return c.json({ error: error instanceof Error ? error.message : "Internal error" }, 500);
});
app.get("/api/health", (c) => c.json({ ok: true, version: env.version }));
app.route("/api/auth", authRoutes);
app.route("/api/mcp/oauth/callback", mcpOAuthCallback);
app.route("/api/public/shares", publicShareRoutes);
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

serve({ fetch: app.fetch, port: env.port, hostname: env.host }, (info) => {
  console.log(`okaychat listening on http://${env.host}:${info.port}`);
});
