import {
  EVAL_INPUT_PREVIEW_CHARS,
  EVAL_MAX_CASES,
  EVAL_MAX_COMMENT,
  EVAL_MAX_DATASET_BYTES,
  EVAL_MAX_DATASETS,
  EVAL_MAX_DESCRIPTION,
  EVAL_MAX_LABEL,
  EVAL_MAX_NAME,
  EVAL_MAX_OUTPUT_BYTES,
  EVAL_MAX_RUNS_PER_ACCOUNT,
  EVAL_OUTPUT_PREVIEW_CHARS,
  EVAL_RESULT_RESERVATION,
  aggregateOf,
  caseBytes,
  normalizeCaseFields,
  preview,
  type EvalAggregate,
  type EvalCase,
  type EvalCaseFields,
  type EvalCaseSnapshot,
  type EvalCaseView,
  type EvalComparison,
  type EvalDatasetDetail,
  type EvalDatasetSummary,
  type EvalJudgeConfig,
  type EvalJudgeState,
  type EvalJudgeSummary,
  type EvalProgress,
  type EvalResultDetail,
  type EvalResultState,
  type EvalResultSummary,
  type EvalRunDetail,
  type EvalRunState,
  type EvalRunSummary,
  type EvalScore,
  type EvalScoreMode,
  type EvalStopReason,
  type EvalTarget,
} from "../../shared/evaluations.js";
import type { FinishReason } from "../../shared/generation.js";
import type { TokenUsage } from "../../shared/types.js";
import { db, tx } from "../db.js";
import { decrypt, encrypt, newId } from "../crypto.js";
import { AppError } from "../errors.js";
import { assertStorage } from "../quota.js";
import type { ExportData } from "./export.js";

// Ownership-checked CRUD for evaluation datasets, cases, runs, results, and scores. Every case write
// is a revision compare-and-set on `evaluation_datasets.revision`; no dataset is ever read by a run
// after launch, because each result keeps its own case snapshot.

interface DatasetRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  revision: number;
  created_at: number;
  updated_at: number;
  case_count?: number;
  run_count?: number;
}

interface CaseRow {
  id: string;
  dataset_id: string;
  position: number;
  input: string;
  instructions: string;
  expected: string;
  notes: string;
  tags_json: string;
  created_at: number;
  updated_at: number;
}

const notFound = (what: string) => new AppError({ code: "not_found", message: `${what} not found.` });
const validation = (message: string) => new AppError({ code: "validation", message });
const conflict = (message: string) => new AppError({ code: "conflict", message });

const parseTags = (json: string): string[] => {
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
};

