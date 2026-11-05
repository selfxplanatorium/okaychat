import { useState } from "react";
import type { EvalScore, EvalScoreMode } from "@shared/evaluations";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { useEvaluations } from "@/state/evaluations";

export function ScoreControl({ runId, caseId, scale, score, onChanged }: {
  runId: string;
  caseId: string;
  scale: EvalScoreMode;
  score: EvalScore | undefined;
  onChanged: () => void;
}) {
  const [comment, setComment] = useState(score?.comment ?? "");
  const [pending, setPending] = useState<number | null>(score?.value ?? null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const actionError = useEvaluations((state) => state.actionError);

  const save = async (value: number) => {
    const previous = pending;
    setPending(value);
    setMessage(null);
    setSaving(true);
    const ok = await useEvaluations.getState().scoreCase(runId, caseId, { expectedRevision: score?.revision ?? 0, value, ...(comment.trim() ? { comment: comment.trim() } : {}) });
    setSaving(false);
    if (ok) {
      setMessage(t("evaluations.scoreSaved"));
      onChanged();
    } else {
      setPending(previous);
      // A conflict re-reads the case, so the control shows the stored score instead of a stale one.
      onChanged();
    }
  };

  const clear = async () => {
    if (!score) return;
    const previous = pending;
    setPending(null);
    setSaving(true);
    const ok = await useEvaluations.getState().clearScore(runId, caseId, score.revision);
    setSaving(false);
    if (ok) {
      setComment("");
      setMessage(t("evaluations.scoreSaved"));
      onChanged();
    } else {
      setPending(previous);
    }
  };

  const values = scale === "scale5" ? [1, 2, 3, 4, 5] : [1, 0];
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium">{t("evaluations.scoreTitle")}</p>
      <div className="flex flex-wrap gap-1.5">
        {values.map((value) => (
          <Button
            key={value}
            size="sm"
            variant={pending === value ? "default" : "outline"}
            aria-pressed={pending === value}
            className="pointer-coarse:min-h-11"
            disabled={saving}
            onClick={() => void save(value)}
          >
            {scale === "scale5" ? value : value === 1 ? t("evaluations.scorePass") : t("evaluations.scoreFail")}
          </Button>
        ))}
        {score && (
          <Button size="sm" variant="ghost" className="pointer-coarse:min-h-11" disabled={saving} onClick={() => void clear()}>
            {t("evaluations.scoreClear")}
          </Button>
        )}
      </div>
      <label className="block text-xs font-medium">
        {t("evaluations.scoreComment")}
        <Textarea aria-label={t("evaluations.scoreComment")} rows={2} value={comment} onChange={(event) => setComment(event.target.value)} />
      </label>
      <Button size="sm" variant="outline" className="pointer-coarse:min-h-11" disabled={saving || pending === null} onClick={() => pending !== null && void save(pending)}>
        {saving ? t("evaluations.scoreSaving") : t("evaluations.scoreSave")}
      </Button>
      {message && <p role="status" className="text-success text-xs">{message}</p>}
      {actionError && <p role="alert" className="text-destructive text-xs">{actionError}</p>}
    </div>
  );
}
