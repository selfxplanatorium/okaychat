import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { Hono } from "hono";
import type { EvalTarget, EvalCaseFields } from "../../shared/evaluations.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-evals-store-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "evaluations-store-test-secret-not-for-production";
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
          "gpt-no-temp": {
            id: "gpt-no-temp",
            name: "No temperature",
            tool_call: true,
            reasoning: true,
            reasoning_options: [{ type: "effort", values: ["low", "high"] }],
            temperature: false,
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
const { updateSettings } = await import("../settings.js");
const { api } = await import("../routes.js");
const store = await import("./store.js");

db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('alice', 'alice@example.test', 'Alice', 'unused', 'admin', 1)").run();
db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('bob', 'bob@example.test', 'Bob', 'unused', 'user', 1)").run();
for (const user of ["alice", "bob"]) {
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(user), user, Date.now() + 600_000);
}
saveConnection("alice", "openai", { apiKey: "test-key" });
updateSettings("alice", { maxSteps: 1, maxSearches: 0, webTools: false, artifacts: false, generativeUI: false, subagents: false, autoCompactAt: 0 });
const app = new Hono().route("/api", api);
after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => {
  db.exec("DELETE FROM evaluation_scores; DELETE FROM evaluation_results; DELETE FROM evaluation_runs; DELETE FROM evaluation_cases; DELETE FROM evaluation_datasets");
});

const request = (user: string, pathname: string, init: RequestInit = {}) =>
  app.request(`http://app/api/evaluations${pathname}`, {
    ...init,
    headers: { cookie: `okaychat_session=${user}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

const fields = (input: string, extra: Partial<EvalCaseFields> = {}): EvalCaseFields => ({
  input,
  instructions: "",
  expected: "",
  notes: "",
  tags: [],
  ...extra,
});

async function createDataset(user = "alice", body: Record<string, unknown> = { name: "Set" }) {
  const response = await request(user, "/datasets", { method: "POST", body: JSON.stringify(body) });
  assert.equal(response.status, 201);
  return json<{ id: string; revision: number; name: string; cases: Array<{ caseId: string; position: number; tags: string[] }>; usedBytes: number }>(response);
}

const target = (modelRef = "openai/gpt-eval"): EvalTarget => ({
  modelRef,
  modelName: modelRef.split("/")[1]!,
  effort: null,
  sampling: {},
  assistantPresetId: null,
  assistantName: null,
  instructions: "",
});

function launch(datasetId: string, options: Partial<import("./store.js").LaunchInput> = {}) {
  return store.launchRun("alice", datasetId, {
    label: "Run",
    target: target(),
    scoreMode: "scale5",
    concurrency: 1,
    budgetTokens: 100_000,
    budgetMicros: 100_000,
    ...options,
  });
}

test("dataset create, read, update, and delete bump the revision once per mutation", async () => {
  const created = await createDataset();
  assert.equal(created.revision, 1);
  const read = await json<{ dataset: { revision: number; caseCount: number }; cases: unknown[]; usedBytes: number }>(await request("alice", `/datasets/${created.id}`));
  assert.equal(read.dataset.revision, 1);
  assert.equal(read.dataset.caseCount, 0);
  assert.deepEqual(read.cases, []);
  assert.equal(read.usedBytes, 0);

  const updated = await request("alice", `/datasets/${created.id}`, {
    method: "PUT",
    body: JSON.stringify({ expectedRevision: 1, name: "Renamed", description: "d" }),
  });
  assert.equal(updated.status, 200);
  const updatedBody = await json<{ dataset: { revision: number; name: string } }>(updated);
  assert.equal(updatedBody.dataset.revision, 2);
  assert.equal(updatedBody.dataset.name, "Renamed");

  assert.equal((await request("alice", `/datasets/${created.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await request("alice", `/datasets/${created.id}`)).status, 404);
});

test("a stale expectedRevision answers 409 with the stored dataset", async () => {
  const created = await createDataset();
  await request("alice", `/datasets/${created.id}`, { method: "PUT", body: JSON.stringify({ expectedRevision: 1, name: "New", description: "" }) });
  const stale = await request("alice", `/datasets/${created.id}`, { method: "PUT", body: JSON.stringify({ expectedRevision: 1, name: "Old", description: "" }) });
  assert.equal(stale.status, 409);
  const body = await json<{ error: string; dataset: { revision: number; name: string } }>(stale);
  assert.match(body.error, /Reload/);
  assert.equal(body.dataset.revision, 2);
  assert.equal(body.dataset.name, "New");

  const caseWrite = await request("alice", `/datasets/${created.id}/cases`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision: 1, ...fields("q") }),
  });
  assert.equal(caseWrite.status, 409);
  assert.equal((await json<{ dataset: { revision: number } }>(caseWrite)).dataset.revision, 2);
});

