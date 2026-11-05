import { useEffect, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react";
import type { EvalCaseFields } from "@shared/evaluations";
import { EVAL_MAX_CASES, EVAL_MAX_DATASET_BYTES } from "@shared/evaluations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { formatBytes } from "@/i18n/format";
import { useEvaluations } from "@/state/evaluations";

const blank = (): EvalCaseFields => ({ input: "", instructions: "", expected: "", notes: "", tags: [] });
const tagText = (tags: string[]) => tags.join(", ");
const parseTags = (value: string) => value.split(",").map((tag) => tag.trim()).filter(Boolean);

export function DatasetEditor({ datasetId, onOpenRun }: { datasetId: string; onOpenRun: () => void }) {
  const dataset = useEvaluations((state) => state.dataset);
  const saving = useEvaluations((state) => state.saving);
  const actionError = useEvaluations((state) => state.actionError);
  const conflict = useEvaluations((state) => state.conflict);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saved, setSaved] = useState(false);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<EvalCaseFields>(blank());
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [savedCase, setSavedCase] = useState(false);

  useEffect(() => {
    if (!dataset) return;
    setName(dataset.name);
    setDescription(dataset.description);
    setEditing(null);
    setSaved(false);
    setSavedCase(false);
  }, [dataset?.id, dataset?.revision]);

  if (!dataset || dataset.id !== datasetId) return null;
  const full = dataset.cases.length >= EVAL_MAX_CASES;
  const startEdit = (caseId: string) => {
    const item = dataset.cases.find((entry) => entry.caseId === caseId);
    if (!item) return;
    setDraft({ input: item.input, instructions: item.instructions, expected: item.expected, notes: item.notes, tags: item.tags });
    setEditing(caseId);
    setSavedCase(false);
  };
  const startNew = () => {
    setDraft(blank());
    setEditing("new");
    setSavedCase(false);
  };
  const saveCase = async () => {
    const ok = editing === "new" ? await useEvaluations.getState().addCase(datasetId, draft) : editing ? await useEvaluations.getState().updateCase(datasetId, editing, draft) : false;
    if (ok) {
      setEditing(null);
      setSavedCase(true);
    }
  };

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <section className="bg-card border-border space-y-3 rounded-xl border p-4 shadow-[var(--depth-highlight),var(--shadow-raised)]">
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1 text-xs font-medium">
            {t("evaluations.datasetName")}
            <Input aria-label={t("evaluations.datasetName")} value={name} onChange={(event) => { setName(event.target.value); setSaved(false); }} placeholder={t("evaluations.datasetNamePlaceholder")} />
          </label>
          <Button
            disabled={saving || !name.trim()}
            onClick={() => void useEvaluations.getState().saveDataset(datasetId, { name: name.trim(), description }).then((ok) => setSaved(ok))}
          >
            {saving ? t("evaluations.datasetSaving") : t("evaluations.datasetSave")}
          </Button>
        </div>
        <label className="block text-xs font-medium">
          {t("evaluations.datasetDescription")}
          <Textarea aria-label={t("evaluations.datasetDescription")} value={description} onChange={(event) => { setDescription(event.target.value); setSaved(false); }} placeholder={t("evaluations.datasetDescriptionPlaceholder")} rows={2} />
        </label>
        <p className="text-muted-foreground text-xs">{t("evaluations.caseBytesUsed", { used: formatBytes(dataset.usedBytes), limit: formatBytes(EVAL_MAX_DATASET_BYTES) })}</p>
        {saved && <p role="status" className="text-success text-xs">{t("evaluations.datasetSaved")}</p>}
        {conflict && (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-xs">
            <span>{t("evaluations.datasetConflict")}</span>
            <Button size="sm" variant="outline" onClick={() => void useEvaluations.getState().loadDataset(datasetId)}>{t("evaluations.reloadDataset")}</Button>
          </div>
        )}
        {actionError && !conflict && <p role="alert" className="text-destructive text-xs">{actionError}</p>}
      </section>

      <section className="bg-card border-border flex min-h-0 flex-col rounded-xl border shadow-[var(--depth-highlight),var(--shadow-raised)]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
          <div>
            <h2 className="text-sm font-semibold">{t("evaluations.casesTitle")}</h2>
            <p className="text-muted-foreground text-xs">{t("evaluations.casesIntro")}</p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => void useEvaluations.getState().loadRuns(datasetId).then(onOpenRun)}>
              {t("evaluations.openRuns")}
            </Button>
            <Button size="sm" disabled={full || saving} onClick={startNew} title={full ? t("evaluations.caseLimit", { count: EVAL_MAX_CASES }) : undefined}>
              <PlusIcon /> {t("evaluations.addCase")}
            </Button>
          </div>
        </div>
        {full && <p className="text-muted-foreground border-b px-4 py-2 text-xs">{t("evaluations.caseLimit", { count: EVAL_MAX_CASES })}</p>}
        {savedCase && <p role="status" className="text-success border-b px-4 py-2 text-xs">{t("evaluations.caseSaved")}</p>}

        {editing === "new" && <CaseForm title={t("evaluations.caseNew")} draft={draft} setDraft={setDraft} onCancel={() => setEditing(null)} onSave={() => void saveCase()} saving={saving} />}

        <ol className="divide-border divide-y">
            {dataset.cases.map((item, index) => (
              <li key={item.caseId}>
                {editing === item.caseId ? (
                  <CaseForm title={t("evaluations.casePosition", { position: item.position })} draft={draft} setDraft={setDraft} onCancel={() => setEditing(null)} onSave={() => void saveCase()} saving={saving} />
                ) : (
                  <div className="flex min-w-0 items-start gap-2 px-4 py-2.5">
                    <span className="text-muted-foreground w-8 shrink-0 pt-0.5 text-right text-xs tabular-nums">{item.position}</span>
                    <button type="button" className="focus-visible:outline-ring min-w-0 flex-1 rounded text-left" onClick={() => startEdit(item.caseId)}>
                      <span className="block truncate text-sm">{item.input}</span>
                      {item.expected && <span className="text-muted-foreground block truncate text-xs">{t("evaluations.caseExpected")}: {item.expected}</span>}
                      {!!item.tags.length && <span className="text-muted-foreground mt-1 flex flex-wrap gap-1 text-[0.7rem]">{item.tags.map((tag) => <span key={tag} className="bg-muted rounded px-1.5 py-0.5">{tag}</span>)}</span>}
                    </button>
                    <div className="flex shrink-0 items-center">
                      <Button size="icon-sm" variant="ghost" aria-label={t("evaluations.moveUp")} disabled={index === 0 || saving} onClick={() => void useEvaluations.getState().moveCase(datasetId, item.caseId, -1)}>
                        <ArrowUpIcon />
                      </Button>
                      <Button size="icon-sm" variant="ghost" aria-label={t("evaluations.moveDown")} disabled={index === dataset.cases.length - 1 || saving} onClick={() => void useEvaluations.getState().moveCase(datasetId, item.caseId, 1)}>
                        <ArrowDownIcon />
                      </Button>
                      <Button size="icon-sm" variant="ghost" aria-label={t("evaluations.caseDelete")} onClick={() => setConfirmDelete(item.caseId)}>
                        <Trash2Icon />
                      </Button>
                    </div>
                  </div>
                )}
                {confirmDelete === item.caseId && (
                  <div role="alertdialog" aria-label={t("evaluations.caseDelete")} className="bg-muted/40 space-y-2 px-4 pb-3">
                    <p className="text-xs">{t("evaluations.caseDeleteConfirm")}</p>
                    <div className="flex gap-2">
                      <Button size="sm" variant="destructive" onClick={() => { setConfirmDelete(null); void useEvaluations.getState().deleteCase(datasetId, item.caseId); }}>{t("common.delete")}</Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>{t("common.cancel")}</Button>
                    </div>
                  </div>
                )}
              </li>
            ))}
            {!dataset.cases.length && editing !== "new" && (
              <li className="p-6 text-center">
                <p className="text-sm font-medium">{t("evaluations.casesEmpty")}</p>
                <Button size="sm" className="mt-3" onClick={startNew}><PlusIcon /> {t("evaluations.addCase")}</Button>
              </li>
            )}
        </ol>
      </section>
    </div>
  );
}

