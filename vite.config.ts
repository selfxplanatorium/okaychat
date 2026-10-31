import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/web",
  plugins: [react(), tailwindcss()],
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
    // `ws` carries `/api/voice/call`; without it the dev server answers the upgrade itself.
    proxy: { "/api": { target: "http://localhost:8787", changeOrigin: false, ws: true } },
  },
});
