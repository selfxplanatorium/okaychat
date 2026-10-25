import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// The worker's own rules, against a real Chromium: offline pages see only staged files, a hung job is stopped and
// its slot comes back only after cleanup, a crashed browser is replaced, and the API needs the token. The
// container's firewall is tested by test/integration/run.sh.
// Several document suites launch Chromium in parallel during npm test.
const JOB_TIMEOUT_MS = 10_000;
process.env.BROWSER_JOB_TIMEOUT_MS = String(JOB_TIMEOUT_MS);
process.env.BROWSER_MAX_JOBS = "2";
process.env.BROWSER_QUEUE_MS = "20000";
const dir = mkdtempSync(path.join(os.tmpdir(), "okaychat-worker-test-"));
const tokenFile = path.join(dir, "token");
writeFileSync(tokenFile, "worker-test-token-0123456789abcdef0123456789");
process.env.BROWSER_TOKEN_FILE = tokenFile;
const { closeRenderer, executablePath, killBrowser, renderStats, screenshotHtml, withBrowserPage } = await import("./render.js");
const { createWorker } = await import("./server.js");

const available = !!executablePath();
const skip = !available && "Chromium is not installed";
after(async () => {
  await closeRenderer();
  rmSync(dir, { recursive: true, force: true });
});

test("offline pages see only staged files, and blocked requests are reported", { skip }, async () => {
  const root = mkdtempSync(path.join(dir, "root-"));
  writeFileSync(path.join(root, "ok.js"), "window.__staged = true;");
  writeFileSync(path.join(dir, "secret.txt"), "do not serve");
  const html = `<script src="/assets/ok.js"></script><img src="https://example.com/x.png"><iframe src="file:///etc/passwd"></iframe>
<script>
(async () => {
  const tries = { file: "file:///etc/passwd", traversal: "/assets/%2e%2e/secret.txt", dotdot: "/assets/../secret.txt", public: "https://cdn.jsdelivr.net/npm/x", loopback: "http://127.0.0.1:1/" };
  const out = {};
  for (const [k, u] of Object.entries(tries)) { try { const r = await fetch(u); out[k] = r.status + ":" + (await r.text()).slice(0, 20); } catch (e) { out[k] = "blocked"; } }
  try { new WebSocket("ws://127.0.0.1:1/"); out.ws = "created"; } catch { out.ws = "threw"; }
  out.rtc = typeof RTCPeerConnection;
  window.__out = out;
})();
</script>`;
  const out = await withBrowserPage(html, { roots: { "/assets/": root }, waitFor: "!!window.__out" }, async ({ page, errors }) => ({
    result: await page.evaluate(() => (window as unknown as { __out: Record<string, string> }).__out),
    staged: await page.evaluate(() => (window as unknown as { __staged?: boolean }).__staged),
    errors,
  }));
  assert.equal(out.staged, true);
  for (const key of ["file", "traversal", "dotdot", "public", "loopback"]) assert.equal(out.result[key], "blocked", `${key}: ${out.result[key]}`);
  assert.equal(out.result.rtc, "undefined");
  assert.ok(out.errors.some((e) => e.includes("Blocked request to https://example.com/x.png") && e.includes("offline")), out.errors.join("\n"));
  assert.ok(out.errors.some((e) => e.startsWith("Blocked WebSocket")), out.errors.join("\n"));
});

test("a hung page is stopped at the timeout and its slot is released only after cleanup", { skip }, async () => {
  const started = Date.now();
  const hung = Array.from({ length: 3 }, () => screenshotHtml("<p>x</p><script>addEventListener('load', () => { for (;;) {} })</script>"));
  // Two slots: the third job waits, then gets its turn once a hung one is cleaned up.
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(renderStats().running, 2);
  assert.equal(renderStats().waiting, 1);
  const settled = await Promise.allSettled(hung);
  for (const result of settled) {
    assert.equal(result.status, "rejected");
    assert.match(String((result as PromiseRejectedResult).reason), /timed out/);
  }
  assert.ok(Date.now() - started < 3 * JOB_TIMEOUT_MS + 15_000, `took ${Date.now() - started} ms`);
  assert.deepEqual({ running: renderStats().running, waiting: renderStats().waiting }, { running: 0, waiting: 0 });
  const shot = await screenshotHtml("<h1>after</h1>");
  assert.ok(shot.png.byteLength > 100);
});

test("a cancelled job stops at once and a crashed browser is replaced", { skip }, async () => {
  const controller = new AbortController();
  const job = screenshotHtml("<script>addEventListener('load', () => { for (;;) {} })</script>", {}, controller.signal);
  setTimeout(() => controller.abort(), 300);
  await assert.rejects(job, /Cancelled/);
  const crash = withBrowserPage("<p>x</p>", {}, async ({ page }) => {
    await killBrowser();
    return page.title();
  });
  await assert.rejects(crash);
  assert.equal(renderStats().running, 0);
  const shot = await screenshotHtml("<h1>relaunched</h1>");
  assert.ok(shot.png.byteLength > 100);
});

test("the job API requires the token and validates jobs", { skip }, async () => {
  const app = createWorker();
  const post = (route: string, body: unknown, token = "worker-test-token-0123456789abcdef0123456789") =>
    app.request(route, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` } });
  assert.equal((await post("/v1/render", { kind: "pdf", html: "<p>x</p>" }, "wrong")).status, 401);
  assert.equal((await post("/v1/render", { kind: "nope" })).status, 400);
  assert.equal((await post("/v1/fetch", { url: "file:///etc/passwd" })).status, 400);
  const pdf = (await (await post("/v1/render", { kind: "pdf", html: "<h1>Hi</h1>" })).json()) as { pdf: string };
  assert.equal(Buffer.from(pdf.pdf, "base64").subarray(0, 5).toString(), "%PDF-");
  const page = await post("/v1/render", { kind: "pdf-page", file: pdf.pdf, page: 4 });
  assert.equal(page.status, 422);
  assert.deepEqual(await page.json(), { error: "This PDF has 1 page.", model: true });
  const health = (await (await app.request("/health")).json()) as { ok: boolean; egressEnforced: boolean };
  assert.equal(health.ok, true);
  assert.equal(health.egressEnforced, false);
});
