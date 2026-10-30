import { CheckIcon, CopyIcon, DownloadIcon, Loader2Icon, PencilIcon, PlusIcon, RefreshCwIcon, TrashIcon, UploadIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MemoryEntry, MemoryImportPreview, MemoryImportSource, MemoryPreferences, MemorySnapshot, MemorySummary } from "@shared/memory";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SimpleMarkdown } from "@/components/ui/simple-markdown";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { formatDate, formatDateTime } from "@/i18n/format";
import { api } from "@/lib/api";
import { useData } from "@/state/data";
import { SettingsPage, SettingsRow, SettingsSection } from "./SettingsUI";

const SOURCE_LABELS = {
  manual: "memory.sourceManual",
  conversation: "memory.sourceConversation",
  claude: "memory.sourceClaude",
  chatgpt: "memory.sourceChatgpt",
  okaychat: "memory.sourceOkaychat",
} as const;
const MAX_IMPORT_CHARS = 200_000;

function MemoryEditor({ initial = "", busy, onSave, onCancel }: { initial?: string; busy: boolean; onSave: (content: string) => void; onCancel: () => void }) {
  const [content, setContent] = useState(initial);
  return (
    <form className="flex flex-col gap-3 p-4" onSubmit={(e) => { e.preventDefault(); onSave(content.trim()); }}>
      <label className="text-sm font-medium" htmlFor="memory-content">{t("memory.editorLabel")}</label>
      <Textarea id="memory-content" value={content} onChange={(e) => setContent(e.target.value)} maxLength={2000} required autoFocus disabled={busy} className="min-h-24" placeholder={t("memory.editorPlaceholder")} />
      <p className="text-muted-foreground text-xs">{t("memory.editorHint", { max: 2000 })}</p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>{t("common.cancel")}</Button>
        <Button type="submit" disabled={busy || !content.trim()}>{busy && <Loader2Icon className="animate-spin" />} {t("memory.saveMemory")}</Button>
      </div>
    </form>
  );
}

