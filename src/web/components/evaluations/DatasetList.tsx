import { useState } from "react";
import { ChevronDownIcon, FlaskConicalIcon, PlusIcon } from "lucide-react";
import type { EvalDatasetSummary } from "@shared/evaluations";
import { EVAL_MAX_DATASETS } from "@shared/evaluations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { formatDate } from "@/i18n/format";
import { useEvaluations } from "@/state/evaluations";

export function DatasetList({ selectedId, onSelect, onCreated }: { selectedId: string | null; onSelect: (id: string | null) => void; onCreated: (id: string) => void }) {
  const datasets = useEvaluations((state) => state.datasets);
  const status = useEvaluations((state) => state.status);
  const error = useEvaluations((state) => state.error);
  const saving = useEvaluations((state) => state.saving);
  const actionError = useEvaluations((state) => state.actionError);
  const createDataset = useEvaluations((state) => state.createDataset);
  const duplicateDataset = useEvaluations((state) => state.duplicateDataset);
  const deleteDataset = useEvaluations((state) => state.deleteDataset);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const full = datasets.length >= EVAL_MAX_DATASETS;
  const save = async () => {
    const id = await createDataset({ name: name.trim(), description });
    if (id) {
      setCreating(false);
      setName("");
      setDescription("");
      onCreated(id);
    }
  };

  return (
    <section aria-label={t("evaluations.datasetsTitle")} className="border-border bg-card flex min-h-0 flex-1 flex-col rounded-xl border shadow-[var(--depth-highlight),var(--shadow-raised)]">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2.5">
        <h1 className="text-sm font-semibold">{t("evaluations.datasetsTitle")}</h1>
        <Button size="sm" variant="outline" disabled={full || creating} onClick={() => setCreating(true)} title={full ? t("evaluations.datasetLimit", { count: EVAL_MAX_DATASETS }) : undefined}>
          <PlusIcon /> {t("evaluations.newDataset")}
        </Button>
      </div>
      {full && <p className="text-muted-foreground border-b px-3 py-2 text-xs">{t("evaluations.datasetLimit", { count: EVAL_MAX_DATASETS })}</p>}
      {creating && (
        <form
          className="border-b space-y-2 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <p className="text-muted-foreground text-xs">{t("evaluations.newDatasetHint")}</p>
          <label className="block text-xs font-medium">
            {t("evaluations.datasetName")}
            <Input aria-label={t("evaluations.datasetName")} value={name} onChange={(event) => setName(event.target.value)} placeholder={t("evaluations.datasetNamePlaceholder")} autoFocus />
          </label>
          <label className="block text-xs font-medium">
            {t("evaluations.datasetDescription")}
            <Textarea aria-label={t("evaluations.datasetDescription")} value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t("evaluations.datasetDescriptionPlaceholder")} rows={2} />
          </label>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={saving || !name.trim()}>
              {saving ? t("evaluations.datasetSaving") : t("evaluations.datasetSave")}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setCreating(false)}>
              {t("common.cancel")}
            </Button>
          </div>
          {actionError && <p role="alert" className="text-destructive text-xs">{actionError}</p>}
        </form>
      )}
      {status === "error" && (
        <div role="alert" className="space-y-2 p-3 text-sm">
          <p>{error ?? t("evaluations.datasetLoadFailed")}</p>
          <Button size="sm" variant="outline" onClick={() => void useEvaluations.getState().loadDatasets()}>
            {t("evaluations.retry")}
          </Button>
        </div>
      )}
      {!datasets.length && status !== "loading" && status !== "error" && !creating ? (
        <div className="flex flex-col items-center gap-3 p-6 text-center">
          <FlaskConicalIcon aria-hidden className="text-muted-foreground size-8" />
          <div>
            <p className="text-sm font-medium">{t("evaluations.emptyDatasets")}</p>
            <p className="text-muted-foreground mt-1 text-xs">{t("evaluations.emptyDatasetsBody")}</p>
          </div>
          <Button size="sm" onClick={() => setCreating(true)}>
            {t("evaluations.createFirstDataset")}
          </Button>
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <ul className="divide-border divide-y">
            {datasets.map((dataset) => (
              <li key={dataset.id} className="relative">
                <button
                  type="button"
                  aria-current={selectedId === dataset.id ? "true" : undefined}
                  onClick={() => onSelect(dataset.id)}
                  className={`hover:bg-muted/60 focus-visible:outline-ring flex w-full min-w-0 flex-col gap-1 px-3 py-2.5 pr-10 text-left transition-colors ${selectedId === dataset.id ? "depth-row-active" : ""}`}
                >
                  <span className="truncate text-sm font-medium">{dataset.name}</span>
                  {dataset.description && <span className="text-muted-foreground truncate text-xs">{dataset.description}</span>}
                  <span className="text-muted-foreground flex flex-wrap gap-x-2 text-[0.7rem]">
                    <span>{t("evaluations.caseCount", { count: dataset.caseCount })}</span>
                    <span>{t("evaluations.runCount", { count: dataset.runCount })}</span>
                    <span>{formatDate(dataset.updatedAt)}</span>
                  </span>
                </button>
                <Menu>
                  <MenuTrigger
                    render={<Button variant="ghost" size="icon-sm" className="absolute top-2 right-2" aria-label={t("evaluations.datasetMenu", { name: dataset.name })} />}
                  >
                    <ChevronDownIcon />
                  </MenuTrigger>
                  <MenuContent align="end">
                    <MenuItem onClick={() => void duplicateDataset(dataset.id).then((id) => id && onCreated(id))}>{t("evaluations.duplicateDataset")}</MenuItem>
                    <MenuSeparator />
                    <MenuItem onClick={() => setConfirmDelete(dataset.id)}>{t("evaluations.deleteDataset")}</MenuItem>
                  </MenuContent>
                </Menu>
                {confirmDelete === dataset.id && (
                  <div role="alertdialog" aria-label={t("evaluations.deleteDataset")} className="bg-card border-border absolute inset-x-2 top-full z-10 space-y-2 rounded-lg border p-3 shadow-lg">
                    <p className="text-sm font-medium">{t("evaluations.deleteDatasetConfirm")}</p>
                    <p className="text-muted-foreground text-xs">
                      {t("evaluations.deleteDatasetBody", { runs: dataset.runCount, cases: dataset.caseCount })}
                    </p>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => {
                          setConfirmDelete(null);
                          void deleteDataset(dataset.id).then((ok) => ok && onSelect(null));
                        }}
                      >
                        {t("common.delete")}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>
                        {t("common.cancel")}
                      </Button>
                    </div>
                    {actionError && <p role="alert" className="text-destructive text-xs">{actionError}</p>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </ScrollArea>
      )}
    </section>
  );
}
