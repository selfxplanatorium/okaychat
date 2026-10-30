import { FileTextIcon, Loader2Icon, PencilIcon, PlusIcon, TrashIcon, UploadIcon } from "lucide-react";
import { useRef, useState, type CSSProperties } from "react";
import type { Project } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { t } from "@/i18n";
import { formatTokens } from "@/i18n/format";
import { useData } from "@/state/data";
import { ModelSelect } from "../chat/ModelPicker";
import { SettingsPage, SettingsSection } from "./SettingsUI";

function ProjectForm({ initial, onDone }: { initial?: Project; onDone: () => void }) {
  const refresh = useData((s) => s.refreshProjects);
  const [name, setName] = useState(initial?.name ?? "");
  const [instructions, setInstructions] = useState(initial?.instructions ?? "");
  const [defaultModel, setDefaultModel] = useState<string | null>(initial?.defaultModel ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { name, instructions, defaultModel };
      if (initial) await api(`/projects/${initial.id}`, { method: "PUT", json: body });
      else await api("/projects", { method: "POST", json: body });
      await refresh();
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="animate-rise-in flex flex-col gap-3 px-4 py-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Input placeholder={t("projects.namePlaceholder")} value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
      <Textarea
        placeholder={t("projects.instructionsPlaceholder")}
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        className="min-h-28"
      />
      <ModelSelect
        aria-label={t("projects.defaultModel")}
        value={defaultModel ?? ""}
        onValueChange={(value) => setDefaultModel(value || null)}
        choices={[{ value: "", label: t("projects.useAccountDefault") }]}
      />
      {error && <p className="text-error settings-error text-xs">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" disabled={busy}>
          {busy && <Loader2Icon className="animate-spin" />}
          {initial ? t("common.save") : t("projects.createProject")}
        </Button>
      </div>
    </form>
  );
}

function ProjectFiles({ project }: { project: Project }) {
  const refresh = useData((s) => s.refreshProjects);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append("file", file);
        await api(`/projects/${project.id}/files`, { method: "POST", body: form });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      await refresh();
      if (input.current) input.current.value = "";
    }
  };

  return (
    <div className="mt-2 flex flex-col gap-1">
      {project.files.map((f) => (
        <div key={f.id} className="text-muted-foreground animate-fade-in flex items-center gap-2 text-xs">
          <FileTextIcon className="size-3.5 shrink-0" />
          <span className="text-foreground truncate">{f.name}</span>
          <span className="shrink-0">{t("projects.fileTokens", { tokens: formatTokens(Math.round(f.chars / 4)) })}</span>
          <button type="button" className="hover:text-foreground ms-auto transition-colors duration-(--motion-fast)" aria-label={t("projects.removeFile", { name: f.name })} onClick={() => void api(`/projects/${project.id}/files/${f.id}`, { method: "DELETE" }).then(refresh)}>
            <TrashIcon className="size-3.5" />
          </button>
        </div>
      ))}
      <input ref={input} type="file" multiple hidden onChange={(e) => void upload(e.target.files)} />
      <Button size="xs" variant="ghost" className="w-fit" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? <Loader2Icon className="animate-spin" /> : <UploadIcon />} {t("projects.pinFiles")}
      </Button>
      {error && <p className="text-error settings-error text-xs">{error}</p>}
    </div>
  );
}

export function ProjectSettings() {
  const projects = useData((s) => s.projects);
  const refresh = useData((s) => s.refreshProjects);
  const [editing, setEditing] = useState<string | "new" | null>(null);

  return (
    <SettingsPage title={t("projects.title")} description={t("projects.description")}>
      <SettingsSection
        action={
          editing !== "new" && (
            <Button size="sm" variant="outline" onClick={() => setEditing("new")}>
              <PlusIcon /> {t("projects.newProject")}
            </Button>
          )
        }
      >
        {editing === "new" && <ProjectForm onDone={() => setEditing(null)} />}
        {projects.length === 0 && editing !== "new" && <p className="text-muted-foreground animate-fade-in px-4 py-6 text-sm">{t("projects.empty")}</p>}
        {projects.map((p, index) =>
          editing === p.id ? (
            <ProjectForm key={p.id} initial={p} onDone={() => setEditing(null)} />
          ) : (
            <div key={p.id} className="stagger animate-rise-in flex items-start gap-3 px-4 py-3" style={{ "--i": index } as CSSProperties}>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{p.name}</p>
                {p.instructions && <p className="text-muted-foreground line-clamp-2 text-xs">{p.instructions}</p>}
                <ProjectFiles project={p} />
              </div>
              <div className="flex shrink-0 gap-1">
                <Button size="icon-sm" variant="ghost" aria-label={t("common.edit")} onClick={() => setEditing(p.id)}>
                  <PencilIcon />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("projects.deleteProject")}
                  onClick={() => confirm(t("projects.confirmDelete", { name: p.name })) && void api(`/projects/${p.id}`, { method: "DELETE" }).then(refresh)}
                >
                  <TrashIcon />
                </Button>
              </div>
            </div>
          ),
        )}
      </SettingsSection>
    </SettingsPage>
  );
}