const summary = (row: DatasetRow): EvalDatasetSummary => ({
  id: row.id,
  name: row.name,
  description: row.description,
  revision: row.revision,
  caseCount: row.case_count ?? 0,
  runCount: row.run_count ?? 0,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toCase = (row: CaseRow): EvalCase => ({
  caseId: row.id,
  position: row.position,
  input: row.input,
  instructions: row.instructions,
  expected: row.expected,
  notes: row.notes,
  tags: parseTags(row.tags_json),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const SELECT_DATASET = `SELECT d.*,
  (SELECT COUNT(*) FROM evaluation_cases c WHERE c.dataset_id = d.id) AS case_count,
  (SELECT COUNT(*) FROM evaluation_runs r WHERE r.dataset_id = d.id) AS run_count
  FROM evaluation_datasets d`;

function datasetRow(userId: string, id: string): DatasetRow | undefined {
  return db.prepare(`${SELECT_DATASET} WHERE d.id = ? AND d.user_id = ?`).get(id, userId) as unknown as DatasetRow | undefined;
}

function datasetSummary(userId: string, id: string): EvalDatasetSummary {
  const row = datasetRow(userId, id);
  if (!row) throw notFound("Dataset");
  return summary(row);
}

function casesOf(datasetId: string): EvalCase[] {
  const rows = db.prepare("SELECT * FROM evaluation_cases WHERE dataset_id = ? ORDER BY position, id").all(datasetId) as unknown as CaseRow[];
  return rows.map(toCase);
}

export function datasetUsedBytes(cases: readonly EvalCase[]): number {
  return cases.reduce((total, item) => total + caseBytes(item), 0);
}

export function listDatasets(userId: string): EvalDatasetSummary[] {
  const rows = db
    .prepare(`${SELECT_DATASET} WHERE d.user_id = ? ORDER BY d.updated_at DESC, d.id DESC LIMIT ?`)
    .all(userId, EVAL_MAX_DATASETS) as unknown as DatasetRow[];
  return rows.map(summary);
}

export function getDataset(userId: string, id: string): EvalDatasetDetail | null {
  const row = datasetRow(userId, id);
  if (!row) return null;
  const cases = casesOf(row.id);
  return { ...summary(row), cases, usedBytes: datasetUsedBytes(cases) };
}

/** Owner-visible summary, used by conflict answers and by the run launcher. */
export function storedDatasetSummary(userId: string, id: string): EvalDatasetSummary | null {
  const row = datasetRow(userId, id);
  return row ? summary(row) : null;
}

export function createDataset(userId: string, input: { name: unknown; description?: unknown; cases?: unknown }): EvalDatasetDetail {
  const name = validateName(input.name);
  const description = validateDescription(input.description);
  const fields = validateInitialCases(input.cases);
  const count = (db.prepare("SELECT COUNT(*) AS n FROM evaluation_datasets WHERE user_id = ?").get(userId) as { n: number }).n;
  if (count >= EVAL_MAX_DATASETS) throw conflict("Delete an old dataset first.");
  const caseTotal = fields.reduce((total, item) => total + caseBytes(item), 0);
  if (caseTotal > EVAL_MAX_DATASET_BYTES) {
    throw validation(`This dataset would use ${caseTotal} bytes of the ${EVAL_MAX_DATASET_BYTES}-byte dataset limit.`);
  }
  const bytes = Buffer.byteLength(name) + Buffer.byteLength(description) + caseTotal;
  assertStorage(userId, bytes);
  const id = newId("eds");
  const now = Date.now();
  tx(() => {
    db.prepare(
      "INSERT INTO evaluation_datasets (id, user_id, name, description, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
    ).run(id, userId, name, description, now, now);
    fields.forEach((item, index) => insertCase(id, index + 1, item, now));
  });
  return getDataset(userId, id)!;
}

export function updateDataset(
  userId: string,
  id: string,
  input: { expectedRevision: unknown; name: unknown; description: unknown },
): EvalDatasetSummary {
  const expectedRevision = requireRevision(input.expectedRevision);
  const name = validateName(input.name);
  const description = validateDescription(input.description);
  return tx(() => {
    const row = datasetRow(userId, id);
    if (!row) throw notFound("Dataset");
    assertRevision(row, expectedRevision);
    const growth = Buffer.byteLength(name) + Buffer.byteLength(description) - Buffer.byteLength(row.name) - Buffer.byteLength(row.description);
    assertStorage(userId, growth);
    db.prepare("UPDATE evaluation_datasets SET name = ?, description = ?, revision = revision + 1, updated_at = ? WHERE id = ?").run(
      name,
      description,
      Date.now(),
      id,
    );
    return datasetSummary(userId, id);
  });
}

export function deleteDataset(userId: string, id: string): void {
  tx(() => {
    const row = datasetRow(userId, id);
    if (!row) throw notFound("Dataset");
    const active = (
      db.prepare("SELECT COUNT(*) AS n FROM evaluation_runs WHERE dataset_id = ? AND state IN ('queued', 'running', 'cancelling')").get(id) as { n: number }
    ).n;
    if (active > 0) throw conflict("Stop that run first.");
    db.prepare("DELETE FROM evaluation_datasets WHERE id = ?").run(id);
  });
}

export function duplicateDataset(userId: string, id: string): EvalDatasetDetail {
  const source = getDataset(userId, id);
  if (!source) throw notFound("Dataset");
  const count = (db.prepare("SELECT COUNT(*) AS n FROM evaluation_datasets WHERE user_id = ?").get(userId) as { n: number }).n;
  if (count >= EVAL_MAX_DATASETS) throw conflict("Delete an old dataset first.");
  const copyName = `${source.name} (copy)`.slice(0, EVAL_MAX_NAME);
  const bytes = Buffer.byteLength(copyName) + Buffer.byteLength(source.description) + source.usedBytes;
  assertStorage(userId, bytes);
  const copyId = newId("eds");
  const now = Date.now();
  tx(() => {
    db.prepare(
      "INSERT INTO evaluation_datasets (id, user_id, name, description, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
    ).run(copyId, userId, copyName, source.description, now, now);
    source.cases.forEach((item, index) => insertCase(copyId, index + 1, item, now));
  });
  return getDataset(userId, copyId)!;
}

export function addCase(userId: string, datasetId: string, expectedRevision: unknown, raw: unknown): { case: EvalCase; dataset: EvalDatasetSummary } {
  const revision = requireRevision(expectedRevision);
  const fields = validateFields(raw);
  return tx(() => {
    const row = datasetRow(userId, datasetId);
    if (!row) throw notFound("Dataset");
    assertRevision(row, revision);
    const cases = casesOf(datasetId);
    if (cases.length >= EVAL_MAX_CASES) throw validation(`A dataset holds at most ${EVAL_MAX_CASES} cases.`);
    assertDatasetBytes(cases, fields);
    assertStorage(userId, caseBytes(fields));
    const position = cases.length ? Math.max(...cases.map((item) => item.position)) + 1 : 1;
    const now = Date.now();
    const caseId = insertCase(datasetId, position, fields, now);
    bumpDataset(datasetId, now);
    const stored = db.prepare("SELECT * FROM evaluation_cases WHERE id = ?").get(caseId) as unknown as CaseRow;
    return { case: toCase(stored), dataset: datasetSummary(userId, datasetId) };
  });
}

export function updateCase(
  userId: string,
  datasetId: string,
  caseId: string,
  expectedRevision: unknown,
  raw: unknown,
): { case: EvalCase; dataset: EvalDatasetSummary } {
  const revision = requireRevision(expectedRevision);
  const fields = validateFields(raw);
  return tx(() => {
    const row = datasetRow(userId, datasetId);
    if (!row) throw notFound("Dataset");
    assertRevision(row, revision);
    const current = db.prepare("SELECT * FROM evaluation_cases WHERE id = ? AND dataset_id = ?").get(caseId, datasetId) as unknown as CaseRow | undefined;
    if (!current) throw notFound("Case");
    const cases = casesOf(datasetId);
    const previous = toCase(current);
    assertDatasetBytes(cases, fields, previous);
    assertStorage(userId, caseBytes(fields) - caseBytes(previous));
    const now = Date.now();
    db.prepare(
      `UPDATE evaluation_cases SET input = ?, instructions = ?, expected = ?, notes = ?, tags_json = ?, updated_at = ? WHERE id = ?`,
    ).run(fields.input, fields.instructions, fields.expected, fields.notes, JSON.stringify(fields.tags), now, caseId);
    bumpDataset(datasetId, now);
    const stored = db.prepare("SELECT * FROM evaluation_cases WHERE id = ?").get(caseId) as unknown as CaseRow;
    return { case: toCase(stored), dataset: datasetSummary(userId, datasetId) };
  });
}

export function deleteCase(userId: string, datasetId: string, caseId: string, expectedRevision: unknown): { dataset: EvalDatasetSummary } {
  const revision = requireRevision(expectedRevision);
  return tx(() => {
    const row = datasetRow(userId, datasetId);
    if (!row) throw notFound("Dataset");
    assertRevision(row, revision);
    const current = db.prepare("SELECT id FROM evaluation_cases WHERE id = ? AND dataset_id = ?").get(caseId, datasetId) as { id: string } | undefined;
    if (!current) throw notFound("Case");
    db.prepare("DELETE FROM evaluation_cases WHERE id = ?").run(caseId);
    renumber(datasetId);
    bumpDataset(datasetId, Date.now());
    return { dataset: datasetSummary(userId, datasetId) };
  });
}

export function reorderCases(
  userId: string,
  datasetId: string,
  expectedRevision: unknown,
  caseIds: unknown,
): { cases: EvalCase[]; dataset: EvalDatasetSummary } {
  const revision = requireRevision(expectedRevision);
  if (!Array.isArray(caseIds) || caseIds.some((id) => typeof id !== "string")) throw validation("That order does not match the cases.");
  const order = caseIds as string[];
  return tx(() => {
    const row = datasetRow(userId, datasetId);
    if (!row) throw notFound("Dataset");
    assertRevision(row, revision);
    const current = casesOf(datasetId);
    if (order.length !== current.length || new Set(order).size !== order.length) throw validation("That order does not match the cases.");
    const known = new Set(current.map((item) => item.caseId));
    if (order.some((id) => !known.has(id))) throw validation("That order does not match the cases.");
    const now = Date.now();
    order.forEach((id, index) => db.prepare("UPDATE evaluation_cases SET position = ?, updated_at = ? WHERE id = ?").run(index + 1, now, id));
    bumpDataset(datasetId, now);
    return { cases: casesOf(datasetId), dataset: datasetSummary(userId, datasetId) };
  });
}

function insertCase(datasetId: string, position: number, fields: EvalCaseFields, now: number): string {
  const id = newId("ecs");
  db.prepare(
    `INSERT INTO evaluation_cases (id, dataset_id, position, input, instructions, expected, notes, tags_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, datasetId, position, fields.input, fields.instructions, fields.expected, fields.notes, JSON.stringify(fields.tags), now, now);
  return id;
}

function renumber(datasetId: string): void {
  const rows = db.prepare("SELECT id FROM evaluation_cases WHERE dataset_id = ? ORDER BY position, id").all(datasetId) as unknown as Array<{ id: string }>;
  const now = Date.now();
  rows.forEach((row, index) => db.prepare("UPDATE evaluation_cases SET position = ?, updated_at = ? WHERE id = ?").run(index + 1, now, row.id));
}

function bumpDataset(datasetId: string, now: number): void {
  db.prepare("UPDATE evaluation_datasets SET revision = revision + 1, updated_at = ? WHERE id = ?").run(now, datasetId);
}

function assertRevision(row: DatasetRow, expected: number): void {
  if (row.revision !== expected) {
    throw new AppError({
      code: "conflict",
      message: "This dataset changed in another tab. Reload it.",
      details: { dataset: summary(row) },
    });
  }
}

function assertDatasetBytes(current: readonly EvalCase[], next: EvalCaseFields, replacing?: EvalCase): void {
  const total = datasetUsedBytes(current) - (replacing ? caseBytes(replacing) : 0) + caseBytes(next);
  if (total > EVAL_MAX_DATASET_BYTES) {
    throw validation(`This case would use ${total} bytes of the ${EVAL_MAX_DATASET_BYTES}-byte dataset limit.`);
  }
}

function validateName(value: unknown): string {
  if (typeof value !== "string") throw validation("Enter a dataset name.");
  const name = value.trim();
  if (name.length < 1 || name.length > EVAL_MAX_NAME) throw validation(`A dataset name is 1 to ${EVAL_MAX_NAME} characters.`);
  return name;
}

function validateDescription(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > EVAL_MAX_DESCRIPTION) throw validation(`A description is at most ${EVAL_MAX_DESCRIPTION} characters.`);
  return value;
}

function requireRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw validation("Reload this dataset before saving.");
  return value;
}

function validateFields(raw: unknown): EvalCaseFields {
  const fields = normalizeCaseFields(raw);
  if (!fields) throw validation("A case needs an input of at most 8,000 characters and fields within their limits.");
  return fields;
}

function validateInitialCases(value: unknown): EvalCaseFields[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw validation("Cases must be a list.");
  if (value.length > EVAL_MAX_CASES) throw validation(`A dataset holds at most ${EVAL_MAX_CASES} cases.`);
  return value.map(validateFields);
}

// ---------------------------------------------------------------------------------------------------
// Runs, results, and scores. Workers and routes share these, so ownership and counters live in one
// place. The launch path is in store because it needs the same CAS and limit rules as the rest.

interface RunRow {
  id: string;
  user_id: string;
  dataset_id: string;
  dataset_revision: number;
  label: string;
  target_json: string;
  score_mode: "scale5" | "pass_fail";
  concurrency: number;
  budget_tokens: number;
  budget_micros: number;
  state: EvalRunSummary["state"];
  stop_reason: EvalRunSummary["stopReason"];
  error_code: string | null;
  error_message: string | null;
  total_cases: number;
  completed_cases: number;
  failed_cases: number;
  skipped_cases: number;
  usage_json: string;
  cost: number;
  latency_total_ms: number;
  judge_json: string | null;
  judge_state: string;
  judge_done_cases: number;
  judge_failed_cases: number;
  started_at: number | null;
  ended_at: number | null;
  created_at: number;
  updated_at: number;
}

interface ResultRow {
  run_id: string;
  case_id: string;
  position: number;
  state: string;
  case_json: string;
  output: string;
  output_bytes: number;
  truncated: number;
  finish_reason: string | null;
  error_code: string | null;
  error_message: string | null;
  usage_json: string;
  cost: number;
  latency_ms: number | null;
  attempts: number;
  created_at: number;
  updated_at: number;
}

interface ScoreRow {
  run_id: string;
  case_id: string;
  source: "manual" | "judge";
  scale: "scale5" | "pass_fail";
  value: number;
  comment_enc: string | null;
  rationale: string | null;
  judge_model_ref: string | null;
  judge_rubric_hash: string | null;
  usage_json: string;
  cost: number;
  revision: number;
  created_at: number;
  updated_at: number;
}

export function runRow(userId: string, id: string): RunRow | undefined {
  return db.prepare("SELECT * FROM evaluation_runs WHERE id = ? AND user_id = ?").get(id, userId) as unknown as RunRow | undefined;
}

export function runById(id: string): RunRow | undefined {
  return db.prepare("SELECT * FROM evaluation_runs WHERE id = ?").get(id) as unknown as RunRow | undefined;
}

export function runTarget(row: RunRow): EvalTarget {
  return parseTarget(row.target_json);
}

export function runJudgeConfig(row: RunRow): EvalJudgeConfig | null {
  return parseJudge(row.judge_json);
}

export function caseSnapshot(row: ResultRow): EvalCaseSnapshot {
  return parseSnapshot(row.case_json);
}

export { conflict, notFound, validation, type RunRow, type ResultRow, type ScoreRow };

const ZERO: TokenUsage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };

const usageOf = (json: string): TokenUsage => {
  try {
    const value = JSON.parse(json) as Partial<TokenUsage>;
    return {
      input: Number(value.input) || 0,
      output: Number(value.output) || 0,
      reasoning: Number(value.reasoning) || 0,
      cacheRead: Number(value.cacheRead) || 0,
      cacheWrite: Number(value.cacheWrite) || 0,
    };
  } catch {
    return { ...ZERO };
  }
};

const parseTarget = (json: string): EvalTarget => JSON.parse(json) as EvalTarget;
const parseJudge = (json: string | null): EvalJudgeConfig | null => {
  if (!json) return null;
  try {
    return JSON.parse(json) as EvalJudgeConfig;
  } catch {
    return null;
  }
};
const parseSnapshot = (json: string): EvalCaseSnapshot => JSON.parse(json) as EvalCaseSnapshot;

function judgeCost(runId: string): number {
  return (
    db.prepare("SELECT COALESCE(SUM(cost), 0) AS cost FROM evaluation_scores WHERE run_id = ? AND source = 'judge'").get(runId) as { cost: number }
  ).cost;
}

export function runSummary(row: RunRow): EvalRunSummary {
  const config = parseJudge(row.judge_json);
  const judge: EvalJudgeSummary | null =
    config || row.judge_state !== "idle"
      ? {
          state: row.judge_state as EvalJudgeState,
          config,
          doneCases: row.judge_done_cases,
          failedCases: row.judge_failed_cases,
          cost: judgeCost(row.id),
        }
      : null;
  return {
    id: row.id,
    datasetId: row.dataset_id,
    datasetRevision: row.dataset_revision,
    label: row.label,
    target: parseTarget(row.target_json),
    scoreMode: row.score_mode,
    concurrency: row.concurrency,
    budgetTokens: row.budget_tokens,
    budgetMicros: row.budget_micros,
    state: row.state,
    stopReason: row.stop_reason,
    errorCode: (row.error_code as EvalRunSummary["errorCode"]) ?? null,
    errorMessage: row.error_message,
    totalCases: row.total_cases,
    completedCases: row.completed_cases,
    failedCases: row.failed_cases,
    skippedCases: row.skipped_cases,
    usage: usageOf(row.usage_json),
    cost: row.cost,
    latencyTotalMs: row.latency_total_ms,
    judge,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function resultSummary(row: ResultRow): EvalResultSummary {
  const snapshot = parseSnapshot(row.case_json);
  return {
    caseId: row.case_id,
    position: row.position,
    state: row.state as EvalResultState,
    inputPreview: preview(snapshot.input, EVAL_INPUT_PREVIEW_CHARS),
    tags: snapshot.tags,
    outputPreview: preview(row.output, EVAL_OUTPUT_PREVIEW_CHARS),
    outputBytes: row.output_bytes,
    truncated: row.truncated === 1,
    finishReason: (row.finish_reason as FinishReason | null) ?? null,
    errorCode: (row.error_code as EvalResultSummary["errorCode"]) ?? null,
    errorMessage: row.error_message,
    usage: usageOf(row.usage_json),
    cost: row.cost,
    latencyMs: row.latency_ms,
    attempts: row.attempts,
  };
}

function resultDetail(row: ResultRow): EvalResultDetail {
  const { inputPreview: _input, outputPreview: _output, ...rest } = resultSummary(row);
  return { ...rest, case: parseSnapshot(row.case_json), output: row.output };
}

function scoreOf(row: ScoreRow): EvalScore {
  let comment: string | undefined;
  if (row.comment_enc) {
    try {
      comment = decrypt(row.comment_enc);
    } catch {
      comment = undefined;
    }
  }
  return {
    caseId: row.case_id,
    source: row.source,
    scale: row.scale,
    value: row.value,
    ...(comment !== undefined ? { comment } : {}),
    ...(row.rationale !== null ? { rationale: row.rationale } : {}),
    ...(row.judge_model_ref !== null ? { judgeModelRef: row.judge_model_ref } : {}),
    cost: row.cost,
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

export function listRuns(userId: string, datasetId?: string, limit = 50): EvalRunSummary[] {
  const rows = datasetId
    ? (db
        .prepare("SELECT * FROM evaluation_runs WHERE user_id = ? AND dataset_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
        .all(userId, datasetId, limit) as unknown as RunRow[])
    : (db
        .prepare("SELECT * FROM evaluation_runs WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
        .all(userId, limit) as unknown as RunRow[]);
  return rows.map(runSummary);
}

export function getRun(userId: string, id: string): EvalRunDetail | null {
  const row = runRow(userId, id);
  if (!row) return null;
  const results = (
    db.prepare("SELECT * FROM evaluation_results WHERE run_id = ? ORDER BY position, case_id").all(id) as unknown as ResultRow[]
  ).map(resultSummary);
  const scores = (db.prepare("SELECT * FROM evaluation_scores WHERE run_id = ? ORDER BY case_id").all(id) as unknown as ScoreRow[]).map(scoreOf);
  return { ...runSummary(row), results, scores, aggregate: aggregateOf(results, scores) };
}

export function getRunProgress(userId: string, id: string): EvalProgress | null {
  const row = runRow(userId, id);
  if (!row) return null;
  return {
    state: row.state,
    stopReason: row.stop_reason,
    errorCode: (row.error_code as EvalProgress["errorCode"]) ?? null,
    totalCases: row.total_cases,
    completedCases: row.completed_cases,
    failedCases: row.failed_cases,
    skippedCases: row.skipped_cases,
    usage: usageOf(row.usage_json),
    cost: row.cost,
    latencyTotalMs: row.latency_total_ms,
    judgeState: row.judge_state as EvalJudgeState,
    judgeDoneCases: row.judge_done_cases,
    judgeFailedCases: row.judge_failed_cases,
    judgeCost: judgeCost(row.id),
    updatedAt: row.updated_at,
  };
}

export function getCaseView(userId: string, runId: string, caseId: string): EvalCaseView | null {
  if (!runRow(userId, runId)) return null;
  const row = db.prepare("SELECT * FROM evaluation_results WHERE run_id = ? AND case_id = ?").get(runId, caseId) as unknown as ResultRow | undefined;
  if (!row) return null;
  const scores = (db.prepare("SELECT * FROM evaluation_scores WHERE run_id = ? AND case_id = ?").all(runId, caseId) as unknown as ScoreRow[]).map(scoreOf);
  return { result: resultDetail(row), scores };
}

export interface LaunchInput {
  label: string;
  target: EvalTarget;
  scoreMode: EvalScoreMode;
  concurrency: number;
  budgetTokens: number;
  budgetMicros: number;
  caseIds?: string[];
  expectedRevision?: number;
}

const snapshotOf = (item: EvalCase): EvalCaseSnapshot => ({
  caseId: item.caseId,
  position: item.position,
  input: item.input,
  instructions: item.instructions,
  expected: item.expected,
  notes: item.notes,
  tags: item.tags,
});

export function launchRun(userId: string, datasetId: string, input: LaunchInput): { run: EvalRunSummary; snapshots: EvalCaseSnapshot[] } {
  const dataset = getDataset(userId, datasetId);
  if (!dataset) throw notFound("Dataset");
  if (input.expectedRevision !== undefined && dataset.revision !== input.expectedRevision) {
    throw new AppError({ code: "conflict", message: "This dataset changed in another tab. Reload it.", details: { dataset: storedDatasetSummary(userId, datasetId) } });
  }
  let chosen = dataset.cases;
  if (input.caseIds) {
    const wanted = new Set(input.caseIds);
    if (wanted.size !== input.caseIds.length) throw validation("Pick each case once.");
    chosen = dataset.cases.filter((item) => wanted.has(item.caseId));
    if (chosen.length !== wanted.size) throw validation("One of those cases is not in this dataset.");
  }
  if (chosen.length === 0) throw validation("Add a case before starting a run.");
  if (chosen.length > EVAL_MAX_CASES) throw validation(`A run holds at most ${EVAL_MAX_CASES} cases.`);
  const active = db
    .prepare("SELECT label FROM evaluation_runs WHERE user_id = ? AND state IN ('queued', 'running', 'cancelling')")
    .get(userId) as { label: string } | undefined;
  if (active) throw conflict(`A run is already active${active.label ? `: ${active.label}` : ""}. Stop it first.`);
  const count = (db.prepare("SELECT COUNT(*) AS n FROM evaluation_runs WHERE user_id = ?").get(userId) as { n: number }).n;
  if (count >= EVAL_MAX_RUNS_PER_ACCOUNT) throw conflict("Delete an old run first.");
  const snapshots = chosen.map(snapshotOf);
  const snapshotBytes = snapshots.reduce((total, snapshot) => total + Buffer.byteLength(JSON.stringify(snapshot)), 0);
  assertStorage(userId, snapshotBytes + snapshots.length * EVAL_RESULT_RESERVATION + 16 * 1024);
  const id = newId("evr");
  const now = Date.now();
  const label = input.label.trim().slice(0, EVAL_MAX_LABEL);
  try {
    tx(() => {
      db.prepare(
        `INSERT INTO evaluation_runs (id, user_id, dataset_id, dataset_revision, label, target_json, score_mode, concurrency,
          budget_tokens, budget_micros, state, total_cases, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
      ).run(
        id,
        userId,
        datasetId,
        dataset.revision,
        label,
        JSON.stringify(input.target),
        input.scoreMode,
        input.concurrency,
        input.budgetTokens,
        input.budgetMicros,
        snapshots.length,
        now,
        now,
      );
      for (const snapshot of snapshots) {
        db.prepare(
          `INSERT INTO evaluation_results (run_id, case_id, position, state, case_json, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
        ).run(id, snapshot.caseId, snapshot.position, JSON.stringify(snapshot), now, now);
      }
    });
  } catch (error) {
    if (/evaluation_runs/i.test(String((error as Error).message))) throw conflict("A run is already active. Stop it first.");
    throw error;
  }
  return { run: runSummary(runRow(userId, id)!), snapshots };
}

export function duplicateRun(userId: string, id: string): EvalRunSummary {
  const source = runRow(userId, id);
  if (!source) throw notFound("Run");
  const active = db
    .prepare("SELECT label FROM evaluation_runs WHERE user_id = ? AND state IN ('queued', 'running', 'cancelling')")
    .get(userId) as { label: string } | undefined;
  if (active) throw conflict("A run is already active. Stop it first.");
  const count = (db.prepare("SELECT COUNT(*) AS n FROM evaluation_runs WHERE user_id = ?").get(userId) as { n: number }).n;
  if (count >= EVAL_MAX_RUNS_PER_ACCOUNT) throw conflict("Delete an old run first.");
  const results = db.prepare("SELECT * FROM evaluation_results WHERE run_id = ? ORDER BY position, case_id").all(id) as unknown as ResultRow[];
  if (!results.length) throw validation("This run has no cases to repeat.");
  const snapshots = results.map((row) => parseSnapshot(row.case_json));
  const bytes = snapshots.reduce((total, snapshot) => total + Buffer.byteLength(JSON.stringify(snapshot)), 0);
  assertStorage(userId, bytes + snapshots.length * EVAL_RESULT_RESERVATION + 16 * 1024);
  const copyId = newId("evr");
  const now = Date.now();
  const label = `${source.label || "Run"} (copy)`.slice(0, EVAL_MAX_LABEL);
  tx(() => {
    db.prepare(
      `INSERT INTO evaluation_runs (id, user_id, dataset_id, dataset_revision, label, target_json, score_mode, concurrency,
        budget_tokens, budget_micros, state, total_cases, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
    ).run(
      copyId,
      userId,
      source.dataset_id,
      source.dataset_revision,
      label,
      source.target_json,
      source.score_mode,
      source.concurrency,
      source.budget_tokens,
      source.budget_micros,
      snapshots.length,
      now,
      now,
    );
    for (const snapshot of snapshots) {
      db.prepare(
        `INSERT INTO evaluation_results (run_id, case_id, position, state, case_json, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
      ).run(copyId, snapshot.caseId, snapshot.position, JSON.stringify(snapshot), now, now);
    }
  });
  return runSummary(runRow(userId, copyId)!);
}

export function deleteRun(userId: string, id: string): void {
  const row = runRow(userId, id);
  if (!row) throw notFound("Run");
  const judging = row.judge_state === "queued" || row.judge_state === "running";
  if (row.state === "queued" || row.state === "running" || row.state === "cancelling" || judging) throw conflict("Stop this run first.");
  db.prepare("DELETE FROM evaluation_runs WHERE id = ?").run(id);
}

export function markRunCancelling(userId: string, id: string): { state: EvalRunState; judgeState: EvalJudgeState } {
  const row = runRow(userId, id);
  if (!row) throw notFound("Run");
  if (row.state === "queued" || row.state === "running" || row.state === "cancelling") {
    if (row.state !== "cancelling") {
      db.prepare("UPDATE evaluation_runs SET state = 'cancelling', updated_at = ? WHERE id = ?").run(Date.now(), id);
    }
    return { state: "cancelling", judgeState: row.judge_state as EvalJudgeState };
  }
  if (row.judge_state === "queued" || row.judge_state === "running") {
    db.prepare("UPDATE evaluation_runs SET judge_state = 'cancelled', updated_at = ? WHERE id = ?").run(Date.now(), id);
    return { state: row.state, judgeState: "cancelled" };
  }
  throw conflict("This run already finished.");
}

/** A queued run cancelled before any worker slot picked it up. Active runs are finalized by the worker. */
export function finalizeQueuedCancel(runId: string): void {
  const now = Date.now();
  tx(() => {
    skipRemaining(runId, "aborted");
    updateRunState(runId, { state: "cancelled", stopReason: "cancelled", errorCode: null, errorMessage: null, endedAt: now });
  });
}

export function saveManualScore(
  userId: string,
  runId: string,
  caseId: string,
  input: { expectedRevision: unknown; value: unknown; comment?: unknown },
): EvalScore {
  const run = runRow(userId, runId);
  if (!run) throw notFound("Run");
  const result = db.prepare("SELECT * FROM evaluation_results WHERE run_id = ? AND case_id = ?").get(runId, caseId) as unknown as ResultRow | undefined;
  if (!result) throw notFound("Case");
  if (result.state !== "done" || result.output.length === 0) throw conflict("This case has no answer to score.");
  const value = input.value;
  if (run.score_mode === "scale5") {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 5) throw validation("A score is a whole number from 1 to 5.");
  } else if (value !== 0 && value !== 1) {
    throw validation("A score is pass or fail.");
  }
  const comment = typeof input.comment === "string" ? input.comment.trim() : "";
  if (comment.length > EVAL_MAX_COMMENT) throw validation(`A score comment is at most ${EVAL_MAX_COMMENT} characters.`);
  if (typeof input.expectedRevision !== "number" || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw validation("Reload this case before scoring.");
  }
  const now = Date.now();
  return tx(() => {
    const existing = db
      .prepare("SELECT * FROM evaluation_scores WHERE run_id = ? AND case_id = ? AND source = 'manual'")
      .get(runId, caseId) as unknown as ScoreRow | undefined;
    if (existing && existing.revision !== input.expectedRevision) {
      throw new AppError({ code: "conflict", message: "This score changed in another tab. Reload it.", details: { score: scoreOf(existing) } });
    }
    if (!existing && input.expectedRevision !== 0) {
      throw new AppError({ code: "conflict", message: "This case has no score to update. Reload it." });
    }
    const commentEnc = comment ? encrypt(comment) : null;
    const growth = Buffer.byteLength(commentEnc ?? "") - Buffer.byteLength(existing?.comment_enc ?? "");
    assertStorage(userId, growth);
    const revision = existing ? existing.revision + 1 : 1;
    db.prepare(
      `INSERT INTO evaluation_scores (run_id, case_id, source, scale, value, comment_enc, cost, revision, created_at, updated_at)
       VALUES (?, ?, 'manual', ?, ?, ?, 0, ?, ?, ?)
       ON CONFLICT (run_id, case_id, source) DO UPDATE SET value = excluded.value, comment_enc = excluded.comment_enc,
         revision = excluded.revision, updated_at = excluded.updated_at`,
    ).run(runId, caseId, run.score_mode, value, commentEnc, revision, existing?.created_at ?? now, now);
    return scoreOf(db.prepare("SELECT * FROM evaluation_scores WHERE run_id = ? AND case_id = ? AND source = 'manual'").get(runId, caseId) as unknown as ScoreRow);
  });
}

export function deleteManualScore(userId: string, runId: string, caseId: string, expectedRevision: unknown): void {
  if (!runRow(userId, runId)) throw notFound("Run");
  if (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision) || expectedRevision < 1) throw validation("Reload this case before clearing the score.");
  const existing = db
    .prepare("SELECT * FROM evaluation_scores WHERE run_id = ? AND case_id = ? AND source = 'manual'")
    .get(runId, caseId) as unknown as ScoreRow | undefined;
  if (!existing || existing.revision !== expectedRevision) {
    throw new AppError({ code: "conflict", message: "This score changed in another tab. Reload it.", ...(existing ? { details: { score: scoreOf(existing) } } : {}) });
  }
  db.prepare("DELETE FROM evaluation_scores WHERE run_id = ? AND case_id = ? AND source = 'manual'").run(runId, caseId);
}

export function queueJudge(userId: string, runId: string, config: EvalJudgeConfig): EvalJudgeSummary {
  const row = runRow(userId, runId);
  if (!row) throw notFound("Run");
  if (row.state !== "done" && row.state !== "failed" && row.state !== "cancelled") throw conflict("Wait for this run to finish.");
  if (row.judge_state === "queued" || row.judge_state === "running") throw conflict("A judge pass is already running.");
  const judgeJson = JSON.stringify(config);
  assertStorage(userId, Buffer.byteLength(judgeJson) - Buffer.byteLength(row.judge_json ?? ""));
  tx(() => {
    db.prepare("DELETE FROM evaluation_scores WHERE run_id = ? AND source = 'judge'").run(runId);
    db.prepare(
      `UPDATE evaluation_runs SET judge_json = ?, judge_state = 'queued', judge_done_cases = 0, judge_failed_cases = 0, updated_at = ? WHERE id = ?`,
    ).run(judgeJson, Date.now(), runId);
  });
  return runSummary(runRow(userId, runId)!).judge!;
}

export function getComparison(userId: string, aId: string, bId: string): EvalComparison {
  const a = runRow(userId, aId);
  const b = runRow(userId, bId);
  if (!a || !b) throw notFound("Run");
  if (a.dataset_id !== b.dataset_id) throw validation("Pick two runs of the same dataset.");
  const aResults = new Map(
    (db.prepare("SELECT * FROM evaluation_results WHERE run_id = ? ORDER BY position").all(aId) as unknown as ResultRow[]).map((row) => [row.case_id, resultSummary(row)]),
  );
  const bResults = new Map(
    (db.prepare("SELECT * FROM evaluation_results WHERE run_id = ? ORDER BY position").all(bId) as unknown as ResultRow[]).map((row) => [row.case_id, resultSummary(row)]),
  );
  const aScores = scoresByCase(aId);
  const bScores = scoresByCase(bId);
  const snapshots = new Map<string, EvalCaseSnapshot>();
  // Side A's snapshot wins, exactly as the contract says; side B fills cases A did not run.
  for (const runId of [aId, bId]) {
    for (const row of db.prepare("SELECT case_json FROM evaluation_results WHERE run_id = ? ORDER BY position").all(runId) as unknown as Array<{ case_json: string }>) {
      const snapshot = parseSnapshot(row.case_json);
      if (!snapshots.has(snapshot.caseId)) snapshots.set(snapshot.caseId, snapshot);
    }
  }
  const ids = new Set([...aResults.keys(), ...bResults.keys()]);
  const cases = [...ids]
    .map((caseId) => {
      const aResult = aResults.get(caseId) ?? null;
      const bResult = bResults.get(caseId) ?? null;
      const snapshot = snapshots.get(caseId)!;
      return {
        caseId,
        position: aResult?.position ?? bResult?.position ?? snapshot.position,
        case: snapshot,
        a: aResult,
        b: bResult,
        aScores: aScores.get(caseId) ?? [],
        bScores: bScores.get(caseId) ?? [],
      };
    })
    .sort((left, right) => left.position - right.position || left.caseId.localeCompare(right.caseId));
  return { a: runSummary(a), b: runSummary(b), cases };
}

function scoresByCase(runId: string): Map<string, EvalScore[]> {
  const map = new Map<string, EvalScore[]>();
  for (const row of db.prepare("SELECT * FROM evaluation_scores WHERE run_id = ?").all(runId) as unknown as ScoreRow[]) {
    const list = map.get(row.case_id) ?? [];
    list.push(scoreOf(row));
    map.set(row.case_id, list);
  }
  return map;
}

export function exportData(userId: string, runId: string): ExportData | null {
  const row = runRow(userId, runId);
  if (!row) return null;
  const dataset = datasetRow(userId, row.dataset_id);
  if (!dataset) return null;
  const scores = db.prepare("SELECT * FROM evaluation_scores WHERE run_id = ?").all(runId) as unknown as ScoreRow[];
  const byCase = new Map<string, { manual: EvalScore | null; judge: EvalScore | null }>();
  for (const score of scores) {
    const entry = byCase.get(score.case_id) ?? { manual: null, judge: null };
    entry[score.source] = scoreOf(score);
    byCase.set(score.case_id, entry);
  }
  const rows = db.prepare("SELECT * FROM evaluation_results WHERE run_id = ? ORDER BY position, case_id").all(runId) as unknown as ResultRow[];
  const results = rows.map((item) => {
    const detail = resultDetail(item);
    const pair = byCase.get(item.case_id) ?? { manual: null, judge: null };
    return { ...detail, manual: pair.manual, judge: pair.judge };
  });
  return {
    exportedAt: Date.now(),
    dataset: { id: dataset.id, name: dataset.name, revision: dataset.revision },
    run: runSummary(row),
    results,
    aggregate: aggregateOf(rows.map(resultSummary), scores.map(scoreOf)),
  };
}

export function runAggregate(runId: string): EvalAggregate {
  const results = (db.prepare("SELECT * FROM evaluation_results WHERE run_id = ?").all(runId) as unknown as ResultRow[]).map(resultSummary);
  const scores = (db.prepare("SELECT * FROM evaluation_scores WHERE run_id = ?").all(runId) as unknown as ScoreRow[]).map(scoreOf);
  return aggregateOf(results, scores);
}

// ---------------------------------------------------------------------------------------------------
// Worker-facing updates. Each one is a single guarded write; nothing here can change a stored `output`.

export function pendingResults(runId: string): ResultRow[] {
  return db.prepare("SELECT * FROM evaluation_results WHERE run_id = ? AND state = 'pending' ORDER BY position, case_id").all(runId) as unknown as ResultRow[];
}

export function doneResultsWithOutput(runId: string): ResultRow[] {
  return db
    .prepare("SELECT * FROM evaluation_results WHERE run_id = ? AND state = 'done' AND length(output) > 0 ORDER BY position, case_id")
    .all(runId) as unknown as ResultRow[];
}

export function markResultRunning(runId: string, caseId: string): void {
  db.prepare("UPDATE evaluation_results SET state = 'running', attempts = attempts + 1, updated_at = ? WHERE run_id = ? AND case_id = ?").run(
    Date.now(),
    runId,
    caseId,
  );
}

export function settleResultSuccess(
  runId: string,
  caseId: string,
  value: { output: string; outputBytes: number; truncated: boolean; finishReason: string | null; usage: TokenUsage; cost: number; latencyMs: number },
): void {
  const now = Date.now();
  tx(() => {
    db.prepare(
      `UPDATE evaluation_results SET state = 'done', output = ?, output_bytes = ?, truncated = ?, finish_reason = ?,
        error_code = NULL, error_message = NULL, usage_json = ?, cost = ?, latency_ms = ?, updated_at = ?
       WHERE run_id = ? AND case_id = ? AND state = 'running'`,
    ).run(
      value.output,
      value.outputBytes,
      value.truncated ? 1 : 0,
      value.finishReason,
      JSON.stringify(value.usage),
      value.cost,
      value.latencyMs,
      now,
      runId,
      caseId,
    );
    recountRun(runId, now);
  });
}

export function settleResultFailure(
  runId: string,
  caseId: string,
  value: { state: "error" | "skipped"; errorCode: string | null; errorMessage: string | null; latencyMs: number | null },
): void {
  const now = Date.now();
  tx(() => {
    db.prepare(
      `UPDATE evaluation_results SET state = ?, error_code = ?, error_message = ?, latency_ms = ?, updated_at = ?
       WHERE run_id = ? AND case_id = ? AND state IN ('pending', 'running')`,
    ).run(value.state, value.errorCode, value.errorMessage, value.latencyMs, now, runId, caseId);
    recountRun(runId, now);
  });
}

export function skipRemaining(runId: string, errorCode: string | null): void {
  const now = Date.now();
  db.prepare(
    "UPDATE evaluation_results SET state = 'skipped', error_code = ?, updated_at = ? WHERE run_id = ? AND state = 'pending'",
  ).run(errorCode, now, runId);
  recountRun(runId, now);
}

/** Counters and totals are derived from result rows, never trusted from memory. */
export function recountRun(runId: string, now = Date.now()): void {
  const counts = db.prepare("SELECT state, COUNT(*) AS n FROM evaluation_results WHERE run_id = ? GROUP BY state").all(runId) as unknown as Array<{
    state: string;
    n: number;
  }>;
  const byState = new Map(counts.map((row) => [row.state, row.n]));
  const totals = db
    .prepare(
      `SELECT COALESCE(SUM(cost), 0) AS cost,
        COALESCE(SUM(json_extract(usage_json, '$.input')), 0) AS input,
        COALESCE(SUM(json_extract(usage_json, '$.output')), 0) AS output,
        COALESCE(SUM(json_extract(usage_json, '$.reasoning')), 0) AS reasoning,
        COALESCE(SUM(json_extract(usage_json, '$.cacheRead')), 0) AS cacheRead,
        COALESCE(SUM(json_extract(usage_json, '$.cacheWrite')), 0) AS cacheWrite,
        COALESCE(SUM(COALESCE(latency_ms, 0)), 0) AS latency
       FROM evaluation_results WHERE run_id = ?`,
    )
    .get(runId) as { cost: number; input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; latency: number };
  const usage: TokenUsage = {
    input: totals.input,
    output: totals.output,
    reasoning: totals.reasoning,
    cacheRead: totals.cacheRead,
    cacheWrite: totals.cacheWrite,
  };
  db.prepare(
    `UPDATE evaluation_runs SET completed_cases = ?, failed_cases = ?, skipped_cases = ?, usage_json = ?, cost = ?,
      latency_total_ms = ?, updated_at = ? WHERE id = ?`,
  ).run(byState.get("done") ?? 0, byState.get("error") ?? 0, byState.get("skipped") ?? 0, JSON.stringify(usage), totals.cost, totals.latency, now, runId);
}

export function updateRunState(runId: string, value: { state: EvalRunState; stopReason: EvalStopReason | null; errorCode: string | null; errorMessage: string | null; startedAt?: number | null; endedAt?: number | null }): void {
  const now = Date.now();
  db.prepare(
    `UPDATE evaluation_runs SET state = ?, stop_reason = ?, error_code = ?, error_message = ?,
      started_at = COALESCE(?, started_at), ended_at = COALESCE(?, ended_at), updated_at = ? WHERE id = ?`,
  ).run(value.state, value.stopReason, value.errorCode, value.errorMessage, value.startedAt ?? null, value.endedAt ?? null, now, runId);
}

export function setRunJudgeState(runId: string, state: EvalJudgeState): void {
  db.prepare("UPDATE evaluation_runs SET judge_state = ?, updated_at = ? WHERE id = ?").run(state, Date.now(), runId);
}

export function bumpJudgeCounters(runId: string, done: number, failed: number): void {
  db.prepare("UPDATE evaluation_runs SET judge_done_cases = judge_done_cases + ?, judge_failed_cases = judge_failed_cases + ?, updated_at = ? WHERE id = ?").run(
    done,
    failed,
    Date.now(),
    runId,
  );
}

export function saveJudgeScore(
  runId: string,
  caseId: string,
  value: { score: number; rationale: string; modelRef: string; rubricHash: string; usage: TokenUsage; cost: number; scale: EvalScoreMode },
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO evaluation_scores (run_id, case_id, source, scale, value, rationale, judge_model_ref, judge_rubric_hash,
       usage_json, cost, revision, created_at, updated_at)
     VALUES (?, ?, 'judge', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT (run_id, case_id, source) DO UPDATE SET scale = excluded.scale, value = excluded.value,
       rationale = excluded.rationale, judge_model_ref = excluded.judge_model_ref, judge_rubric_hash = excluded.judge_rubric_hash,
       usage_json = excluded.usage_json, cost = excluded.cost, updated_at = excluded.updated_at`,
  ).run(runId, caseId, value.scale, value.score, value.rationale, value.modelRef, value.rubricHash, JSON.stringify(value.usage), value.cost, now, now);
}

export function judgeScoreCost(runId: string): number {
  return judgeCost(runId);
}

export function runIdsInterrupted(): string[] {
  const rows = db
    .prepare(
      "SELECT id FROM evaluation_runs WHERE state IN ('queued', 'running', 'cancelling') OR judge_state IN ('queued', 'running')",
    )
    .all() as unknown as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

export function failRunAsInterrupted(runId: string): void {
  const now = Date.now();
  tx(() => {
    const row = db.prepare("SELECT state, judge_state FROM evaluation_runs WHERE id = ?").get(runId) as { state: string; judge_state: string } | undefined;
    if (!row) return;
    if (row.state === "queued" || row.state === "running" || row.state === "cancelling") {
      db.prepare(
        `UPDATE evaluation_runs SET state = 'failed', stop_reason = 'interrupted', error_code = 'unknown',
          error_message = 'The server restarted before this run finished.', ended_at = ?, updated_at = ? WHERE id = ?`,
      ).run(now, now, runId);
      db.prepare("UPDATE evaluation_results SET state = 'skipped', updated_at = ? WHERE run_id = ? AND state IN ('pending', 'running')").run(now, runId);
    }
    if (row.judge_state === "queued" || row.judge_state === "running") {
      db.prepare("UPDATE evaluation_runs SET judge_state = 'failed', updated_at = ? WHERE id = ?").run(now, runId);
    }
    recountRun(runId, now);
  });
}

export function firstFailedResult(runId: string): { code: string; message: string | null } | null {
  const row = db.prepare("SELECT error_code, error_message FROM evaluation_results WHERE run_id = ? AND state = 'error' ORDER BY position LIMIT 1").get(runId) as
    | { error_code: string | null; error_message: string | null }
    | undefined;
  return row?.error_code ? { code: row.error_code, message: row.error_message } : null;
}

export function resultRow(runId: string, caseId: string): ResultRow | undefined {
  return db.prepare("SELECT * FROM evaluation_results WHERE run_id = ? AND case_id = ?").get(runId, caseId) as unknown as ResultRow | undefined;
}

export function runUsageTotals(runId: string): { usage: TokenUsage; cost: number } {
  const row = db.prepare("SELECT usage_json, cost FROM evaluation_runs WHERE id = ?").get(runId) as { usage_json: string; cost: number } | undefined;
  return { usage: row ? usageOf(row.usage_json) : { ...ZERO }, cost: row?.cost ?? 0 };
}
