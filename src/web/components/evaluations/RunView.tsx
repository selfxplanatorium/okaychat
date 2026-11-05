import { useEffect, useState } from "react";
import { ArrowLeftIcon, DownloadIcon, GitCompareArrowsIcon, SquareIcon, Trash2Icon } from "lucide-react";
import type { EvalDatasetDetail, EvalRunDetail, EvalRunSummary, EvalScoreMode } from "@shared/evaluations";
import { EVAL_PROGRESS_POLL_MS } from "@shared/evaluations";
import { isAgentTarget } from "@shared/n8n-agents";
import { ModelSelect } from "@/components/chat/ModelPicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useCommand } from "@/keyboard/registry";
import { t } from "@/i18n";
import { formatCost, formatDuration, formatNumber, formatTokens } from "@/i18n/format";
import { useData } from "@/state/data";
import { useEvaluations } from "@/state/evaluations";
import { CaseDetail } from "./CaseDetail";
import { ResultsTable, StateChip } from "./ResultsTable";

const activeState = (state: string) => state === "queued" || state === "running" || state === "cancelling";
const activeJudge = (state: string) => state === "queued" || state === "running";

export function RunView({ runId, dataset, onBack, onOpenRun, onCompare }: { runId: string; dataset: EvalDatasetDetail | null; onBack: () => void; onOpenRun: (id: string) => void; onCompare: (otherId: string) => void }) {
  const run = useEvaluations((state) => state.run);
  const progress = useEvaluations((state) => state.progress);
  const status = useEvaluations((state) => state.status);
  const error = useEvaluations((state) => state.error);
  const actionError = useEvaluations((state) => state.actionError);
  const runs = useEvaluations((state) => state.runs);
  const saving = useEvaluations((state) => state.saving);
  const [openCase, setOpenCase] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [judging, setJudging] = useState(false);
  const [exporting, setExporting] = useState<"csv" | "json" | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [tick, setTick] = useState(Date.now());

  useEffect(() => {
    setOpenCase(null);
    setComparing(false);
    setConfirmDelete(false);
    setJudging(false);
    setStopped(false);
    void useEvaluations.getState().loadRun(runId);
  }, [runId]);

  const polling = !!progress && (activeState(progress.state) || activeJudge(progress.judgeState));
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => void useEvaluations.getState().pollRun(runId), EVAL_PROGRESS_POLL_MS);
    return () => clearInterval(timer);
  }, [polling, runId]);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [polling]);

  useCommand("evaluations.stopRun", () => void stopRun(), !!progress && (activeState(progress.state) || activeJudge(progress.judgeState)));
  useCommand("evaluations.refreshRun", () => void useEvaluations.getState().loadRun(runId), !polling);

  const stopRun = async () => {
    await useEvaluations.getState().cancelRun(runId);
    setStopped(true);
  };
  const download = async (format: "csv" | "json") => {
    setExporting(format);
    setExportError(null);
    try {
      const response = await fetch(`/api/evaluations/runs/${runId}/export?format=${format}`, { credentials: "same-origin" });
      if (!response.ok) throw new Error(t("evaluations.exportFailed"));
      const disposition = response.headers.get("content-disposition") ?? "";
      const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `evaluation-${runId}.${format}`;
      const url = URL.createObjectURL(await response.blob());
      Object.assign(document.createElement("a"), { href: url, download: name }).click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) {
      setExportError((failure as Error).message);
    } finally {
      setExporting(null);
    }
  };

  if (!run || run.id !== runId) {
    return (
      <div className="space-y-3 p-4">
        <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeftIcon /> {t("evaluations.back")}</Button>
        {status === "error" ? (
          <div role="alert" className="space-y-2 text-sm">
            <p>{error ?? t("evaluations.loadFailed")}</p>
            <Button size="sm" variant="outline" onClick={() => void useEvaluations.getState().loadRun(runId)}>{t("evaluations.retry")}</Button>
          </div>
        ) : (
          <p role="status" className="text-muted-foreground text-sm">{t("evaluations.resultsLoading")}</p>
        )}
      </div>
    );
  }

  const state = progress?.state ?? run.state;
  const judgeState = progress?.judgeState ?? run.judge?.state ?? "idle";
  const completed = progress?.completedCases ?? run.completedCases;
  const failed = progress?.failedCases ?? run.failedCases;
  const skipped = progress?.skippedCases ?? run.skippedCases;
  const usable = state === "done" || state === "failed" || state === "cancelled";
  const stopReason = progress?.stopReason ?? run.stopReason;
  const elapsedEnd = run.endedAt ?? tick;
  const elapsed = run.startedAt ? Math.max(0, (elapsedEnd - run.startedAt) / 1000) : 0;
  const budget = run.budgetMicros / 1_000_000;
  const percent = run.totalCases ? Math.round((completed / run.totalCases) * 100) : 0;
  const otherRuns = runs.filter((item) => item.id !== run.id && item.datasetId === run.datasetId);

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <section className="bg-card border-border space-y-3 rounded-xl border p-4 shadow-[var(--depth-highlight),var(--shadow-raised)]">
        <div className="flex flex-wrap items-start gap-2">
          <Button variant="ghost" size="sm" className="pointer-coarse:min-h-11" onClick={onBack}><ArrowLeftIcon /> {t("evaluations.back")}</Button>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-base font-semibold">{run.label || t("evaluations.runsTitle")}</h2>
              <StateChip state={state} active={activeState(state)} />
            </div>
            <p className="text-muted-foreground mt-1 text-xs">
              {run.target.modelName}
              {run.target.effort ? ` · ${run.target.effort}` : ""}
              {run.target.assistantName ? ` · ${run.target.assistantName}` : ""}
            </p>
          </div>
          {(activeState(state) || activeJudge(judgeState)) && (
            <Button variant="destructive" size="sm" className="pointer-coarse:min-h-11" onClick={() => void stopRun()}>
              <SquareIcon /> {t("evaluations.stopRun")}
            </Button>
          )}
        </div>

        {stopped && <p role="status" className="text-xs">{t("evaluations.runStopped")}</p>}
        <div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span>{t("evaluations.progressCases", { done: formatNumber(completed), total: formatNumber(run.totalCases) })}</span>
            <span className="text-muted-foreground">
              {t("evaluations.progressFailed", { count: failed })} · {t("evaluations.progressSkipped", { count: skipped })}
            </span>
          </div>
          <div role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label={t("evaluations.progressCases", { done: String(completed), total: String(run.totalCases) })} className="bg-muted mt-1.5 h-2 overflow-hidden rounded-full">
            <div className="bg-primary h-full transition-[width] duration-(--motion-base) ease-out-quart" style={{ width: `${percent}%` }} />
          </div>
        </div>
        <dl className="text-muted-foreground grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <Stat label={t("evaluations.elapsed")} value={formatDuration(elapsed)} />
          <Stat label={t("evaluations.spend", { cost: formatCost(progress?.cost ?? run.cost), budget: formatCost(budget) })} value={formatCost(progress?.cost ?? run.cost)} />
          <Stat label={t("evaluations.tokens")} value={formatTokens((progress?.usage.input ?? 0) + (progress?.usage.output ?? 0))} />
          <Stat label={t("evaluations.concurrency")} value={formatNumber(run.concurrency)} />
        </dl>
        {stopReason && (
          <p className="text-xs">
            {stopReason === "budget"
              ? t("evaluations.stopReasonBudget", { cost: formatCost(budget) })
              : stopReason === "interrupted"
                ? t("evaluations.stopReasonInterrupted")
                : stopReason === "cancelled"
                  ? t("evaluations.stopReasonCancelled")
                  : stopReason === "error"
                    ? t("evaluations.stopReasonError")
                    : t("evaluations.stopReasonCompleted")}
          </p>
        )}
        {run.errorCode && <p className="text-destructive text-xs">{run.errorMessage ?? run.errorCode}</p>}
        {actionError && <p role="alert" className="text-destructive text-xs">{actionError}</p>}
        {exportError && <p role="alert" className="text-destructive text-xs">{exportError}</p>}

        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={exporting !== null} onClick={() => void download("csv")}><DownloadIcon /> {exporting === "csv" ? t("evaluations.exporting") : t("evaluations.exportCsv")}</Button>
          <Button size="sm" variant="outline" disabled={exporting !== null} onClick={() => void download("json")}><DownloadIcon /> {exporting === "json" ? t("evaluations.exporting") : t("evaluations.exportJson")}</Button>
          <Button size="sm" variant="outline" disabled={saving} onClick={() => void useEvaluations.getState().duplicateRun(run.id).then((id) => id && onOpenRun(id))}>{t("evaluations.duplicateRun")}</Button>
          <Button size="sm" variant="outline" onClick={() => setComparing((open) => !open)}><GitCompareArrowsIcon /> {t("evaluations.compareOpen")}</Button>
          <Button size="sm" variant="destructive" onClick={() => setConfirmDelete(true)}><Trash2Icon /> {t("evaluations.deleteRun")}</Button>
        </div>
        {comparing && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border p-2 text-xs">
            {otherRuns.length ? (
              <Select aria-label={t("evaluations.compareRunB")} value="" onValueChange={onCompare} placeholder={t("evaluations.comparePickRun")} options={otherRuns.map((item) => ({ value: item.id, label: `${item.label || item.id} · ${item.target.modelName}` }))} />
            ) : (
              <span className="text-muted-foreground">{t("evaluations.compareEmpty")}</span>
            )}
          </div>
        )}
        {confirmDelete && (
          <div role="alertdialog" aria-label={t("evaluations.deleteRun")} className="space-y-2 rounded-lg border p-3 text-xs">
            <p className="font-medium">{t("evaluations.deleteRunConfirm")}</p>
            <p>{t("evaluations.deleteRunBody")}</p>
            <div className="flex gap-2">
              <Button size="sm" variant="destructive" onClick={() => void useEvaluations.getState().deleteRun(run.id).then(() => onBack())}>{t("common.delete")}</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>{t("common.cancel")}</Button>
            </div>
          </div>
        )}
      </section>

      <JudgePanel run={run} usable={usable} judging={judging} setJudging={setJudging} />

      <ResultsTable run={run} onOpen={setOpenCase} />
      <CaseDetail runId={run.id} caseId={openCase} scale={run.scoreMode} open={!!openCase} onClose={() => setOpenCase(null)} onChanged={() => void useEvaluations.getState().refreshDetail(run.id)} />
      {dataset && <p className="text-muted-foreground text-xs">{dataset.name} · {t("evaluations.caseCount", { count: dataset.cases.length })}</p>}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className="text-foreground">{value}</dd>
    </div>
  );
}

