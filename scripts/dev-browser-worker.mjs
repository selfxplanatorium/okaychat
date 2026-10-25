// Dev only: runs the browser worker (src/browser) next to `npm run dev:server`, as its own process with a
// clean environment, so it never sees OKAYCHAT_SECRET or other app settings. It shares the app's token file.
// This mode has no firewall: egress is checked by the in-process proxy only. For the hardened container, use
// scripts/dev-browser.sh. See docs/implementation/browser-worker.md.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const PASSED = ["PATH", "HOME", "TMPDIR", "PLAYWRIGHT_BROWSERS_PATH", "OKAYCHAT_CHROMIUM_PATH", "OKAYCHAT_SCRAPLING_COMMAND", "OKAYCHAT_SCRAPLING_BROWSER"];
const dotenv = {};
try {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) dotenv[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
} catch {
  // No .env: defaults apply.
}
const pick = (name) => process.env[name] ?? dotenv[name];
const env = Object.fromEntries(PASSED.flatMap((name) => (pick(name) ? [[name, pick(name)]] : [])));
const dataDir = path.resolve(pick("OKAYCHAT_DATA_DIR") ?? "./data");
Object.assign(env, {
  BROWSER_HOST: "127.0.0.1",
  BROWSER_PORT: "8791",
  BROWSER_TOKEN_FILE: path.resolve(pick("OKAYCHAT_BROWSER_TOKEN_FILE") ?? path.join(dataDir, "browser-token")),
});
const child = spawn(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), "watch", "src/browser/index.ts"], { env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 0));
