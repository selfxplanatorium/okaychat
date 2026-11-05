import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4 } from "ai";

type LanguageModelV4CallOptions = Parameters<LanguageModelV4["doGenerate"]>[0];
import type { EvalCaseFields, EvalTarget } from "../../shared/evaluations.js";
import { AppError } from "../errors.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-evals-worker-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "evaluations-worker-test-secret-not-for-production";
writeFileSync(
  path.join(dataDir, "models-dev.json"),
  JSON.stringify({
    data: {
      openai: {
        id: "openai",
        name: "OpenAI",
        npm: "@ai-sdk/openai",
        api: "https://api.openai.com/v1",
        models: Object.fromEntries(
          ["gpt-eval", "gpt-judge", "gpt-pricey", "gpt-judge-pricey"].map((id) => [
            id,
            {
              id,
              name: id,
              tool_call: true,
              modalities: { input: ["text"], output: ["text"] },
              limit: { context: 100_000, output: 8_000 },
              ...(id.includes("pricey") ? { cost: { input: 1_000_000, output: 0 } } : {}),
            },
          ]),
        ),
      },
    },
    fetchedAt: Date.now(),
  }),
);
const { db } = await import("../db.js");
const { sha256 } = await import("../crypto.js");
const { saveConnection } = await import("../catalog/providers.js");
const { updateSettings } = await import("../settings.js");
const { writePolicy } = await import("../permissions/store.js");
const store = await import("./store.js");
const worker = await import("./worker.js");

db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('alice', 'alice@example.test', 'Alice', 'unused', 'admin', 1)").run();
db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, 'alice', ?)").run(sha256("alice"), Date.now() + 600_000);
saveConnection("alice", "openai", { apiKey: "test-key" });
updateSettings("alice", { maxSteps: 1, maxSearches: 0, webTools: false, artifacts: false, generativeUI: false, subagents: false, autoCompactAt: 0 });
after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});
afterEach(() => {
  worker.setEvaluationModelFactoryForTests(null);
});
beforeEach(() => {
  db.exec("DELETE FROM evaluation_scores; DELETE FROM evaluation_results; DELETE FROM evaluation_runs; DELETE FROM evaluation_cases; DELETE FROM evaluation_datasets; DELETE FROM permission_policies");
});
const fields = (input: string, extra: Partial<EvalCaseFields> = {}): EvalCaseFields => ({
  input,
  instructions: "",
  expected: "",
  notes: "",
  tags: [],
  ...extra,
});

const target = (modelRef = "openai/gpt-eval"): EvalTarget => ({
  modelRef,
  modelName: modelRef,
  effort: null,
  sampling: {},
  assistantPresetId: null,
  assistantName: null,
  instructions: "",
});

function dataset(cases: EvalCaseFields[], name = "Set") {
  const created = store.createDataset("alice", { name, cases });
  return created;
}

function launch(datasetId: string, options: Partial<import("./store.js").LaunchInput> = {}) {
  return store.launchRun("alice", datasetId, {
    label: "Run",
    target: target(),
    scoreMode: "scale5",
    concurrency: 1,
    budgetTokens: 1_000_000,
    budgetMicros: 1_000_000,
    ...options,
  });
}

const usage = (input = 10, output = 2) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 },
});

const answer = (text: string, input = 10, output = 2) => ({
  content: [{ type: "text" as const, text }],
  finishReason: { unified: "stop" as const, raw: "stop" },
  usage: usage(input, output),
  warnings: [],
});

function fakeModel(modelId: string, calls: LanguageModelV4CallOptions[], handler: (options: LanguageModelV4CallOptions, index: number) => Promise<unknown> | unknown) {
  return new MockLanguageModelV4({
    provider: "test",
    modelId,
    doGenerate: (async (options: LanguageModelV4CallOptions) => {
      calls.push(options);
      return handler(options, calls.length - 1);
    }) as never,
  });
}