function JudgePanel({ run, usable, judging, setJudging }: { run: EvalRunDetail; usable: boolean; judging: boolean; setJudging: (open: boolean) => void }) {
  const models = useData((state) => state.models).filter((model) => !isAgentTarget(model));
  const saving = useEvaluations((state) => state.saving);
  const judge = run.judge;
  const [modelRef, setModelRef] = useState(models[0]?.ref ?? "");
  const [rubric, setRubric] = useState("");
  const [scale, setScale] = useState<EvalScoreMode>(run.scoreMode);
  const active = judge?.state === "queued" || judge?.state === "running";
  const start = async () => {
    const ok = await useEvaluations.getState().judgeRun(run.id, { modelRef, rubric: rubric.trim(), scale });
    if (ok) setJudging(false);
  };
  const self = judge && modelRef === run.target.modelRef;
  return (
    <section className="bg-card border-border space-y-2 rounded-xl border p-4 shadow-[var(--depth-highlight),var(--shadow-raised)]">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{t("evaluations.judgeRun")}</h3>
        <span className="text-muted-foreground text-xs">
          {active ? (judge?.state === "queued" ? t("evaluations.judgeQueued") : t("evaluations.judgeRunning")) : judge?.state === "failed" ? t("evaluations.judgeFailed") : judge?.state === "cancelled" ? t("evaluations.judgeCancelled") : judge?.state === "done" ? t("evaluations.judgeDone") : t("evaluations.judgeNotJudged")}
        </span>
        {judge && (
          <span className="text-muted-foreground text-xs">
            {t("evaluations.progressCases", { done: formatNumber(judge.doneCases), total: formatNumber(run.completedCases) })} · {t("evaluations.judgeCost")}: {formatCost(judge.cost)}
          </span>
        )}
        {judge?.config && <span className="text-muted-foreground text-xs">{judge.config.modelName}</span>}
        {usable && (
          <Button size="sm" variant="outline" className="ms-auto" onClick={() => setJudging(!judging)}>
            {judge?.config ? t("evaluations.judgeRejudge") : t("evaluations.judgeStart")}
          </Button>
        )}
      </div>
      {judge?.failedCases ? <p className="text-muted-foreground text-xs">{t("evaluations.judgeFailedCount", { count: judge.failedCases })}</p> : null}
      {judging && usable && (
        <div className="space-y-2 rounded-lg border p-3">
          <p className="text-xs font-medium">{t("evaluations.judgeFormTitle")}</p>
          <label className="block text-xs font-medium">
            {t("evaluations.judgeModel")}
            <ModelSelect aria-label={t("evaluations.judgeModel")} value={modelRef} onValueChange={setModelRef} filter={(model) => !isAgentTarget(model)} />
          </label>
          {self && <p className="text-warning text-xs">{t("evaluations.judgeSelfWarning")}</p>}
          <label className="block text-xs font-medium">
            {t("evaluations.judgeRubric")}
            <Textarea aria-label={t("evaluations.judgeRubric")} rows={4} value={rubric} onChange={(event) => setRubric(event.target.value)} placeholder={t("evaluations.judgeRubricPlaceholder")} />
          </label>
          <label className="block text-xs font-medium">
            {t("evaluations.judgeScale")}
            <Select aria-label={t("evaluations.judgeScale")} value={scale} onValueChange={(value) => setScale(value as EvalScoreMode)} options={[
              { value: "scale5", label: t("evaluations.scoreModeScale5") },
              { value: "pass_fail", label: t("evaluations.scoreModePassFail") },
            ]} />
          </label>
          {judge?.config && <p className="text-muted-foreground text-xs">{t("evaluations.judgeRejudgeBody")}</p>}
          <Button size="sm" disabled={saving || !modelRef || !rubric.trim()} onClick={() => void start()}>{saving ? t("evaluations.judgeStarting") : t("evaluations.judgeStart")}</Button>
        </div>
      )}
    </section>
  );
}
