import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { Hono } from "hono";
import type { EvalCaseFields, EvalTarget } from "../../shared/evaluations.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-evals-routes-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "evaluations-routes-test-secret-not-for-production";
writeFileSync(
  path.join(dataDir, "models-dev.json"),
  JSON.stringify({
    data: {
      openai: {
        id: "openai",
        name: "OpenAI",
        npm: "@ai-sdk/openai",
        api: "https://api.openai.com/v1",
        models: {
          "gpt-eval": {
            id: "gpt-eval",
            name: "Eval",
            tool_call: true,
            modalities: { input: ["text"], output: ["text"] },
            limit: { context: 100_000, output: 8_000 },
          },
        },
      },
    },
    fetchedAt: Date.now(),
  }),
);
const { db } = await import("../db.js");
const { sha256 } = await import("../crypto.js");
const { saveConnection } = await import("../catalog/providers.js");
const { writePolicy } = await import("../permissions/store.js");
const { api } = await import("../routes.js");
const store = await import("./store.js");

db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('alice', 'alice@example.test', 'Alice', 'unused', 'admin', 1)").run();
db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('bob', 'bob@example.test', 'Bob', 'unused', 'user', 1)").run();
for (const user of ["alice", "bob"]) {
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(user), user, Date.now() + 600_000);
}
saveConnection("alice", "openai", { apiKey: "test-key" });
writePolicy({ kind: "user", id: "bob" }, null, { version: 1, features: { evaluations: false } }, "alice");
const app = new Hono().route("/api", api);
after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => {
  db.exec("DELETE FROM evaluation_scores; DELETE FROM evaluation_results; DELETE FROM evaluation_runs; DELETE FROM evaluation_cases; DELETE FROM evaluation_datasets");
});

const call = (user: string | null, pathname: string, init: RequestInit = {}) =>
  app.request(`http://app/api/evaluations${pathname}`, {
    ...init,
    headers: { ...(user ? { cookie: `okaychat_session=${user}` } : {}), "content-type": "application/json", ...(init.headers ?? {}) },
  });

const fields = (input: string): EvalCaseFields => ({ input, instructions: "", expected: "", notes: "", tags: [] });
const target = (): EvalTarget => ({
  modelRef: "openai/gpt-eval",
  modelName: "Eval",
  effort: null,
  sampling: {},
  assistantPresetId: null,
  assistantName: null,
  instructions: "",
});

function seed() {
  const dataset = store.createDataset("alice", { name: "Set", cases: [fields("question")] });
  const { run } = store.launchRun("alice", dataset.id, {
    label: "Run",
    target: target(),
    scoreMode: "scale5",
    concurrency: 1,
    budgetTokens: 100_000,
    budgetMicros: 100_000,
  });
  db.prepare("UPDATE evaluation_results SET state = 'done', output = 'SECRET ANSWER', output_bytes = 13 WHERE run_id = ?").run(run.id);
  store.recountRun(run.id);
  store.updateRunState(run.id, { state: "done", stopReason: "completed", errorCode: null, errorMessage: null, endedAt: Date.now() });
  return { dataset, run, caseId: dataset.cases[0]!.caseId };
}

test("every evaluation route requires auth and the evaluations feature", async () => {
  const { dataset, run, caseId } = seed();
  const routes: Array<[string, string, RequestInit?]> = [
    ["GET", "/datasets"],
    ["POST", "/datasets", { method: "POST", body: JSON.stringify({ name: "x" }) }],
    ["GET", `/datasets/${dataset.id}`],
    ["PUT", `/datasets/${dataset.id}`, { method: "PUT", body: JSON.stringify({ expectedRevision: 1, name: "x", description: "" }) }],
    ["DELETE", `/datasets/${dataset.id}`, { method: "DELETE" }],
    ["POST", `/datasets/${dataset.id}/duplicate`, { method: "POST" }],
    ["POST", `/datasets/${dataset.id}/cases`, { method: "POST", body: JSON.stringify({ expectedRevision: 1, ...fields("q") }) }],
    ["PUT", `/datasets/${dataset.id}/cases/${caseId}`, { method: "PUT", body: JSON.stringify({ expectedRevision: 1, ...fields("q") }) }],
    ["DELETE", `/datasets/${dataset.id}/cases/${caseId}`, { method: "DELETE", body: JSON.stringify({ expectedRevision: 1 }) }],
    ["PATCH", `/datasets/${dataset.id}/cases/order`, { method: "PATCH", body: JSON.stringify({ expectedRevision: 1, caseIds: [caseId] }) }],
    ["GET", "/runs"],
    ["POST", `/datasets/${dataset.id}/runs`, { method: "POST", body: JSON.stringify({ modelRef: "openai/gpt-eval" }) }],
    ["GET", `/runs/${run.id}`],
    ["GET", `/runs/${run.id}/progress`],
    ["GET", `/runs/${run.id}/cases/${caseId}`],
    ["POST", `/runs/${run.id}/cancel`, { method: "POST" }],
    ["DELETE", `/runs/${run.id}`, { method: "DELETE" }],
    ["POST", `/runs/${run.id}/duplicate`, { method: "POST" }],
    ["PUT", `/runs/${run.id}/cases/${caseId}/score`, { method: "PUT", body: JSON.stringify({ expectedRevision: 0, value: 3 }) }],
    ["DELETE", `/runs/${run.id}/cases/${caseId}/score`, { method: "DELETE", body: JSON.stringify({ expectedRevision: 1 }) }],
    ["POST", `/runs/${run.id}/judge`, { method: "POST", body: JSON.stringify({ modelRef: "openai/gpt-eval", rubric: "r", scale: "scale5" }) }],
    ["GET", `/runs/${run.id}/compare/${run.id}`],
    ["GET", `/runs/${run.id}/export?format=json`],
  ];
  for (const [method, pathname, init] of routes) {
    assert.equal((await call(null, pathname, { ...init, method })).status, 401, `anonymous ${method} ${pathname}`);
    const denied = await call("bob", pathname, { ...init, method });
    assert.equal(denied.status, 403, `denied ${method} ${pathname}`);
    assert.match((await denied.json() as { error: string }).error, /administrator/i);
  }
});

