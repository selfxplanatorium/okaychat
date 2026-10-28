import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

// The app owns workspace routing and job cancellation. Docker exec is only the test controller's
// out-of-band fixture channel: runner file APIs serialize behind the active run's workspace lock.
const url = process.env.OKAYCHAT_IT_SANDBOX_URL;
const token = process.env.OKAYCHAT_IT_SANDBOX_TOKEN;
const container = process.env.OKAYCHAT_IT_SANDBOX_CONTAINER;
if (!url || !token || !container) throw new Error("Run through test/integration/cross-chat.sh or run.sh");
const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-isolation-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "isolated-integration-fixtures-only";
process.env.OKAYCHAT_SANDBOX_URL = url;
process.env.OKAYCHAT_SANDBOX_TOKEN = token;
const { db } = await import("./db.js");
const { ensureThread } = await import("./threads.js");
const { runCode, workspaceId } = await import("./tools/sandbox.js");
after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const exec = promisify(execFile);
const fixture = (name: string) => readFileSync(new URL(`../../test/integration/cross_chat_${name}.py`, import.meta.url), "utf8");
const common = fixture("common");
type Identity = { pid: number; start: string };
type Target = Identity & { uid: number; workspace: string; canary: string; socket: string; fd: number; address: number };
type Status = {
  nonce: string; target?: Target; checks?: Record<string, boolean>; signals?: number;
  identity?: Identity; uid?: number; workspace?: string; result?: string; before?: Identity; after?: Identity;
};

// Only paths derived from our two random workspace ids. Never enumerate /proc or read resource contents.
const CHANNEL = String.raw`
import json, os, pathlib, sys
root = pathlib.Path('/work') / sys.argv[1]
action = sys.argv[2]
if action == 'absent':
    print(json.dumps(not root.exists()))
elif action == 'dead':
    target = json.loads(sys.argv[3])
    try:
        text = pathlib.Path('/proc/%s/stat' % target['pid']).read_text()
        print(json.dumps(text[text.rfind(')') + 2:].split()[19] != target['start']))
    except FileNotFoundError:
        print('true')
elif action == 'read':
    try: print((root / '.okaychat/cross-chat/status.json').read_text())
    except FileNotFoundError: print('null')
else:
    private = root / '.okaychat/cross-chat'
    temporary = private / 'control.tmp'
    fd = os.open(temporary, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
    with os.fdopen(fd, 'w') as out:
        os.fchown(out.fileno(), private.stat().st_uid, private.stat().st_gid)
        out.write(sys.argv[3])
    temporary.replace(private / 'control.json')
    print('null')
`;

async function channel(ws: string, action: string, value?: unknown): Promise<unknown> {
  const { stdout } = await exec("docker", ["exec", container!, "python3", "-c", CHANNEL, ws, action, JSON.stringify(value ?? null)], { timeout: 5000 });
  return JSON.parse(stdout);
}

async function runner(ws: string, method: string, suffix = ""): Promise<void> {
  const response = await fetch(`${url}/workspaces/${ws}${suffix}`, {
    method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
  });
  assert.ok(response.ok, `runner ${method} ${suffix}: HTTP ${response.status}`);
  await response.arrayBuffer();
}

