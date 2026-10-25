import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { closeRenderer } from "./render.js";
import { createWorker } from "./server.js";

// Entry point of the browser worker: Chromium for documents and previews, and Scrapling for web_fetch's
// fallback, kept out of the app process. See docs/research/browser-worker.md.

if ((config.role === "all" || config.role === "dispatch") && !config.tokenFile) {
  throw new Error("BROWSER_TOKEN_FILE must name the file the app writes the worker token to");
}

const server = serve({ fetch: createWorker().fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`okaychat browser worker (${config.role}) listening on ${config.host}:${info.port} (egress ${config.egressEnforced ? "enforced by firewall" : "checked by proxy only"})`);
});

// A render slot serves one job and exits once its answer is sent, so nothing of that job (browser, contexts,
// process memory) is left for the next one. The container supervisor starts a fresh slot.
if (config.role === "render" && config.exitAfterJob) {
  server.on("request", (req, res) => {
    if (req.url?.startsWith("/v1/render")) res.on("close", () => void closeRenderer().finally(() => process.exit(0)));
  });
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close();
    void closeRenderer().finally(() => process.exit(0));
  });
}
