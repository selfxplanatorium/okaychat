import assert from "node:assert/strict";
import { test } from "node:test";
import type { EvalAggregate, EvalResultDetail, EvalRunSummary, EvalScore } from "../../shared/evaluations.js";
import { defuse, exportCsv, exportFilename, exportJson, exportSlug, type ExportData } from "./export.js";

const aggregate: EvalAggregate = {
  cases: 1,
  done: 1,
  failed: 0,
  skipped: 0,
  scorable: 1,
  meanScore: 4,
  passRate: null,
  manualScored: 1,
  judgeMeanScore: null,
  judgePassRate: null,
  judged: 0,
  totalCost: 0.01,
  totalTokens: 12,
  p50LatencyMs: 100,
};

const result: EvalResultDetail = {
  caseId: "c1",
  position: 1,
  state: "done",
  case: { caseId: "c1", position: 1, input: "=SUM(1,1)", instructions: "", expected: "", notes: "", tags: ["tag"] },
  output: "line one\nline two, with \"quotes\"",
  outputBytes: 30,
  truncated: false,
  finishReason: "stop",
  errorCode: null,
  errorMessage: null,
  usage: { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  cost: 0.01,
  latencyMs: 100,
  attempts: 1,
};

const manual: EvalScore = { caseId: "c1", source: "manual", scale: "scale5", value: 4, comment: "=note", cost: 0, revision: 1, updatedAt: 1 };

const run = {
  id: "r1",
  datasetId: "d1",
  datasetRevision: 1,
  label: "Run",
  target: { modelRef: "m/m", modelName: "M", effort: null, sampling: {}, assistantPresetId: null, assistantName: null, instructions: "" },
  scoreMode: "scale5",
  concurrency: 1,
  budgetTokens: 10000,
  budgetMicros: 10000,
  state: "done",
  stopReason: "completed",
  errorCode: null,
  errorMessage: null,
  totalCases: 1,
  completedCases: 1,
  failedCases: 0,
  skippedCases: 0,
  usage: { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  cost: 0.01,
  latencyTotalMs: 100,
  judge: null,
  startedAt: 1,
  endedAt: 2,
  createdAt: 1,
  updatedAt: 2,
} satisfies EvalRunSummary;

const data: ExportData = {
  exportedAt: 1,
  dataset: { id: "d1", name: "My dataset", revision: 1 },
  run,
  results: [{ ...result, manual, judge: null }],
  aggregate,
};

test("CSV quotes separators, quotes, and newlines with CRLF rows", () => {
  const csv = exportCsv(data);
  const rows = csv.split("\r\n");
  assert.equal(rows.length, 3);
  assert.equal(rows[0]!.split(",").length, 24);
  assert.match(csv, /"line one\nline two, with ""quotes"""/);
  assert.match(csv, /'=SUM\(1,1\)/);
});

test("formula injection is defused, including case text and model output", () => {
  assert.equal(defuse("=1+1"), "'=1+1");
  assert.equal(defuse("+1"), "'+1");
  assert.equal(defuse("-1"), "'-1");
  assert.equal(defuse("@cmd"), "'@cmd");
  assert.equal(defuse("\tcmd"), "'\tcmd");
  assert.equal(defuse("'already"), "'already");
  assert.equal(defuse("plain"), "plain");
});

test("JSON round-trips, contains full output, and declares version 1", () => {
  const parsed = JSON.parse(exportJson(data)) as { version: number; results: Array<{ output: string; manual: EvalScore | null }> };
  assert.equal(parsed.version, 1);
  assert.equal(parsed.results[0]!.output, result.output);
  assert.equal(parsed.results[0]!.manual?.comment, "=note");
});

test("filename slug is safe for unicode, spaces, and punctuation", () => {
  assert.equal(exportSlug("  Ünïcode!!!  "), "n-code");
  assert.equal(exportSlug("***"), "evaluation");
  assert.match(exportFilename("My Dataset", "r1", "csv"), /^my-dataset-r1\.csv$/);
});
