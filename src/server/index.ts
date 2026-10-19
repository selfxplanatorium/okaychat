import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { authRoutes } from "./auth.js";
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
  app.use("/*", serveStatic({ root }));
  app.get("*", serveStatic({ root, path: "index.html" }));
}

serve({ fetch: app.fetch, port: env.port, hostname: env.host }, (info) => {
  console.log(`okaychat listening on http://${env.host}:${info.port}`);
});