async function waitFor(check: () => boolean, label = "condition", timeout = 8_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const waitTerminal = (runId: string, timeout = 8_000) =>
  waitFor(() => {
    const row = store.runById(runId);
    return !!row && (row.state === "done" || row.state === "failed" || row.state === "cancelled");
  }, "terminal run", timeout);

test("concurrency never exceeds the run's limit and every case finishes", async () => {
  const created = dataset(Array.from({ length: 5 }, (_, index) => fields(`case ${index}`)), "Concurrent");
  const { run } = launch(created.id, { concurrency: 2 });
  let activeCount = 0;
  let peak = 0;
  const calls: LanguageModelV4CallOptions[] = [];
  const model = fakeModel("gpt-eval", calls, async () => {
    activeCount += 1;
    peak = Math.max(peak, activeCount);
    await new Promise((resolve) => setTimeout(resolve, 20));
    activeCount -= 1;
    return answer("ok");
  });
  worker.setEvaluationModelFactoryForTests(() => model);
  worker.enqueueRun("alice", run.id);
  await waitTerminal(run.id);
  const detail = store.getRun("alice", run.id)!;
  assert.equal(detail.state, "done");
  assert.equal(detail.completedCases, 5);
  assert.equal(detail.aggregate.done, 5);
  assert.ok(peak <= 2, `peak ${peak}`);
  assert.equal(calls.length, 5);
});

test("an answer over 32 KiB is stored truncated while the provider reports full usage", async () => {
  const created = dataset([fields("long")], "Long");
  const { run } = launch(created.id);
  const calls: LanguageModelV4CallOptions[] = [];
  const long = "é".repeat(30_000);
  worker.setEvaluationModelFactoryForTests(() => fakeModel("gpt-eval", calls, () => answer(long, 40, 90)));
  worker.enqueueRun("alice", run.id);
  await waitTerminal(run.id);
  const view = store.getCaseView("alice", run.id, created.cases[0]!.caseId)!;
  assert.equal(view.result.truncated, true);
  assert.ok(view.result.outputBytes <= 32 * 1024);
  assert.equal(view.result.usage.output, 90);
  assert.ok(view.result.output.length < long.length);
});

test("expected, notes, and tags never enter the target request", async () => {
  const created = dataset([fields("the question", { instructions: "be brief", expected: "SECRET_EXPECTED", notes: "SECRET_NOTE", tags: ["secret-tag"] })], "Private");
  const { run } = launch(created.id);
  const calls: LanguageModelV4CallOptions[] = [];
  worker.setEvaluationModelFactoryForTests(() => fakeModel("gpt-eval", calls, () => answer("ok")));
  worker.enqueueRun("alice", run.id);
  await waitTerminal(run.id);
  const prompt = JSON.stringify(calls[0]!.prompt);
  assert.match(prompt, /the question/);
  assert.match(prompt, /be brief/);
  assert.doesNotMatch(prompt, /SECRET_EXPECTED|SECRET_NOTE|secret-tag/);
});

test("one failed case does not fail the run, and all failures end it with an error", async () => {
  const created = dataset([fields("bad"), fields("good")], "Partial");
  const { run } = launch(created.id, { concurrency: 1 });
  const calls: LanguageModelV4CallOptions[] = [];
  worker.setEvaluationModelFactoryForTests(() =>
    fakeModel("gpt-eval", calls, (_options, index) => {
      if (index === 0) throw Object.assign(new Error("upstream exploded"), { statusCode: 500 });
      return answer("ok");
    }),
  );
  worker.enqueueRun("alice", run.id);
  await waitTerminal(run.id);
  let detail = store.getRun("alice", run.id)!;
  assert.equal(detail.state, "done");
  assert.equal(detail.stopReason, "completed");
  assert.equal(detail.results[0]!.state, "error");
  assert.equal(detail.results[1]!.state, "done");

  const only = dataset([fields("one")], "AllFail");
  const second = launch(only.id).run;
  worker.setEvaluationModelFactoryForTests(() =>
    fakeModel("gpt-eval", [], () => {
      throw Object.assign(new Error("nope"), { statusCode: 401 });
    }),
  );
  worker.enqueueRun("alice", second.id);
  await waitTerminal(second.id);
  detail = store.getRun("alice", second.id)!;
  assert.equal(detail.state, "failed");
  assert.equal(detail.stopReason, "error");
  assert.ok(detail.errorCode);
});

test("cancelling during the second case aborts it, skips the rest, and stops calling the provider", async () => {
  const created = dataset([fields("one"), fields("two"), fields("three")], "Cancel");
  const { run } = launch(created.id, { concurrency: 1 });
  const calls: LanguageModelV4CallOptions[] = [];
  worker.setEvaluationModelFactoryForTests(() =>
    fakeModel("gpt-eval", calls, async (options, index) => {
      if (index === 1) {
        await new Promise((_resolve, reject) => {
          options.abortSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      }
      return answer("ok");
    }),
  );
  worker.enqueueRun("alice", run.id);
  await waitFor(() => calls.length >= 2, "second case started");
  assert.equal(store.markRunCancelling("alice", run.id).state, "cancelling");
  worker.cancelRunJob("alice", run.id);
  await waitTerminal(run.id);
  const detail = store.getRun("alice", run.id)!;
  assert.equal(detail.state, "cancelled");
  assert.equal(detail.stopReason, "cancelled");
  assert.equal(detail.results.filter((result) => result.state === "skipped").length, 2);
  assert.equal(calls.length, 2);
});

test("a spent cost budget skips later cases and keeps the run done", async () => {
  const created = dataset([fields("one"), fields("two")], "Budget");
  const { run } = launch(created.id, { target: target("openai/gpt-pricey"), budgetMicros: 10_000, concurrency: 1 });
  const calls: LanguageModelV4CallOptions[] = [];
  worker.setEvaluationModelFactoryForTests(() => fakeModel("gpt-pricey", calls, () => answer("ok", 100, 0)));
  worker.enqueueRun("alice", run.id);
  await waitTerminal(run.id);
  const detail = store.getRun("alice", run.id)!;
  assert.equal(detail.state, "done");
  assert.equal(detail.stopReason, "budget");
  assert.equal(detail.completedCases, 1);
  assert.equal(detail.skippedCases, 1);
  assert.equal(calls.length, 1);
});

test("a spent token budget stops the pool", async () => {
  const created = dataset([fields("one"), fields("two")], "Tokens");
  const { run } = launch(created.id, { budgetTokens: 10_000, concurrency: 1 });
  const calls: LanguageModelV4CallOptions[] = [];
  worker.setEvaluationModelFactoryForTests(() => fakeModel("gpt-eval", calls, () => answer("ok", 20_000, 0)));
  worker.enqueueRun("alice", run.id);
  await waitTerminal(run.id);
  const detail = store.getRun("alice", run.id)!;
  assert.equal(detail.state, "done");
  assert.equal(detail.stopReason, "budget");
  assert.equal(detail.skippedCases, 1);
  assert.equal(calls.length, 1);
});

test("a rate limit is retried once, and two in a row is a case error", async () => {
  const created = dataset([fields("one")], "Rate");
  const { run } = launch(created.id);
  const calls: LanguageModelV4CallOptions[] = [];
  worker.setEvaluationModelFactoryForTests(() =>
    fakeModel("gpt-eval", calls, (_options, index) => {
      if (index === 0) throw new AppError({ code: "rate_limited", message: "Slow down.", retryAfterMs: 1 });
      return answer("ok");
    }),
  );
  worker.enqueueRun("alice", run.id);
  await waitTerminal(run.id);
  let detail = store.getRun("alice", run.id)!;
  assert.equal(detail.state, "done");
  assert.equal(detail.results[0]!.attempts, 2);

  const second = dataset([fields("two")], "RateFail");
  const failed = launch(second.id).run;
  worker.setEvaluationModelFactoryForTests(() =>
    fakeModel("gpt-eval", [], () => {
      throw new AppError({ code: "rate_limited", message: "Slow down.", retryAfterMs: 1 });
    }),
  );
  worker.enqueueRun("alice", failed.id);
  await waitTerminal(failed.id);
  detail = store.getRun("alice", failed.id)!;
  assert.equal(detail.results[0]!.state, "error");
  assert.equal(detail.state, "failed");
});

test("a revoked feature stops dispatch and leaves the remaining cases skipped", async () => {
  const created = dataset([fields("one"), fields("two")], "Revoked");
  const { run } = launch(created.id, { concurrency: 1 });
  const calls: LanguageModelV4CallOptions[] = [];
  worker.setEvaluationModelFactoryForTests(() =>
    fakeModel("gpt-eval", calls, () => {
      writePolicy({ kind: "user", id: "alice" }, null, { version: 1, features: { evaluations: false } }, "alice");
      return answer("ok");
    }),
  );
  worker.enqueueRun("alice", run.id);
  await waitTerminal(run.id);
  const detail = store.getRun("alice", run.id)!;
  assert.equal(detail.state, "failed");
  assert.equal(detail.errorCode, "forbidden");
  assert.equal(detail.completedCases, 1);
  assert.equal(detail.skippedCases, 1);
  assert.equal(calls.length, 1);
});

test("a restart fails open runs honestly, skips unfinished results, and a second call is a no-op", () => {
  const created = dataset([fields("one"), fields("two")], "Crash");
  const { run } = launch(created.id);
  db.prepare("UPDATE evaluation_runs SET state = 'running', started_at = 1, judge_state = 'queued' WHERE id = ?").run(run.id);
  db.prepare("UPDATE evaluation_results SET state = 'running' WHERE run_id = ? AND position = 1").run(run.id);
  worker.initEvaluations();
  let detail = store.getRun("alice", run.id)!;
  assert.equal(detail.state, "failed");
  assert.equal(detail.stopReason, "interrupted");
  assert.match(detail.errorMessage ?? "", /restarted/);
  assert.equal(detail.results[0]!.state, "skipped");
  assert.equal(detail.results[1]!.state, "skipped");
  assert.equal(detail.judge?.state, "failed");
  const before = JSON.stringify(detail);
  worker.initEvaluations();
  detail = store.getRun("alice", run.id)!;
  assert.equal(JSON.stringify(detail), before);
});

function finishRun(runId: string, cases: Array<{ caseId: string; output: string }>) {
  for (const item of cases) {
    db.prepare(
      "UPDATE evaluation_results SET state = 'done', output = ?, output_bytes = ?, updated_at = ? WHERE run_id = ? AND case_id = ?",
    ).run(item.output, Buffer.byteLength(item.output), Date.now(), runId, item.caseId);
  }
  store.recountRun(runId);
  store.updateRunState(runId, { state: "done", stopReason: "completed", errorCode: null, errorMessage: null, endedAt: Date.now() });
}

function judgeConfig(scale: "scale5" | "pass_fail" = "scale5", modelRef = "openai/gpt-judge") {
  return { modelRef, modelName: modelRef, effort: null, scale, rubric: "Be correct.", rubricHash: "hash" };
}

test("judging scores answered cases, keeps the raw output, records judge usage, and replaces verdicts on a rerun", async () => {
  const created = dataset([fields("one"), fields("two")], "Judge");
  const { run } = launch(created.id);
  finishRun(run.id, [
    { caseId: created.cases[0]!.caseId, output: "first answer" },
    { caseId: created.cases[1]!.caseId, output: "second answer" },
  ]);
  const before = store.getCaseView("alice", run.id, created.cases[0]!.caseId)!.result.output;
  const calls: LanguageModelV4CallOptions[] = [];
  const judge = fakeModel("gpt-judge", calls, () => answer('{"score":4,"reason":"solid"}'));
  worker.setEvaluationModelFactoryForTests((ref) => (ref.includes("judge") ? judge : fakeModel("gpt-eval", [], () => answer("unused"))));
  store.queueJudge("alice", run.id, judgeConfig());
  worker.enqueueJudge("alice", run.id);
  await waitFor(() => store.runById(run.id)?.judge_state === "done", "judge done");
  let detail = store.getRun("alice", run.id)!;
  assert.equal(detail.aggregate.judged, 2);
  assert.equal(detail.aggregate.judgeMeanScore, 4);
  assert.equal(store.getCaseView("alice", run.id, created.cases[0]!.caseId)!.result.output, before);
  assert.match(JSON.stringify(calls[0]!.prompt), /untrusted_data/);
  assert.match(JSON.stringify(calls[0]!.prompt), /evaluation_output/);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM usage WHERE kind = 'evaluation_judge'").get() as { n: number }).n, 2);

  store.saveManualScore("alice", run.id, created.cases[0]!.caseId, { expectedRevision: 0, value: 5 });
  store.queueJudge("alice", run.id, judgeConfig());
  worker.setEvaluationModelFactoryForTests((ref) => (ref.includes("judge") ? fakeModel("gpt-judge", [], () => answer('{"score":2,"reason":"revised"}')) : fakeModel("gpt-eval", [], () => answer("unused"))));
  worker.enqueueJudge("alice", run.id);
  await waitFor(() => store.runById(run.id)?.judge_state === "done", "rejudge done");
  detail = store.getRun("alice", run.id)!;
  const judgeScores = detail.scores.filter((score) => score.source === "judge");
  assert.equal(judgeScores.length, 2);
  assert.equal(judgeScores[0]!.value, 2);
  assert.equal(detail.scores.filter((score) => score.source === "manual").length, 1);
});

test("a malformed judge reply leaves no score and counts a failed case", async () => {
  const created = dataset([fields("one")], "JudgeParse");
  const { run } = launch(created.id);
  finishRun(run.id, [{ caseId: created.cases[0]!.caseId, output: "answer" }]);
  const judgeUsage = () => (db.prepare("SELECT COUNT(*) AS n FROM usage WHERE kind = 'evaluation_judge'").get() as { n: number }).n;
  const usageBefore = judgeUsage();
  worker.setEvaluationModelFactoryForTests(() => fakeModel("gpt-judge", [], () => answer("not json")));
  store.queueJudge("alice", run.id, judgeConfig());
  worker.enqueueJudge("alice", run.id);
  await waitFor(() => store.runById(run.id)?.judge_state === "failed", "judge failed");
  const detail = store.getRun("alice", run.id)!;
  assert.equal(detail.judge?.failedCases, 1);
  assert.equal(detail.scores.length, 0);
  // The unusable reply was still paid for.
  assert.equal(judgeUsage(), usageBefore + 1);
});

test("malformed judge replies count against the judge cost cap", async () => {
  const created = dataset([fields("one"), fields("two")], "JudgeParseBudget");
  const { run } = launch(created.id);
  finishRun(run.id, [
    { caseId: created.cases[0]!.caseId, output: "first" },
    { caseId: created.cases[1]!.caseId, output: "second" },
  ]);
  const calls: LanguageModelV4CallOptions[] = [];
  worker.setEvaluationModelFactoryForTests(() => fakeModel("gpt-judge-pricey", calls, () => answer("not json", 100, 0)));
  store.queueJudge("alice", run.id, judgeConfig("scale5", "openai/gpt-judge-pricey"));
  worker.enqueueJudge("alice", run.id);
  await waitFor(() => store.runById(run.id)?.judge_state !== "queued" && store.runById(run.id)?.judge_state !== "running", "judge settled");
  assert.equal(calls.length, 1);
  assert.equal(worker.activeEvaluationRuns().length, 0);
});

test("a dataset cannot be deleted while one of its runs is being judged", () => {
  const created = dataset([fields("one")], "JudgeDelete");
  const { run } = launch(created.id);
  finishRun(run.id, [{ caseId: created.cases[0]!.caseId, output: "answer" }]);
  store.queueJudge("alice", run.id, judgeConfig());
  assert.throws(() => store.deleteDataset("alice", created.id), (error: unknown) => error instanceof AppError && error.code === "conflict");
  store.setRunJudgeState(run.id, "cancelled");
  store.deleteDataset("alice", created.id);
});

test("the judge cost cap stops the pass with the remaining cases unjudged", async () => {
  const created = dataset([fields("one"), fields("two")], "JudgeBudget");
  const { run } = launch(created.id);
  finishRun(run.id, [
    { caseId: created.cases[0]!.caseId, output: "first" },
    { caseId: created.cases[1]!.caseId, output: "second" },
  ]);
  const calls: LanguageModelV4CallOptions[] = [];
  worker.setEvaluationModelFactoryForTests(() => fakeModel("gpt-judge-pricey", calls, () => answer('{"score":3,"reason":"ok"}', 100, 0)));
  store.queueJudge("alice", run.id, judgeConfig("scale5", "openai/gpt-judge-pricey"));
  worker.enqueueJudge("alice", run.id);
  await waitFor(() => store.runById(run.id)?.judge_state === "done", "judge done");
  const detail = store.getRun("alice", run.id)!;
  assert.equal(detail.scores.filter((score) => score.source === "judge").length, 1);
  assert.equal(calls.length, 1);
});

test("exact-model evaluation denial blocks both generation and judge dispatch", async () => {
  const created = dataset([fields("one")], "Exact deny");
  const { run } = launch(created.id);
  const calls: LanguageModelV4CallOptions[] = [];
  worker.setEvaluationModelFactoryForTests(() => fakeModel("gpt-eval", calls, () => answer("ok")));
  writePolicy({ kind: "user", id: "alice" }, "openai/gpt-eval", { version: 1, features: { evaluations: false } }, "alice");
  worker.enqueueRun("alice", run.id);
  await waitTerminal(run.id);
  assert.equal(calls.length, 0, "a model-specific feature deny must prevent provider execution");
  assert.equal(store.getRun("alice", run.id)!.errorCode, "forbidden");

  const second = launch(created.id).run;
  finishRun(second.id, [{ caseId: created.cases[0]!.caseId, output: "answer" }]);
  store.queueJudge("alice", second.id, judgeConfig());
  writePolicy({ kind: "user", id: "alice" }, "openai/gpt-judge", { version: 1, features: { evaluations: false } }, "alice");
  worker.enqueueJudge("alice", second.id);
  await waitFor(() => ["done", "failed"].includes(store.runById(second.id)!.judge_state), "judge terminal");
  assert.equal(calls.length, 0, "judge execution follows its own model-specific feature policy");
  assert.equal(store.runById(second.id)!.judge_state, "failed");
});