test("case positions stay dense; delete renumbers; order takes exactly a permutation", async () => {
  const created = await createDataset("alice", {
    name: "Ordered",
    cases: [fields("one"), fields("two"), fields("three")],
  });
  let detail = await json<{ cases: Array<{ caseId: string; position: number }> }>(await request("alice", `/datasets/${created.id}`));
  assert.deepEqual(detail.cases.map((item) => item.position), [1, 2, 3]);
  const middle = detail.cases[1]!.caseId;

  const deleted = await request("alice", `/datasets/${created.id}/cases/${middle}`, { method: "DELETE", body: JSON.stringify({ expectedRevision: 1 }) });
  assert.equal(deleted.status, 200);
  const afterDelete = await json<{ dataset: { revision: number } }>(deleted);
  assert.equal(afterDelete.dataset.revision, 2);
  detail = await json<{ cases: Array<{ caseId: string; position: number }> }>(await request("alice", `/datasets/${created.id}`));
  assert.deepEqual(detail.cases.map((item) => item.position), [1, 2]);

  const ids = detail.cases.map((item) => item.caseId);
  const bad = await request("alice", `/datasets/${created.id}/cases/order`, {
    method: "PATCH",
    body: JSON.stringify({ expectedRevision: 2, caseIds: [ids[0], ids[0]] }),
  });
  assert.equal(bad.status, 400);
  const wrong = await request("alice", `/datasets/${created.id}/cases/order`, {
    method: "PATCH",
    body: JSON.stringify({ expectedRevision: 2, caseIds: [ids[0]] }),
  });
  assert.equal(wrong.status, 400);

  const moved = await request("alice", `/datasets/${created.id}/cases/order`, {
    method: "PATCH",
    body: JSON.stringify({ expectedRevision: 2, caseIds: [ids[1], ids[0]] }),
  });
  assert.equal(moved.status, 200);
  detail = await json<{ cases: Array<{ caseId: string; position: number }> }>(await request("alice", `/datasets/${created.id}`));
  assert.deepEqual(detail.cases.map((item) => [item.caseId, item.position]), [[ids[1], 1], [ids[0], 2]]);
});

test("case and dataset caps reject precisely, and tags are normalized and capped", async () => {
  const created = await createDataset();
  let revision = 1;
  const tooMany = await request("alice", "/datasets", {
    method: "POST",
    body: JSON.stringify({ name: "Huge", cases: Array.from({ length: 201 }, (_, index) => fields(`case ${index}`)) }),
  });
  assert.equal(tooMany.status, 400);

  const big = await request("alice", "/datasets", {
    method: "POST",
    body: JSON.stringify({ name: "Bytes", cases: Array.from({ length: 200 }, (_, index) => fields(`${index}`.padEnd(6_000, "x"))) }),
  });
  assert.equal(big.status, 400);
  assert.match((await json<{ error: string }>(big)).error, /byte/i);

  const tagged = await request("alice", `/datasets/${created.id}/cases`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision: revision, ...fields("tagged", { tags: ["Good Tag", "!!!", "good  tag", ...Array.from({ length: 12 }, (_, index) => `t${index}`)] }) }),
  });
  assert.equal(tagged.status, 201);
  const taggedBody = await json<{ case: { tags: string[] }; dataset: { revision: number } }>(tagged);
  assert.deepEqual(taggedBody.case.tags.slice(0, 2), ["good tag", "t0"]);
  assert.equal(taggedBody.case.tags.length, 10);
  revision = taggedBody.dataset.revision;

  for (let index = 1; index < 200; index++) {
    const response = await request("alice", `/datasets/${created.id}/cases`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision: revision, ...fields(`case ${index}`) }),
    });
    assert.equal(response.status, 201);
    revision = (await json<{ dataset: { revision: number } }>(response)).dataset.revision;
  }
  const overflow = await request("alice", `/datasets/${created.id}/cases`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision: revision, ...fields("one too many") }),
  });
  assert.equal(overflow.status, 400);
});

