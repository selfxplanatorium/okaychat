import { FileArchiveIcon, GlobeIcon, Loader2Icon, PackageIcon, PencilIcon, PlusIcon, RefreshCwIcon, TrashIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Skill, SkillDetail, SkillSource, SkillSourceListing } from "@shared/skills";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { formatList, formatTokens } from "@/i18n/format";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { SettingsPage, SettingsSection } from "./SettingsUI";

// Skills are reusable SKILL.md instruction packages (Anthropic Agent Skills format). The account
// preference gates everything: off, no chat sees the skill index or any skill tool.

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
        <Input placeholder={t("skills.namePlaceholder")} value={name} onChange={(e) => setName(e.target.value)} required autoFocus spellCheck={false} />
        <Input placeholder={t("skills.descriptionPlaceholder")} value={description} onChange={(e) => setDescription(e.target.value)} required maxLength={1024} />
      </div>
      <Textarea
        placeholder={t("skills.bodyPlaceholder")}
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
                <Input value={file.name} onChange={(e) => setFiles(files.toSpliced(i, 1, { ...file, name: e.target.value }))} className="font-mono text-xs" spellCheck={false} aria-label={t("skills.fileName")} />
                <button type="button" aria-label={t("skills.removeFile", { name: file.name })} onClick={() => setFiles(files.toSpliced(i, 1))} className="text-muted-foreground hover:text-destructive rounded p-1">
                  <TrashIcon className="size-3.5" />
                </button>
              </div>
              <Textarea value={file.content} onChange={(e) => setFiles(files.toSpliced(i, 1, { ...file, content: e.target.value }))} className="mt-2 min-h-16 font-mono text-xs" spellCheck={false} aria-label={t("skills.fileContent", { name: file.name })} />
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy} size="sm">{initial ? t("skills.saveChanges") : t("skills.createSkill")}</Button>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setFiles([...files, { name: "", content: "" }])}>
          <PlusIcon className="size-3.5" /> {t("skills.addFile")}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>{t("common.cancel")}</Button>
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
          {skill.origin !== "manual" && <span className="text-muted-foreground bg-muted rounded px-1 py-px text-[10px] font-medium">{skill.origin === "conversation" ? t("skills.fromChat") : t("skills.fromSource")}</span>}
        </div>
        <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">{skill.description}</p>
        <p className="text-muted-foreground mt-1 text-[10px]">
          {skill.files.length > 0
            ? t("skills.sizeAndFilesNamed", { size: formatTokens(skill.chars), count: skill.files.length, names: formatList(skill.files.map((file) => file.name), { type: "unit", style: "narrow" }) })
            : t("skills.sizeAndFiles", { size: formatTokens(skill.chars), count: 0 })}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Switch checked={skill.enabled} disabled={busy} onCheckedChange={(enabled) => void change(enabled)} aria-label={t("skills.enable", { name: skill.name })} />
        <button type="button" aria-label={t("skills.edit", { name: skill.name })} onClick={onEdit} className="text-muted-foreground hover:text-foreground rounded p-1.5 transition-colors duration-(--motion-fast)">
          <PencilIcon className="size-4" />
        </button>
        <button type="button" aria-label={t("skills.deleteSkill", { name: skill.name })} onClick={() => void remove()} disabled={busy} className="text-muted-foreground hover:text-destructive rounded p-1.5 transition-colors duration-(--motion-fast)">
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
            {source.hasToken && <span className="text-muted-foreground text-[10px]">{t("skills.withToken")}</span>}
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
            {listing ? t("common.refresh") : t("skills.browse")}
          </Button>
          <button type="button" aria-label={t("skills.removeSource", { name: source.name })} onClick={() => void remove()} disabled={busy} className="text-muted-foreground hover:text-destructive rounded p-1.5 transition-colors duration-(--motion-fast)">
            <TrashIcon className="size-4" />
          </button>
        </div>
      </div>
      {listing && (
        <div className="mt-2 flex flex-col gap-1.5">
          {listing.entries.length === 0 && !errors.length && <p className="text-muted-foreground text-xs">{t("skills.noSkillsFound")}</p>}
          {listing.entries.map((entry) => (
            <div key={entry.path} className="border-border flex items-center justify-between gap-3 rounded-lg border px-2.5 py-2">
              <div className="min-w-0">
                <p className="truncate font-mono text-xs">{entry.name}</p>
                <p className="text-muted-foreground line-clamp-2 text-[10px]">{entry.description}</p>
              </div>
              <Button variant="outline" size="sm" disabled={installing !== null} onClick={() => void install(entry.name)}>
                {installing === entry.name && <Loader2Icon className="size-3.5 animate-spin" />}
                {installing === entry.name ? t("skills.installing") : t("skills.install")}
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
          <PlusIcon className="size-3.5" /> {t("skills.linkSource")}
        </Button>
        <p className="text-muted-foreground mt-2 text-xs">{t("skills.linkSourceHint")}</p>
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
      <Input placeholder={t("skills.urlPlaceholder")} value={url} onChange={(e) => setUrl(e.target.value)} type="url" required autoFocus />
      <div className="grid gap-2 sm:grid-cols-3">
        <Input placeholder={t("skills.sourceNamePlaceholder")} value={name} onChange={(e) => setName(e.target.value)} />
        <Input placeholder={t("skills.branchPlaceholder")} value={branch} onChange={(e) => setBranch(e.target.value)} spellCheck={false} />
        <Input placeholder={t("skills.subpathPlaceholder")} value={subpath} onChange={(e) => setSubpath(e.target.value)} spellCheck={false} />
      </div>
      <Input placeholder={t("skills.tokenPlaceholder")} value={token} onChange={(e) => setToken(e.target.value)} type="password" autoComplete="off" spellCheck={false} />
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={busy}>{t("skills.saveSource")}</Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
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
        ...res.installed.map((s) => t("skills.importedSkill", { name: s.name })),
        ...res.skipped,
      ];
      setResult(notes.join(" · ") || t("skills.nothingImported"));
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
        aria-label={t("skills.importFile")}
        disabled={busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      <Button variant="outline" size="sm" disabled={busy} onClick={() => inputRef.current?.click()}>
        {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : <PackageIcon className="size-3.5" />}
        {t("skills.importFile")}
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
      title={embedded ? "" : t("skills.title")}
      description={t("skills.description")}
    >
      <SettingsSection title={t("skills.useInChats")} description={t("skills.useInChatsDescription")}>
        <div className="flex items-center justify-between px-4 py-3">
          <p className="text-muted-foreground text-xs">
            {prefs.enabled
              ? t("skills.statusEnabled")
              : t("skills.statusOff")}
          </p>
          <Switch checked={prefs.enabled} disabled={toggleBusy} onCheckedChange={(enabled) => void toggle(enabled)} aria-label={t("skills.useInChats")} />
        </div>
      </SettingsSection>
      <SettingsSection
        title={t("skills.installed")}
        description={t("skills.installedCount", { count: skills.length })}
        action={
          <Button size="sm" variant="outline" onClick={() => setEditingId("new")}>
            <PlusIcon className="size-3.5" /> {t("skills.newSkill")}
          </Button>
        }
      >
        {skills.map((skill) => (
          <SkillRow key={skill.id} skill={skill} editing={editingId === skill.id} onEdit={() => setEditingId(skill.id)} onChanged={refresh} />
        ))}
        {skills.length === 0 && (
          <p className="text-muted-foreground px-4 py-4 text-sm">{t("skills.empty")}</p>
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
      <SettingsSection title={t("skills.importSection")}>
        <ImportRow onChanged={() => { refresh(); }} />
      </SettingsSection>
      <SettingsSection title={t("skills.sources")} description={t("skills.sourcesDescription")}>
        {sources.map((source) => (
          <SourceRow key={source.id} source={source} onChanged={refresh} />
        ))}
        <AddSourceForm onDone={refresh} />
      </SettingsSection>
      {error && <p role="alert" className={cn("text-destructive text-xs")}>{error}</p>}
    </SettingsPage>
  );
}
