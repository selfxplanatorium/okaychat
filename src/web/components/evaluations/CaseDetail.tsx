import { useEffect, useState } from "react";
import type { EvalCaseView, EvalScoreMode } from "@shared/evaluations";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { t } from "@/i18n";
import { formatCost, formatDuration, formatNumber, formatTokens } from "@/i18n/format";
import { ScoreControl } from "./ScoreControl";

export function CaseDetail({ runId, caseId, scale, open, onClose, onChanged }: {
  runId: string;
  caseId: string | null;
  scale: EvalScoreMode;
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [view, setView] = useState<EvalCaseView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!caseId || !open) return;
    let live = true;
    setView(null);
    setError(null);
    void api<EvalCaseView>(`/evaluations/runs/${runId}/cases/${caseId}`)
      .then((next) => { if (live) setView(next); })
      .catch((failure: Error) => { if (live) setError(failure.message); });
    return () => { live = false; };
  }, [runId, caseId, open, reload]);

  const manual = view?.scores.find((score) => score.source === "manual");
  const judge = view?.scores.find((score) => score.source === "judge");
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[min(90dvh,54rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("evaluations.caseDetailTitle")}</DialogTitle>
          <DialogDescription>{view ? `${view.result.case.caseId}` : t("common.loading")}</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
        {!view && !error && <p role="status" className="text-muted-foreground text-sm">{t("common.loading")}</p>}
        {view && (
          <div className="space-y-4 text-sm">
            <Field label={t("evaluations.caseInput")} value={view.result.case.input} />
            <Field label={t("evaluations.caseInstructions")} value={view.result.case.instructions || t("evaluations.caseExpectedEmpty")} />
            <Field label={t("evaluations.caseExpected")} value={view.result.case.expected || t("evaluations.caseExpectedEmpty")} />
            <Field label={t("evaluations.caseNotes")} value={view.result.case.notes || t("evaluations.caseNotesEmpty")} />
            <div>
              <p className="text-xs font-medium">{t("evaluations.caseOutput")}</p>
              {view.result.output ? (
                <pre className="bg-muted/50 mt-1 max-h-72 overflow-auto rounded-lg border p-2.5 text-xs whitespace-pre-wrap break-words">{view.result.output}</pre>
              ) : (
                <p className="text-muted-foreground mt-1 text-xs">{t("evaluations.caseOutputEmpty")}</p>
              )}
              {view.result.truncated && <p className="text-warning mt-1 text-xs">{t("evaluations.caseOutputTruncated")}</p>}
            </div>
            {view.result.errorCode && (
              <div role="alert" className="rounded-lg border p-2.5">
                <p className="text-xs font-medium">{t("evaluations.caseError")}</p>
                <p className="text-muted-foreground text-xs">{view.result.errorMessage ?? view.result.errorCode}</p>
              </div>
            )}
            <dl className="text-muted-foreground grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              <Stat label={t("evaluations.caseLatency")} value={view.result.latencyMs === null ? "—" : formatDuration(view.result.latencyMs / 1000)} />
              <Stat label={t("evaluations.tokens")} value={formatTokens(view.result.usage.input + view.result.usage.output)} />
              <Stat label={t("evaluations.columnCost")} value={formatCost(view.result.cost)} />
              <Stat label={t("evaluations.caseAttemptsLabel")} value={t("evaluations.caseAttempts", { count: view.result.attempts })} />
            </dl>
            {view.result.state === "error" && <p className="text-xs">{t("evaluations.scoreNoAnswer")}</p>}
            {view.result.state === "done" && view.result.outputBytes > 0 && (
              <ScoreControl runId={runId} caseId={view.result.caseId} scale={scale} score={manual} onChanged={() => { onChanged(); setReload((value) => value + 1); }} />
            )}
            <div>
              <p className="text-xs font-medium">{t("evaluations.columnJudge")}</p>
              {judge ? (
                <div className="mt-1 space-y-1">
                  <p className="text-sm">{t("evaluations.judgeScore")}: {formatNumber(judge.value)}</p>
                  {judge.rationale && <p className="bg-muted/40 rounded-lg border p-2.5 text-xs whitespace-pre-wrap">{judge.rationale}</p>}
                  {judge.judgeModelRef && <p className="text-muted-foreground text-xs">{t("evaluations.judgeModel")}: {judge.judgeModelRef}</p>}
                </div>
              ) : (
                <p className="text-muted-foreground mt-1 text-xs">{t("evaluations.judgeNotJudged")}</p>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium">{label}</p>
      <p className="mt-1 text-xs whitespace-pre-wrap break-words">{value}</p>
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
