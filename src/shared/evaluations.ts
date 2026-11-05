import { normalizeTags } from "./tags.js";
import type { SamplingSettings } from "./assistant-presets.js";
import type { ErrorCode } from "./errors.js";
import type { FinishReason } from "./generation.js";
import type { ReasoningEffort, TokenUsage } from "./types.js";

// Shared contract for the private evaluation workspace. Pure module: no database, no web imports, so
// the server and the browser enforce the same bounds. Evaluation turns never touch chats; see
// docs/implementation/evaluations.md.

export const EVAL_MAX_DATASETS = 50;
export const EVAL_MAX_CASES = 200;
export const EVAL_MAX_RUNS_PER_ACCOUNT = 50;
export const EVAL_MIN_CONCURRENCY = 1;
export const EVAL_MAX_CONCURRENCY = 8;
export const EVAL_DEFAULT_CONCURRENCY = 2;
export const EVAL_MAX_NAME = 80;
export const EVAL_MAX_DESCRIPTION = 500;
export const EVAL_MAX_LABEL = 80;
export const EVAL_MAX_INPUT = 8_000;
export const EVAL_MAX_INSTRUCTIONS = 8_000;
export const EVAL_MAX_EXPECTED = 8_000;
export const EVAL_MAX_NOTES = 2_000;
export const EVAL_MAX_TAGS = 10;
/** Sum of case text in one dataset, in UTF-8 bytes. A fixture, not a document store. */
export const EVAL_MAX_DATASET_BYTES = 1024 * 1024;
/** Stored per-case output cap, in UTF-8 bytes; longer answers are cut and flagged. */
export const EVAL_MAX_OUTPUT_BYTES = 32 * 1024;
export const EVAL_MAX_RUBRIC = 4_000;
/** Fixed upper bound charged per case at launch (output cap + usage, error, score columns). */
export const EVAL_RESULT_RESERVATION = 48 * 1024;
export const EVAL_MAX_LOG = 400;
export const EVAL_CASE_TIMEOUT_MS = 120_000;
/** A judge pass stops here; unjudged cases stay "not judged" rather than failing the pass. */
export const EVAL_JUDGE_BUDGET_MICROS = 2_000_000;
export const EVAL_MIN_BUDGET_MICROS = 10_000;
export const EVAL_MAX_BUDGET_MICROS = 20_000_000;
export const EVAL_DEFAULT_BUDGET_MICROS = 1_000_000;
export const EVAL_MIN_BUDGET_TOKENS = 10_000;
export const EVAL_MAX_BUDGET_TOKENS = 20_000_000;
export const EVAL_DEFAULT_BUDGET_TOKENS = 1_000_000;
/** Progress polling interval; one timer per open run view, never a global loop. */
export const EVAL_PROGRESS_POLL_MS = 1_500;
/** Single-line and preview lengths for result summaries. */
export const EVAL_INPUT_PREVIEW_CHARS = 200;
export const EVAL_OUTPUT_PREVIEW_CHARS = 400;
/** Manual score comment cap. */
export const EVAL_MAX_COMMENT = 2_000;

export type EvalScoreMode = "scale5" | "pass_fail";
export type EvalRunState = "queued" | "running" | "cancelling" | "done" | "failed" | "cancelled";
/** `interrupted` is a restart, not a model failure: the UI shows its own sentence instead of a wire error. */
export type EvalStopReason = "completed" | "budget" | "cancelled" | "error" | "interrupted";
export type EvalResultState = "pending" | "running" | "done" | "error" | "skipped";
export type EvalJudgeState = "idle" | "queued" | "running" | "done" | "failed" | "cancelled";
export type EvalScoreSource = "manual" | "judge";

export interface EvalCaseFields {
  input: string;
  instructions: string;
  expected: string;
  notes: string;
  tags: string[];
}

/** Written into each result row at launch; the run never reads the dataset again. */
export interface EvalCaseSnapshot extends EvalCaseFields {
  caseId: string;
  position: number;
}

export interface EvalCase extends EvalCaseSnapshot {
  createdAt: number;
  updatedAt: number;
}

/** Immutable per-run configuration. `modelRef` here is authoritative. */
export interface EvalTarget {
  modelRef: string;
  modelName: string;
  effort: ReasoningEffort | null;
  sampling: SamplingSettings;
  assistantPresetId: string | null;
  assistantName: string | null;
  /** Copied from the preset at launch; never re-read afterwards. */
  instructions: string;
}