test("duplicating a dataset copies cases, order, and tags with new ids", async () => {
  const created = await createDataset("alice", {
    name: "Original",
    cases: [fields("a", { tags: ["one"] }), fields("b", { instructions: "be brief" })],
  });
  const response = await request("alice", `/datasets/${created.id}/duplicate`, { method: "POST" });
  assert.equal(response.status, 201);
  const copy = await json<{ dataset: { id: string; name: string; caseCount: number } }>(response);
  assert.notEqual(copy.dataset.id, created.id);
  assert.match(copy.dataset.name, /copy/);
  const detail = await json<{ cases: Array<{ caseId: string; input: string; tags: string[] }> }>(await request("alice", `/datasets/${copy.dataset.id}`));
  assert.deepEqual(detail.cases.map((item) => item.input), ["a", "b"]);
  assert.deepEqual(detail.cases.map((item) => item.tags), [["one"], []]);
  assert.notEqual(detail.cases[0]!.caseId, created.cases[0]!.caseId);
});

test("foreign dataset and case ids answer 404 on every route", async () => {
  const created = await createDataset();
  const detail = await json<{ cases: Array<{ caseId: string }> }>(
    await request("alice", `/datasets/${created.id}/cases`, { method: "POST", body: JSON.stringify({ expectedRevision: 1, ...fields("q") }) }).then(async (r) => {
      assert.equal(r.status, 201);
      return request("alice", `/datasets/${created.id}`);
    }),
  );
  const caseId = detail.cases[0]!.caseId;
  const attempts: Array<[string, RequestInit]> = [
    [`/datasets/${created.id}`, {}],
    [`/datasets/${created.id}`, { method: "PUT", body: JSON.stringify({ expectedRevision: 2, name: "x", description: "" }) }],
    [`/datasets/${created.id}`, { method: "DELETE" }],
    [`/datasets/${created.id}/duplicate`, { method: "POST" }],
    [`/datasets/${created.id}/cases`, { method: "POST", body: JSON.stringify({ expectedRevision: 2, ...fields("q") }) }],
    [`/datasets/${created.id}/cases/${caseId}`, { method: "PUT", body: JSON.stringify({ expectedRevision: 2, ...fields("q") }) }],
    [`/datasets/${created.id}/cases/${caseId}`, { method: "DELETE", body: JSON.stringify({ expectedRevision: 2 }) }],
    [`/datasets/${created.id}/cases/order`, { method: "PATCH", body: JSON.stringify({ expectedRevision: 2, caseIds: [caseId] }) }],
  ];
  for (const [pathname, init] of attempts) {
    assert.equal((await request("bob", pathname, init)).status, 404, `${init.method ?? "GET"} ${pathname}`);
  }
  assert.equal((await request("bob", "/runs/missing")).status, 404);
  assert.equal((await request("bob", "/runs/missing/progress")).status, 404);
});

test("deleting a dataset is refused while a run is active and then cascades", async () => {
  const created = await createDataset("alice", { name: "Cascade", cases: [fields("q")] });
  const { run } = launch(created.id);
  assert.equal((await request("alice", `/datasets/${created.id}`, { method: "DELETE" })).status, 409);
  store.markRunCancelling("alice", run.id);
  store.finalizeQueuedCancel(run.id);
  assert.equal((await request("alice", `/datasets/${created.id}`, { method: "DELETE" })).status, 200);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM evaluation_runs").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM evaluation_results").get() as { n: number }).n, 0);
});

test("launch validation rejects unknown datasets, empty sets, agents, unconnected providers, and bad sampling", async () => {
  const missing = await request("alice", "/datasets/missing/runs", { method: "POST", body: JSON.stringify({ modelRef: "openai/gpt-eval" }) });
  assert.equal(missing.status, 404);

  const empty = await createDataset();
  const emptyRun = await request("alice", `/datasets/${empty.id}/runs`, { method: "POST", body: JSON.stringify({ modelRef: "openai/gpt-eval" }) });
  assert.equal(emptyRun.status, 400);

  const cases = await createDataset("alice", { name: "Cases", cases: [fields("q")] });
  const agent = await request("alice", `/datasets/${cases.id}/runs`, { method: "POST", body: JSON.stringify({ modelRef: "n8n/agent" }) });
  assert.equal(agent.status, 400);
  assert.match((await json<{ error: string }>(agent)).error, /Agents/);

  const disconnected = await request("alice", `/datasets/${cases.id}/runs`, { method: "POST", body: JSON.stringify({ modelRef: "custom-test/mock" }) });
  assert.equal(disconnected.status, 400);

  const badSampling = await request("alice", `/datasets/${cases.id}/runs`, {
    method: "POST",
    body: JSON.stringify({ modelRef: "openai/gpt-no-temp", temperature: 0.5, effort: "high" }),
  });
  assert.equal(badSampling.status, 400);
  assert.match((await json<{ error: string }>(badSampling)).error, /Temperature/);
});

