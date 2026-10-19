import { FileTextIcon, Loader2Icon, PencilIcon, PlusIcon, TrashIcon, UploadIcon } from "lucide-react";
import { useRef, useState } from "react";
import type { Project } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, formatTokens } from "@/lib/api";
import { useData } from "@/state/data";
import { SettingsPage, SettingsSection } from "./SettingsUI";

function ProjectForm({ initial, onDone }: { initial?: Project; onDone: () => void }) {
  const models = useData((s) => s.models);
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
      className="flex flex-col gap-3 px-4 py-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Input placeholder="Project name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
      <Textarea
        placeholder="Instructions for every chat in this project, e.g. You help me run my bakery's marketing. Write in a warm, plain voice."
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        className="min-h-28"
      />
      <Select
        aria-label="Default model"
        value={defaultModel}
        onValueChange={setDefaultModel}
        placeholder="Default model: keep the current one"
        options={models.map((m) => ({ value: m.ref, label: `${m.name} · ${m.providerId}` }))}
      />
      {error && <p className="text-error text-xs">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy && <Loader2Icon className="animate-spin" />}
          {initial ? "Save" : "Create project"}
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
        <div key={f.id} className="text-muted-foreground flex items-center gap-2 text-xs">
          <FileTextIcon className="size-3.5 shrink-0" />
          <span className="text-foreground truncate">{f.name}</span>
          <span className="shrink-0">~{formatTokens(Math.round(f.chars / 4))} tokens</span>
          <button type="button" className="hover:text-foreground ms-auto" aria-label={`Remove ${f.name}`} onClick={() => void api(`/projects/${project.id}/files/${f.id}`, { method: "DELETE" }).then(refresh)}>
            <TrashIcon className="size-3.5" />
          </button>
        </div>
      ))}
      <input ref={input} type="file" multiple hidden onChange={(e) => void upload(e.target.files)} />
      <Button size="xs" variant="ghost" className="w-fit" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? <Loader2Icon className="animate-spin" /> : <UploadIcon />} Pin files
      </Button>
      {error && <p className="text-error text-xs">{error}</p>}
    </div>
  );
}

export function ProjectSettings() {
  const projects = useData((s) => s.projects);
  const refresh = useData((s) => s.refreshProjects);
  const [editing, setEditing] = useState<string | "new" | null>(null);

  return (
    <SettingsPage title="Projects" description="Group chats under shared instructions, pinned files, and a default model. Switch projects at the top of the sidebar.">
      <SettingsSection
        action={
          editing !== "new" && (
            <Button size="sm" variant="outline" onClick={() => setEditing("new")}>
              <PlusIcon /> New project
            </Button>
          )
        }
      >
        {editing === "new" && <ProjectForm onDone={() => setEditing(null)} />}
        {projects.length === 0 && editing !== "new" && <p className="text-muted-foreground px-4 py-6 text-sm">No projects yet.</p>}
        {projects.map((p) =>
          editing === p.id ? (
            <ProjectForm key={p.id} initial={p} onDone={() => setEditing(null)} />
          ) : (
            <div key={p.id} className="flex items-start gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{p.name}</p>
                {p.instructions && <p className="text-muted-foreground line-clamp-2 text-xs">{p.instructions}</p>}
                <ProjectFiles project={p} />
              </div>
              <div className="flex shrink-0 gap-1">
                <Button size="icon-sm" variant="ghost" aria-label="Edit" onClick={() => setEditing(p.id)}>
                  <PencilIcon />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Delete project"
                  onClick={() => confirm(`Delete "${p.name}"? Its chats stay and move to All chats.`) && void api(`/projects/${p.id}`, { method: "DELETE" }).then(refresh)}
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
