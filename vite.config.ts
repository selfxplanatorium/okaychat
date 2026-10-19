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
  build: { outDir: "../../dist/web", emptyOutDir: true },
  server: {
    port: 5173,
    // Dev servers are reached over the tailnet (see AGENTS.md); allow MagicDNS names.
    allowedHosts: [".ts.net"],
    proxy: { "/api": { target: "http://localhost:8787", changeOrigin: false } },
  },
});
