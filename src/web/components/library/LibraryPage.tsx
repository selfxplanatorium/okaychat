import { DownloadIcon, FileCodeIcon, FileSpreadsheetIcon, FileTextIcon, ImageIcon, LayoutGridIcon, ListIcon, Loader2Icon, MessageCircleIcon, PaperclipIcon, SearchIcon, TrashIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { useLocation } from "wouter";
import { useAui } from "@assistant-ui/react";
import type { ArtifactVersion, LibraryItem, LibraryKind, LibraryPage, LibrarySort } from "@shared/types";
import { DocxPreview, DocumentPreview } from "@/components/artifacts/DocumentPreview";
import { FRAME_SANDBOX, artifactFilename, frameDocument } from "@/components/artifacts/frame";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SimpleMarkdown } from "@/components/ui/simple-markdown";
import { Delayed, Skeleton } from "@/components/ui/skeleton";
import { BulkDeleteDialog, FloatingSelectionBar, SelectionCheck, SelectModeToggle, useSelection, useSelectionKeys } from "@/components/ui/selection";
import { api } from "@/lib/api";
import { batchError, runBatch } from "@/lib/selection";
import { cn } from "@/lib/utils";
import { useData } from "@/state/data";
import { cachedLibraryPage, DEFAULT_LIBRARY_QUERY, fetchLibraryFirstPage, forgetLibraryPages } from "@/state/library-cache";
import { ArchivedChats } from "./ArchivedChats";

// The Library lists everything the agent received or produced for this account: uploads, generated
// images, and the latest version of every artifact. Server-side filtering and cursor pagination do
// the work; the page only accumulates pages and keeps its view mode per device.

const VIEW_KEY = "okaychat:library-view";

const KIND_LABELS: Record<LibraryKind, string> = {
  image: "Images",
  document: "Word files",
  pdf: "PDFs",
  spreadsheet: "Spreadsheets",
  code: "Code & artifacts",
  other: "Other files",
};

const KIND_ICONS: Record<LibraryKind, typeof FileTextIcon> = {
  image: ImageIcon,
  document: FileTextIcon,
  pdf: FileTextIcon,
  spreadsheet: FileSpreadsheetIcon,
  code: FileCodeIcon,
  other: PaperclipIcon,
};

const formatSize = (bytes: number) => {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024).toLocaleString()} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const formatDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { dateStyle: "medium" });

