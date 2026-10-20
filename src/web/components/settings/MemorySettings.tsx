import { CheckIcon, CopyIcon, DownloadIcon, Loader2Icon, PencilIcon, PlusIcon, TrashIcon, UploadIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MemoryEntry, MemoryImportPreview, MemoryImportSource, MemoryPreferences, MemorySnapshot } from "@shared/memory";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { useData } from "@/state/data";
import { SettingsPage, SettingsRow, SettingsSection } from "./SettingsUI";

const SOURCE_LABELS = { manual: "Added by you", conversation: "Conversation", claude: "Claude", chatgpt: "ChatGPT", okaychat: "okaychat" };
const EXPORT_PROMPT = "I am moving my context to another assistant. Export the memories and preferences you can access about me as a plain Markdown list, with one fact per item. Include my response preferences, recurring projects, tools, and durable personal context. Preserve dates when known. Exclude passwords, tokens, financial identifiers, and other secrets. Distinguish confirmed facts from uncertainty, and say if the export may be incomplete.";
const MAX_IMPORT_CHARS = 200_000;

function MemoryEditor({ initial = "", busy, onSave, onCancel }: { initial?: string; busy: boolean; onSave: (content: string) => void; onCancel: () => void }) {
  const [content, setContent] = useState(initial);
  return (
    <form className="flex flex-col gap-3 p-4" onSubmit={(e) => { e.preventDefault(); onSave(content.trim()); }}>
      <label className="text-sm font-medium" htmlFor="memory-content">Memory</label>
      <Textarea id="memory-content" value={content} onChange={(e) => setContent(e.target.value)} maxLength={2000} required autoFocus disabled={busy} className="min-h-24" placeholder="e.g. I prefer concise answers with TypeScript examples." />
      <p className="text-muted-foreground text-xs">One lasting fact or preference, up to 2,000 characters.</p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" disabled={busy || !content.trim()}>{busy && <Loader2Icon className="animate-spin" />} Save memory</Button>
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
      if (file.size > MAX_IMPORT_CHARS * 4) throw new Error("Choose a text, Markdown, or okaychat JSON file with up to 200,000 characters.");
      const value = await file.text();
      if (value.length > MAX_IMPORT_CHARS) throw new Error("The file is too long. Keep it under 200,000 characters.");
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
      if (text.length > MAX_IMPORT_CHARS) throw new Error("The import is too long. Keep it under 200,000 characters.");
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
      await onImported(`${result.imported} ${result.imported === 1 ? "memory" : "memories"} imported${result.skipped ? `; ${result.skipped} duplicates skipped` : ""}.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copyPrompt = async () => {
    try {
      // Clipboard access is unavailable on the app's plain-HTTP tailnet origins.
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(EXPORT_PROMPT);
      else {
        const field = document.createElement("textarea");
        field.value = EXPORT_PROMPT;
        field.style.position = "fixed";
        field.style.opacity = "0";
        document.body.append(field);
        field.select();
        const succeeded = document.execCommand("copy");
        field.remove();
        if (!succeeded) throw new Error("Copy is unavailable in this browser. Select the prompt below and copy it manually.");
      }
      setCopied(true);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2500);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <SettingsSection title="Bring your memories" description="Move context from Claude, ChatGPT, or another okaychat account.">
      <div className="flex flex-col gap-4 p-4">
        <p className="text-muted-foreground text-sm">Ask your previous assistant to export its memories, then paste the result here. You review every entry before saving. An export may be incomplete.</p>
        <details className="text-sm">
          <summary className="cursor-pointer font-medium">How to export from another assistant</summary>
          <div className="mt-3 flex flex-col gap-3">
            <p className="text-muted-foreground text-xs">In Claude, open memory settings and copy what it remembers, or ask for an export. In ChatGPT, inspect saved memories in personalization settings and ask for the accessible facts as a list.</p>
            <Textarea aria-label="Memory export prompt" value={EXPORT_PROMPT} readOnly className="min-h-36 text-xs" />
            <Button variant="outline" className="w-fit" onClick={() => void copyPrompt()}>{copied ? <CheckIcon /> : <CopyIcon />}{copied ? "Prompt copied" : "Copy export prompt"}</Button>
            <p className="text-muted-foreground text-xs">
              <a className="text-foreground underline underline-offset-4" href="https://support.claude.com/en/articles/12123587-import-and-export-your-memory-from-claude" target="_blank" rel="noreferrer">Claude transfer guide</a>
              {" · "}<a className="text-foreground underline underline-offset-4" href="https://learn.chatgpt.com/docs/personalize" target="_blank" rel="noreferrer">ChatGPT personalization</a>
            </p>
          </div>
        </details>
        <fieldset disabled={busy || disabled} className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <Select aria-label="Memory import source" className="sm:w-48" value={source} onValueChange={(value) => { setSource(value); setPreview(null); }} options={[{ value: "claude", label: "From Claude" }, { value: "chatgpt", label: "From ChatGPT" }, { value: "okaychat", label: "From okaychat" }, { value: "manual", label: "Other text" }]} />
          <input ref={fileInput} type="file" hidden accept=".txt,.md,.markdown,.json,text/plain,text/markdown,application/json" onChange={(e) => void readFile(e.target.files?.[0])} />
          <Button variant="outline" disabled={busy || disabled} onClick={() => fileInput.current?.click()}><UploadIcon /> Choose text file</Button>
        </fieldset>
        <label htmlFor="memory-import" className="text-sm font-medium">Exported memories</label>
        <Textarea id="memory-import" value={text} onChange={(e) => changeText(e.target.value)} disabled={busy || disabled} className="min-h-32" placeholder="Paste a list of memories or an okaychat JSON export…" />
        <p className="text-muted-foreground text-xs">Text, Markdown, or okaychat JSON, up to 200,000 characters and 500 entries. Each memory can contain up to 2,000 characters. Full chat archives are not supported.</p>
        {error && <p className="text-error text-sm" role="alert">{error}</p>}
        {!preview && <Button className="w-fit" disabled={!text.trim() || busy || disabled} onClick={() => void review()}>{busy && <Loader2Icon className="animate-spin" />} Review import</Button>}
        {preview && <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium">Review {preview.entries.length} {preview.entries.length === 1 ? "memory" : "memories"}</h3>
            {preview.entries.length > 0 && <Button variant="ghost" size="sm" disabled={busy} onClick={() => setSelected(selected.size === preview.entries.length ? new Set() : new Set(preview.entries.map((_, index) => index)))}>{selected.size === preview.entries.length ? "Deselect all" : "Select all"}</Button>}
          </div>
          {preview.warnings.map((warning, index) => <p key={index} className="text-muted-foreground text-xs" role="status">{warning}</p>)}
          {preview.entries.length === 0 && <p className="text-muted-foreground text-sm">No new memories found. Check the text or try a different export.</p>}
          <div className="divide-border max-h-80 divide-y overflow-y-auto">
            {preview.entries.map((entry, index) => <label key={index} className="flex cursor-pointer items-start gap-3 py-3 text-sm">
              <input type="checkbox" checked={selected.has(index)} disabled={busy} onChange={(e) => setSelected((current) => { const next = new Set(current); if (e.target.checked) next.add(index); else next.delete(index); return next; })} className="accent-primary mt-1 size-4 shrink-0" />
              <span className="min-w-0 whitespace-pre-wrap break-words">{entry.content}{entry.scope && <span className="text-muted-foreground mt-1 block text-xs">Project memory</span>}</span>
            </label>)}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button disabled={selected.size === 0 || busy || disabled} onClick={() => void save()}>{busy && <Loader2Icon className="animate-spin" />} Import {selected.size} selected</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setPreview(null)}>Back to text</Button>
          </div>
        </div>}
      </div>
    </SettingsSection>
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
  const save = (content: string, entry?: MemoryEntry) => mutate(() => api(entry ? `/memory/${entry.id}` : "/memory", { method: entry ? "PATCH" : "POST", json: { content } }), "Memory saved.");
  const filtered = snapshot?.entries.filter((entry) => `${entry.content} ${SOURCE_LABELS[entry.source]}`.toLowerCase().includes(query.toLowerCase().trim())) ?? [];

  return (
    <SettingsPage title="Memory" description="Carry useful facts and preferences into future chats, across models and providers.">
      {loadError && <div className="flex flex-wrap items-center gap-3" role="alert"><p className="text-error text-sm">Could not load memories: {loadError}</p><Button variant="outline" onClick={() => void reload()}>Try again</Button></div>}
      {!snapshot && !loadError && <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status"><Loader2Icon className="size-4 animate-spin" /> Loading memories…</p>}
      {error && <p className="text-error text-sm" role="alert">{error}</p>}
      {notice && <p className="text-muted-foreground text-sm" role="status">{notice}</p>}
      {snapshot && <SettingsSection title="Memory controls">
        <SettingsRow label="Use memory" description="Include saved facts in your chats. Turning this off pauses use and saving without deleting anything." control={<Switch aria-label="Use memory" checked={snapshot.preferences.enabled} disabled={busy} onCheckedChange={(enabled) => void preferences({ enabled })} />} />
        <SettingsRow label="Save memories automatically" description="Let the assistant save lasting facts you share. When off, ask it to remember something and approve the change in chat." control={<Switch aria-label="Save memories automatically" checked={snapshot.preferences.autoSave} disabled={busy || !snapshot.preferences.enabled} onCheckedChange={(autoSave) => void preferences({ autoSave })} />} />
        <p className="text-muted-foreground px-4 py-3 text-xs">Memories belong to your account. When used, they are sent to your selected model provider. Automatic saving requires a model with tool support and is selective. Deleting a chat does not delete its saved memories.</p>
      </SettingsSection>}
      {snapshot && <SettingsSection title={`Saved memories (${snapshot.entries.length})`} description={snapshot.preferences.enabled ? "Review and correct what the assistant remembers." : "Memory is paused. You can still manage and import saved facts."} action={editing !== "new" && <Button size="sm" variant="outline" disabled={busy} onClick={() => { setEditing("new"); setDeleting(null); }}><PlusIcon /> Add memory</Button>}>
        {snapshot.entries.length > 0 && <div className="p-3"><Input type="search" aria-label="Search memories" placeholder="Search memories…" value={query} onChange={(e) => setQuery(e.target.value)} /></div>}
        {editing === "new" && <MemoryEditor busy={busy} onSave={(content) => void save(content)} onCancel={() => setEditing(null)} />}
        {snapshot.entries.length === 0 && editing !== "new" && <p className="text-muted-foreground px-4 py-6 text-sm">No memories yet. Add a preference, import your existing context, or enable memory and ask the assistant to remember something.</p>}
        {snapshot.entries.length > 0 && filtered.length === 0 && <p className="text-muted-foreground px-4 py-6 text-sm">No memories match your search.</p>}
        {filtered.map((entry) => editing === entry.id ? <MemoryEditor key={entry.id} initial={entry.content} busy={busy} onSave={(content) => void save(content, entry)} onCancel={() => setEditing(null)} /> : <div key={entry.id} className="flex flex-col gap-2 p-4">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="whitespace-pre-wrap break-words text-sm">{entry.content}</p>
              <p className="text-muted-foreground mt-2 text-xs">{SOURCE_LABELS[entry.source]} · {entry.scope ? projects.find((project) => project.id === entry.scope)?.name ?? "Deleted project" : "All chats"} · Updated {new Date(entry.updatedAt).toLocaleDateString()}</p>
            </div>
            <div className="flex shrink-0 gap-1">
              <Button size="icon-sm" variant="ghost" aria-label={`Edit memory: ${entry.content.slice(0, 60)}`} disabled={busy} onClick={() => { setEditing(entry.id); setDeleting(null); }}><PencilIcon /></Button>
              <Button size="icon-sm" variant="ghost" aria-label={`Delete memory: ${entry.content.slice(0, 60)}`} disabled={busy} onClick={() => setDeleting(entry.id)}><TrashIcon /></Button>
            </div>
          </div>
          {deleting === entry.id && <div className="flex flex-wrap items-center gap-2 text-xs"><span>Delete this memory?</span><Button size="sm" variant="destructive" disabled={busy} onClick={() => void mutate(() => api(`/memory/${entry.id}`, { method: "DELETE" }), "Memory deleted.")}>Delete memory</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => setDeleting(null)}>Keep it</Button></div>}
        </div>)}
      </SettingsSection>}
      {snapshot && <MemoryImport disabled={busy} onImported={async (message) => { await reload(); setNotice(message); }} />}
      {snapshot && <SettingsSection title="Export and reset">
        <div className="flex flex-col gap-3 p-4">
          <p className="text-muted-foreground text-sm">Save a JSON backup for okaychat, or export readable text to copy into Claude or ChatGPT. Follow the destination's memory controls and review what it saves.</p>
          <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={snapshot.entries.length === 0} onClick={() => { window.location.assign("/api/memory/export?format=json"); }}><DownloadIcon /> Export JSON</Button><Button variant="outline" disabled={snapshot.entries.length === 0} onClick={() => { window.location.assign("/api/memory/export?format=text"); }}><DownloadIcon /> Export text</Button></div>
          <p className="text-muted-foreground text-xs">For Claude, paste the text into its memory import screen. For ChatGPT, paste the facts into a chat and ask it to remember them; support depends on your account. These are manual transfers.</p>
        </div>
        <div className="flex flex-col gap-3 p-4">
          <p className="text-muted-foreground text-sm">Delete saved memories from this account. Existing chats and exported copies keep their contents.</p>
          {!confirmClear ? <Button variant="destructive" className="w-fit" disabled={busy || snapshot.entries.length === 0} onClick={() => setConfirmClear(true)}><TrashIcon /> Delete all memories</Button> : <div className="flex flex-wrap items-center gap-2"><span className="text-sm">Permanently delete all {snapshot.entries.length} memories?</span><Button variant="destructive" disabled={busy} onClick={() => void mutate(() => api("/memory", { method: "DELETE" }), "All memories deleted.")}>Delete all</Button><Button variant="ghost" disabled={busy} onClick={() => setConfirmClear(false)}>Cancel</Button></div>}
        </div>
      </SettingsSection>}
    </SettingsPage>
  );
}
