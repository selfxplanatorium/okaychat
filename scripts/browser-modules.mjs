// Copies the browser worker's runtime packages and everything they depend on from node_modules into
// <out>/node_modules, so the worker image carries only what it runs. Used by the Dockerfile's build stage.
import { cpSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOTS = ["playwright-core", "pdfjs-dist", "docx-preview", "jszip", "hono", "@hono/node-server", "@ai-sdk/mcp"];
const out = process.argv[2];
if (!out) throw new Error("usage: node scripts/browser-modules.mjs OUT_DIR");
const base = path.resolve("node_modules");

/** Node's lookup: node_modules next to the requiring package, then each parent directory's. */
function locate(name, from) {
  for (let dir = from; dir.startsWith(base); dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
  }
  const top = path.join(base, name);
  return existsSync(path.join(top, "package.json")) ? top : null;
}

const seen = new Set();
const queue = ROOTS.map((name) => {
  const dir = locate(name, base);
  if (!dir) throw new Error(`${name} is not installed`);
  return dir;
});
while (queue.length) {
  const dir = queue.pop();
  if (seen.has(dir)) continue;
  seen.add(dir);
  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  // Optional dependencies are skipped: the only one is pdfjs-dist's native canvas, for running pdf.js in Node.
  const deps = { ...pkg.dependencies, ...pkg.peerDependencies };
  for (const name of Object.keys(deps)) {
    const found = locate(name, dir);
    // Unmet optional peer dependencies may be absent; required ones are checked by npm ci.
    if (found) queue.push(found);
  }
}
for (const dir of seen) cpSync(dir, path.join(out, "node_modules", path.relative(base, dir)), { recursive: true, dereference: true });
console.log(`copied ${seen.size} packages`);