test("bodies are validated and unknown keys are stripped", async () => {
  const long = await call("alice", "/datasets", { method: "POST", body: JSON.stringify({ name: "x".repeat(81), extra: true }) });
  assert.equal(long.status, 400);
  const created = await call("alice", "/datasets", { method: "POST", body: JSON.stringify({ name: "Fine", evil: "ignored" }) });
  assert.equal(created.status, 201);
  const body = (await created.json()) as { id: string };
  assert.deepEqual(Object.keys(db.prepare("SELECT * FROM evaluation_datasets WHERE id = ?").get(body.id) as object).includes("evil"), false);

  const dataset = store.createDataset("alice", { name: "Cases", cases: [fields("q")] });
  const foreign = await call("alice", `/datasets/${dataset.id}/runs`, {
    method: "POST",
    body: JSON.stringify({ modelRef: "openai/gpt-eval", caseIds: ["missing"] }),
  });
  assert.equal(foreign.status, 400);
});

test("progress carries counters and no result text", async () => {
  const { run } = seed();
  const response = await call("alice", `/runs/${run.id}/progress`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.totalCases, 1);
  assert.equal(body.completedCases, 1);
  assert.equal("results" in body, false);
  assert.doesNotMatch(JSON.stringify(body), /SECRET ANSWER/);
});

test("evaluation routes never create a thread or a message", async () => {
  const before = {
    threads: (db.prepare("SELECT COUNT(*) AS n FROM threads").get() as { n: number }).n,
    messages: (db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n,
    runs: (db.prepare("SELECT COUNT(*) AS n FROM generation_runs").get() as { n: number }).n,
    uploads: (db.prepare("SELECT COUNT(*) AS n FROM uploads").get() as { n: number }).n,
    images: (db.prepare("SELECT COUNT(*) AS n FROM images").get() as { n: number }).n,
  };
  const { dataset, run, caseId } = seed();
  await call("alice", `/runs/${run.id}/cases/${caseId}/score`, { method: "PUT", body: JSON.stringify({ expectedRevision: 0, value: 4 }) });
  await call("alice", `/runs/${run.id}/export?format=csv`);
  await call("alice", `/runs/${dataset.id}/duplicate`, { method: "POST" });
  assert.deepEqual(
    {
      threads: (db.prepare("SELECT COUNT(*) AS n FROM threads").get() as { n: number }).n,
      messages: (db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n,
      runs: (db.prepare("SELECT COUNT(*) AS n FROM generation_runs").get() as { n: number }).n,
      uploads: (db.prepare("SELECT COUNT(*) AS n FROM uploads").get() as { n: number }).n,
      images: (db.prepare("SELECT COUNT(*) AS n FROM images").get() as { n: number }).n,
    },
    before,
  );
});

test("temporary-chat shaped ids are ordinary 404s", async () => {
  assert.equal((await call("alice", "/datasets/tmp_abc")).status, 404);
  assert.equal((await call("alice", "/datasets/tmp_abc/runs", { method: "POST", body: JSON.stringify({ modelRef: "openai/gpt-eval" }) })).status, 404);
  assert.equal((await call("alice", "/runs/tmp_abc")).status, 404);
  assert.equal((await call("alice", "/runs/tmp_abc/progress")).status, 404);
});

test("export streams a file with a safe filename and both formats", async () => {
  const { run } = seed();
  const csv = await call("alice", `/runs/${run.id}/export?format=csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-disposition") ?? "", /^attachment; filename="set-.*\.csv"$/);
  assert.match(await csv.text(), /SECRET ANSWER/);
  const json = await call("alice", `/runs/${run.id}/export?format=json`);
  assert.equal(json.status, 200);
  assert.equal((await json.json() as { version: number }).version, 1);
  assert.equal((await call("alice", `/runs/${run.id}/export?format=xml`)).status, 400);
});
