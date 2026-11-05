import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { PlayIcon } from "lucide-react";
import type { EvalDatasetDetail, EvalRunSummary, EvalScoreMode } from "@shared/evaluations";
import type { ModelInfo, ReasoningEffort } from "@shared/types";
import { EVAL_DEFAULT_BUDGET_MICROS, EVAL_MAX_CONCURRENCY, EVAL_MIN_CONCURRENCY } from "@shared/evaluations";
import { samplingCapabilities } from "@shared/assistant-presets";
import { reasoningOptions } from "@shared/reasoning";
import { isAgentTarget } from "@shared/n8n-agents";
import { ModelSelect } from "@/components/chat/ModelPicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { t } from "@/i18n";
import { formatCost, formatNumber } from "@/i18n/format";
import { useAssistantPresets } from "@/state/assistant-presets";
import { useData } from "@/state/data";
import { useEvaluations } from "@/state/evaluations";

export function RunLauncher({ dataset, activeRun, onStarted }: { dataset: EvalDatasetDetail; activeRun: EvalRunSummary | null; onStarted: (id: string) => void }) {
  const models = useData((state) => state.models);
  const settings = useData((state) => state.settings);
  const minePresets = useAssistantPresets((state) => state.mine);
  const publishedPresets = useAssistantPresets((state) => state.published);
  const presets = useMemo(() => [...minePresets, ...publishedPresets.filter((preset) => !minePresets.some((mine) => mine.id === preset.id))], [minePresets, publishedPresets]);
  const loadMine = useAssistantPresets((state) => state.loadMine);
  const loadPublished = useAssistantPresets((state) => state.loadPublished);
  const saving = useEvaluations((state) => state.saving);
  const actionError = useEvaluations((state) => state.actionError);
  const chatModels = useMemo(() => models.filter((model): model is ModelInfo => !isAgentTarget(model)), [models]);
  const [modelRef, setModelRef] = useState(settings?.defaultModel ?? chatModels[0]?.ref ?? "");
  const [effort, setEffort] = useState("");
  const [temperature, setTemperature] = useState("");
  const [assistantId, setAssistantId] = useState("");
  const [concurrency, setConcurrency] = useState(String(Math.min(2, EVAL_MAX_CONCURRENCY)));
  const [budgetCost, setBudgetCost] = useState("1");
  const [budgetTokens, setBudgetTokens] = useState("1000000");
  const [scoreMode, setScoreMode] = useState<EvalScoreMode>("scale5");
  const [allCases, setAllCases] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [label, setLabel] = useState("");

  useEffect(() => {
    void loadMine().catch(() => {});
    void loadPublished().catch(() => {});
  }, [loadMine, loadPublished]);
  useEffect(() => {
    setAllCases(true);
    setSelected([]);
    setLabel("");
  }, [dataset.id]);
  useEffect(() => {
    if (!chatModels.some((item) => item.ref === modelRef) && chatModels[0]) setModelRef(chatModels[0].ref);
  }, [chatModels, modelRef]);
  const model = models.find((item): item is ModelInfo => !isAgentTarget(item) && item.ref === modelRef);
  const caps = model ? samplingCapabilities(model, effort ? (effort as ReasoningEffort) : undefined) : null;
  const caseIds = allCases ? dataset.cases.map((item) => item.caseId) : selected;
  const budgetMicros = Math.round(Number(budgetCost) * 1_000_000);
  const disabledReason =
    !modelRef ? t("evaluations.modelRequired") : !caseIds.length ? t("evaluations.casesRequired") : activeRun ? t("evaluations.activeRunExists", { label: activeRun.label }) : null;

  const start = async () => {
    if (!model || disabledReason) return;
    const preset = presets.find((item) => item.id === assistantId);
    const id = await useEvaluations.getState().startRun(dataset.id, {
      label: label.trim() || undefined,
      modelRef: model.ref,
      ...(effort ? { effort } : {}),
      ...(temperature && caps?.temperature ? { temperature: Number(temperature) } : {}),
      ...(assistantId ? { assistantPresetId: assistantId, ...(preset ? { assistantRevision: preset.revision } : {}) } : {}),
      concurrency: Number(concurrency),
      budgetMicros: Number.isFinite(budgetMicros) ? budgetMicros : EVAL_DEFAULT_BUDGET_MICROS,
      budgetTokens: Number(budgetTokens),
      scoreMode,
      ...(allCases ? {} : { caseIds }),
      expectedRevision: dataset.revision,
    });
    if (id) onStarted(id);
  };

  return (
    <section aria-label={t("evaluations.runLauncher")} className="bg-card border-border space-y-3 rounded-xl border p-4 shadow-[var(--depth-highlight),var(--shadow-raised)]">
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-48 flex-1 text-xs font-medium">
          {t("evaluations.model")}
          <ModelSelect aria-label={t("evaluations.model")} value={modelRef} onValueChange={(value) => { setModelRef(value); setTemperature(""); }} filter={(item) => !isAgentTarget(item)} />
        </label>
        <label className="w-32 text-xs font-medium">
          {t("evaluations.effort")}
          <Select
            aria-label={t("evaluations.effort")}
            value={effort || "default"}
            onValueChange={(value) => setEffort(value === "default" ? "" : value)}
            options={[{ value: "default", label: t("evaluations.effortDefault") }, ...(model ? reasoningOptions(model) : []).map((value) => ({ value, label: value }))]}
          />
        </label>
        <label className="w-36 text-xs font-medium">
          {t("evaluations.concurrency")}
          <Select
            aria-label={t("evaluations.concurrency")}
            value={concurrency}
            onValueChange={setConcurrency}
            options={Array.from({ length: EVAL_MAX_CONCURRENCY - EVAL_MIN_CONCURRENCY + 1 }, (_, index) => String(index + EVAL_MIN_CONCURRENCY)).map((value) => ({ value, label: value }))}
          />
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {caps?.temperature && (
          <label className="text-xs font-medium">
            {t("evaluations.temperature")}
            <Input aria-label={t("evaluations.temperature")} type="number" min={0} max={caps.temperatureMax} step="0.1" value={temperature} onChange={(event) => setTemperature(event.target.value)} />
          </label>
        )}
        <label className="text-xs font-medium">
          {t("evaluations.assistant")}
          <Select
            aria-label={t("evaluations.assistant")}
            value={assistantId || "__none"}
            onValueChange={(value) => {
              setAssistantId(value === "__none" ? "" : value);
              const preset = presets.find((item) => item.id === value);
              if (preset?.config.modelRef) setModelRef(preset.config.modelRef);
            }}
            options={[{ value: "__none", label: t("evaluations.noAssistant") }, ...presets.map((preset) => ({ value: preset.id, label: preset.name }))]}
          />
        </label>
        <label className="text-xs font-medium">
          {t("evaluations.scoreMode")}
          <Select aria-label={t("evaluations.scoreMode")} value={scoreMode} onValueChange={(value) => setScoreMode(value as EvalScoreMode)} options={[
            { value: "scale5", label: t("evaluations.scoreModeScale5") },
            { value: "pass_fail", label: t("evaluations.scoreModePassFail") },
          ]} />
        </label>
        <label className="text-xs font-medium">
          {t("evaluations.budgetCost")}
          <Input aria-label={t("evaluations.budgetCost")} type="number" min={0.01} max={20} step="0.01" value={budgetCost} onChange={(event) => setBudgetCost(event.target.value)} />
        </label>
        <label className="text-xs font-medium">
          {t("evaluations.budgetTokens")}
          <Input aria-label={t("evaluations.budgetTokens")} type="number" min={10000} max={20000000} step="1000" value={budgetTokens} onChange={(event) => setBudgetTokens(event.target.value)} />
        </label>
        <label className="text-xs font-medium sm:col-span-2">
          {t("evaluations.runLabel")}
          <Input aria-label={t("evaluations.runLabel")} value={label} onChange={(event) => setLabel(event.target.value)} placeholder={t("evaluations.runLabelPlaceholder")} />
        </label>
      </div>
      <p className="text-muted-foreground text-xs">{t("evaluations.budgetHelp")}</p>

      <fieldset className="space-y-2">
        <legend className="text-xs font-medium">{t("evaluations.casesToRun")}</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={allCases} onChange={(event) => setAllCases(event.target.checked)} />
          {t("evaluations.allCases", { count: dataset.cases.length })}
        </label>
        {!allCases && (
          <div className="grid max-h-40 gap-1 overflow-y-auto rounded-lg border p-2 sm:grid-cols-2">
            {dataset.cases.map((item) => (
              <label key={item.caseId} className="flex min-w-0 items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={selected.includes(item.caseId)}
                  onChange={(event) => setSelected((current) => (event.target.checked ? [...current, item.caseId] : current.filter((id) => id !== item.caseId)))}
                />
                <span className="truncate">{item.input}</span>
              </label>
            ))}
          </div>
        )}
        <p className="text-muted-foreground text-xs">
          {t("evaluations.launchEstimate", { cases: formatNumber(caseIds.length), cost: formatCost(Number.isFinite(budgetMicros) ? budgetMicros / 1_000_000 : 0), concurrency: formatNumber(Number(concurrency)) })}
        </p>
      </fieldset>

      {disabledReason && <p className="text-muted-foreground text-xs">{disabledReason}</p>}
      {actionError && <p role="alert" className="text-destructive text-xs">{actionError}</p>}
      {activeRun && <p className="text-muted-foreground text-xs">{t("evaluations.concurrencyHelp")}</p>}
      <Button disabled={saving || !!disabledReason} onClick={() => void start()}>
        <PlayIcon /> {saving ? t("evaluations.launching") : t("evaluations.launch")}
      </Button>
      {!chatModels.length && (
        <p className="text-xs">
          {t("evaluations.noModels")} <Link className="text-primary underline" href="/settings/providers">{t("evaluations.openProviders")}</Link>
        </p>
      )}
    </section>
  );
}
