import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// The container's job API (role dispatch) against fake render slots and a fake fetch server: it needs the token,
// gives each slot one job at a time, skips slots that report unhealthy (a slot that has served its job), and passes
// fetches through. The real slots and the firewall around them are tested by test/integration/run.sh.
const slots: Array<{ server: Server; healthy: boolean; active: number; peak: number; jobs: number }> = [];
const listen = (server: Server) => new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
const urls: string[] = [];
for (let i = 0; i < 2; i++) {
  const slot = { server: null as unknown as Server, healthy: true, active: 0, peak: 0, jobs: 0 };
  slot.server = createServer(async (req, res) => {
    if (req.url === "/health") return res.writeHead(slot.healthy ? 200 : 503).end("{}");
    for await (const _ of req);
    slot.active++;
    slot.jobs++;
    slot.peak = Math.max(slot.peak, slot.active);
    await new Promise((resolve) => setTimeout(resolve, 150));
    slot.active--;
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ pdf: `slot${i}` }));
  });
  slots.push(slot);
  urls.push(await listen(slot.server));
}
const fetcher = createServer(async (req, res) => {
  if (req.url === "/health") return res.writeHead(200).end("{}");
  let body = "";
  for await (const chunk of req) body += chunk;
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ title: "fetched", content: body }));
});
const fetchUrl = await listen(fetcher);

const dir = mkdtempSync(path.join(os.tmpdir(), "okaychat-dispatch-test-"));
const TOKEN = "dispatch-test-token-0123456789abcdef0123456789";
writeFileSync(path.join(dir, "token"), TOKEN);
process.env.BROWSER_TOKEN_FILE = path.join(dir, "token");
process.env.BROWSER_SLOTS = urls.join(",");
process.env.BROWSER_FETCH_URL = fetchUrl;
process.env.BROWSER_QUEUE_MS = "3000";
const { createWorker } = await import("./server.js");
const app = createWorker("dispatch");
after(() => {
  for (const slot of slots) slot.server.close();
  fetcher.close();
  rmSync(dir, { recursive: true, force: true });
});

const post = (route: string, body: unknown, token = TOKEN) =>
  app.request(route, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` } });

test("the job API needs the token", async () => {
  assert.equal((await post("/v1/render", { kind: "pdf", html: "x" }, "wrong-token-wrong-token-wrong-token")).status, 401);
  assert.equal(slots[0]!.jobs + slots[1]!.jobs, 0);
});

test("each slot takes one job at a time and unhealthy slots are skipped", async () => {
  const answers = await Promise.all(Array.from({ length: 6 }, () => post("/v1/render", { kind: "pdf", html: "x" }).then((r) => r.json() as Promise<{ pdf: string }>)));
  assert.deepEqual(new Set(answers.map((a) => a.pdf)), new Set(["slot0", "slot1"]));
  assert.ok(slots.every((s) => s.peak === 1), `peaks ${slots.map((s) => s.peak)}`);
  slots[0]!.healthy = false;
  const before = slots[0]!.jobs;
  for (let i = 0; i < 3; i++) assert.equal(((await (await post("/v1/render", { kind: "pdf", html: "x" })).json()) as { pdf: string }).pdf, "slot1");
  assert.equal(slots[0]!.jobs, before);
  slots[1]!.healthy = false;
  const busy = await post("/v1/render", { kind: "pdf", html: "x" });
  assert.equal(busy.status, 503);
  slots[0]!.healthy = slots[1]!.healthy = true;
});

test("fetches pass through to the fetch server unchanged", async () => {
  const page = (await (await post("/v1/fetch", { url: "https://example.com/" })).json()) as { title: string; content: string };
  assert.deepEqual(page, { title: "fetched", content: JSON.stringify({ url: "https://example.com/" }) });
});