test("one active run per account; cancelling frees the slot; 51 runs is the cap", async () => {
  const created = await createDataset("alice", { name: "Limits", cases: [fields("q")] });
  const first = launch(created.id).run;
  assert.throws(() => launch(created.id), /already active/);
  store.markRunCancelling("alice", first.id);
  store.finalizeQueuedCancel(first.id);
  const second = launch(created.id).run;
  assert.ok(second.id);

  db.prepare("DELETE FROM evaluation_runs").run();
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO evaluation_runs (id, user_id, dataset_id, dataset_revision, label, target_json, score_mode, concurrency,
      budget_tokens, budget_micros, state, stop_reason, total_cases, created_at, updated_at)
     VALUES (?, 'alice', ?, 1, 'old', ?, 'scale5', 1, 10000, 10000, 'done', 'completed', 1, ?, ?)`,
  );
  for (let index = 0; index < 50; index++) insert.run(`old${index}`, created.id, JSON.stringify(target()), now, now);
  assert.throws(() => launch(created.id), /old run/i);
  db.prepare("DELETE FROM evaluation_runs WHERE id = 'old0'").run();
  assert.ok(launch(created.id).run.id);
});

test("a launch over the storage quota writes nothing", async () => {
  const created = await createDataset("alice", { name: "Quota", cases: [fields("q")] });
  const before = (db.prepare("SELECT COUNT(*) AS n FROM evaluation_runs").get() as { n: number }).n;
  db.prepare("UPDATE users SET storage_limit = 1 WHERE id = 'alice'").run();
  try {
    assert.throws(() => launch(created.id), /Storage quota/);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM evaluation_runs").get() as { n: number }).n, before);
  } finally {
    db.prepare("UPDATE users SET storage_limit = NULL WHERE id = 'alice'").run();
  }
});

test("a run snapshots its target and case text; later edits change nothing", async () => {
  const created = await createDataset("alice", { name: "Snap", cases: [fields("original", { expected: "original expected", notes: "original note" })] });
  const { run } = launch(created.id);
  const before = store.getRun("alice", run.id)!;
  assert.equal(before.results[0]!.inputPreview, "original");
  assert.equal((await request("alice", `/datasets/${created.id}`, { method: "PUT", body: JSON.stringify({ expectedRevision: 1, name: "Changed", description: "" }) })).status, 200);
  assert.equal(
    (await request("alice", `/datasets/${created.id}/cases/${created.cases[0]!.caseId}`, {
      method: "PUT",
      body: JSON.stringify({ expectedRevision: 2, ...fields("rewritten", { expected: "rewritten" }) }),
    })).status,
    200,
  );
  const after = store.getRun("alice", run.id)!;
  assert.equal(after.results[0]!.inputPreview, "original");
  assert.equal(after.target.modelRef, "openai/gpt-eval");
  assert.equal(after.datasetRevision, 1);
  const view = store.getCaseView("alice", run.id, created.cases[0]!.caseId)!;
  assert.equal(view.result.case.input, "original");
  assert.equal(view.result.case.expected, "original expected");
});

test("manual scores enforce the run scale, use CAS, decrypt for the owner, and leave judge rows alone", async () => {
  const created = await createDataset("alice", { name: "Scored", cases: [fields("q")] });
  const { run } = launch(created.id);
  const caseId = created.cases[0]!.caseId;
  db.prepare("UPDATE evaluation_results SET state = 'done', output = 'answer', output_bytes = 6, updated_at = ? WHERE run_id = ? AND case_id = ?").run(Date.now(), run.id, caseId);

  const badScale = await request("alice", `/runs/${run.id}/cases/${caseId}/score`, { method: "PUT", body: JSON.stringify({ expectedRevision: 0, value: 6 }) });
  assert.equal(badScale.status, 400);

  const saved = await request("alice", `/runs/${run.id}/cases/${caseId}/score`, {
    method: "PUT",
    body: JSON.stringify({ expectedRevision: 0, value: 4, comment: "private note" }),
  });
  assert.equal(saved.status, 200);
  const score = (await json<{ score: { value: number; comment: string; revision: number } }>(saved)).score;
  assert.equal(score.value, 4);
  assert.equal(score.comment, "private note");
  assert.equal(score.revision, 1);
  assert.doesNotMatch(JSON.stringify(db.prepare("SELECT comment_enc FROM evaluation_scores").get()), /private note/);

  const stale = await request("alice", `/runs/${run.id}/cases/${caseId}/score`, {
    method: "PUT",
    body: JSON.stringify({ expectedRevision: 0, value: 5 }),
  });
  assert.equal(stale.status, 409);
  assert.equal((await json<{ score: { value: number } }>(stale)).score.value, 4);

  db.prepare(
    "INSERT INTO evaluation_scores (run_id, case_id, source, scale, value, rationale, judge_model_ref, judge_rubric_hash, revision, created_at, updated_at) VALUES (?, ?, 'judge', 'scale5', 3, 'r', 'm', 'h', 1, 1, 1)",
  ).run(run.id, caseId);
  assert.equal((await request("alice", `/runs/${run.id}/cases/${caseId}/score`, { method: "DELETE", body: JSON.stringify({ expectedRevision: 1 }) })).status, 200);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM evaluation_scores WHERE source = 'manual'").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM evaluation_scores WHERE source = 'judge'").get() as { n: number }).n, 1);
});

test("comparison refuses two datasets, unions cases, and marks a missing side null", async () => {
  const created = await createDataset("alice", { name: "Compare", cases: [fields("a"), fields("b")] });
  const other = await createDataset("alice", { name: "Other", cases: [fields("c")] });
  const first = launch(created.id).run;
  store.markRunCancelling("alice", first.id);
  store.finalizeQueuedCancel(first.id);
  const second = launch(created.id, { caseIds: [created.cases[1]!.caseId] }).run;
  store.markRunCancelling("alice", second.id);
  store.finalizeQueuedCancel(second.id);
  const third = launch(other.id).run;
  store.markRunCancelling("alice", third.id);
  store.finalizeQueuedCancel(third.id);
  const refusing = await request("alice", `/runs/${first.id}/compare/${third.id}`);
  assert.equal(refusing.status, 400);

  const comparison = await json<{ a: { id: string }; b: { id: string }; cases: Array<{ caseId: string; a: unknown; b: unknown }> }>(
    await request("alice", `/runs/${first.id}/compare/${second.id}`),
  );
  assert.equal(comparison.a.id, first.id);
  assert.equal(comparison.b.id, second.id);
  assert.equal(comparison.cases.length, 2);
  assert.ok(comparison.cases[0]!.a);
  assert.equal(comparison.cases[0]!.b, null);
  assert.ok(comparison.cases[1]!.a);
  assert.ok(comparison.cases[1]!.b);
});


test("evaluation reservations remain charged while other writes compete and results settle", async () => {
  const { storageUsed, assertStorage } = await import("../quota.js");
  const { EVAL_RESULT_RESERVATION } = await import("../../shared/evaluations.js");
  const created = await createDataset("alice", { name: "Reserved", cases: [fields("q")] });
  const before = storageUsed("alice");
  const { run } = launch(created.id);
  const reserved = storageUsed("alice");
  assert.ok(reserved - before >= EVAL_RESULT_RESERVATION, "launch must retain its output reservation");
  db.prepare("UPDATE users SET storage_limit = ? WHERE id = 'alice'").run(reserved);
  try {
    assert.throws(() => assertStorage("alice", 1), /Storage quota/);
    const caseId = created.cases[0]!.caseId;
    store.markResultRunning(run.id, caseId);
    store.settleResultSuccess(run.id, caseId, {
      output: "x".repeat(32 * 1024), outputBytes: 32 * 1024, truncated: false, finishReason: "stop",
      usage: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, latencyMs: 1,
    });
    store.saveJudgeScore(run.id, caseId, {
      score: 5, rationale: "good", modelRef: "openai/gpt-eval", rubricHash: "hash", scale: "scale5",
      usage: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0,
    });
    assert.equal(storageUsed("alice"), reserved, "settlement consumes the reservation without double charging");
    store.updateRunState(run.id, { state: "done", stopReason: "completed", errorCode: null, errorMessage: null, endedAt: Date.now() });
    store.deleteRun("alice", run.id);
    assert.equal(storageUsed("alice"), before, "deletion frees the reservation");
  } finally {
    db.prepare("UPDATE users SET storage_limit = NULL WHERE id = 'alice'").run();
  }
});