function CaseForm({ title, draft, setDraft, onCancel, onSave, saving }: {
  title: string;
  draft: EvalCaseFields;
  setDraft: (next: EvalCaseFields) => void;
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
}) {
  const field = (key: keyof EvalCaseFields) => ({ value: key === "tags" ? tagText(draft.tags) : (draft[key] as string), onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft({ ...draft, [key]: key === "tags" ? parseTags(event.target.value) : event.target.value }) });
  return (
    <form
      className="bg-muted/30 space-y-3 border-b p-4"
      onSubmit={(event) => { event.preventDefault(); onSave(); }}
    >
      <p className="text-sm font-medium">{title}</p>
      <label className="block text-xs font-medium">
        {t("evaluations.caseInput")}
        <Textarea aria-label={t("evaluations.caseInput")} rows={3} required {...field("input")} placeholder={t("evaluations.caseInputPlaceholder")} />
      </label>
      <label className="block text-xs font-medium">
        {t("evaluations.caseInstructions")}
        <Textarea aria-label={t("evaluations.caseInstructions")} rows={2} {...field("instructions")} />
        <span className="text-muted-foreground font-normal">{t("evaluations.caseInstructionsHelp")}</span>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs font-medium">
          {t("evaluations.caseExpected")}
          <Textarea aria-label={t("evaluations.caseExpected")} rows={2} {...field("expected")} />
          <span className="text-muted-foreground font-normal">{t("evaluations.caseExpectedHelp")}</span>
        </label>
        <label className="block text-xs font-medium">
          {t("evaluations.caseNotes")}
          <Textarea aria-label={t("evaluations.caseNotes")} rows={2} {...field("notes")} />
        </label>
      </div>
      <label className="block text-xs font-medium">
        {t("evaluations.caseTags")}
        <Input aria-label={t("evaluations.caseTags")} {...field("tags")} placeholder={t("evaluations.caseTagsPlaceholder")} />
      </label>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={saving || !draft.input.trim()}>{saving ? t("evaluations.datasetSaving") : t("evaluations.caseSave")}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>{t("common.cancel")}</Button>
      </div>
    </form>
  );
}