function MemoryImport({ onImported, disabled }: { onImported: (message: string) => Promise<void>; disabled: boolean }) {
  const [source, setSource] = useState<MemoryImportSource>("claude");
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<MemoryImportPreview | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copyTimer.current), []);

  const changeText = (value: string) => {
    setText(value);
    setPreview(null);
    setError(null);
  };

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      if (file.size > MAX_IMPORT_CHARS * 4) throw new Error(t("memory.fileTooLarge", { max: MAX_IMPORT_CHARS }));
      const value = await file.text();
      if (value.length > MAX_IMPORT_CHARS) throw new Error(t("memory.fileTooLong", { max: MAX_IMPORT_CHARS }));
      changeText(value);
      if (file.name.toLowerCase().endsWith(".json")) setSource("okaychat");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const review = async () => {
    setBusy(true);
    setError(null);
    try {
      if (text.length > MAX_IMPORT_CHARS) throw new Error(t("memory.importTooLong", { max: MAX_IMPORT_CHARS }));
      const next = await api<MemoryImportPreview>("/memory/import/preview", { method: "POST", json: { text, source } });
      setPreview(next);
      setSelected(new Set(next.entries.map((_, index) => index)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ imported: number; skipped: number }>("/memory/import", { method: "POST", json: { entries: preview.entries.filter((_, index) => selected.has(index)), source } });
      setText("");
      setPreview(null);
      await onImported(result.skipped ? t("memory.importedSkipped", { count: result.imported, skipped: result.skipped }) : t("memory.imported", { count: result.imported }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copyPrompt = async () => {
    try {
      // Clipboard access is unavailable on the app's plain-HTTP tailnet origins.
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(t("memory.exportPrompt"));
      else {
        const field = document.createElement("textarea");
        field.value = t("memory.exportPrompt");
        field.style.position = "fixed";
        field.style.opacity = "0";
        document.body.append(field);
        field.select();
        const succeeded = document.execCommand("copy");
        field.remove();
        if (!succeeded) throw new Error(t("memory.copyUnavailable"));
      }
      setCopied(true);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2500);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <SettingsSection title={t("memory.bringTitle")} description={t("memory.bringDescription")}>
      <div className="flex flex-col gap-4 p-4">
        <p className="text-muted-foreground text-sm">{t("memory.bringIntro")}</p>
        <details className="text-sm">
          <summary className="cursor-pointer font-medium">{t("memory.howToExport")}</summary>
          <div className="mt-3 flex flex-col gap-3">
            <p className="text-muted-foreground text-xs">{t("memory.howToExportBody")}</p>
            <Textarea aria-label={t("memory.exportPromptLabel")} value={t("memory.exportPrompt")} readOnly className="min-h-36 text-xs" />
            <Button variant="outline" className="w-fit" onClick={() => void copyPrompt()}>{copied ? <CheckIcon /> : <CopyIcon />}{copied ? t("memory.promptCopied") : t("memory.copyExportPrompt")}</Button>
            <p className="text-muted-foreground text-xs">
              <a className="text-foreground underline underline-offset-4" href="https://support.claude.com/en/articles/12123587-import-and-export-your-memory-from-claude" target="_blank" rel="noreferrer">{t("memory.claudeGuide")}</a>
              {" · "}<a className="text-foreground underline underline-offset-4" href="https://learn.chatgpt.com/docs/personalize" target="_blank" rel="noreferrer">{t("memory.chatgptPersonalization")}</a>
            </p>
          </div>
        </details>
        <fieldset disabled={busy || disabled} className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <Select disabled={busy || disabled} aria-label={t("memory.importSourceLabel")} className="sm:w-48" value={source} onValueChange={(value) => { setSource(value); setPreview(null); }} options={[{ value: "claude", label: t("memory.fromClaude") }, { value: "chatgpt", label: t("memory.fromChatgpt") }, { value: "okaychat", label: t("memory.fromOkaychat") }, { value: "manual", label: t("memory.otherText") }]} />
          <input ref={fileInput} type="file" hidden accept=".txt,.md,.markdown,.json,text/plain,text/markdown,application/json" onChange={(e) => void readFile(e.target.files?.[0])} />
          <Button variant="outline" disabled={busy || disabled} onClick={() => fileInput.current?.click()}><UploadIcon /> {t("memory.chooseTextFile")}</Button>
        </fieldset>
        <label htmlFor="memory-import" className="text-sm font-medium">{t("memory.exportedMemories")}</label>
        <Textarea id="memory-import" value={text} onChange={(e) => changeText(e.target.value)} disabled={busy || disabled} className="min-h-32" placeholder={t("memory.importPlaceholder")} />
        <p className="text-muted-foreground text-xs">{t("memory.importLimits", { max: MAX_IMPORT_CHARS })}</p>
        {error && <p className="text-error text-sm" role="alert">{error}</p>}
        {!preview && <Button className="w-fit" disabled={!text.trim() || busy || disabled} onClick={() => void review()}>{busy && <Loader2Icon className="animate-spin" />} {t("memory.reviewImport")}</Button>}
        {preview && <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium">{t("memory.reviewHeading", { count: preview.entries.length })}</h3>
            {preview.entries.length > 0 && <Button variant="ghost" size="sm" disabled={busy} onClick={() => setSelected(selected.size === preview.entries.length ? new Set() : new Set(preview.entries.map((_, index) => index)))}>{selected.size === preview.entries.length ? t("memory.deselectAll") : t("common.selectAll")}</Button>}
          </div>
          {preview.warnings.map((warning, index) => <p key={index} className="text-muted-foreground text-xs" role="status">{warning}</p>)}
          {preview.entries.length === 0 && <p className="text-muted-foreground text-sm">{t("memory.noNewMemories")}</p>}
          <div className="divide-border max-h-80 divide-y overflow-y-auto">
            {preview.entries.map((entry, index) => <label key={index} className="flex cursor-pointer items-start gap-3 py-3 text-sm">
              <input type="checkbox" checked={selected.has(index)} disabled={busy} onChange={(e) => setSelected((current) => { const next = new Set(current); if (e.target.checked) next.add(index); else next.delete(index); return next; })} className="accent-primary mt-1 size-4 shrink-0" />
              <span className="min-w-0 whitespace-pre-wrap break-words">{entry.content}{entry.scope && <span className="text-muted-foreground mt-1 block text-xs">{t("memory.projectMemory")}</span>}</span>
            </label>)}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button disabled={selected.size === 0 || busy || disabled} onClick={() => void save()}>{busy && <Loader2Icon className="animate-spin" />} {t("memory.importSelected", { count: selected.size })}</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setPreview(null)}>{t("memory.backToText")}</Button>
          </div>
        </div>}
      </div>
    </SettingsSection>
  );
}

function SummaryView({ summary, label, busy, onRefresh }: { summary: MemorySummary; label: string; busy: boolean; onRefresh: () => void }) {
  return (
    <div className="flex flex-col gap-2 p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">{label}</h3>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onRefresh}>{busy ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />} {t("memory.rewrite")}</Button>
      </div>
      {summary.content
        ? <SimpleMarkdown className="text-sm">{summary.content}</SimpleMarkdown>
        : <p className="text-muted-foreground text-sm">{summary.error ? t("memory.summaryError", { error: summary.error }) : t("memory.summaryWriting")}</p>}
      <p className="text-muted-foreground text-xs">
        {(() => {
          const base = summary.updatedAt ? t("memory.summaryWritten", { date: formatDateTime(summary.updatedAt) }) : t("memory.summaryNotWritten");
          return summary.content && summary.stale ? t("memory.summaryStale", { base }) : base;
        })()}
      </p>
    </div>
  );
}

export function MemorySettings() {
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const projects = useData((s) => s.projects);

  const reload = async () => {
    setLoadError(null);
    try { setSnapshot(await api<MemorySnapshot>("/memory")); }
    catch (e) { setLoadError((e as Error).message); }
  };
  useEffect(() => {
    let active = true;
    void api<MemorySnapshot>("/memory").then((next) => { if (active) setSnapshot(next); }).catch((e: Error) => { if (active) setLoadError(e.message); });
    return () => { active = false; };
  }, []);

  const mutate = async (operation: () => Promise<unknown>, message?: string) => {
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      await operation();
      const next = await api<MemorySnapshot>("/memory");
      setSnapshot(next);
      setEditing(null);
      setDeleting(null);
      setConfirmClear(false);
      if (message) setNotice(message);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const preferences = (patch: Partial<MemoryPreferences>) => mutate(async () => {
    await api("/memory/preferences", { method: "PATCH", json: patch });
    window.dispatchEvent(new Event("okaychat:memory"));
  });
  const refresh = async (scope: string | null) => {
    setRefreshing(scope ?? "");
    setError(null);
    try {
      const { summaries } = await api<{ summaries: MemorySummary[] }>("/memory/summaries/refresh", { method: "POST", json: { scope } });
      setSnapshot((current) => current && { ...current, summaries });
    } catch (e) { setError((e as Error).message); }
    finally { setRefreshing(null); }
  };
  const save = (content: string, entry?: MemoryEntry) => mutate(() => api(entry ? `/memory/${entry.id}` : "/memory", { method: entry ? "PATCH" : "POST", json: { content } }), t("memory.memorySaved"));
  const filtered = snapshot?.entries.filter((entry) => `${entry.content} ${t(SOURCE_LABELS[entry.source])}`.toLowerCase().includes(query.toLowerCase().trim())) ?? [];

  return (
    <SettingsPage title={t("memory.title")} description={t("memory.description")}>
      {loadError && <div className="flex flex-wrap items-center gap-3" role="alert"><p className="text-error text-sm">{t("memory.loadFailed", { error: loadError })}</p><Button variant="outline" onClick={() => void reload()}>{t("common.tryAgain")}</Button></div>}
      {!snapshot && !loadError && <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status"><Loader2Icon className="size-4 animate-spin" /> {t("memory.loadingMemories")}</p>}
      {error && <p className="text-error text-sm" role="alert">{error}</p>}
      {notice && <p className="text-muted-foreground text-sm" role="status">{notice}</p>}
      {snapshot && <SettingsSection title={t("memory.controlsTitle")}>
        <SettingsRow label={t("memory.useMemory")} description={t("memory.useMemoryDescription")} control={<Switch aria-label={t("memory.useMemory")} checked={snapshot.preferences.enabled} disabled={busy} onCheckedChange={(enabled) => void preferences({ enabled })} />} />
        <SettingsRow
          label={t("memory.autoSave")}
          className={!snapshot.preferences.enabled ? "text-muted-foreground" : undefined}
          description={<span id="memory-auto-save-description">{snapshot.preferences.enabled
            ? t("memory.autoSaveDescription")
            : t("memory.autoSaveDisabled")}</span>}
          control={<Switch aria-label={t("memory.autoSave")} aria-describedby="memory-auto-save-description" checked={snapshot.preferences.autoSave} disabled={busy || !snapshot.preferences.enabled} onCheckedChange={(autoSave) => void preferences({ autoSave })} />}
        />
        <SettingsRow
          label={t("memory.searchPastChats")}
          className={!snapshot.preferences.enabled ? "text-muted-foreground" : undefined}
          description={t("memory.searchPastChatsDescription")}
          control={<Switch aria-label={t("memory.searchPastChats")} checked={snapshot.preferences.chatSearch} disabled={busy || !snapshot.preferences.enabled} onCheckedChange={(chatSearch) => void preferences({ chatSearch })} />}
        />
        <p className="text-muted-foreground px-4 py-3 text-xs">{t("memory.privacyNote")}</p>
      </SettingsSection>}
      {snapshot && snapshot.entries.length > 0 && <SettingsSection title={t("memory.summaryTitle")} description={t("memory.summaryDescription")}>
        {snapshot.summaries.length === 0 && <p className="text-muted-foreground px-4 py-6 text-sm">{snapshot.preferences.enabled ? t("memory.summaryPending") : t("memory.summaryNeedsMemory")}</p>}
        {snapshot.summaries.map((summary) => <SummaryView key={summary.scope ?? ""} summary={summary} busy={refreshing === (summary.scope ?? "")}
          label={summary.scope ? projects.find((project) => project.id === summary.scope)?.name ?? t("memory.project") : t("memory.allChats")}
          onRefresh={() => void refresh(summary.scope)} />)}
      </SettingsSection>}
      {snapshot && <SettingsSection title={t("memory.savedTitle", { count: snapshot.entries.length })} description={snapshot.preferences.enabled ? t("memory.savedDescription") : t("memory.savedPaused")} action={editing !== "new" && <Button size="sm" variant="outline" disabled={busy} onClick={() => { setEditing("new"); setDeleting(null); }}><PlusIcon /> {t("memory.addMemory")}</Button>}>
        {snapshot.entries.length > 0 && <div className="p-3"><Input type="search" aria-label={t("memory.searchMemories")} placeholder={t("memory.searchMemoriesPlaceholder")} value={query} onChange={(e) => setQuery(e.target.value)} /></div>}
        {editing === "new" && <MemoryEditor busy={busy} onSave={(content) => void save(content)} onCancel={() => setEditing(null)} />}
        {snapshot.entries.length === 0 && editing !== "new" && <p className="text-muted-foreground px-4 py-6 text-sm">{t("memory.noMemories")}</p>}
        {snapshot.entries.length > 0 && filtered.length === 0 && <p className="text-muted-foreground px-4 py-6 text-sm">{t("memory.noMatches")}</p>}
        {filtered.map((entry) => editing === entry.id ? <MemoryEditor key={entry.id} initial={entry.content} busy={busy} onSave={(content) => void save(content, entry)} onCancel={() => setEditing(null)} /> : <div key={entry.id} className="flex flex-col gap-2 p-4">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="whitespace-pre-wrap break-words text-sm">{entry.content}</p>
              <p className="text-muted-foreground mt-2 text-xs">{t("memory.entryMeta", { source: t(SOURCE_LABELS[entry.source]), scope: entry.scope ? projects.find((project) => project.id === entry.scope)?.name ?? t("memory.deletedProject") : t("memory.allChats"), date: formatDate(entry.updatedAt) })}</p>
            </div>
            <div className="flex shrink-0 gap-1">
              <Button size="icon-sm" variant="ghost" aria-label={t("memory.editMemory", { content: entry.content.slice(0, 60) })} disabled={busy} onClick={() => { setEditing(entry.id); setDeleting(null); }}><PencilIcon /></Button>
              <Button size="icon-sm" variant="ghost" aria-label={t("memory.deleteMemory", { content: entry.content.slice(0, 60) })} disabled={busy} onClick={() => setDeleting(entry.id)}><TrashIcon /></Button>
            </div>
          </div>
          {deleting === entry.id && <div className="flex flex-wrap items-center gap-2 text-xs"><span>{t("memory.deleteThisMemory")}</span><Button size="sm" variant="destructive" disabled={busy} onClick={() => void mutate(() => api(`/memory/${entry.id}`, { method: "DELETE" }), t("memory.memoryDeleted"))}>{t("memory.deleteMemoryButton")}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => setDeleting(null)}>{t("memory.keepIt")}</Button></div>}
        </div>)}
      </SettingsSection>}
      {snapshot && <MemoryImport disabled={busy} onImported={async (message) => { await reload(); setNotice(message); }} />}
      {snapshot && <SettingsSection title={t("memory.exportResetTitle")}>
        <div className="flex flex-col gap-3 p-4">
          <p className="text-muted-foreground text-sm">{t("memory.exportIntro")}</p>
          <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={snapshot.entries.length === 0} onClick={() => { window.location.assign("/api/memory/export?format=json"); }}><DownloadIcon /> {t("memory.exportJson")}</Button><Button variant="outline" disabled={snapshot.entries.length === 0} onClick={() => { window.location.assign("/api/memory/export?format=text"); }}><DownloadIcon /> {t("memory.exportText")}</Button></div>
          <p className="text-muted-foreground text-xs">{t("memory.exportNote")}</p>
        </div>
        <div className="flex flex-col gap-3 p-4">
          <p className="text-muted-foreground text-sm">{t("memory.deleteAllIntro")}</p>
          {!confirmClear ? <Button variant="destructive" className="w-fit" disabled={busy || snapshot.entries.length === 0} onClick={() => setConfirmClear(true)}><TrashIcon /> {t("memory.deleteAll")}</Button> : <div className="flex flex-wrap items-center gap-2"><span className="text-sm">{t("memory.deleteAllConfirm", { count: snapshot.entries.length })}</span><Button variant="destructive" disabled={busy} onClick={() => void mutate(() => api("/memory", { method: "DELETE" }), t("memory.allMemoriesDeleted"))}>{t("memory.deleteAllButton")}</Button><Button variant="ghost" disabled={busy} onClick={() => setConfirmClear(false)}>{t("common.cancel")}</Button></div>}
        </div>
      </SettingsSection>}
    </SettingsPage>
  );
}
