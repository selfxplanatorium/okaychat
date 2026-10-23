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
const { SandboxTurn, sandboxRoutes, sandboxTools, workspaceId } = await import("./sandbox.js");
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
  db.exec("DELETE FROM uploads; DELETE FROM sandbox_files; DELETE FROM threads;");
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
  assert.match(output.files[0].url, /^\/api\/sandbox\/thr_alice\/stored\?path=out%2Fplot\.png&v=/);
  // The fake runner answers any download with its SVG body.
  const stored = db.prepare("SELECT size FROM sandbox_files WHERE user_id = 'alice' AND thread_id = 'thr_alice' AND path = 'out/plot.png'").get() as { size: number } | undefined;
  assert.equal(stored?.size, 21);
  const modelView = await tool.toModelOutput!({ toolCallId: "1", input: {}, output });
  assert.doesNotMatch(JSON.stringify(modelView), /api\/sandbox/);
  assert.deepEqual((modelView as { value: { files: unknown } }).value.files, [{ path: "out/plot.png", size: 21, fileId: output.files[0].fileId }]);
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

test("stored outputs are served from chat storage with the same safeguards, only to the owner", async () => {
  db.prepare("INSERT INTO sandbox_files (id, user_id, thread_id, path, mime, data, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    "sf_1",
    "alice",
    "thr_alice",
    "out/plot.png",
    "image/png",
    Buffer.from("png-bytes"),
    9,
    Date.now(),
  );
  assert.equal((await as("bob", "/sandbox/thr_alice/stored?path=out/plot.png")).status, 404);
  const res = await as("alice", "/sandbox/thr_alice/stored?path=out/plot.png");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "image/png");
  assert.match(res.headers.get("Content-Disposition") ?? "", /^attachment/);
  assert.match(res.headers.get("Content-Security-Policy") ?? "", /sandbox/);
  assert.equal((await res.arrayBuffer()).byteLength, 9);
  assert.equal((await as("alice", "/sandbox/thr_alice/stored?path=other.png")).status, 404);
});

test("outputs that would pass the storage quota keep their sandbox URL and warn the model", async () => {
  db.prepare("UPDATE users SET storage_limit = 20 WHERE id = 'alice'").run();
  const tool = sandboxTools("alice", "thr_alice").run_code!;
  const output = await tool.execute!({ language: "python", code: "print(1)" }, { toolCallId: "3", messages: [] });
  assert.match(output.storageWarning ?? "", /quota/i);
  assert.match(output.files[0]!.url, /\/files\?path=/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sandbox_files").get()?.n, 0);
  const modelView = await tool.toModelOutput!({ toolCallId: "3", input: {}, output });
  assert.match(JSON.stringify(modelView), /quota/i);
  db.prepare("UPDATE users SET storage_limit = NULL WHERE id = 'alice'").run();
});

test("rewriting an output at quota replaces its bytes without charging for both copies", async () => {
  db.prepare("UPDATE users SET storage_limit = 21 WHERE id = 'alice'").run();
  const tool = sandboxTools("alice", "thr_alice").run_code!;
  for (let i = 0; i < 2; i++) {
    const output = await tool.execute!({ language: "python", code: "print(1)" }, { toolCallId: String(i), messages: [] });
    assert.equal(output.storageWarning, undefined);
    assert.match(output.files[0]!.url, /\/stored\?/);
  }
  assert.equal(db.prepare("SELECT count(*) AS n FROM sandbox_files").get()!.n, 1);
  db.prepare("UPDATE users SET storage_limit = NULL WHERE id = 'alice'").run();
});

test("saved outputs can be restored by fileId after scratch expiry, without crossing accounts", async () => {
  const tool = sandboxTools("alice", "thr_alice").run_code!;
  const first = await tool.execute!({ language: "python", code: "print(1)" }, { toolCallId: "first", messages: [] });
  const id = first.files[0]!.fileId;
  assert.ok(id);
  calls.length = 0;
  await tool.execute!({ language: "python", code: "print(2)", input_files: [id] }, { toolCallId: "second", messages: [] });
  assert.match(calls[0]!.url, /files\?path=plot.png$/);
  assert.equal(calls[0]!.body.toString(), "<svg onload=alert(1)>");
  ensureThread("bob", "thr_bob");
  const other = sandboxTools("bob", "thr_bob").run_code!;
  await assert.rejects(async () => other.execute!({ language: "python", code: "print(1)", input_files: [id] }, { toolCallId: "other", messages: [] }), /Unknown file_id/);
});

test("a finished turn keeps only the last file-writing run's new files", () => {
  const insert = db.prepare("INSERT INTO sandbox_files (id, user_id, thread_id, path, mime, data, size, created_at) VALUES (?, 'alice', 'thr_alice', ?, 'text/plain', x'00', 1, 1)");
  for (const id of ["sf_old", "sf_scratch", "sf_draft", "sf_final"]) insert.run(id, `${id}.txt`);
  const turn = new SandboxTurn();
  // sf_old came from an earlier turn, so it is never a draft of this one.
  for (const id of ["sf_scratch", "sf_draft", "sf_final"]) turn.created.add(id);
  turn.lastFiles = ["sf_final", "sf_old"];
  turn.prune("alice");
  const left = db.prepare("SELECT id FROM sandbox_files WHERE user_id = 'alice' AND id LIKE 'sf_%' ORDER BY id").all().map((r) => (r as { id: string }).id);
  assert.ok(left.includes("sf_old") && left.includes("sf_final"));
  assert.ok(!left.includes("sf_scratch") && !left.includes("sf_draft"));
});
