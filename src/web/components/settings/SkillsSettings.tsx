import { FileArchiveIcon, GlobeIcon, Loader2Icon, PackageIcon, PencilIcon, PlusIcon, RefreshCwIcon, TrashIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Skill, SkillDetail, SkillSource, SkillSourceListing } from "@shared/skills";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { SettingsPage, SettingsSection } from "./SettingsUI";

// Skills are reusable SKILL.md instruction packages (Anthropic Agent Skills format). The account
// preference gates everything: off, no chat sees the skill index or any skill tool.

const formatChars = (n: number) => (n < 1024 ? `${n}` : `${Math.round(n / 1024)}k`);

function useSkillData() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [sources, setSources] = useState<SkillSource[]>([]);
  const [prefs, setPrefs] = useState({ enabled: false, revision: 0 });
  const [error, setError] = useState<string | null>(null);
  const refresh = () => {
    Promise.all([
      api<Skill[]>("/skills"),
      api<SkillSource[]>("/skills/sources"),
      api<{ enabled: boolean; revision: number }>("/skills/prefs"),
    ])
      .then(([skillList, sourceList, preferences]) => {
        setSkills(skillList);
        setSources(sourceList);
        setPrefs(preferences);
        setError(null);
      })
      .catch((e) => setError((e as Error).message));
  };
  useEffect(refresh, []);
  return { skills, sources, prefs, error, refresh };
}

