import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

const chatgptHelperFile = fileURLToPath(new URL("./scripts/chatgpt-connect.mjs", import.meta.url));
const helperChecksum = (source: Buffer) => `${createHash("sha256").update(source).digest("hex")}\n`;

// A worktree usually symlinks `node_modules` to the primary checkout, which sits outside the Vite root.
// Serving dependencies from their real path keeps bundled fonts and other node_modules assets working in
// dev exactly as they do in the build, instead of silently falling back.
const projectRoot = fileURLToPath(new URL("./", import.meta.url));
const dependencyRoot = realpathSync(fileURLToPath(new URL("./node_modules", import.meta.url)));

/**
 * The ChatGPT desktop helper is one standalone script, so it lives in `scripts/` and is published at the
 * web root: Vite serves it in dev and emits it into the built web directory. The published checksum lets a
 * user verify the downloaded script before running it. No package or build-script change is needed.
 */
function chatgptHelper(): Plugin {
  const isHelperPath = (url: string | undefined) => {
    const path = url?.split("?")[0];
    return path === "/chatgpt-connect.mjs" || path === "/chatgpt-connect.mjs.sha256";
  };
  return {
    name: "okaychat-chatgpt-helper",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!isHelperPath(req.url)) return next();
        const source = readFileSync(chatgptHelperFile);
        const checksum = req.url!.split("?")[0]!.endsWith(".sha256");
        res.setHeader("Content-Type", checksum ? "text/plain; charset=utf-8" : "text/javascript; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        if (!checksum) res.setHeader("Content-Disposition", 'attachment; filename="chatgpt-connect.mjs"');
        res.end(checksum ? helperChecksum(source) : source);
      });
    },
    generateBundle() {
      const source = readFileSync(chatgptHelperFile);
      this.emitFile({ type: "asset", fileName: "chatgpt-connect.mjs", source });
      this.emitFile({ type: "asset", fileName: "chatgpt-connect.mjs.sha256", source: helperChecksum(source) });
    },
  };
}

export default defineConfig({
  root: "src/web",
  plugins: [react(), tailwindcss(), chatgptHelper()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src/web", import.meta.url)),
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
    },
  },
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    manifest: true,
    rolldownOptions: {
      output: {
        strictExecutionOrder: true,
        codeSplitting: {
          groups: [
            // Keep runtime singletons together; only load chat libraries from authenticated routes.
            { name: "react", test: /node_modules\/(react|react-dom|scheduler)\//, priority: 30 },
            { name: "markdown", test: /node_modules\/(@assistant-ui\/react-markdown|react-markdown|remark[^/]*|rehype[^/]*|micromark[^/]*|mdast[^/]*|hast[^/]*|unist[^/]*|unified|vfile[^/]*)\//, priority: 20 },
            { name: "assistant-ui-core", test: /node_modules\/@assistant-ui\/core\//, priority: 15 },
            { name: "assistant-ui", test: /node_modules\/@assistant-ui\//, priority: 10 },
            { name: "ui-primitives", test: /node_modules\/(@base-ui|@floating-ui)\//, priority: 10 },
            { name: "widgets", test: /node_modules\/(generative-frame|safe-content-frame)\//, priority: 10 },
            { name: "ai-sdk", test: /node_modules\/(ai|@ai-sdk\/[^/]+|assistant-stream)\//, priority: 10 },
          ].map((group) => ({ ...group, includeDependenciesRecursively: false, entriesAware: true })),
        },
      },
    },
  },
  server: {
    port: 5173,
    // Dev servers are reached over the tailnet (see AGENTS.md); allow MagicDNS names.
    allowedHosts: [".ts.net"],
    fs: { allow: [projectRoot, dependencyRoot] },
    // `ws` carries `/api/voice/call`; without it the dev server answers the upgrade itself. `/v1` is the
    // external API, mounted outside the session/CSRF chain on the server.
    proxy: { "/api": { target: "http://localhost:8787", changeOrigin: false, ws: true }, "/v1": { target: "http://localhost:8787", changeOrigin: false } },
  },
});
