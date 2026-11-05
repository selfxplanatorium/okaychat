import { useEffect, useState } from "react";
import { ArrowLeftIcon, DownloadIcon } from "lucide-react";
import type { EvalCaseView, EvalComparison, EvalComparisonCase, EvalRunSummary } from "@shared/evaluations";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { t } from "@/i18n";
import { formatCost, formatDuration, formatNumber } from "@/i18n/format";
import { useEvaluations } from "@/state/evaluations";
import { StateChip } from "./ResultsTable";

export function CompareRuns({ a, b, onBack, onChangeB }: { a: string; b: string; onBack: () => void; onChangeB: (id: string) => void }) {
  const comparison = useEvaluations((state) => state.comparison);
  const status = useEvaluations((state) => state.status);
  const error = useEvaluations((state) => state.error);
  const runs = useEvaluations((state) => state.runs);
  const [openCase, setOpenCase] = useState<EvalComparisonCase | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    if (a && b) void useEvaluations.getState().loadComparison(a, b);
  }, [a, b]);

  if (!a || !b) {
    return (
      <div className="space-y-3 p-4">
        <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeftIcon /> {t("evaluations.back")}</Button>
        <p className="text-muted-foreground text-sm">{t("evaluations.comparePickTwo")}</p>
      </div>
    );
  }
  if (status === "error" || (!comparison && status !== "loading")) {
    return (
      <div className="space-y-3 p-4">
        <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeftIcon /> {t("evaluations.back")}</Button>
        <p role="alert" className="text-sm">{error ?? t("evaluations.loadFailed")}</p>
        <Button size="sm" variant="outline" onClick={() => void useEvaluations.getState().loadComparison(a, b)}>{t("evaluations.retry")}</Button>
      </div>
    );
  }
  if (!comparison) return <p role="status" className="text-muted-foreground p-4 text-sm">{t("common.loading")}</p>;

  const options = runs.filter((run) => run.datasetId === comparison.a.datasetId && run.id !== comparison.a.id);
  const meanA = manualMean(comparison.cases.flatMap((item) => item.aScores));
  const meanB = manualMean(comparison.cases.flatMap((item) => item.bScores));
  const delta = meanA === null || meanB === null ? null : meanB - meanA;
  const deltaText =
    delta === null
      ? t("evaluations.compareDeltaNone")
      : delta > 0
        ? t("evaluations.compareDeltaUp", { value: `+${formatNumber(delta)}` })
        : delta < 0
          ? t("evaluations.compareDeltaDown", { value: formatNumber(delta) })
          : t("evaluations.compareSame", { value: formatNumber(delta) });
  const exportRun = async (runId: string, format: "csv" | "json") => {
    const key = `${runId}:${format}`;
    setExporting(key);
    setExportError(null);
    try {
      const response = await fetch(`/api/evaluations/runs/${runId}/export?format=${format}`, { credentials: "same-origin" });
      if (!response.ok) throw new Error(t("evaluations.exportFailed"));
      const disposition = response.headers.get("content-disposition") ?? "";
      const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `evaluation-${runId}.${format}`;
      const url = URL.createObjectURL(await response.blob());
      Object.assign(document.createElement("a"), { href: url, download: name }).click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setExportError(t("evaluations.exportFailed"));
    } finally {
      setExporting(null);
    }
  };
  return (
    <div className="flex min-h-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeftIcon /> {t("evaluations.back")}</Button>
        <h2 className="text-base font-semibold">{t("evaluations.compareTitle")}</h2>
        <span className="text-muted-foreground text-xs">{t("evaluations.compareIntro")}</span>
        <div className="ms-auto flex items-center gap-2">
          <span className="text-muted-foreground text-xs">{t("evaluations.compareRunB")}</span>
          <Select aria-label={t("evaluations.compareRunB")} value={comparison.b.id} onValueChange={onChangeB} className="w-56" options={options.map((run) => ({ value: run.id, label: `${run.label || run.id} · ${run.target.modelName}` }))} />
        </div>
      </div>
      <p className="text-muted-foreground text-xs">{t("evaluations.columnManual")}: {deltaText}</p>
      {exportError && <p role="alert" className="text-destructive text-xs">{exportError}</p>}
      <div className="grid gap-3 lg:grid-cols-2">
        <Side run={comparison.a} mean={meanA} onExport={(format) => void exportRun(comparison.a.id, format)} exporting={exporting?.startsWith(comparison.a.id) ? exporting : null} />
        <Side run={comparison.b} mean={meanB} onExport={(format) => void exportRun(comparison.b.id, format)} exporting={exporting?.startsWith(comparison.b.id) ? exporting : null} />
      </div>
      <section className="bg-card border-border overflow-x-auto rounded-xl border shadow-[var(--depth-highlight),var(--shadow-raised)]">
        <table className="w-full min-w-[48rem] text-left text-xs">
          <thead className="bg-muted/60">
            <tr>
              <th scope="col" className="text-muted-foreground px-3 py-2">{t("evaluations.columnCase")}</th>
              <th scope="col" className="text-muted-foreground px-3 py-2">{comparison.a.target.modelName}</th>
              <th scope="col" className="text-muted-foreground px-3 py-2">{comparison.b.target.modelName}</th>
            </tr>
          </thead>
          <tbody className="divide-border divide-y">
            {comparison.cases.map((item) => (
              <tr key={item.caseId} tabIndex={0} className="hover:bg-muted/50 focus-visible:outline-ring cursor-pointer" onClick={() => setOpenCase(item)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpenCase(item); } }}>
                <td className="max-w-64 px-3 py-2">
                  <span className="text-muted-foreground me-2 tabular-nums">{item.position}</span>
                  <span className="truncate">{item.case.input}</span>
                </td>
                <CompareCell result={item.a} side="a" />
                <CompareCell result={item.b} side="b" />
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <CaseCompareDialog comparison={comparison} item={openCase} onClose={() => setOpenCase(null)} />
    </div>
  );
}