test("same-account chats isolate live private resources through app workspace routing", { timeout: 180_000 }, async (t) => {
  const userId = `usr_isolation_${randomUUID()}`;
  const chats = [0, 1].map(() => `thr_isolation_${randomUUID()}`);
  const workspaces = chats.map((chat) => workspaceId(userId, chat));
  const [a, b] = workspaces as [string, string];
  assert.notEqual(a, b);
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(userId, `${userId}@example.test`, "Isolation fixture", "unused", "user", Date.now());
  for (const chat of chats) ensureThread(userId, chat);

  const controllers = [new AbortController(), new AbortController()];
  const jobs: Array<Promise<Awaited<ReturnType<typeof runCode>>>> = [];
  const ended = new Set<number>();
  const identities: Identity[] = [];
  const start = (index: number, code: string) => {
    const job = runCode({ userId, threadId: chats[index]!, language: "python", code, timeoutS: 120, signal: controllers[index]!.signal });
    jobs.push(job);
    // Attach rejection handling immediately, even when fixture readiness fails before we await the job.
    void job.then(() => ended.add(index), () => ended.add(index));
  };
  const wait = async (ws: string, nonce: string): Promise<Status> => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      assert.equal(ended.size, 0, "fixture job ended before the controller released it");
      const status = await channel(ws, "read") as Status | null;
      if (status?.nonce === nonce) return status;
      await delay(50);
    }
    throw new Error(`fixture checkpoint ${nonce} did not arrive (not an isolation pass)`);
  };
  const command = async (ws: string, op: string) => {
    const nonce = randomUUID();
    await channel(ws, "write", { nonce, op });
    return wait(ws, nonce);
  };
  let target: Target;
  const positive = (status: Status) => {
    assert.deepEqual(status.identity, { pid: target.pid, start: target.start }, "A's original process stayed alive");
    assert.equal(status.signals, 1, "B delivered no signal to A");
    assert.ok(status.checks && Object.keys(status.checks).length === 17);
    for (const [name, ok] of Object.entries(status.checks!)) assert.equal(ok, true, `A local control: ${name}`);
  };

  try {
    start(0, common + "\n" + fixture("holder"));
    const ready = await wait(a, "ready");
    assert.ok(ready.target);
    target = ready.target;
    identities.push(target);
    assert.equal(target.workspace, `/work/${a}`, "A reached the app-derived workspace");
    positive(ready);
    t.diagnostic("A ready: all 17 local controls passed; canary and socket private; no contents logged");

    start(1, common + `\nTARGET = ${JSON.stringify(target)}\n` + fixture("probe"));
    const bReady = await wait(b, "ready");
    assert.ok(bReady.identity);
    identities.push(bReady.identity);
    assert.equal(bReady.workspace, `/work/${b}`, "B reached its distinct app-derived workspace");
    assert.notEqual(bReady.uid, target.uid, "the same account's two chats have different runner uids");

    const hidden = new Set(["workspace_open", "workspace_list", "canary_read", "unix_socket"]);
    const probes = ["workspace_open", "workspace_list", "canary_read", "proc_root_canary", "unix_socket", "proc_root_socket",
      "environment", "memory", "process_vm_readv", "fd_list", "fd_readlink", "fd_read", "signal_zero", "signal_usr1"];
    for (const name of probes) {
      await t.test(name, async (probe) => {
        positive(await command(a, "checkpoint"));
        const result = await command(b, name);
        positive(await command(a, "checkpoint"));
        const original = { pid: target.pid, start: target.start };
        assert.deepEqual(result.before, original, "B saw the exact live A process before its attempt");
        assert.deepEqual(result.after, original, "B saw the same A process after its attempt");
        const expected = hidden.has(name) ? ["ENOENT", "EACCES", "EPERM"] : ["EACCES", "EPERM"];
        const evidence = result.result === "ENOENT" && hidden.has(name)
          ? "hidden by mount isolation (A independently verified target exists)"
          : result.result === "EACCES" || result.result === "EPERM"
            ? "access denied to live target"
            : result.result === "ALLOWED" ? "ISOLATION FAILURE: operation succeeded" : "unexpected outcome; isolation not established";
        probe.diagnostic(`${result.result}; ${evidence}; A local controls passed before and after`);
        assert.ok(expected.includes(result.result!), `${name}: ${result.result}; missing/deleted proc targets and connection refusals do not count as enforced isolation`);
      });
    }
    for (const ws of workspaces) await channel(ws, "write", { nonce: randomUUID(), op: "stop" });
    for (const job of jobs) {
      const result = await job;
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stopped, null);
      assert.equal(result.stdout, "", "coordination never relies on streamed or final stdout");
      assert.deepEqual(result.files, [], "private fixture bytes never become app outputs");
    }
  } finally {
    // Both paths run even after a failed assertion/readiness check. Cancel explicitly and await it;
    // abort callbacks alone are fire-and-forget. The enclosing shell also removes the entire test container.
    controllers.forEach((controller) => controller.abort());
    const cancelled = await Promise.allSettled(workspaces.map((ws) => runner(ws, "POST", "/cancel")));
    const settled = await Promise.allSettled(jobs);
    const deleted = await Promise.allSettled(workspaces.map((ws) => runner(ws, "DELETE")));
    const absent = await Promise.all(workspaces.map((ws) => channel(ws, "absent")));
    const dead = await Promise.all(identities.map((id) => channel(a, "dead", id)));
    for (const result of [...cancelled, ...deleted]) assert.equal(result.status, "fulfilled", "cleanup request completed");
    assert.equal(settled.length, jobs.length);
    assert.ok(absent.every((value) => value === true), "both workspaces removed");
    assert.ok(dead.every((value) => value === true), "both original fixture processes ended");
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    t.diagnostic("cleanup: both jobs settled, both original fixture processes gone, both workspaces deleted");
  }
});
