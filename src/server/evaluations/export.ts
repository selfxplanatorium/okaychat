import type { EvalAggregate, EvalResultDetail, EvalRunSummary, EvalScore } from "../../shared/evaluations.js";

// CSV/JSON serialization for one run. Pure: no database, no files. The owner downloads this file; it is
// never rendered, and every cell that begins with a spreadsheet formula character is defused.

export interface ExportRow extends EvalResultDetail {
  manual: EvalScore | null;
  judge: EvalScore | null;
}

export interface ExportData {
  exportedAt: number;
  dataset: { id: string; name: string; revision: number };
  run: EvalRunSummary;
  results: ExportRow[];
  aggregate: EvalAggregate;
}

const FORMULA_START = /^[=+\-@\t\r]/;

/** Prevents a spreadsheet from executing case text or a model answer as a formula. */
export function defuse(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = defuse(String(value));
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const HEADER = [
  "case",
  "position",
  "tags",
  "input",
  "instructions",
  "expected",
  "output",
  "state",
  "error_code",
  "error_message",
  "latency_ms",
  "input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "cost",
  "finish_reason",
  "manual_score",
  "manual_comment",
  "judge_score",
  "judge_rationale",
  "judge_model",
  "truncated",
];

export function exportCsv(data: ExportData): string {
  const lines = [HEADER.join(",")];
  for (const row of data.results) {
    lines.push(
      [
        row.case.caseId,
        row.position,
        row.case.tags.join(" "),
        row.case.input,
        row.case.instructions,
        row.case.expected,
        row.output,
        row.state,
        row.errorCode,
        row.errorMessage,
        row.latencyMs,
        row.usage.input,
        row.usage.output,
        row.usage.reasoning,
        row.usage.cacheRead,
        row.usage.cacheWrite,
        row.cost,
        row.finishReason,
        row.manual?.value ?? null,
        row.manual?.comment ?? null,
        row.judge?.value ?? null,
        row.judge?.rationale ?? null,
        row.judge?.judgeModelRef ?? null,
        row.truncated ? 1 : 0,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

export function exportJson(data: ExportData): string {
  return JSON.stringify(
    {
      version: 1,
      exportedAt: data.exportedAt,
      dataset: data.dataset,
      run: data.run,
      results: data.results.map((row) => ({
        ...row,
        manual: row.manual,
        judge: row.judge,
      })),
      aggregate: data.aggregate,
    },
    null,
    2,
  );
}

/** Lowercase, non-alphanumerics collapsed to dashes, at most 40 characters, never empty. */
export function exportSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "evaluation";
}

export function exportFilename(datasetName: string, runId: string, ext: "csv" | "json"): string {
  return `${exportSlug(datasetName)}-${runId}.${ext}`;
}