function manualMean(scores: EvalComparisonCase["aScores"]): number | null {
  const values = scores.filter((score) => score.source === "manual" && score.scale === "scale5").map((score) => score.value);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function Side({ run, mean, onExport, exporting }: { run: EvalRunSummary; mean: number | null; onExport: (format: "csv" | "json") => void; exporting: string | null }) {
  return (
    <div className="bg-card border-border rounded-xl border p-3 text-xs shadow-[var(--depth-highlight),var(--shadow-raised)]">
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-medium">{run.label || run.id}</span>
        <StateChip state={run.state} active={run.state === "running"} />
      </div>
      <p className="text-muted-foreground mt-1">{run.target.modelName}{run.target.effort ? ` · ${run.target.effort}` : ""}</p>
      <p className="text-muted-foreground mt-1">
        {t("evaluations.columnManual")}: {mean === null ? "—" : formatNumber(mean)} · {t("evaluations.columnCost")}: {formatCost(run.cost)}
      </p>
      <div className="mt-2 flex gap-2">
        <Button size="sm" variant="ghost" disabled={exporting !== null} onClick={() => onExport("csv")}><DownloadIcon /> {exporting === `${run.id}:csv` ? t("evaluations.exporting") : t("evaluations.exportCsv")}</Button>
        <Button size="sm" variant="ghost" disabled={exporting !== null} onClick={() => onExport("json")}><DownloadIcon /> {exporting === `${run.id}:json` ? t("evaluations.exporting") : t("evaluations.exportJson")}</Button>
      </div>
    </div>
  );
}

function CompareCell({ result, side }: { result: EvalComparisonCase["a"]; side: "a" | "b" }) {
  if (!result) return <td className="text-muted-foreground px-3 py-2">{side === "a" ? t("evaluations.compareOnlyInB") : t("evaluations.compareOnlyInA")}</td>;
  return (
    <td className="px-3 py-2">
      <div className="flex flex-wrap items-center gap-1">
        <StateChip state={result.state} />
        {result.latencyMs !== null && <span className="text-muted-foreground">{formatDuration(result.latencyMs / 1000)}</span>}
        <span className="text-muted-foreground">{formatCost(result.cost)}</span>
      </div>
      <p className="text-muted-foreground mt-1 line-clamp-2">{result.outputPreview || t("evaluations.caseOutputEmpty")}</p>
    </td>
  );
}

function CaseCompareDialog({ comparison, item, onClose }: { comparison: EvalComparison; item: EvalComparisonCase | null; onClose: () => void }) {
  const [a, setA] = useState<EvalCaseView | null>(null);
  const [b, setB] = useState<EvalCaseView | null>(null);
  const [tab, setTab] = useState<"a" | "b">("a");
  useEffect(() => {
    if (!item) return;
    setA(null);
    setB(null);
    setTab("a");
    let live = true;
    void Promise.all([
      item.a ? api<EvalCaseView>(`/evaluations/runs/${comparison.a.id}/cases/${item.caseId}`) : Promise.resolve(null),
      item.b ? api<EvalCaseView>(`/evaluations/runs/${comparison.b.id}/cases/${item.caseId}`) : Promise.resolve(null),
    ]).then(([nextA, nextB]) => { if (live) { setA(nextA); setB(nextB); } }).catch(() => {});
    return () => { live = false; };
  }, [item, comparison.a.id, comparison.b.id]);
  return (
    <Dialog open={!!item} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[min(90dvh,54rem)] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t("evaluations.caseDetailTitle")}</DialogTitle>
          <DialogDescription>{item?.case.input}</DialogDescription>
        </DialogHeader>
        <div role="tablist" aria-label={t("evaluations.compareTitle")} className="flex gap-2 lg:hidden">
          {(["a", "b"] as const).map((side, index) => (
            <Button
              key={side}
              role="tab"
              aria-selected={tab === side}
              tabIndex={tab === side ? 0 : -1}
              variant={tab === side ? "default" : "outline"}
              size="sm"
              onClick={() => setTab(side)}
              onKeyDown={(event) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const next = event.key === "Home" ? "a" : event.key === "End" ? "b" : index === 0 ? "b" : "a";
                setTab(next);
                document.getElementById(`compare-tab-${next}`)?.focus();
              }}
              id={`compare-tab-${side}`}
            >
              {side === "a" ? comparison.a.target.modelName : comparison.b.target.modelName}
            </Button>
          ))}
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <CompareOutput title={comparison.a.target.modelName} view={a} side="a" hidden={tab !== "a"} />
          <CompareOutput title={comparison.b.target.modelName} view={b} side="b" hidden={tab !== "b"} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CompareOutput({ title, view, side, hidden }: { title: string; view: EvalCaseView | null; side: "a" | "b"; hidden: boolean }) {
  return (
    <section className={hidden ? "hidden lg:block" : ""} aria-label={title}>
      <h3 className="text-sm font-medium">{title}</h3>
      {!view ? (
        <p className="text-muted-foreground mt-1 text-xs">{side === "a" ? t("evaluations.compareMissingA") : t("evaluations.compareMissingB")}</p>
      ) : (
        <div className="mt-1 space-y-2">
          <pre className="bg-muted/50 max-h-64 overflow-auto rounded-lg border p-2.5 text-xs whitespace-pre-wrap break-words">{view.result.output || t("evaluations.caseOutputEmpty")}</pre>
          <p className="text-muted-foreground text-xs">{t("evaluations.columnManual")}: {view.scores.find((score) => score.source === "manual")?.value ?? "—"} · {t("evaluations.columnJudge")}: {view.scores.find((score) => score.source === "judge")?.value ?? "—"}</p>
        </div>
      )}
    </section>
  );
}