async function downloadUrl(name: string, url: string) {
  const blob = await fetch(url, { credentials: "same-origin" }).then((r) => { if (!r.ok) throw new Error("Could not download the file."); return r.blob(); });
  const href = URL.createObjectURL(blob);
  Object.assign(document.createElement("a"), { href, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

function downloadText(name: string, content: string, mime: string) {
  const href = URL.createObjectURL(new Blob([content], { type: mime }));
  Object.assign(document.createElement("a"), { href, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

const downloadable = (item: LibraryItem) => Boolean(item.downloadUrl || item.artifactId);

async function downloadItem(item: LibraryItem) {
  if (item.downloadUrl) return downloadUrl(item.name, item.downloadUrl);
  // Text artifacts have no bytes endpoint; their latest version's content is the file.
  const versions = await api<ArtifactVersion[]>(`/threads/${encodeURIComponent(item.threadId!)}/artifacts/${encodeURIComponent(item.artifactId!)}`);
  const v = versions.at(-1);
  if (v) downloadText(artifactFilename(v.title, v.kind, v.language), v.content, v.kind === "html" ? "text/html" : v.kind === "svg" ? "image/svg+xml" : "text/plain");
}

const deleteItem = (item: LibraryItem) =>
  api(`/library/${item.id.split(":")[0]}/${encodeURIComponent(item.id.slice(item.id.indexOf(":") + 1))}`, { method: "DELETE" });

/** Item actions: download bytes or source, jump to the chat that produced the item, delete. */
function ItemActions({ item, onDeleted }: { item: LibraryItem; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    try {
      await deleteItem(item);
      void useData.getState().refreshStorage().catch(() => {});
      onDeleted();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete file.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {error && <p role="alert" className="text-destructive text-xs">{error}</p>}
      {downloadable(item) && (
        <Button variant="outline" size="sm" onClick={() => void downloadItem(item).catch((e: Error) => setError(e.message))}>
          <DownloadIcon /> Download
        </Button>
      )}
      {item.threadId ? <OpenChatButton threadId={item.threadId} /> : null}
      {item.deletable ? (
        <Button variant="destructive" size="sm" onClick={remove} disabled={busy}>
          {confirming ? (
            <>Really delete?</>
          ) : (
            <>
              <TrashIcon /> Delete
            </>
          )}
        </Button>
      ) : null}
    </>
  );
}

/** From a navigation page: reload the thread list, enter the chat, and select the thread. */
function OpenChatButton({ threadId }: { threadId: string }) {
  const aui = useAui();
  const [, navigate] = useLocation();
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={async () => {
        useData.getState().setActiveProject(null);
        await aui.threads.reload();
        navigate("/");
        aui.threads.switchToThread(threadId);
      }}
    >
      <MessageCircleIcon /> Open chat
    </Button>
  );
}

/** Latest version of an artifact, rendered like the chat's side panel. */
function ArtifactPreview({ item }: { item: LibraryItem }) {
  const [version, setVersion] = useState<ArtifactVersion | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api<ArtifactVersion[]>(`/threads/${encodeURIComponent(item.threadId!)}/artifacts/${encodeURIComponent(item.artifactId!)}`)
      .then((versions) => !cancelled && setVersion(versions.at(-1) ?? null))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [item.threadId, item.artifactId]);
  if (error) return <p className="text-muted-foreground p-4 text-sm">{error}</p>;
  if (!version) {
    return (
      <div className="text-muted-foreground flex h-24 items-center justify-center gap-2 text-sm">
        <Loader2Icon className="size-4 animate-spin" /> Loading {item.name}
      </div>
    );
  }
  const kind = item.artifactKind!;
  const docKind = kind === "pdf" || kind === "docx" || kind === "xlsx" ? kind : null;
  if (docKind) {
    const base = `/api/threads/${encodeURIComponent(item.threadId!)}/artifacts/${encodeURIComponent(item.artifactId!)}`;
    return (
      <DocumentPreview
        kind={docKind}
        fileUrl={`${base}/file?version=${version.version}`}
        previewUrl={`${base}/preview?version=${version.version}`}
        title={item.name}
      />
    );
  }
  const doc = frameDocument(kind, version.content);
  if (doc) return <iframe title={item.name} sandbox={FRAME_SANDBOX} srcDoc={doc} className="h-full w-full border-0 bg-white" />;
  if (kind === "markdown") return <SimpleMarkdown className="h-full overflow-auto px-6 py-4">{version.content}</SimpleMarkdown>;
  return <pre className="h-full overflow-auto p-4 font-mono text-xs leading-relaxed">{version.content}</pre>;
}

function ItemPreviewBody({ item }: { item: LibraryItem }) {
  if (item.kind === "image" && item.previewUrl) {
    return (
      <div className="flex h-full items-center justify-center bg-muted/30 p-2 sm:p-4">
        <img src={item.previewUrl} alt={item.name} className="max-h-full max-w-full rounded-lg object-contain shadow-[var(--depth-highlight),var(--shadow-raised)]" />
      </div>
    );
  }
  if (item.artifactId) return <ArtifactPreview item={item} />;
  if (item.kind === "spreadsheet" && item.previewUrl && item.downloadUrl) {
    return <DocumentPreview kind="xlsx" fileUrl={item.downloadUrl} previewUrl={item.previewUrl} title={item.name} />;
  }
  if (item.previewUrl && item.kind !== "pdf") return <TextFilePreview url={item.previewUrl} />;
  if (item.previewUrl) {
    // Uploaded PDFs use the browser's own viewer; uploaded images are covered above.
    return <iframe title={item.name} src={item.previewUrl} className="h-full w-full border-0 bg-white" />;
  }
  if (item.kind === "document" && item.downloadUrl) return <DocxPreview url={item.downloadUrl} title={item.name} />;
  const Icon = KIND_ICONS[item.kind];
  return (
    <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3 text-sm">
      <Icon className="size-10" />
      <p>No inline preview. Download the file to view it.</p>
    </div>
  );
}

function TextFilePreview({ url }: { url: string }) {
  const [text, setText] = useState("Loading…");
  useEffect(() => {
    let active = true;
    fetch(url).then(async (r) => {
      if (!r.ok) throw new Error("Could not preview this file.");
      const body = await r.json() as { text: string; truncated?: boolean };
      if (active) setText(body.text + (body.truncated ? "\n[Preview truncated]" : ""));
    }).catch((e: Error) => { if (active) setText(e.message); });
    return () => { active = false; };
  }, [url]);
  return <pre className="h-full overflow-auto whitespace-pre-wrap p-4 font-mono text-xs">{text}</pre>;
}

function ItemPreviewDialog({ item, onClose, onDeleted }: { item: LibraryItem | null; onClose: () => void; onDeleted: () => void }) {
  return (
    <Dialog open={!!item} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="h-[85dvh] grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] gap-0 p-0 sm:max-w-3xl">
        {item && (
          <>
            {/* Phones stack the actions under the title so neither squeezes the other. */}
            <div className="flex shrink-0 flex-col gap-2 border-b px-4 py-3 sm:flex-row sm:items-center sm:gap-3 sm:pr-12">
              <div className="min-w-0 pr-8 sm:flex-1 sm:pr-0">
                <DialogTitle className="truncate text-sm font-medium">{item.name}</DialogTitle>
                <p className="text-muted-foreground truncate text-xs">
                  {KIND_LABELS[item.kind]} · {formatSize(item.size)} · {formatDate(item.createdAt)}
                  {item.threadTitle ? ` · ${item.threadTitle}` : ""}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <ItemActions item={item} onDeleted={() => {
                  onDeleted();
                  onClose();
                }} />
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              <ItemPreviewBody item={item} />
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** In selection mode a card or row is a checkbox; Shift extends the range from the last one clicked. */
type ItemSelection = { selected: boolean; onToggle: (range: boolean) => void };

const pressProps = (selection: ItemSelection | undefined, onOpen: () => void) =>
  selection
    ? {
        role: "checkbox" as const,
        "aria-checked": selection.selected,
        // Without this Shift+click would also select the text between the two clicks.
        onMouseDown: (event: ReactMouseEvent) => event.shiftKey && event.preventDefault(),
        onClick: (event: ReactMouseEvent) => selection.onToggle(event.shiftKey),
      }
    : { onClick: onOpen };

function GridCard({ item, onOpen, selection }: { item: LibraryItem; onOpen: () => void; selection?: ItemSelection }) {
  const Icon = KIND_ICONS[item.kind];
  return (
    <button
      type="button"
      {...pressProps(selection, onOpen)}
      className={cn(
        "bg-card hover:bg-accent/40 group relative flex flex-col overflow-hidden rounded-xl text-left shadow-[var(--depth-highlight),var(--shadow-raised)] ring-0 ring-primary transition-[background-color,box-shadow] duration-(--motion-fast) ease-out-quart outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        selection?.selected && "bg-primary/5 ring-2 focus-visible:ring-primary",
      )}
    >
      {selection && <SelectionCheck checked={selection.selected} className="absolute top-2 left-2 z-10 size-5 shadow-[var(--shadow-raised)]" />}
      <div className="bg-muted/30 grid aspect-[4/3] place-items-center overflow-hidden">
        {item.kind === "image" && item.previewUrl ? (
          <img src={item.previewUrl} alt="" loading="lazy" className="size-full object-cover" />
        ) : (
          <Icon className="text-muted-foreground size-8 transition-transform duration-(--motion-base) ease-spring group-hover:scale-110" />
        )}
      </div>
      <div className="flex flex-col gap-0.5 px-3 py-2">
        <span className="truncate text-sm">{item.name}</span>
        <span className="text-muted-foreground truncate text-xs">
          {KIND_LABELS[item.kind]} · {formatSize(item.size)} · {formatDate(item.createdAt)}
        </span>
      </div>
    </button>
  );
}

function ListRow({ item, onOpen, selection }: { item: LibraryItem; onOpen: () => void; selection?: ItemSelection }) {
  const Icon = KIND_ICONS[item.kind];
  return (
    <button
      type="button"
      {...pressProps(selection, onOpen)}
      className={cn(
        "hover:bg-accent/40 flex w-full items-center gap-3 px-3 py-2 text-left transition-colors duration-(--motion-fast) ease-out-quart first:rounded-t-xl last:rounded-b-xl outline-none focus-visible:bg-accent/40 pointer-coarse:px-4 pointer-coarse:py-3",
        selection?.selected && "bg-primary/10 hover:bg-primary/15",
      )}
    >
      {selection && <SelectionCheck checked={selection.selected} />}
      <Icon className="text-muted-foreground size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-sm">{item.name}</span>
      <span className="text-muted-foreground hidden w-28 shrink-0 truncate text-xs sm:block">{KIND_LABELS[item.kind]}</span>
      <span className="text-muted-foreground hidden w-20 shrink-0 text-xs tabular-nums sm:block">{formatSize(item.size)}</span>
      <span className="text-muted-foreground hidden w-36 shrink-0 truncate text-xs md:block">{item.threadTitle ?? "—"}</span>
      <span className="text-muted-foreground w-24 shrink-0 text-right text-xs tabular-nums">{formatDate(item.createdAt)}</span>
    </button>
  );
}

type LibrarySection = "files" | "archived";

/**
 * Files and archived chats share the page; the switch sits under each section's header. Both stay mounted,
 * so switching shows the loaded list at once instead of refetching behind a skeleton.
 */
export function LibraryPage() {
  const [section, setSection] = useState<LibrarySection>("files");
  const tabs = <LibrarySectionSwitch section={section} onChange={setSection} />;
  return (
    <>
      <div hidden={section !== "files"} className="contents">
        <LibraryFiles tabs={tabs} />
      </div>
      <div hidden={section !== "archived"} className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 pt-6 pb-[max(2rem,env(safe-area-inset-bottom))] sm:px-6">
        <header>
          <h1 className="text-xl font-semibold tracking-tight">Library</h1>
          <p className="text-muted-foreground mt-1 text-sm">Archived chats from every project.</p>
        </header>
        <ArchivedChats tabs={tabs} />
      </div>
    </>
  );
}

function LibrarySectionSwitch({ section, onChange }: { section: LibrarySection; onChange: (section: LibrarySection) => void }) {
  return (
    <div aria-label="Library section" className="bg-muted/60 flex self-start rounded-lg p-0.5">
      {(["files", "archived"] as const).map((s) => (
        <button
          key={s}
          type="button"
          aria-pressed={section === s}
          onClick={() => onChange(s)}
          className={cn(
            "text-muted-foreground rounded-md px-3 py-1 text-sm transition-colors duration-(--motion-fast) ease-out-quart pointer-coarse:px-4 pointer-coarse:py-2",
            section === s && "bg-background text-foreground shadow-sm",
          )}
        >
          {s === "files" ? "Files" : "Archived chats"}
        </button>
      ))}
    </div>
  );
}

function LibraryFiles({ tabs }: { tabs: ReactNode }) {
  const projects = useData((s) => s.projects);
  const [view, setView] = useState<"grid" | "list">(() => (localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid"));
  const [kind, setKind] = useState<LibraryKind | "all">("all");
  const [source, setSource] = useState<"all" | "uploaded" | "generated">("all");
  const [project, setProject] = useState<"all" | string>("all");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<LibrarySort>("newest");
  // A visit after the first starts from the last result, refreshed in place by the load below.
  const [items, setItems] = useState<LibraryItem[] | null>(() => cachedLibraryPage(DEFAULT_LIBRARY_QUERY)?.items ?? null);
  const [cursor, setCursor] = useState<string | null>(() => cachedLibraryPage(DEFAULT_LIBRARY_QUERY)?.nextCursor ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<LibraryItem | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const requestId = useRef(0);

  const params = useMemo(() => {
    const p = new URLSearchParams({ sort });
    if (kind !== "all") p.set("kind", kind);
    if (source !== "all") p.set("source", source);
    if (project !== "all") p.set("project", project);
    if (query) p.set("q", query);
    return p;
  }, [kind, source, project, query, sort]);

  // Search debounces: the box edits freely, the query follows after a pause.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(
    async (nextCursor: string | null) => {
      // Only the newest request may write: a filter change while one is in flight must not mix pages.
      const id = ++requestId.current;
      setLoading(true);
      setError(null);
      try {
        const page = nextCursor
          ? await api<LibraryPage>(`/library?${params}&cursor=${encodeURIComponent(nextCursor)}`)
          : await fetchLibraryFirstPage(params.toString());
        if (id !== requestId.current) return;
        setItems((prev) => (nextCursor && prev ? [...prev, ...page.items] : page.items));
        setCursor(page.nextCursor);
      } catch (cause) {
        if (id === requestId.current) { setItems((prev) => prev ?? []); setError(cause instanceof Error ? cause.message : "Could not load files."); }
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [params],
  );

  // New filters restart paging; cursors are per filter set. The current items stay until the new page
  // arrives, so a filter switch never blanks the grid into a skeleton.
  useEffect(() => {
    setCursor(null);
    void load(null);
  }, [load]);

  // A filter's first page is loading over the previous filter's items. They dim only if it takes a while,
  // so quick responses swap in place without any visible step.
  const refreshing = loading && cursor === null && items !== null;
  const fade = cn("transition-opacity duration-(--motion-fast)", refreshing && "opacity-60 delay-300");

  // Infinite scroll with a real button fallback (keyboard, touch, reduced motion).
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !cursor || loading) return;
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && void load(cursor), { rootMargin: "400px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [cursor, loading, load]);

  const removeItem = (id: string) => {
    forgetLibraryPages();
    setItems((prev) => prev?.filter((i) => i.id !== id) ?? null);
    setOpen((prev) => (prev?.id === id ? null : prev));
  };

  const order = useMemo(() => items?.map((i) => i.id) ?? [], [items]);
  const selection = useSelection(order);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const selectedItems = useMemo(() => items?.filter((i) => selection.selected.has(i.id)) ?? [], [items, selection.selected]);
  const deletable = selectedItems.filter((i) => i.deletable);
  const [deleting, setDeleting] = useState({ count: 0, kept: 0 });
  // Select all means every match, not only the loaded pages, so it fetches the rest first.
  const everySelected = selection.allSelected && !cursor;

  const setSelecting = (on: boolean) => {
    selection.setMode(on);
    setBulkError(null);
  };

  const selectEverything = async () => {
    if (!cursor || !items) return selection.selectAll();
    const id = ++requestId.current;
    setLoading(true);
    setLoadingAll(true);
    setBulkError(null);
    try {
      let all = items;
      for (let next: string | null = cursor; next; ) {
        const page: LibraryPage = await api<LibraryPage>(`/library?${params}&cursor=${encodeURIComponent(next)}`);
        if (id !== requestId.current) return;
        all = [...all, ...page.items];
        next = page.nextCursor;
      }
      setItems(all);
      setCursor(null);
      selection.selectAll(all.map((i) => i.id));
    } catch (cause) {
      if (id === requestId.current) setBulkError(cause instanceof Error ? cause.message : "Could not load every file.");
    } finally {
      if (id === requestId.current) {
        setLoading(false);
        setLoadingAll(false);
      }
    }
  };

  useSelectionKeys(selection.selecting, { onExit: () => setSelecting(false), onSelectAll: () => void selectEverything() });

  const downloadSelected = async () => {
    const files = selectedItems.filter(downloadable);
    setBulkBusy(true);
    setBulkError(null);
    // One at a time: browsers drop downloads started in a burst.
    const { failed, error } = await runBatch(files, downloadItem, 1);
    if (failed.length) setBulkError(batchError(failed.length, files.length, "download", error));
    setBulkBusy(false);
  };

  const deleteSelected = async () => {
    const { failed, error } = await runBatch(deletable, deleteItem);
    const gone = new Set(deletable.filter((i) => !failed.includes(i)).map((i) => i.id));
    forgetLibraryPages();
    setItems((prev) => prev?.filter((i) => !gone.has(i.id)) ?? null);
    if (gone.size) void useData.getState().refreshStorage().catch(() => {});
    if (failed.length) {
      setDeleting((prev) => ({ ...prev, count: failed.length }));
      throw new Error(batchError(failed.length, deletable.length, "be deleted", error));
    }
    setSelecting(false);
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 pt-6 pb-[max(2rem,env(safe-area-inset-bottom))] sm:px-6">
      {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Library</h1>
          <p className="text-muted-foreground mt-1 text-sm">Every file your chats received or created, in one place.</p>
        </div>
        <div className="bg-muted/60 flex rounded-lg p-0.5">
          {(["grid", "list"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-label={v === "grid" ? "Grid view" : "List view"}
              aria-pressed={view === v}
              onClick={() => {
                setView(v);
                localStorage.setItem(VIEW_KEY, v);
              }}
              className={cn(
                "text-muted-foreground rounded-md p-1.5 transition-colors duration-(--motion-fast) ease-out-quart pointer-coarse:p-2.5",
                view === v && "bg-background text-foreground shadow-sm",
              )}
            >
              {v === "grid" ? <LayoutGridIcon className="size-4" /> : <ListIcon className="size-4" />}
            </button>
          ))}
        </div>
      </header>
      <div className="flex items-center justify-between gap-3">
        {tabs}
        <SelectModeToggle selecting={selection.selecting} onChange={setSelecting} disabled={!items?.length && !selection.selecting} />
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-1.5">
          {(["all", "image", "pdf", "spreadsheet", "document", "code", "other"] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={kind === k}
              onClick={() => setKind(k)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs transition-colors duration-(--motion-fast) ease-out-quart pointer-coarse:px-4 pointer-coarse:py-2",
                kind === k ? "depth-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {k === "all" ? "All" : KIND_LABELS[k]}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 basis-56">
            <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
            <Input value={search} onChange={(e) => setSearch(e.currentTarget.value)} placeholder="Search by name…" aria-label="Search the library" className="pl-8" />
          </div>
          <Select
            aria-label="Source"
            className="w-40"
            value={source}
            onValueChange={setSource}
            options={[
              { value: "all", label: "All sources" },
              { value: "uploaded", label: "Uploaded" },
              { value: "generated", label: "Created in chat" },
            ]}
          />
          <Select
            aria-label="Project"
            className="w-44"
            value={project}
            onValueChange={setProject}
            options={[{ value: "all", label: "All projects" }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
          />
          <Select
            aria-label="Sort"
            className="w-40"
            value={sort}
            onValueChange={setSort}
            options={[
              { value: "newest", label: "Newest" },
              { value: "oldest", label: "Oldest" },
              { value: "name", label: "Name" },
              { value: "size", label: "Size" },
            ]}
          />
        </div>
      </div>

      {items === null ? (
        <Delayed>
          <div className={cn("animate-fade-in", view === "grid" ? "grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" : "flex flex-col gap-2")}>
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className={view === "grid" ? "aspect-[4/3] rounded-xl" : "h-10 rounded-lg"} />
            ))}
          </div>
        </Delayed>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center py-16 text-center">
          <PaperclipIcon aria-hidden className="text-muted-foreground mb-5 size-8" />
          <h2 className="text-base font-medium">Nothing here yet</h2>
          <p className="text-muted-foreground mt-2 max-w-xs text-sm">Files you attach and things your chats create — images, documents, spreadsheets — collect here.</p>
        </div>
      ) : view === "grid" ? (
        <div aria-busy={refreshing} className={cn("grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4", fade)}>
          {items.map((item) => (
            <GridCard key={item.id} item={item} onOpen={() => setOpen(item)} selection={selection.selecting ? { selected: selection.selected.has(item.id), onToggle: (range) => selection.toggle(item.id, range) } : undefined} />
          ))}
        </div>
      ) : (
        <div aria-busy={refreshing} className={cn("bg-card divide-border rounded-xl divide-y shadow-[var(--depth-highlight),var(--shadow-raised)]", fade)}>
          {items.map((item) => (
            <ListRow key={item.id} item={item} onOpen={() => setOpen(item)} selection={selection.selecting ? { selected: selection.selected.has(item.id), onToggle: (range) => selection.toggle(item.id, range) } : undefined} />
          ))}
        </div>
      )}

      {cursor && (
        <div ref={sentinel} className="flex justify-center">
          <Button variant="outline" size="sm" disabled={loading} onClick={() => void load(cursor)}>
            {loading ? <Loader2Icon className="animate-spin" /> : null} Load more
          </Button>
        </div>
      )}

      {selection.selecting && (
        <FloatingSelectionBar
          count={selection.selected.size}
          allSelected={everySelected}
          selectAllBusy={loadingAll}
          onSelectAll={() => void selectEverything()}
          onClear={selection.clear}
          error={bulkError}
        >
          {bulkBusy && <Loader2Icon aria-label="Working" className="text-muted-foreground mx-1 size-4 animate-spin" />}
          <Button variant="ghost" size="sm" disabled={bulkBusy || !selectedItems.some(downloadable)} onClick={() => void downloadSelected()} className="pointer-coarse:h-10">
            <DownloadIcon /> Download
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={bulkBusy || deletable.length === 0}
            onClick={() => {
              setDeleting({ count: deletable.length, kept: selectedItems.length - deletable.length });
              setConfirmDelete(true);
            }}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive pointer-coarse:h-10"
          >
            <TrashIcon /> Delete
          </Button>
        </FloatingSelectionBar>
      )}

      <BulkDeleteDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={deleting.count === 1 ? "Delete 1 file permanently?" : `Delete ${deleting.count} files permanently?`}
        description={
          <>
            {deleting.count === 1 ? "It is" : "They are"} removed for good and free their storage.
            {deleting.kept > 0 && ` ${deleting.kept === 1 ? "1 selected artifact can't be deleted here and stays" : `${deleting.kept} selected artifacts can't be deleted here and stay`}.`}
          </>
        }
        confirmLabel={`Delete ${deleting.count}`}
        onConfirm={deleteSelected}
      />

      <ItemPreviewDialog item={open} onClose={() => setOpen(null)} onDeleted={() => open && removeItem(open.id)} />
    </div>
  );
}