export interface EvalJudgeConfig {
  modelRef: string;
  modelName: string;
  effort: ReasoningEffort | null;
  scale: EvalScoreMode;
  rubric: string;
  rubricHash: string;
}

export interface EvalUsageTotals {
  usage: TokenUsage;
  cost: number;
}

export interface EvalAggregate {
  cases: number;
  done: number;
  failed: number;
  skipped: number;
  /** Results that produced a non-empty answer and can be scored. */
  scorable: number;
  meanScore: number | null;
  passRate: number | null;
  manualScored: number;
  judgeMeanScore: number | null;
  judgePassRate: number | null;
  judged: number;
  totalCost: number;
  totalTokens: number;
  p50LatencyMs: number | null;
}

export interface EvalRunSummary {
  id: string;
  datasetId: string;
  datasetRevision: number;
  label: string;
  target: EvalTarget;
  scoreMode: EvalScoreMode;
  concurrency: number;
  budgetTokens: number;
  budgetMicros: number;
  state: EvalRunState;
  stopReason: EvalStopReason | null;
  errorCode: ErrorCode | null;
  errorMessage: string | null;
  totalCases: number;
  completedCases: number;
  failedCases: number;
  skippedCases: number;
  usage: TokenUsage;
  cost: number;
  latencyTotalMs: number;
  judge: EvalJudgeSummary | null;
  startedAt: number | null;
  endedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface EvalJudgeSummary {
  state: EvalJudgeState;
  config: EvalJudgeConfig | null;
  doneCases: number;
  failedCases: number;
  cost: number;
}

export interface EvalProgress {
  state: EvalRunState;
  stopReason: EvalStopReason | null;
  errorCode: ErrorCode | null;
  totalCases: number;
  completedCases: number;
  failedCases: number;
  skippedCases: number;
  usage: TokenUsage;
  cost: number;
  latencyTotalMs: number;
  judgeState: EvalJudgeState;
  judgeDoneCases: number;
  judgeFailedCases: number;
  judgeCost: number;
  updatedAt: number;
}

export interface EvalResultSummary {
  caseId: string;
  position: number;
  state: EvalResultState;
  /** Single line, 200 characters. */
  inputPreview: string;
  tags: string[];
  /** 400 characters; the full text comes from the case endpoint. */
  outputPreview: string;
  outputBytes: number;
  truncated: boolean;
  finishReason: FinishReason | null;
  errorCode: ErrorCode | null;
  errorMessage: string | null;
  usage: TokenUsage;
  cost: number;
  latencyMs: number | null;
  attempts: number;
}

export interface EvalResultDetail extends Omit<EvalResultSummary, "inputPreview" | "outputPreview"> {
  case: EvalCaseSnapshot;
  output: string;
}

export interface EvalScore {
  caseId: string;
  source: EvalScoreSource;
  scale: EvalScoreMode;
  value: number;
  comment?: string;
  rationale?: string;
  judgeModelRef?: string;
  cost: number;
  revision: number;
  updatedAt: number;
}

export interface EvalDatasetSummary {
  id: string;
  name: string;
  description: string;
  revision: number;
  caseCount: number;
  runCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface EvalDatasetDetail extends EvalDatasetSummary {
  cases: EvalCase[];
  /** UTF-8 bytes of all case text, against EVAL_MAX_DATASET_BYTES. */
  usedBytes: number;
}

export interface EvalRunDetail extends EvalRunSummary {
  results: EvalResultSummary[];
  scores: EvalScore[];
  aggregate: EvalAggregate;
}

export interface EvalCaseView {
  result: EvalResultDetail;
  scores: EvalScore[];
}

export interface EvalComparisonCase {
  caseId: string;
  position: number;
  /** The snapshot from side A when present, otherwise side B. */
  case: EvalCaseSnapshot;
  a: EvalResultSummary | null;
  b: EvalResultSummary | null;
  aScores: EvalScore[];
  bScores: EvalScore[];
}

export interface EvalComparison {
  a: EvalRunSummary;
  b: EvalRunSummary;
  cases: EvalComparisonCase[];
}

const utf8Bytes = (text: string): number => {
  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
};

export const utf8ByteLength = (text: string): number => utf8Bytes(text);

/** UTF-8 bytes of a case, matching the quota SQL exactly (the tag array counts as its JSON text). */
export function caseBytes(fields: EvalCaseFields): number {
  return (
    utf8Bytes(fields.input) +
    utf8Bytes(fields.instructions) +
    utf8Bytes(fields.expected) +
    utf8Bytes(fields.notes) +
    utf8Bytes(JSON.stringify(fields.tags))
  );
}

/** Validated case text; null when a field is beyond its cap or the input is empty. */
export function normalizeCaseFields(raw: unknown): EvalCaseFields | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = textOf((raw as Record<string, unknown>).input);
  const instructions = textOf((raw as Record<string, unknown>).instructions);
  const expected = textOf((raw as Record<string, unknown>).expected);
  const notes = textOf((raw as Record<string, unknown>).notes);
  if (input === null || instructions === null || expected === null || notes === null) return null;
  const trimmedInput = input.trim();
  if (trimmedInput.length < 1 || trimmedInput.length > EVAL_MAX_INPUT) return null;
  if (instructions.length > EVAL_MAX_INSTRUCTIONS) return null;
  if (expected.length > EVAL_MAX_EXPECTED) return null;
  if (notes.length > EVAL_MAX_NOTES) return null;
  const tags = normalizeTags((raw as Record<string, unknown>).tags).slice(0, EVAL_MAX_TAGS);
  return { input: trimmedInput, instructions, expected, notes, tags };
}

function textOf(value: unknown): string | null {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : null;
}

/** Cuts on a code-point boundary, never splitting a surrogate pair. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (utf8Bytes(text) <= maxBytes) return { text, truncated: false };
  let used = 0;
  let cut = "";
  for (const character of text) {
    const bytes = utf8Bytes(character);
    if (used + bytes > maxBytes) break;
    used += bytes;
    cut += character;
  }
  return { text: cut, truncated: true };
}

/** Collapses whitespace to single spaces and cuts to `maxChars` characters. */
export function preview(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  return collapsed.length > maxChars ? collapsed.slice(0, maxChars) : collapsed;
}

/** One aggregate implementation shared by the detail and comparison endpoints. */
export function aggregateOf(results: readonly EvalResultSummary[], scores: readonly EvalScore[]): EvalAggregate {
  let done = 0;
  let failed = 0;
  let skipped = 0;
  let scorable = 0;
  let totalCost = 0;
  let totalTokens = 0;
  const latencies: number[] = [];
  for (const result of results) {
    if (result.state === "done") done += 1;
    else if (result.state === "error") failed += 1;
    else if (result.state === "skipped") skipped += 1;
    if (result.state === "done" && result.outputBytes > 0) scorable += 1;
    totalCost += result.cost;
    totalTokens += result.usage.input + result.usage.output;
    if (result.state === "done" && result.latencyMs !== null) latencies.push(result.latencyMs);
  }
  const manual = scores.filter((score) => score.source === "manual");
  const judge = scores.filter((score) => score.source === "judge");
  for (const score of scores) totalCost += score.cost;
  const scale5 = manual.filter((score) => score.scale === "scale5");
  const passed = manual.filter((score) => score.scale === "pass_fail");
  const judgeScale5 = judge.filter((score) => score.scale === "scale5");
  const judgePassed = judge.filter((score) => score.scale === "pass_fail");
  latencies.sort((a, b) => a - b);
  return {
    cases: results.length,
    done,
    failed,
    skipped,
    scorable,
    meanScore: scale5.length ? scale5.reduce((sum, score) => sum + score.value, 0) / scale5.length : null,
    passRate: passed.length ? passed.filter((score) => score.value === 1).length / passed.length : null,
    manualScored: manual.length,
    judgeMeanScore: judgeScale5.length ? judgeScale5.reduce((sum, score) => sum + score.value, 0) / judgeScale5.length : null,
    judgePassRate: judgePassed.length ? judgePassed.filter((score) => score.value === 1).length / judgePassed.length : null,
    judged: judge.length,
    totalCost,
    totalTokens,
    p50LatencyMs: latencies.length ? latencies[Math.floor((latencies.length - 1) / 2)]! : null,
  };
}

export const ZERO_EVAL_USAGE: TokenUsage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