function SkillForm({ initial, onDone, onCancel }: { initial?: SkillDetail; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [files, setFiles] = useState(initial?.fileContents.map((file) => ({ ...file })) ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const payload = { name, description, body, files: files.filter((file) => file.name && file.content) };
    try {
      if (initial) await api(`/skills/${initial.id}`, { method: "PUT", json: payload });
      else await api("/skills", { method: "POST", json: payload });
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
      <div className="grid gap-3 sm:grid-cols-2">
        <Input placeholder="skill-name (kebab-case)" value={name} onChange={(e) => setName(e.target.value)} required autoFocus spellCheck={false} />
        <Input placeholder="One sentence: what it does and when to use it" value={description} onChange={(e) => setDescription(e.target.value)} required maxLength={1024} />
      </div>
      <Textarea
        placeholder={"Instructions the model loads with load_skill:\n## Steps\n1. …"}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        className="min-h-40 font-mono text-xs"
        required
        spellCheck={false}
      />
      {files.length > 0 && (
        <div className="flex flex-col gap-2">
          {files.map((file, i) => (
            <div key={i} className="border-border rounded-lg border p-2">
              <div className="flex items-center gap-2">
                <Input value={file.name} onChange={(e) => setFiles(files.toSpliced(i, 1, { ...file, name: e.target.value }))} className="font-mono text-xs" spellCheck={false} aria-label="File name" />
                <button type="button" aria-label={`Remove ${file.name}`} onClick={() => setFiles(files.toSpliced(i, 1))} className="text-muted-foreground hover:text-destructive rounded p-1">
                  <TrashIcon className="size-3.5" />
                </button>
              </div>
              <Textarea value={file.content} onChange={(e) => setFiles(files.toSpliced(i, 1, { ...file, content: e.target.value }))} className="mt-2 min-h-16 font-mono text-xs" spellCheck={false} aria-label={`Content of ${file.name}`} />
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy} size="sm">{initial ? "Save changes" : "Create skill"}</Button>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setFiles([...files, { name: "", content: "" }])}>
          <PlusIcon className="size-3.5" /> Add file
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
        {error && <p role="alert" className="text-destructive text-xs">{error}</p>}
      </div>
    </form>
  );
}

function SkillRow({ skill, editing, onEdit, onChanged }: { skill: Skill; editing: boolean; onEdit: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const change = async (enabled: boolean) => {
    setBusy(true);
    try {
      await api(`/skills/${skill.id}`, { method: "PATCH", json: { enabled } });
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api(`/skills/${skill.id}`, { method: "DELETE" });
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  if (editing) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-sm">{skill.name}</span>
          {skill.origin !== "manual" && <span className="text-muted-foreground bg-muted rounded px-1 py-px text-[10px] font-medium">{skill.origin === "conversation" ? "from a chat" : "from a source"}</span>}
        </div>
        <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">{skill.description}</p>
        <p className="text-muted-foreground mt-1 text-[10px]">
          {formatChars(skill.chars)} chars · {skill.files.length} file{skill.files.length === 1 ? "" : "s"}
          {skill.files.length > 0 && ` (${skill.files.map((file) => file.name).join(", ")})`}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Switch checked={skill.enabled} disabled={busy} onCheckedChange={(enabled) => void change(enabled)} aria-label={`Enable ${skill.name}`} />
        <button type="button" aria-label={`Edit ${skill.name}`} onClick={onEdit} className="text-muted-foreground hover:text-foreground rounded p-1.5 transition-colors duration-(--motion-fast)">
          <PencilIcon className="size-4" />
        </button>
        <button type="button" aria-label={`Delete ${skill.name}`} onClick={() => void remove()} disabled={busy} className="text-muted-foreground hover:text-destructive rounded p-1.5 transition-colors duration-(--motion-fast)">
          <TrashIcon className="size-4" />
        </button>
      </div>
    </div>
  );
}

function SourceRow({ source, onChanged }: { source: SkillSource; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [listing, setListing] = useState<SkillSourceListing | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const load = async () => {
    setBusy(true);
    setListing(null);
    try {
      setListing(await api<SkillSourceListing>(`/skills/sources/${source.id}/skills`));
    } catch (e) {
      setListing({ source, entries: [], errors: [(e as Error).message] });
    } finally {
      setBusy(false);
    }
  };
  const install = async (name: string) => {
    setInstalling(name);
    try {
      await api(`/skills/sources/${source.id}/install`, { method: "POST", json: { name } });
      await api<SkillSourceListing>(`/skills/sources/${source.id}/skills`).then(setListing);
      onChanged();
    } catch (e) {
      setListing((prev) => ({ ...(prev ?? { source, entries: [], errors: [] }), errors: [(e as Error).message] }));
    } finally {
      setInstalling(null);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api(`/skills/sources/${source.id}`, { method: "DELETE" });
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  const errors = listing?.errors ?? [];
  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium">{source.name}</span>
            <span className="text-muted-foreground bg-muted flex items-center gap-1 rounded px-1 py-px text-[10px] font-medium">
              {source.kind === "github" ? <GlobeIcon className="size-3" /> : <FileArchiveIcon className="size-3" />}
              {source.kind}
            </span>
            {source.hasToken && <span className="text-muted-foreground text-[10px]">with token</span>}
          </div>
          <p className="text-muted-foreground mt-0.5 truncate text-xs">
            {source.url}
            {source.branch ? ` · ${source.branch}` : ""}
            {source.subpath ? ` · ${source.subpath}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void load()}>
            {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : <RefreshCwIcon className="size-3.5" />}
            {listing ? "Refresh" : "Browse"}
          </Button>
          <button type="button" aria-label={`Remove source ${source.name}`} onClick={() => void remove()} disabled={busy} className="text-muted-foreground hover:text-destructive rounded p-1.5 transition-colors duration-(--motion-fast)">
            <TrashIcon className="size-4" />
          </button>
        </div>
      </div>
      {listing && (
        <div className="mt-2 flex flex-col gap-1.5">
          {listing.entries.length === 0 && !errors.length && <p className="text-muted-foreground text-xs">No skills found here.</p>}
          {listing.entries.map((entry) => (
            <div key={entry.path} className="border-border flex items-center justify-between gap-3 rounded-lg border px-2.5 py-2">
              <div className="min-w-0">
                <p className="truncate font-mono text-xs">{entry.name}</p>
                <p className="text-muted-foreground line-clamp-2 text-[10px]">{entry.description}</p>
              </div>
              <Button variant="outline" size="sm" disabled={installing !== null} onClick={() => void install(entry.name)}>
                {installing === entry.name && <Loader2Icon className="size-3.5 animate-spin" />}
                {installing === entry.name ? "Installing…" : "Install"}
              </Button>
            </div>
          ))}
          {errors.map((message) => (
            <p key={message} role="alert" className="text-warning text-xs">{message}</p>
          ))}
        </div>
      )}
    </div>
  );
}

function AddSourceForm({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [subpath, setSubpath] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open) {
    return (
      <div className="px-4 py-3">
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <PlusIcon className="size-3.5" /> Link a source
        </Button>
        <p className="text-muted-foreground mt-2 text-xs">A GitHub repository, a SKILL.md URL, or a .zip URL. Optional: branch, subpath, and a read-only access token for private repos.</p>
      </div>
    );
  }
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/skills/sources", { method: "POST", json: { name: name || undefined, url, branch: branch || undefined, subpath: subpath || undefined, token: token || undefined } });
      setOpen(false);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="flex flex-col gap-2 px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Input placeholder="https://github.com/owner/repo, a SKILL.md URL, or a .zip URL" value={url} onChange={(e) => setUrl(e.target.value)} type="url" required autoFocus />
      <div className="grid gap-2 sm:grid-cols-3">
        <Input placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
        <Input placeholder="Branch (optional)" value={branch} onChange={(e) => setBranch(e.target.value)} spellCheck={false} />
        <Input placeholder="Subpath, e.g. skills/ (optional)" value={subpath} onChange={(e) => setSubpath(e.target.value)} spellCheck={false} />
      </div>
      <Input placeholder="Access token for private repos (optional, stored encrypted)" value={token} onChange={(e) => setToken(e.target.value)} type="password" autoComplete="off" spellCheck={false} />
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={busy}>Save source</Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
        {error && <p role="alert" className="text-destructive text-xs">{error}</p>}
      </div>
    </form>
  );
}

function ImportRow({ onChanged }: { onChanged: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const upload = async (file: File) => {
    setBusy(true);
    setResult(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await api<{ installed: Skill[]; skipped: string[] }>("/skills/import", { method: "POST", body: form });
      const notes = [
        ...res.installed.map((s) => `installed ${s.name}`),
        ...res.skipped,
      ];
      setResult(notes.join(" · ") || "Nothing imported.");
      onChanged();
    } catch (e) {
      setResult((e as Error).message);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };
  return (
    <div className="px-4 py-3">
      <input
        ref={inputRef}
        type="file"
        accept=".md,.zip,text/markdown,application/zip"
        className="sr-only"
        aria-label="Import a SKILL.md or .zip"
        disabled={busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      <Button variant="outline" size="sm" disabled={busy} onClick={() => inputRef.current?.click()}>
        {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : <PackageIcon className="size-3.5" />}
        Import a SKILL.md or .zip
      </Button>
      {result && <p className="text-muted-foreground mt-2 text-xs">{result}</p>}
    </div>
  );
}

export function SkillsSettings({ embedded = false }: { embedded?: boolean }) {
  const { skills, sources, prefs, error, refresh } = useSkillData();
  const [editingId, setEditingId] = useState<string | null | "new">(null);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [toggleBusy, setToggleBusy] = useState(false);
  useEffect(() => {
    if (editingId === null || editingId === "new") setDetail(null);
    if (editingId && editingId !== "new") {
      api<SkillDetail>(`/skills/${editingId}`).then(setDetail).catch(() => setDetail(null));
    }
  }, [editingId]);
  const toggle = async (enabled: boolean) => {
    setToggleBusy(true);
    try {
      await api("/skills/prefs", { method: "PATCH", json: { enabled } });
      refresh();
    } finally {
      setToggleBusy(false);
    }
  };
  return (
    <SettingsPage
      title={embedded ? "" : "Skills"}
      description="Reusable instruction packages for your chats (Agent Skills format: a SKILL.md plus optional reference files)."
    >
      <SettingsSection title="Use skills in chats" description="When on, each chat sees the index of enabled skills and can load their instructions on demand. Installing and creating skills always asks you first.">
        <div className="flex items-center justify-between px-4 py-3">
          <p className="text-muted-foreground text-xs">
            {prefs.enabled
              ? "Enabled. Chats load skill bodies only when a task matches."
              : "Off. Chats see no skills and no skill tools."}
          </p>
          <Switch checked={prefs.enabled} disabled={toggleBusy} onCheckedChange={(enabled) => void toggle(enabled)} aria-label="Use skills in chats" />
        </div>
      </SettingsSection>
      <SettingsSection
        title="Installed skills"
        description={`${skills.length} installed`}
        action={
          <Button size="sm" variant="outline" onClick={() => setEditingId("new")}>
            <PlusIcon className="size-3.5" /> New skill
          </Button>
        }
      >
        {skills.map((skill) => (
          <SkillRow key={skill.id} skill={skill} editing={editingId === skill.id} onEdit={() => setEditingId(skill.id)} onChanged={refresh} />
        ))}
        {skills.length === 0 && (
          <p className="text-muted-foreground px-4 py-4 text-sm">No skills yet. Create one, import a SKILL.md or .zip, or install from a source below.</p>
        )}
        {editingId !== null && (
          <div className="border-border border-t">
            {editingId === "new" || detail ? (
              <SkillForm initial={detail ?? undefined} onDone={() => { setEditingId(null); refresh(); }} onCancel={() => setEditingId(null)} />
            ) : (
              <div className="text-muted-foreground px-4 py-4 text-sm"><Loader2Icon className="size-4 animate-spin" /></div>
            )}
          </div>
        )}
      </SettingsSection>
      <SettingsSection title="Import">
        <ImportRow onChanged={() => { refresh(); }} />
      </SettingsSection>
      <SettingsSection title="Skill sources" description="Linked GitHub repos or raw files. Sources are fetched server-side; their content is stored as text and never executed.">
        {sources.map((source) => (
          <SourceRow key={source.id} source={source} onChanged={refresh} />
        ))}
        <AddSourceForm onDone={refresh} />
      </SettingsSection>
      {error && <p role="alert" className={cn("text-destructive text-xs")}>{error}</p>}
    </SettingsPage>
  );
}
