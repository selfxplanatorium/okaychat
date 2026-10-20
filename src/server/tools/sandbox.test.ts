import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { Hono } from "hono";

// A fake runner stands in for sandbox/runner.py. The runner's own isolation is checked against the real
// container (docs/research/code-sandbox.md); these tests cover what the app sends and exposes.
const calls: Array<{ method: string; url: string; auth: string | undefined; body: Buffer }> = [];
const runner = createServer(async (req: IncomingMessage, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  calls.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body: Buffer.concat(chunks) });
  res.setHeader("Content-Type", "application/json");
  if (req.url!.endsWith("/run")) {
    return res.end(JSON.stringify({ exitCode: 0, stdout: "42\n", stderr: "", stopped: null, durationMs: 12, files: [{ path: "out/plot.png", size: 10 }], deleted: [] }));
  }
  if (req.method === "GET" && req.url!.includes("/files?path=")) return res.end("<svg onload=alert(1)>");
  res.end(JSON.stringify({ ok: true }));
});
await new Promise<void>((resolve) => runner.listen(0, "127.0.0.1", resolve));

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-sandbox-test-"));
const TOKEN = "sandbox-test-token-0123456789abcdef";
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "sandbox-test-secret-only-not-for-production";
process.env.OKAYCHAT_SANDBOX_URL = `http://127.0.0.1:${(runner.address() as AddressInfo).port}`;
process.env.OKAYCHAT_SANDBOX_TOKEN = TOKEN;
const { db } = await import("../db.js");
const { requireUser } = await import("../auth.js");
const { sha256 } = await import("../crypto.js");
const { ensureThread } = await import("../threads.js");
const { sandboxRoutes, sandboxTools, workspaceId } = await import("./sandbox.js");
const app = new Hono().use(requireUser).route("/", sandboxRoutes);
for (const id of ["alice", "bob"]) {
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, `${id}@example.test`, id, "unused", "user", Date.now());
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(id), id, Date.now() + 600_000);
}
after(() => {
  runner.close();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => {
  calls.length = 0;
  db.exec("DELETE FROM uploads; DELETE FROM threads;");
  ensureThread("alice", "thr_alice");
});

const as = (user: string, url: string) => app.request(url, { headers: { Cookie: `okaychat_session=${user}` } });

test("each user and chat gets its own workspace id", () => {
  const ids = new Set([workspaceId("alice", "t1"), workspaceId("alice", "t2"), workspaceId("bob", "t1")]);
  assert.equal(ids.size, 3);
  for (const id of ids) assert.match(id, /^[a-f0-9]{32}$/);
});

test("run_code authenticates, copies the owner's uploads, and hides download URLs from the model", async () => {
  db.prepare("INSERT INTO uploads (id, user_id, name, mime, data, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("upl_a", "alice", "../../data.csv", "text/csv", Buffer.from("a,b\n1,2\n"), Date.now());
  const tool = sandboxTools("alice", "thr_alice").run_code!;
  const output = await tool.execute!({ language: "python", code: "print(42)", input_files: ["upl_a"] }, { toolCallId: "1", messages: [] });
  const ws = workspaceId("alice", "thr_alice");
  assert.ok(calls.every((c) => c.auth === `Bearer ${TOKEN}`));
  assert.equal(calls[0]!.url, `/workspaces/${ws}/files?path=data.csv`);
  assert.equal(calls[0]!.body.toString(), "a,b\n1,2\n");
  assert.deepEqual(JSON.parse(calls[1]!.body.toString()), { language: "python", code: "print(42)", timeout: 60 });
  assert.match(output.files[0].url, /^\/api\/sandbox\/thr_alice\/files\?path=out%2Fplot\.png&v=/);
  const modelView = await tool.toModelOutput!({ toolCallId: "1", input: {}, output });
  assert.doesNotMatch(JSON.stringify(modelView), /api\/sandbox/);
  assert.deepEqual((modelView as { value: { files: unknown } }).value.files, [{ path: "out/plot.png", size: 10 }]);
});

test("another user's file_id is rejected before anything reaches the sandbox", async () => {
  db.prepare("INSERT INTO uploads (id, user_id, name, mime, data, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("upl_b", "bob", "secret.txt", "text/plain", Buffer.from("bob"), Date.now());
  const tool = sandboxTools("alice", "thr_alice").run_code!;
  await assert.rejects(async () => tool.execute!({ language: "bash", code: "cat secret.txt", input_files: ["upl_b"] }, { toolCallId: "2", messages: [] }), /Unknown file_id/);
  assert.equal(calls.length, 0);
});

test("downloads require owning the chat and can never render on the app origin", async () => {
  assert.equal((await as("bob", "/sandbox/thr_alice/files?path=x.svg")).status, 404);
  assert.equal(calls.length, 0);
  const res = await as("alice", "/sandbox/thr_alice/files?path=x.svg");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Disposition") ?? "", /^attachment/);
  assert.match(res.headers.get("Content-Security-Policy") ?? "", /sandbox/);
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(calls[0]!.url, `/workspaces/${workspaceId("alice", "thr_alice")}/files?path=x.svg`);
});
