import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-custom-tools-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "custom-tools-test-secret-not-for-production";
const { db } = await import("../db.js");
const { storageUsed } = await import("../quota.js");
const store = await import("./store.js");
const { approvedInvocation, executePrepared, prepareExecution, setExecutionDeps } = await import("./execute.js");
const { CUSTOM_LIMITS } = await import("../../shared/custom-tools.js");

for (const id of ["alice", "bob"]) {
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, 'user', ?)").run(id, `${id}@example.test`, id, "unused", Date.now());
}
db.prepare("INSERT INTO threads (id, user_id, title, created_at, updated_at) VALUES ('thread-a', 'alice', 'Chat', 1, 1)").run();
db.prepare("INSERT INTO threads (id, user_id, title, created_at, updated_at) VALUES ('thread-b', 'bob', 'Chat', 1, 1)").run();

after(() => {
  setExecutionDeps(null);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const pythonWrite = {
  name: "Sum",
  description: "Adds numbers.",
  icon: "calculator" as const,
  enabled: true,
  inputSchema: {
    type: "object" as const,
    properties: { values: { type: "array" as const, items: { type: "number" as const }, maxItems: 10 } },
    required: ["values"],
    additionalProperties: false as const,
  },
  config: { kind: "python" as const, code: "def main(input):\n    return {'total': sum(input['values'])}\n", timeoutMs: 5_000 },
};

const httpWrite = {
  name: "Lookup",
  description: "Looks up an item.",
  icon: "globe" as const,
  enabled: true,
  inputSchema: {
    type: "object" as const,
    properties: { id: { type: "string" as const }, limit: { type: "integer" as const } },
    required: ["id", "limit"],
    additionalProperties: false as const,
  },
  config: {
    kind: "http" as const,
    origin: "https://api.example.com",
    path: "/items/{{id}}",
    method: "GET" as const,
    query: [{ name: "limit", value: { input: "limit" as const } }],
    headers: [{ name: "authorization", secret: "apiKey" }],
    body: null,
    response: "json" as const,
    timeoutMs: 5_000,
  },
};

test("definitions are owner-scoped, revision-CAS, encrypted and counted by quota", () => {
  const before = storageUsed("alice");
  const created = store.createTool("alice", pythonWrite, undefined);
  assert.equal(created.revision, 1);
  assert.equal(created.enabled, true);
  assert.ok(store.toolRow("alice", created.id));
  assert.equal(store.toolRow("bob", created.id)?.id, undefined);
  assert.deepEqual(store.listTools("bob"), []);
  assert.ok(storageUsed("alice") > before);

  assert.throws(() => store.updateTool("alice", created.id, 2, pythonWrite, undefined), /changed/i);
  const updated = store.updateTool("alice", created.id, 1, { ...pythonWrite, name: "Sum v2" }, undefined);
  assert.equal(updated.revision, 2);
  assert.equal(updated.name, "Sum v2");

  // Ciphertext copied to another row fails the ownership binding.
  const second = store.createTool("alice", { ...pythonWrite, name: "Second" }, undefined);
  const row = store.toolRow("alice", second.id)!;
  db.prepare("UPDATE custom_tools SET config_enc = ? WHERE user_id = 'alice' AND id = ?").run(store.toolRow("alice", created.id)!.config_enc, second.id);
  assert.equal(store.toolValid(store.toolRow("alice", second.id)!), false);
  assert.ok(row);

  store.deleteTool("alice", created.id, 2);
  assert.equal(store.toolRow("alice", created.id), undefined);
});

test("HTTP secrets are write-only, bound to headers, and cleared by an origin change", () => {
  const created = store.createTool("alice", httpWrite, { set: { apiKey: "secret-value" }, remove: [] });
  assert.deepEqual(hostSecretNames(created.id), ["apiKey"]);
  assert.throws(() => store.updateTool("alice", created.id, 1, { ...httpWrite, config: { ...httpWrite.config, origin: "https://other.example.com" } }, undefined));
  const moved = store.updateTool("alice", created.id, 1, { ...httpWrite, config: { ...httpWrite.config, origin: "https://other.example.com" } }, { set: { apiKey: "new" }, remove: [] });
  assert.deepEqual(hostSecretNames(moved.id), ["apiKey"]);
  const cleared = store.updateTool("alice", created.id, moved.revision, { ...httpWrite, config: { ...httpWrite.config, headers: [{ name: "accept", value: "application/json" }] } }, { set: {}, remove: ["apiKey"] });
  assert.deepEqual(hostSecretNames(cleared.id), []);
  store.deleteTool("alice", created.id, cleared.revision);
});

function hostSecretNames(id: string): string[] {
  return store.secretNames(store.toolRow("alice", id)!);
}

test("Python execution is claimed once, counted once and dedupes a repeated request", async () => {
  const created = store.createTool("alice", pythonWrite, undefined);
  let calls = 0;
  setExecutionDeps({
    sandbox: async () => {
      calls++;
      return { exitCode: 0, stopped: null, durationMs: 12, stdout: '{"total":3}', stderr: "", stdoutOverflow: false, stderrOverflow: false };
    },
  });
  const key = "test:session:00000000-0000-7000-8000-000000000000";
  const prepared = prepareExecution({ userId: "alice", row: store.toolRow("alice", created.id)!, input: { values: [1, 2] }, source: "test", executionKey: key, sessionHash: "session" });
  const first = await executePrepared({
    actor: { userId: "alice" },
    runId: prepared.row.id,
    input: prepared.input,
    runtime: "workspaceTest",
    executionKey: key,
    sessionHash: "session",
    requestHash: prepared.requestHash,
    assertReady: () => {},
  });
  assert.equal(first.ok, true);
  assert.deepEqual(first.value, { total: 3 });
  assert.equal(calls, 1);
  const second = await executePrepared({
    actor: { userId: "alice" },
    runId: prepared.row.id,
    input: prepared.input,
    runtime: "workspaceTest",
    executionKey: key,
    sessionHash: "session",
    requestHash: prepared.requestHash,
    assertReady: () => {},
  });
  assert.deepEqual(second.value, { total: 3 });
  assert.equal(calls, 1);
  const row = store.runRow("alice", prepared.row.id)!;
  assert.equal(row.state, "succeeded");
  assert.equal(row.input_enc, null);
  assert.equal(store.summaryOf(store.toolRow("alice", created.id)!).counters.succeeded, 1);
  store.deleteTool("alice", created.id, 1);
});

test("HTTP never dispatches without the approved capability and redacts the secret", async () => {
  const created = store.createTool("alice", httpWrite, { set: { apiKey: "super-secret" }, remove: [] });
  let calls = 0;
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  setExecutionDeps({
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      calls++;
      seen.push({ url: String(input), headers: init?.headers as Record<string, string> });
      return new Response(JSON.stringify({ echo: "super-secret", ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  const key = "chat:reply-1:call-1";
  const prepared = prepareExecution({ userId: "alice", row: store.toolRow("alice", created.id)!, input: { id: "a", limit: 2 }, source: "chat", executionKey: key, sessionHash: "session", threadId: "thread-a" });
  const denied = await executePrepared({
    actor: { userId: "alice" },
    runId: prepared.row.id,
    input: prepared.input,
    runtime: "interactiveChat",
    executionKey: key,
    sessionHash: "session",
    requestHash: prepared.requestHash,
    assertReady: () => {},
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error?.code, "approval_required");
  assert.equal(calls, 0);

  const allowed = await executePrepared({
    actor: { userId: "alice" },
    runId: prepared.row.id,
    input: prepared.input,
    runtime: "interactiveChat",
    executionKey: key,
    sessionHash: "session",
    requestHash: prepared.requestHash,
    approvedInvocation: approvedInvocation(prepared.row.id, prepared.requestHash, prepared.row.revision),
    assertReady: () => {},
  });
  assert.equal(allowed.ok, true);
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(allowed.value).includes("super-secret"));
  assert.equal(seen[0]!.url, "https://api.example.com/items/a?limit=2");
  assert.equal(seen[0]!.headers.authorization, "super-secret");
  const row = store.runRow("alice", prepared.row.id)!;
  assert.equal(row.state, "succeeded");
  assert.equal(row.dispatched, 1);
  store.deleteTool("alice", created.id, 1);
});

test("a changed revision invalidates a prepared approval before dispatch", async () => {
  const created = store.createTool("alice", httpWrite, { set: { apiKey: "secret-value" }, remove: [] });
  let calls = 0;
  setExecutionDeps({ fetch: (async () => { calls++; return new Response("{}", { status: 200, headers: { "content-type": "application/json" } }); }) as typeof fetch });
  const key = "chat:reply-2:call-2";
  const prepared = prepareExecution({ userId: "alice", row: store.toolRow("alice", created.id)!, input: { id: "a", limit: 1 }, source: "chat", executionKey: key, sessionHash: "session", threadId: "thread-a" });
  const updated = store.updateTool("alice", created.id, 1, { ...httpWrite, config: { ...httpWrite.config, path: "/changed/{{id}}" } }, undefined);
  const result = await executePrepared({
    actor: { userId: "alice" },
    runId: prepared.row.id,
    input: prepared.input,
    runtime: "interactiveChat",
    executionKey: key,
    sessionHash: "session",
    requestHash: prepared.requestHash,
    approvedInvocation: approvedInvocation(prepared.row.id, prepared.requestHash, prepared.row.revision),
    assertReady: () => { throw new Error("changed"); },
  });
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
  store.deleteTool("alice", created.id, updated.revision);
});


test("HTTP credential payloads are redacted before persistence and delivery", async () => {
  for (const secret of ["ab", "Bearer opaque-token", "Basic dXNlcjpwYXNz", "123"]) {
    const created = store.createTool("alice", httpWrite, { set: { apiKey: secret }, remove: [] });
    const payload = secret.replace(/^(?:Bearer|Basic) /, "");
    setExecutionDeps({ fetch: (async () => new Response(JSON.stringify({ echo: secret === "123" ? 123 : payload }), {
      headers: { "content-type": "application/json" },
    })) as typeof fetch });
    const key = `test:redaction:${created.id}`;
    const prepared = prepareExecution({ userId: "alice", row: store.toolRow("alice", created.id)!, input: { id: "a", limit: 1 }, source: "test", executionKey: key, sessionHash: "session" });
    const result = await executePrepared({ actor: { userId: "alice" }, runId: prepared.row.id, input: prepared.input,
      runtime: "workspaceTest", executionKey: key, sessionHash: "session", requestHash: prepared.requestHash, assertReady: () => {} });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, { echo: "[redacted]" });
    assert.deepEqual(store.runView(store.runRow("alice", prepared.row.id)!).result, { echo: "[redacted]" });
    store.deleteTool("alice", created.id, 1);
  }
});

test("a reply admits at most its custom tool budget across preparing and running", () => {
  const created = store.createTool("alice", pythonWrite, undefined);
  const row = store.toolRow("alice", created.id)!;
  const logical = "reply-budget";
  let claimed: string | null = null;
  try {
    for (let i = 0; i < CUSTOM_LIMITS.attemptsPerReply; i++) {
      const executionKey = `chat:${logical}:call-${i}`;
      const prepared = prepareExecution({ userId: "alice", row, input: { values: [i] }, source: "chat", executionKey, sessionHash: "session", threadId: "thread-a" });
      // Claim the first one so the budget must include running and prepared rows together.
      if (i === 0) {
        store.claimRun({ userId: "alice", runId: prepared.row.id, requestHash: prepared.requestHash, sessionHash: "session" }, () => {}, () => ({ release: () => {} }));
        claimed = prepared.row.id;
      }
    }
    assert.throws(
      () => prepareExecution({ userId: "alice", row, input: { values: [99] }, source: "chat", executionKey: `chat:${logical}:call-over`, sessionHash: "session", threadId: "thread-a" }),
      /reached its custom tool limit/,
    );
  } finally {
    // A running row blocks deletion; settle it before removing the fixture.
    if (claimed) store.finishRun({ userId: "alice", runId: claimed, state: "cancelled", result: null, errorCode: null, outputBytes: 0, httpStatus: null, dispatched: false, durationMs: 0 });
    for (const run of store.listRuns("alice", created.id, 100)) {
      if (run.state === "prepared") store.denyRun("alice", run.id);
    }
    store.deleteTool("alice", created.id, row.revision);
  }
});

test("retention prunes expired results and keeps the latest", () => {
  const created = store.createTool("alice", pythonWrite, undefined);
  const row = store.toolRow("alice", created.id)!;
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const prepared = prepareExecution({ userId: "alice", row, input: { values: [i] }, source: "test", executionKey: `test:retention:${i}`, sessionHash: "session" });
    store.claimRun({ userId: "alice", runId: prepared.row.id, requestHash: prepared.requestHash, sessionHash: "session" }, () => {}, () => ({ release: () => {} }));
    store.finishRun({ userId: "alice", runId: prepared.row.id, state: "succeeded", result: { total: i }, errorCode: null, outputBytes: 2, httpStatus: null, dispatched: true, durationMs: 1 });
    ids.push(prepared.row.id);
  }
  const now = Date.now();
  const ages = [9, 8, 1 / 24].map((days) => days * 24 * 60 * 60_000);
  ids.forEach((id, i) => db.prepare("UPDATE custom_tool_runs SET created_at = ? WHERE id = ?").run(now - ages[i]!, id));
  store.prune("alice", now);
  const left = store.listRuns("alice", created.id, 100);
  assert.deepEqual(left.map((run) => run.id), [ids[2]]);
  store.deleteTool("alice", created.id, row.revision);
});
