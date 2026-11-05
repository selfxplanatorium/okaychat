import { useMemo, useState } from "react";
import type { EvalResultSummary, EvalRunDetail, EvalScore } from "@shared/evaluations";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { t, type PlainMessageKey } from "@/i18n";
import { formatCost, formatDuration, formatNumber, formatTokens } from "@/i18n/format";

type Filter = "all" | "done" | "error" | "skipped" | "unscored";

export function stateKey(state: EvalResultSummary["state"]): "statusQueued" | "statusRunning" | "statusDone" | "statusFailed" | "statusCancelled" {
  if (state === "pending") return "statusQueued";
  if (state === "running") return "statusRunning";
  if (state === "done") return "statusDone";
  if (state === "error") return "statusFailed";
  return "statusCancelled";
}

export function stateLabel(state: string): string {
  const map: Record<string, PlainMessageKey> = {
    queued: "evaluations.statusQueued",
    running: "evaluations.statusRunning",
    cancelling: "evaluations.statusCancelling",
    done: "evaluations.statusDone",
    failed: "evaluations.statusFailed",
    cancelled: "evaluations.statusCancelled",
  };
  return t(map[state] ?? "evaluations.statusDone");
}

export function StateChip({ state, active = false }: { state: string; active?: boolean }) {
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-[0.7rem] font-medium ${active ? "depth-row-active" : "bg-muted text-muted-foreground"}`}>{stateLabel(state)}</span>;
}

export function ResultsTable({ run, onOpen }: { run: EvalRunDetail; onOpen: (caseId: string) => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [tag, setTag] = useState("");
  const [search, setSearch] = useState("");
  const tags = useMemo(() => [...new Set(run.results.flatMap((result) => result.tags))].sort(), [run.results]);
  const manual = useMemo(() => new Map(run.scores.filter((score) => score.source === "manual").map((score) => [score.caseId, score])), [run.scores]);
  const judge = useMemo(() => new Map(run.scores.filter((score) => score.source === "judge").map((score) => [score.caseId, score])), [run.scores]);
  const rows = run.results.filter((result) => {
    if (filter === "unscored" && (manual.has(result.caseId) || judge.has(result.caseId))) return false;
    if (filter !== "all" && filter !== "unscored" && result.state !== filter) return false;
    if (tag && !result.tags.includes(tag)) return false;
    if (search) {
      const haystack = `${result.inputPreview} ${result.outputPreview}`.toLowerCase();
      if (!haystack.includes(search.toLowerCase())) return false;
    }
    return true;
  });

  return (
    <section className="bg-card border-border flex min-h-0 flex-col rounded-xl border shadow-[var(--depth-highlight),var(--shadow-raised)]">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <h2 className="text-sm font-semibold">{t("evaluations.resultsTitle")}</h2>
        <div className="ms-auto flex flex-wrap items-center gap-2">
          <Select
            aria-label={t("evaluations.filterState")}
            value={filter}
            onValueChange={(value) => setFilter(value as Filter)}
            className="w-32"
            options={[
              { value: "all", label: t("evaluations.filterAll") },
              { value: "done", label: t("evaluations.filterDone") },
              { value: "error", label: t("evaluations.filterError") },
              { value: "skipped", label: t("evaluations.filterSkipped") },
              { value: "unscored", label: t("evaluations.filterUnscored") },
            ]}
          />
          {tags.length > 0 && (
            <Select
              aria-label={t("evaluations.filterTag")}
              value={tag || "__all"}
              onValueChange={(value) => setTag(value === "__all" ? "" : value)}
              className="w-32"
              options={[{ value: "__all", label: t("evaluations.filterAll") }, ...tags.map((value) => ({ value, label: value }))]}
            />
          )}
          <Input aria-label={t("evaluations.searchCases")} className="w-44" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("evaluations.searchCasesPlaceholder")} />
        </div>
      </div>
      {!run.results.length ? (
        <p className="text-muted-foreground p-6 text-sm">{t("evaluations.resultsEmpty")}</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-x-auto">
          <table className="w-full min-w-[46rem] text-left text-xs">
            <thead className="bg-muted/60 sticky top-0 z-10">
              <tr>
                {[t("evaluations.columnCase"), t("evaluations.columnInput"), t("evaluations.columnState"), t("evaluations.columnLatency"), t("evaluations.columnTokens"), t("evaluations.columnCost"), t("evaluations.columnManual"), t("evaluations.columnJudge")].map((label) => (
                  <th key={label} scope="col" className="text-muted-foreground px-3 py-2 font-medium whitespace-nowrap">{label}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-border divide-y">
              {rows.map((result) => (
                <tr key={result.caseId} tabIndex={0} className="hover:bg-muted/50 focus-visible:outline-ring cursor-pointer" onClick={() => onOpen(result.caseId)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(result.caseId); } }}>
                  <td className="px-3 py-2 tabular-nums">{result.position}</td>
                  <td className="max-w-72 px-3 py-2">
                    <span className="block truncate" title={result.inputPreview}>{result.inputPreview}</span>
                    {!!result.tags.length && <span className="mt-1 flex flex-wrap gap-1">{result.tags.map((value) => <span key={value} className="bg-muted rounded px-1.5 py-0.5 text-[0.65rem]">{value}</span>)}</span>}
                  </td>
                  <td className="px-3 py-2"><StateChip state={result.state} active={result.state === "running"} /></td>
                  <td className="px-3 py-2 tabular-nums">{result.latencyMs === null ? "—" : formatDuration(result.latencyMs / 1000)}</td>
                  <td className="px-3 py-2 tabular-nums">{formatTokens(result.usage.input + result.usage.output)}</td>
                  <td className="px-3 py-2 tabular-nums">{formatCost(result.cost)}</td>
                  <td className="px-3 py-2"><ScoreChip score={manual.get(result.caseId)} /></td>
                  <td className="px-3 py-2"><ScoreChip score={judge.get(result.caseId)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <p className="text-muted-foreground p-6 text-sm">{t("evaluations.filterEmpty")}</p>}
        </div>
      )}
    </section>
  );
}

function ScoreChip({ score }: { score: EvalScore | undefined }) {
  if (!score) return <span className="text-muted-foreground">—</span>;
  return <span className="bg-muted inline-flex rounded px-1.5 py-0.5 tabular-nums">{formatNumber(score.value)}</span>;
}
