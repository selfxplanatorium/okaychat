import { useEffect, useMemo } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { ArrowLeftIcon, FlaskConicalIcon } from "lucide-react";
import { isAgentTarget } from "@shared/n8n-agents";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { settingsHref } from "@/lib/settings-link";
import { t } from "@/i18n";
import { formatCost, formatDate } from "@/i18n/format";
import { useData } from "@/state/data";
import { useEvaluations } from "@/state/evaluations";
import { usePermissions } from "@/state/permissions";
import { CompareRuns } from "./CompareRuns";
import { DatasetEditor } from "./DatasetEditor";
import { DatasetList } from "./DatasetList";
import { RunLauncher } from "./RunLauncher";
import { RunView } from "./RunView";
import { StateChip } from "./ResultsTable";

const ACTIVE = new Set(["queued", "running", "cancelling"]);

/** One route, query state: dataset, run, or compare. Back leaves the workspace, not every table row. */
export function EvaluationsPage() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const datasetId = params.get("dataset");
  const runId = params.get("run");
  const compare = params.get("compare");
  const [compareA, compareB] = compare?.includes(",") ? compare.split(",") : [null, null];
  const me = useData((state) => state.me);
  const models = useData((state) => state.models);
  const self = usePermissions((state) => state.self);
  const selfStatus = usePermissions((state) => state.selfStatus);
  const dataset = useEvaluations((state) => state.dataset);
  const status = useEvaluations((state) => state.status);
  const error = useEvaluations((state) => state.error);
  const runs = useEvaluations((state) => state.runs);
  const actionError = useEvaluations((state) => state.actionError);

  useEffect(() => {
    if (!me) return;
    usePermissions.getState().begin(me.id);
    void usePermissions.getState().loadSelf();
    void useEvaluations.getState().loadDatasets();
  }, [me?.id]);

  useEffect(() => {
    if (!datasetId) {
      useEvaluations.setState({ dataset: null, run: null, progress: null, comparison: null });
      void useEvaluations.getState().loadDatasets();
      return;
    }
    void useEvaluations.getState().loadDataset(datasetId);
    void useEvaluations.getState().loadRuns(datasetId);
  }, [datasetId]);

  useEffect(() => {
    if (runId) void useEvaluations.getState().loadRun(runId);
  }, [runId]);

  const go = (next: { dataset?: string | null; run?: string | null; compare?: string | null }) => {
    const query = new URLSearchParams();
    const selectedDataset = next.dataset === undefined ? datasetId : next.dataset;
    const selectedRun = next.run === undefined ? runId : next.run;
    const selectedCompare = next.compare === undefined ? compare : next.compare;
    if (selectedDataset) query.set("dataset", selectedDataset);
    if (selectedRun) query.set("run", selectedRun);
    if (selectedCompare) query.set("compare", selectedCompare);
    navigate(`/evaluations${query.size ? `?${query.toString()}` : ""}`, { replace: true });
  };

  if (selfStatus === "loading" || (selfStatus === "idle" && !self)) {
    return <p role="status" className="text-muted-foreground p-8 text-sm">{t("common.loading")}</p>;
  }
  if (self && !self.features.evaluations) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-16 text-center">
        <FlaskConicalIcon aria-hidden className="text-muted-foreground size-8" />
        <h1 className="text-base font-medium">{t("evaluations.disabledTitle")}</h1>
        <p className="text-muted-foreground text-sm">{t("evaluations.disabledBody")}</p>
        <Link className="text-primary text-sm underline underline-offset-4" href={settingsHref("account")}>{t("evaluations.openPermissions")}</Link>
      </div>
    );
  }
  if (!models.some((model) => !isAgentTarget(model))) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-16 text-center">
        <FlaskConicalIcon aria-hidden className="text-muted-foreground size-8" />
        <h1 className="text-base font-medium">{t("evaluations.noModels")}</h1>
        <Link className="text-primary text-sm underline underline-offset-4" href={settingsHref("providers")}>{t("evaluations.openProviders")}</Link>
      </div>
    );
  }

  const detailOpen = !!datasetId;
  const activeRun = runs.find((run) => ACTIVE.has(run.state)) ?? null;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 lg:grid lg:grid-cols-[320px_minmax(0,1fr)] lg:gap-4 lg:p-4">
      <div className={detailOpen ? "hidden min-h-0 lg:flex lg:flex-col" : "flex min-h-0 flex-1 flex-col"}>
        <DatasetList
          selectedId={datasetId}
          onSelect={(id) => go({ dataset: id, run: null, compare: null })}
          onCreated={(id) => go({ dataset: id, run: null, compare: null })}
        />
      </div>
      <div className={detailOpen ? "flex min-h-0 flex-1 flex-col" : "hidden min-h-0 flex-1 flex-col lg:flex"}>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-4 pb-6">
            {compareA && compareB && compareA !== compareB ? (
              <CompareRuns a={compareA} b={compareB} onBack={() => go({ compare: null })} onChangeB={(id) => go({ compare: `${compareA},${id}` })} />
            ) : runId ? (
              <RunView
                runId={runId}
                dataset={dataset}
                onBack={() => {
                  if (datasetId) void useEvaluations.getState().loadRuns(datasetId);
                  go({ run: null, compare: null });
                }}
                onOpenRun={(id) => go({ run: id, compare: null })}
                onCompare={(id) => go({ compare: `${runId},${id}`, run: null })}
              />
            ) : datasetId ? (
              status === "loading" && (!dataset || dataset.id !== datasetId) ? (
                <p role="status" className="text-muted-foreground p-6 text-sm">{t("common.loading")}</p>
              ) : status === "error" && !dataset ? (
                <div role="alert" className="space-y-3 p-6 text-sm">
                  <p>{error ?? t("evaluations.datasetLoadFailed")}</p>
                  <Button size="sm" variant="outline" onClick={() => void useEvaluations.getState().loadDataset(datasetId)}>{t("evaluations.retry")}</Button>
                </div>
              ) : dataset && dataset.id === datasetId ? (
                <>
                  <div className="flex items-center gap-2">
                    <h1 className="min-w-0 flex-1 truncate text-lg font-semibold tracking-tight">{dataset.name}</h1>
                    <span className="text-muted-foreground text-xs">{formatDate(dataset.updatedAt)}</span>
                  </div>
                  <RunLauncher dataset={dataset} activeRun={activeRun} onStarted={(id) => go({ run: id, compare: null })} />
                  <section className="bg-card border-border rounded-xl border shadow-[var(--depth-highlight),var(--shadow-raised)]">
                    <div className="flex items-center justify-between border-b px-4 py-2.5">
                      <h2 className="text-sm font-semibold">{t("evaluations.runsTitle")}</h2>
                      <Button size="sm" variant="ghost" onClick={() => go({ dataset: null, run: null })}><ArrowLeftIcon /> {t("evaluations.datasetsTitle")}</Button>
                    </div>
                    {runs.length ? (
                      <ul className="divide-border divide-y">
                        {runs.map((run) => (
                          <li key={run.id}>
                            <button type="button" onClick={() => go({ run: run.id, compare: null })} className="hover:bg-muted/60 focus-visible:outline-ring flex w-full min-w-0 flex-wrap items-center gap-2 px-4 py-2.5 text-left">
                              <span className="min-w-0 flex-1 truncate text-sm">{run.label || run.id}</span>
                              <StateChip state={run.state} active={ACTIVE.has(run.state)} />
                              <span className="text-muted-foreground text-xs">{run.target.modelName}</span>
                              <span className="text-muted-foreground text-xs">{formatCost(run.cost)}</span>
                              <span className="text-muted-foreground text-xs">{formatDate(run.createdAt)}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-muted-foreground p-6 text-sm">{t("evaluations.runsEmpty")}</p>
                    )}
                  </section>
                  {actionError && <p role="alert" className="text-destructive text-xs">{actionError}</p>}
                  <DatasetEditor datasetId={datasetId} onOpenRun={() => go({ run: null })} />
                </>
              ) : (
                <div className="space-y-3 p-6">
                  <p className="text-sm">{t("evaluations.datasetNotFound")}</p>
                  <Button size="sm" variant="outline" onClick={() => go({ dataset: null, run: null, compare: null })}>{t("evaluations.back")}</Button>
                </div>
              )
            ) : (
              <div className="flex flex-col items-center gap-3 px-6 py-20 text-center">
                <FlaskConicalIcon aria-hidden className="text-muted-foreground size-8" />
                <h2 className="text-base font-medium">{t("evaluations.noDatasetSelected")}</h2>
                <p className="text-muted-foreground max-w-sm text-sm">{t("evaluations.noDatasetSelectedBody")}</p>
              </div>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
