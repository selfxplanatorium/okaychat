import { ArrowLeftIcon, BookOpenIcon, FileUpIcon, LinkIcon, Loader2Icon, PencilIcon, PlusIcon, RefreshCwIcon, SearchIcon, Share2Icon, TrashIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  KnowledgeCapabilities,
  KnowledgeCollectionView,
  KnowledgeEmbeddingOption,
  KnowledgeEmbeddingSetting,
  KnowledgeOwnedCollection,
  KnowledgeSearchResult,
  KnowledgeSharedCollection,
  KnowledgeSource,
  KnowledgeSourceStatus,
  KnowledgeSourceSummary,
} from "@shared/knowledge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { t, type PlainMessageKey } from "@/i18n";
import { formatBytes, formatNumber, formatPercent } from "@/i18n/format";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useData } from "@/state/data";
import { useKnowledgeCitationStore } from "@/state/chat-knowledge";
import { KnowledgeCitationHost } from "./KnowledgeCitation";
import { KnowledgeSharingDialog } from "./KnowledgeSharingDialog";
import { useCommand } from "@/keyboard/registry";

const SOURCE_STATUS: Record<KnowledgeSourceStatus, PlainMessageKey> = {
  queued: "knowledge.sourceStatusQueued",
  extracting: "knowledge.sourceStatusExtracting",
  embedding: "knowledge.sourceStatusEmbedding",
  ready: "knowledge.sourceStatusReady",
  failed: "knowledge.sourceStatusFailed",
  cancelled: "knowledge.sourceStatusCancelled",
};

const COLLECTION_STATUS: Record<KnowledgeCollectionView["status"], PlainMessageKey> = {
  empty: "knowledge.statusEmpty",
  processing: "knowledge.statusProcessing",
  ready: "knowledge.statusReady",
  failed: "knowledge.statusFailed",
};

const processing = (source: { status: KnowledgeSourceStatus }) => source.status === "queued" || source.status === "extracting" || source.status === "embedding";
const isOwned = (collection: KnowledgeCollectionView): collection is KnowledgeOwnedCollection => collection.access === "owner";
const embeddingLabel = (collection: KnowledgeOwnedCollection) =>
  collection.embedding.provider === "none" ? t("knowledge.embeddingNone") : `${collection.embedding.provider}${collection.embedding.model ? ` · ${collection.embedding.model}` : ""}`;
const embeddingKeyOf = (embedding: KnowledgeEmbeddingSetting) =>
  embedding.provider === "none" ? "none" : embedding.provider === "compatible" ? `compatible:${embedding.providerId ?? ""}` : embedding.provider;

const projectName = (id: string | null) => (id ? useData.getState().projects.find((project) => project.id === id)?.name ?? "" : t("knowledge.noProject"));

function StatusDot({ status }: { status: KnowledgeCollectionView["status"] }) {
  const tone =
    status === "ready" ? "bg-success" : status === "processing" ? "bg-warning" : status === "failed" ? "bg-destructive" : "bg-muted-foreground";
  return (
    <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs whitespace-nowrap">
      <span aria-hidden className={cn("size-1.5 rounded-full", tone)} />
      {t(COLLECTION_STATUS[status])}
    </span>
  );
}

function Badge({ children }: { children: string }) {
  return <span className="border-border text-muted-foreground rounded border px-1 text-[10px] uppercase tracking-wide">{children}</span>;
}

function ConfirmButton({ label, confirmLabel, onConfirm, disabled, command }: { label: string; confirmLabel: string; onConfirm: () => void; disabled?: boolean; command?: string }) {
  const [armed, setArmed] = useState(false);
  return (
    <Button
      variant="destructive"
      size="sm"
      disabled={disabled}
      data-command={command}
      onClick={() => {
        if (!armed) return setArmed(true);
        setArmed(false);
        onConfirm();
      }}
    >
      <TrashIcon /> {armed ? confirmLabel : label}
    </Button>
  );
}

type Tab = "mine" | "shared";

export function KnowledgePage() {
  const [collections, setCollections] = useState<KnowledgeCollectionView[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("mine");
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const projects = useData((s) => s.projects);

  const load = useCallback(async (scope: Tab, cursor?: string) => {
    try {
      const query = `scope=${scope === "mine" ? "owned" : "shared"}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page = await api<{ collections: KnowledgeCollectionView[]; nextCursor: string | null }>(`/knowledge/collections?${query}`);
      setCollections((previous) => (cursor && previous ? [...previous, ...page.collections] : page.collections));
      setNextCursor(page.nextCursor);
      setError(null);
    } catch {
      setError(t("knowledge.loadFailed"));
    }
  }, []);

  useEffect(() => { setSelected(null); setCollections(null); void load(tab); }, [tab, load]);
  // A passage panel belongs to the page that opened it; leaving must not reopen it over a chat later.
  useEffect(() => () => useKnowledgeCitationStore.getState().close(), []);
  useCommand("knowledge.newCollection", () => setCreating(true), tab === "mine");
  useCommand("knowledge.retryLoad", () => { setError(null); void load(tab); }, !!error);
  useCommand("knowledge.tabMine", () => { setSelected(null); setTab("mine"); });
  useCommand("knowledge.tabShared", () => { setSelected(null); setTab("shared"); });

  const selectedView = collections?.find((collection) => collection.id === selected) ?? null;

  return (
    <>
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 pt-6 pb-[max(2rem,env(safe-area-inset-bottom))] sm:px-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">{selected ? t("knowledge.title") : t("knowledge.collections")}</h1>
            <p className="text-muted-foreground mt-1 max-w-xl text-sm">{t("knowledge.intro")}</p>
          </div>
          {!selected && tab === "mine" && (
            <Button data-command="knowledge.newCollection" onClick={() => setCreating(true)}>
              <PlusIcon /> {t("knowledge.newCollection")}
            </Button>
          )}
        </header>

        {!selected && (
          <div
            role="tablist"
            aria-label={t("knowledge.collections")}
            className="flex gap-1 rounded-lg border p-1"
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const next = tab === "mine" ? "shared" : "mine";
              setTab(next);
              requestAnimationFrame(() => {
                const node = (event.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-knowledge-tab="${next}"]`);
                node?.focus();
              });
            }}
          >
            {(["mine", "shared"] as const).map((value) => (
              <button
                key={value}
                role="tab"
                data-knowledge-tab={value}
                aria-selected={tab === value}
                tabIndex={tab === value ? 0 : -1}
                type="button"
                onClick={() => setTab(value)}
                className={cn("min-h-10 flex-1 rounded-md px-3 text-sm pointer-coarse:min-h-11", tab === value ? "bg-primary text-primary-foreground" : "hover:bg-muted")}
              >
                {value === "mine" ? t("knowledge.mine") : t("knowledge.sharedWithMe")}
              </button>
            ))}
          </div>
        )}

        {selected && selectedView ? (
          isOwned(selectedView) ? (
            <CollectionDetail
              collection={selectedView}
              onBack={() => { setSelected(null); void load(tab); }}
              onChanged={() => void load(tab)}
            />
          ) : (
            <SharedCollectionDetail collection={selectedView} onBack={() => setSelected(null)} />
          )
        ) : (
          <>
            {error && (
              <div className="flex flex-wrap items-center gap-2">
                <p role="alert" className="text-destructive text-sm">{error}</p>
                <Button variant="outline" size="sm" data-command="knowledge.retryLoad" onClick={() => { setError(null); void load(tab); }}>
                  <RefreshCwIcon /> {t("common.retry")}
                </Button>
              </div>
            )}
            {!collections && !error && <p role="status" className="text-muted-foreground text-sm">{t("common.loading")}</p>}
            {collections && collections.length === 0 && (
              tab === "mine" ? (
                <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-4 py-12 text-center">
                  <BookOpenIcon aria-hidden className="text-muted-foreground size-7" />
                  <h2 className="font-medium">{t("knowledge.emptyTitle")}</h2>
                  <p className="text-muted-foreground max-w-sm text-sm">{t("knowledge.emptyBody")}</p>
                  <Button onClick={() => setCreating(true)}>
                    <PlusIcon /> {t("knowledge.createCollection")}
                  </Button>
                </div>
              ) : (
                <p className="text-muted-foreground rounded-xl border border-dashed px-4 py-12 text-center text-sm">{t("knowledge.sharedEmpty")}</p>
              )
            )}
            <ul className="grid gap-2 sm:grid-cols-2">
              {collections?.map((collection) => (
                <li key={collection.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(collection.id)}
                    className="hover:bg-muted/60 focus-visible:outline-ring flex h-full w-full flex-col gap-2 rounded-xl border px-3 py-3 text-start transition-colors duration-(--motion-fast) ease-out-quart pointer-coarse:min-h-16 focus-visible:outline-2 focus-visible:outline-offset-2"
                  >
                    <span className="flex w-full items-start justify-between gap-2">
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{collection.name}</span>
                        <span className="text-muted-foreground block text-xs">
                          {isOwned(collection)
                            ? collection.projectId ? projectName(collection.projectId) : t("knowledge.noProject")
                            : t("knowledge.ownerLabel", { name: collection.owner.displayName ?? t("knowledge.ownerUnknown") })}
                        </span>
                      </span>
                      <StatusDot status={collection.status} />
                    </span>
                    <span className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                      <span>{t("knowledge.sources", { count: collection.sourceCount })}</span>
                      <span>{t("knowledge.chunks", { count: collection.chunkCount })}</span>
                      {isOwned(collection) ? (
                        <>
                          <span>{t("knowledge.size")}: {formatBytes(collection.bytes)}</span>
                          <Badge>{collection.visibility === "shared" ? t("knowledge.sharedBadge") : t("knowledge.privateBadge")}</Badge>
                        </>
                      ) : <Badge>{t("knowledge.readerBadge")}</Badge>}
                    </span>
                    <span className="text-muted-foreground line-clamp-1 text-xs">
                      {isOwned(collection) ? embeddingLabel(collection) : t("knowledge.sharedLexical")}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {nextCursor && (
              <div className="flex justify-center">
                <Button variant="outline" size="sm" onClick={() => void load(tab, nextCursor)}>{t("knowledge.loadMore")}</Button>
              </div>
            )}
          </>
        )}
      </div>
      <NewCollectionDialog
        open={creating}
        onOpenChange={setCreating}
        projects={projects}
        onSaved={(collection) => { setCreating(false); void load(tab).then(() => setSelected(collection.id)); }}
      />
      <KnowledgeCitationHost />
    </>
  );
}

function NewCollectionDialog({
  open,
  onOpenChange,
  projects,
  collection,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: Array<{ id: string; name: string }>;
  collection?: KnowledgeOwnedCollection | null;
  onSaved: (collection: KnowledgeOwnedCollection, reindex: boolean) => void;
}) {
  const editing = !!collection;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState<string>("");
  const [options, setOptions] = useState<KnowledgeEmbeddingOption[] | null>(null);
  const [provider, setProvider] = useState<string>("none");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const optionKey = (option: KnowledgeEmbeddingOption) => (option.provider === "compatible" ? `compatible:${option.providerId}` : option.provider);

  useEffect(() => {
    if (!open) return;
    // Reset once per open/collection, not on every metadata refresh while the dialog is visible.
    setName(collection?.name ?? "");
    setDescription(collection?.description ?? "");
    setProjectId(collection?.projectId ?? "");
    setProvider(collection ? embeddingKeyOf(collection.embedding) : "none");
    setModel(collection?.embedding.model ?? "");
    setBusy(false);
    setError(null);
    let live = true;
    void api<{ options: KnowledgeEmbeddingOption[] }>("/knowledge/embedding-options")
      .then(({ options: rows }) => {
        if (!live) return;
        setOptions(rows);
        if (!collection) {
          const first = rows.find((row) => row.provider !== "none");
          if (first) {
            setProvider(optionKey(first));
            setModel(first.model ?? "");
          }
        }
      })
      .catch(() => { if (live) setError(t("knowledge.loadFailed")); });
    return () => { live = false; };
    // `collection.id` keeps a polling parent refresh from wiping the open form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, collection?.id]);

  const current = options?.find((row) => optionKey(row) === provider);
  const currentKey = collection ? embeddingKeyOf(collection.embedding) : null;
  const selectOptions = (options ?? [{ provider: "none" as const, label: t("knowledge.embeddingNone") }]).map((option) => ({
    value: optionKey(option),
    label: option.provider === "none" ? t("knowledge.embeddingNone") : option.label,
  }));
  // A provider removed from Settings must remain selectable so renaming the collection does not force a
  // reindex or silently switch models; choosing it keeps the stored setting unchanged.
  if (currentKey && currentKey !== "none" && !selectOptions.some((option) => option.value === currentKey)) {
    selectOptions.unshift({ value: currentKey, label: t("knowledge.embeddingUnavailableOption", { value: currentKey }) });
  }
  const embeddingChanged = !!collection && (provider !== currentKey || (provider !== "none" && (model.trim() || collection.embedding.model || "") !== (collection.embedding.model ?? "")));
  const embeddingSetting = (): KnowledgeEmbeddingSetting => {
    if (provider === "none") return { provider: "none" };
    // Keeping the saved provider (even one that is no longer offered) preserves its connection id exactly.
    const option = collection && provider === currentKey
      ? { provider: collection.embedding.provider, providerId: collection.embedding.providerId, model: collection.embedding.model }
      : current;
    const nextProvider = option?.provider ?? collection?.embedding.provider ?? "none";
    const nextProviderId = option?.providerId ?? collection?.embedding.providerId;
    return { provider: nextProvider, ...(nextProviderId ? { providerId: nextProviderId } : {}), model: model.trim() || collection?.embedding.model || undefined } as KnowledgeEmbeddingSetting;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] gap-3 overflow-y-auto sm:max-w-md">
        <DialogTitle className="text-base">{editing ? t("knowledge.editCollection") : t("knowledge.newCollection")}</DialogTitle>
        <form
          className="flex flex-col gap-3"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const body = { name, description, projectId: projectId || null, embedding: embeddingSetting() };
              const saved = editing
                ? await api<KnowledgeOwnedCollection>(`/knowledge/collections/${encodeURIComponent(collection.id)}`, { method: "PATCH", json: body })
                : await api<KnowledgeOwnedCollection>("/knowledge/collections", { method: "POST", json: body });
              onSaved(saved, embeddingChanged && !editing);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : t("knowledge.collectionSaveFailed"));
            } finally {
              setBusy(false);
            }
          }}
        >
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium">{t("knowledge.name")}</span>
            <Input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder={t("knowledge.namePlaceholder")} autoFocus />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium">{t("knowledge.description")}</span>
            <Input maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t("knowledge.descriptionPlaceholder")} />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium">{t("knowledge.project")}</span>
            <Select
              aria-label={t("knowledge.project")}
              value={projectId || "none"}
              onValueChange={(value) => setProjectId(value === "none" ? "" : value)}
              options={[{ value: "none", label: t("knowledge.noProject") }, ...projects.map((project) => ({ value: project.id, label: project.name }))]}
            />
            <span className="text-muted-foreground">{t("knowledge.projectHelp")}</span>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium">{t("knowledge.embedding")}</span>
            <Select
              aria-label={t("knowledge.embedding")}
              value={provider}
              onValueChange={(value) => {
                setProvider(value);
                setModel(options?.find((row) => optionKey(row) === value)?.model ?? (value === currentKey ? collection?.embedding.model ?? "" : ""));
              }}
              options={selectOptions}
            />
            <span className="text-muted-foreground">{editing && collection.sourceCount > 0 ? t("knowledge.embeddingLocked") : t("knowledge.embeddingHelp")}</span>
          </label>
          {provider !== "none" && (
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium">{t("knowledge.model")}</span>
              <Input required maxLength={200} value={model} onChange={(event) => setModel(event.target.value)} placeholder={t("knowledge.modelPlaceholder")} />
            </label>
          )}
          {embeddingChanged && editing && collection.sourceCount === 0 && <p role="status" className="text-warning text-xs">{t("knowledge.embeddingChangeWarning")}</p>}
          {error && <p role="alert" className="text-destructive text-xs">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
            <Button type="submit" disabled={busy || !name.trim() || (editing && embeddingChanged && collection.sourceCount > 0)}>
              {busy && <Loader2Icon className="animate-spin motion-reduce:animate-none" />} {editing ? t("common.save") : t("knowledge.createCollection")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CollectionDetail({ collection, onBack, onChanged }: { collection: KnowledgeOwnedCollection; onBack: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<{ collection: KnowledgeOwnedCollection; sources: KnowledgeSource[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [urlOpen, setUrlOpen] = useState(false);
  const [chunksOpen, setChunksOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [sharing, setSharing] = useState(false);
  // OCR depends on the code sandbox, not on this account's code feature. One read, no polling; a failure
  // keeps null and shows nothing.
  const [capabilities, setCapabilities] = useState<KnowledgeCapabilities | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const projects = useData((s) => s.projects);
  const id = collection.id;

  useEffect(() => {
    let live = true;
    void api<KnowledgeCapabilities>("/knowledge/capabilities")
      .then((value) => { if (live) setCapabilities(value); })
      .catch(() => { if (live) setCapabilities(null); });
    return () => { live = false; };
  }, []);

  const load = useCallback(async () => {
    try {
      const value = await api<{ collection: KnowledgeOwnedCollection; sources: KnowledgeSource[] }>(`/knowledge/collections/${encodeURIComponent(id)}`);
      setDetail(value);
      const loadFailed = t("knowledge.loadFailed");
      setError((previous) => (previous === loadFailed ? null : previous));
    } catch {
      setError(t("knowledge.loadFailed"));
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);
  const anyProcessing = !!detail?.sources.some(processing);
  useEffect(() => {
    if (!anyProcessing) return;
    const timer = setInterval(() => void load(), 2_000);
    return () => clearInterval(timer);
  }, [anyProcessing, load]);

  useCommand("knowledge.addSource", () => fileInput.current?.click());
  useCommand("knowledge.pasteSource", () => setPasteOpen(true));
  useCommand("knowledge.addUrl", () => setUrlOpen(true));
  useCommand("knowledge.previewChunks", () => setChunksOpen(true), !!detail?.collection.chunkCount);
  useCommand("knowledge.editCollection", () => setEditing(true), !!detail);
  useCommand("knowledge.sharing", () => setSharing(true), !!detail);
  const runReindex = async () => {
    setBusy(true);
    try {
      const result = await api<{ queued: number }>(`/knowledge/collections/${encodeURIComponent(id)}/reindex`, { method: "POST" });
      setNotice(t("knowledge.reindexQueued", { count: result.queued }));
      await load();
    } catch {
      setError(t("knowledge.reindexFailed"));
    } finally {
      setBusy(false);
    }
  };
  useCommand("knowledge.reindex", () => { if (detail?.collection.sourceCount) void runReindex(); });

  const uploadFiles = async (files: File[]) => {
    if (!files.length) return;
    setBusy(true);
    setError(null);
    const failures: string[] = [];
    let added = 0;
    try {
      // One bad file must not hide the rest: keep going, then report every failure.
      for (const file of files) {
        const form = new FormData();
        form.set("file", file);
        try {
          await api(`/knowledge/collections/${encodeURIComponent(id)}/sources/file`, { method: "POST", body: form });
          added++;
        } catch (cause) {
          failures.push(cause instanceof Error ? cause.message : t("knowledge.sourceAddFailed"));
        }
      }
      if (added) setNotice(t("knowledge.sourceAdded"));
      if (failures.length) setError([...new Set(failures)].join(" "));
    } finally {
      // Files that did upload must appear even when a later one failed.
      onChanged();
      await load();
      setBusy(false);
    }
  };

  const current = detail?.collection ?? collection;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start gap-2">
        <Button variant="ghost" size="sm" className="shrink-0" onClick={onBack}><ArrowLeftIcon /> {t("knowledge.back")}</Button>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h2 className="min-w-0 text-base font-semibold break-words">{current.name}</h2>
            <StatusDot status={current.status} />
            <Badge>{current.visibility === "shared" ? t("knowledge.sharedBadge") : t("knowledge.privateBadge")}</Badge>
          </div>
          <p className="text-muted-foreground min-w-0 text-xs break-words">{embeddingLabel(current)}</p>
          <p className="text-muted-foreground flex min-w-0 flex-wrap gap-x-2 text-xs">
            <span className="break-words">{current.projectId ? projectName(current.projectId) : t("knowledge.noProject")}</span>
            <span>{formatBytes(current.bytes)}</span>
            <span>{t("knowledge.chunks", { count: current.chunkCount })}</span>
            <span>{t("knowledge.ownerPays")}</span>
          </p>
          {current.description && <p className="text-muted-foreground min-w-0 text-xs break-words">{current.description}</p>}
          {current.embeddingNeedsReindex && <p role="status" className="text-warning text-xs">{t("knowledge.reindexRequired")}</p>}
        </div>
        <div className="flex shrink-0 flex-wrap gap-1.5">
          <Button variant="outline" size="sm" data-command="knowledge.sharing" disabled={busy} onClick={() => setSharing(true)}>
            <Share2Icon /> {t("knowledge.manageSharing")}
          </Button>
          <Button variant="outline" size="sm" data-command="knowledge.editCollection" disabled={busy} onClick={() => setEditing(true)}>
            <PencilIcon /> {t("knowledge.editCollection")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            data-command="knowledge.reindex"
            disabled={busy || !current.sourceCount}
            onClick={() => void runReindex()}
            title={t("knowledge.reindexConfirm")}
          >
            <RefreshCwIcon /> {t("knowledge.reindex")}
          </Button>
          <ConfirmButton
            label={t("knowledge.deleteCollection")}
            confirmLabel={t("knowledge.reallyDeleteCollection")}
            onConfirm={async () => {
              try {
                await api(`/knowledge/collections/${encodeURIComponent(id)}`, { method: "DELETE" });
                onChanged();
                onBack();
              } catch {
                setError(t("knowledge.deleteFailed"));
              }
            }}
          />
        </div>
      </div>

      {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
      {notice && <p role="status" className="text-muted-foreground text-sm">{notice}</p>}
      {!detail && !error && <p role="status" className="text-muted-foreground text-sm">{t("common.loading")}</p>}

      {detail && (
        <>
          <section aria-labelledby="knowledge-add-source" className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="knowledge-add-source" className="text-sm font-medium">{t("knowledge.addSource")}</h2>
              <div className="flex flex-wrap gap-1.5">
                <Button variant="outline" size="sm" data-command="knowledge.addSource" disabled={busy} onClick={() => fileInput.current?.click()}>
                  <FileUpIcon /> {t("knowledge.addFiles")}
                </Button>
                <Button variant="outline" size="sm" data-command="knowledge.pasteSource" onClick={() => setPasteOpen(true)}><PlusIcon /> {t("knowledge.paste")}</Button>
                <Button variant="outline" size="sm" data-command="knowledge.addUrl" onClick={() => setUrlOpen(true)}><LinkIcon /> {t("knowledge.addUrl")}</Button>
              </div>
            </div>
            <input
              ref={fileInput}
              type="file"
              multiple
              className="sr-only"
              accept=".pdf,.docx,.pptx,.ppsx,.xlsx,.xlsm,.odt,.epub,.html,.htm,.txt,.md,.csv,.json,.ts,.tsx,.js,.jsx,.py,.go,.rs,.java,.c,.cpp,.h,.css,.yaml,.yml,.xml,.sql,.sh,.toml,.png,.jpg,.jpeg,.webp,.gif,.bmp,.tif,.tiff,.heic,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.openxmlformats-officedocument.presentationml.slideshow,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel.sheet.macroEnabled.12,application/vnd.oasis.opendocument.text,application/epub+zip,image/png,image/jpeg,image/webp,image/gif,image/bmp,image/tiff,image/heic"
              onChange={(event) => { void uploadFiles([...(event.target.files ?? [])]); event.target.value = ""; }}
            />
            <div
              onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => { event.preventDefault(); setDragging(false); void uploadFiles([...event.dataTransfer.files]); }}
              className={cn(
                "text-muted-foreground rounded-xl border border-dashed px-3 py-4 text-center text-xs transition-colors",
                dragging && "border-primary bg-primary/5 text-foreground",
              )}
            >
              {busy ? <Loader2Icon aria-hidden className="mx-auto size-4 animate-spin motion-reduce:animate-none" /> : t("knowledge.dropFiles")}
              <span className="mt-1 block">{t("knowledge.addFilesHint")}</span>
              {capabilities?.ocr.reason === "not_configured" && (
                <p className="text-muted-foreground mx-auto mt-1 max-w-[360px] text-xs">{t("knowledge.ocrUnavailableNotConfigured")}</p>
              )}
              {capabilities?.ocr.reason === "unavailable" && (
                <p className="text-muted-foreground mx-auto mt-1 max-w-[360px] text-xs">{t("knowledge.ocrUnavailableDown")}</p>
              )}
            </div>
          </section>

          <section aria-labelledby="knowledge-sources" className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="knowledge-sources" className="text-sm font-medium">{t("knowledge.sources", { count: detail.sources.length })}</h2>
              <Button variant="outline" size="sm" data-command="knowledge.previewChunks" onClick={() => setChunksOpen(true)} disabled={!current.chunkCount}>
                <BookOpenIcon /> {t("knowledge.chunkPreview")}
              </Button>
            </div>
            {detail.sources.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t("knowledge.noSources")}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {detail.sources.map((source) => (
                  <OwnerSourceRow key={source.id} source={source} onChanged={() => { onChanged(); void load(); }} onNotice={setNotice} />
                ))}
              </ul>
            )}
          </section>

          <SearchTest collectionId={id} />
          <ChunkBrowser collectionId={id} chunkCount={current.chunkCount} open={chunksOpen} onOpenChange={setChunksOpen} />
        </>
      )}

      <PasteDialog open={pasteOpen} onOpenChange={setPasteOpen} collectionId={id} onAdded={() => { setNotice(t("knowledge.sourceAdded")); onChanged(); void load(); }} />
      <UrlDialog open={urlOpen} onOpenChange={setUrlOpen} collectionId={id} onAdded={() => { setNotice(t("knowledge.sourceAdded")); onChanged(); void load(); }} />
      <NewCollectionDialog
        open={editing}
        onOpenChange={setEditing}
        projects={projects}
        collection={current}
        onSaved={() => {
          setEditing(false);
          setNotice(t("knowledge.collectionUpdated"));
          onChanged();
          void load();
        }}
      />
      <KnowledgeSharingDialog
        open={sharing}
        onOpenChange={setSharing}
        collection={current}
        onSaved={() => { onChanged(); void load(); }}
      />
    </div>
  );
}

/** Reader detail: safe source summaries, search, and passage browsing; no owner commands at all. */
function SharedCollectionDetail({ collection, onBack }: { collection: KnowledgeSharedCollection; onBack: () => void }) {
  const [detail, setDetail] = useState<{ collection: KnowledgeSharedCollection; sources: KnowledgeSourceSummary[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chunksOpen, setChunksOpen] = useState(false);
  const id = collection.id;

  useEffect(() => {
    let live = true;
    void api<{ collection: KnowledgeSharedCollection; sources: KnowledgeSourceSummary[] }>(`/knowledge/collections/${encodeURIComponent(id)}`)
      .then((value) => { if (live) setDetail(value); })
      .catch(() => { if (live) setError(t("knowledge.loadFailed")); });
    return () => { live = false; };
  }, [id]);
  useCommand("knowledge.previewChunks", () => setChunksOpen(true), !!detail?.collection.chunkCount);

  const current = detail?.collection ?? collection;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start gap-2">
        <Button variant="ghost" size="sm" className="shrink-0" onClick={onBack}><ArrowLeftIcon /> {t("knowledge.back")}</Button>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h2 className="min-w-0 text-base font-semibold break-words">{current.name}</h2>
            <StatusDot status={current.status} />
            <Badge>{t("knowledge.readerBadge")}</Badge>
          </div>
          <p className="text-muted-foreground min-w-0 text-xs break-words">
            {t("knowledge.ownerLabel", { name: current.owner.displayName ?? t("knowledge.ownerUnknown") })} · {t("knowledge.sharedLexical")}
          </p>
          <p className="text-muted-foreground flex flex-wrap gap-x-2 text-xs">
            <span>{t("knowledge.sources", { count: current.sourceCount })}</span>
            <span>{t("knowledge.chunks", { count: current.chunkCount })}</span>
          </p>
          {current.description && <p className="text-muted-foreground min-w-0 text-xs break-words">{current.description}</p>}
          <p className="text-muted-foreground text-xs">{t("knowledge.readerPays")}</p>
          <p className="text-muted-foreground text-xs">{t("knowledge.sharedLexicalHelp")}</p>
        </div>
      </div>
      {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
      {!detail && !error && <p role="status" className="text-muted-foreground text-sm">{t("common.loading")}</p>}
      {detail && (
        <>
          <section aria-labelledby="knowledge-reader-sources" className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="knowledge-reader-sources" className="text-sm font-medium">{t("knowledge.sources", { count: detail.sources.length })}</h2>
              <Button variant="outline" size="sm" data-command="knowledge.previewChunks" onClick={() => setChunksOpen(true)} disabled={!current.chunkCount}>
                <BookOpenIcon /> {t("knowledge.chunkPreview")}
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">{t("knowledge.readOnlyHelp")}</p>
            {detail.sources.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t("knowledge.noSources")}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {detail.sources.map((source) => (
                  <li key={source.id} className="flex flex-col gap-1 rounded-xl border px-3 py-2">
                    <p className="truncate text-sm font-medium">{source.name}</p>
                    <p className="text-muted-foreground flex flex-wrap gap-x-2 text-xs">
                      <span>{t(SOURCE_STATUS[source.status])}</span>
                      <span>{t("knowledge.chunks", { count: source.chunkCount })}</span>
                      {source.status === "failed" && <span>{t("knowledge.sourceFailedReader")}</span>}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <SearchTest collectionId={id} />
          <ChunkBrowser collectionId={id} chunkCount={current.chunkCount} open={chunksOpen} onOpenChange={setChunksOpen} />
        </>
      )}
    </div>
  );
}

function OwnerSourceRow({ source, onChanged, onNotice }: { source: KnowledgeSource; onChanged: () => void; onNotice: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (path: string, method = "POST") => {
    setBusy(true);
    setError(null);
    try {
      await api(path, { method });
      if (path.endsWith("/retry")) onNotice(t("knowledge.retryQueued"));
      if (method === "DELETE") onNotice(t("knowledge.sourceDeleted"));
      onChanged();
    } catch (cause) {
      setError(path.endsWith("/cancel") ? t("knowledge.cancelFailed") : cause instanceof Error ? cause.message : t("knowledge.sourceAddFailed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="flex flex-col gap-1 rounded-xl border px-3 py-2">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{source.name}</p>
          <p className="text-muted-foreground flex flex-wrap gap-x-2 text-xs">
            <span>{t(SOURCE_STATUS[source.status])}</span>
            <span>{formatBytes(source.bytes)}</span>
            <span>{t("knowledge.chunks", { count: source.chunkCount })}</span>
            {source.extraction === "ocr" && <Badge>{t("knowledge.ocrRead")}</Badge>}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-1">
          {processing(source) && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => act(`/knowledge/sources/${encodeURIComponent(source.id)}/cancel`)}><XIcon /> {t("knowledge.cancel")}</Button>
          )}
          {(source.status === "failed" || source.status === "cancelled") && (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => act(`/knowledge/sources/${encodeURIComponent(source.id)}/retry`)}><RefreshCwIcon /> {t("knowledge.retry")}</Button>
          )}
          {source.status === "ready" && (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => act(`/knowledge/sources/${encodeURIComponent(source.id)}/reindex`)}><RefreshCwIcon /> {t("knowledge.reindex")}</Button>
          )}
          <ConfirmButton
            label={t("knowledge.deleteSource")}
            confirmLabel={t("knowledge.reallyDeleteSource")}
            disabled={busy}
            onConfirm={() => void act(`/knowledge/sources/${encodeURIComponent(source.id)}`, "DELETE")}
          />
        </div>
      </div>
      {processing(source) && (
        <progress className="h-1 w-full" max={1} value={source.progress} aria-label={t(SOURCE_STATUS[source.status])}>
          {formatPercent(source.progress)}
        </progress>
      )}
      {source.status === "failed" ? (
        <p role="alert" className="text-destructive text-xs">{source.error ?? t("knowledge.sourceFailedNoDetail")}</p>
      ) : null}
      {error && <p role="alert" className="text-destructive text-xs">{error}</p>}
    </li>
  );
}

function SearchTest({ collectionId }: { collectionId: string }) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<KnowledgeSearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useCommand("knowledge.search", () => input.current?.focus());
  return (
    <section aria-labelledby="knowledge-search-test" className="flex flex-col gap-2">
      <h2 id="knowledge-search-test" className="text-sm font-medium">{t("knowledge.searchTest")}</h2>
      <form
        className="flex gap-1.5"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!query.trim()) return;
          setBusy(true);
          setError(null);
          try {
            setResult(await api<KnowledgeSearchResult>(`/knowledge/collections/${encodeURIComponent(collectionId)}/search`, { method: "POST", json: { query } }));
          } catch {
            setError(t("knowledge.searchFailed"));
            setResult(null);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Input ref={input} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("knowledge.searchPlaceholder")} aria-label={t("knowledge.searchTest")} />
        <Button type="submit" disabled={busy || !query.trim()}>
          {busy ? <Loader2Icon className="animate-spin motion-reduce:animate-none" /> : <SearchIcon />} {t("knowledge.search")}
        </Button>
      </form>
      {error && <p role="alert" className="text-destructive text-xs">{error}</p>}
      {result && (
        <div className="flex flex-col gap-1.5">
          <p className="text-muted-foreground text-xs">
            {result.degraded ? t("knowledge.searchModeDegraded") : result.mode === "hybrid" ? t("knowledge.searchModeHybrid") : t("knowledge.searchModeLexical")} · {t("knowledge.searchResults", { count: result.hits.length, tokens: formatNumber(result.tokens) })}
          </p>
          {result.collections.some((entry) => entry.reason === "shared_lexical") && (
            <p className="text-muted-foreground text-xs">{t("knowledge.mixedRetrieval")} · {t("knowledge.sharedLexical")}</p>
          )}
          {result.hits.length === 0 && <p className="text-muted-foreground text-sm">{t("knowledge.searchNoHits")}</p>}
          {result.hits.map((hit) => (
            <button
              key={hit.chunkId}
              type="button"
              onClick={() => useKnowledgeCitationStore.getState().open(hit.chunkId)}
              className="hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-ring flex min-w-0 flex-col gap-0.5 rounded-lg border px-2.5 py-2 text-start pointer-coarse:min-h-11 focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              <span className="text-muted-foreground text-xs">{hit.title} · {t("knowledge.citationOffset", { start: formatNumber(hit.offset), end: formatNumber(hit.end) })}</span>
              <span className="line-clamp-3 text-xs">{hit.text}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function ChunkBrowser({ collectionId, chunkCount, open, onOpenChange }: { collectionId: string; chunkCount: number; open: boolean; onOpenChange: (open: boolean) => void }) {
  type PreviewChunk = { id: string; title: string; sourceName: string; start: number; end: number; excerpt: string; tokens: number };
  const [chunks, setChunks] = useState<PreviewChunk[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setChunks(null);
    setError(null);
    void api<{ chunks: PreviewChunk[] }>(`/knowledge/collections/${encodeURIComponent(collectionId)}/chunks?limit=20`)
      .then(({ chunks: rows }) => setChunks(rows))
      .catch(() => setError(t("knowledge.loadFailed")));
  }, [open, collectionId]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] gap-3 overflow-y-auto sm:max-w-2xl">
        <DialogTitle className="text-base">{t("knowledge.chunkPreview")}</DialogTitle>
        <DialogDescription>{t("knowledge.chunksFor", { count: chunkCount })}</DialogDescription>
        {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
        {!chunks && !error && <p role="status" className="text-muted-foreground text-sm">{t("common.loading")}</p>}
        {chunks?.length === 0 && <p className="text-muted-foreground text-sm">{t("knowledge.noChunks")}</p>}
        {chunks && chunks.length > 0 && chunks.length < chunkCount && (
          <p className="text-muted-foreground text-sm">{t("knowledge.chunksShowing", { count: chunkCount, shown: formatNumber(chunks.length) })}</p>
        )}
        <ul className="flex flex-col gap-1.5">
          {chunks?.map((chunk) => (
            <li key={chunk.id}>
              <button
                type="button"
                onClick={() => useKnowledgeCitationStore.getState().open(chunk.id)}
                className="hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-ring flex w-full min-w-0 flex-col gap-0.5 rounded-lg border px-2.5 py-2 text-start pointer-coarse:min-h-11 focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                <span className="text-muted-foreground text-xs">{chunk.sourceName} · {t("knowledge.citationOffset", { start: formatNumber(chunk.start), end: formatNumber(chunk.end) })}</span>
                <span className="text-sm">{chunk.title}</span>
                <span className="text-muted-foreground line-clamp-2 text-xs">{chunk.excerpt}</span>
              </button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

function PasteDialog({ open, onOpenChange, collectionId, onAdded }: { open: boolean; onOpenChange: (open: boolean) => void; collectionId: string; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] gap-3 overflow-y-auto sm:max-w-lg">
        <DialogTitle className="text-base">{t("knowledge.pasteTitle")}</DialogTitle>
        <form
          className="flex flex-col gap-3"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await api(`/knowledge/collections/${encodeURIComponent(collectionId)}/sources/paste`, { method: "POST", json: { name, text } });
              setName("");
              setText("");
              onOpenChange(false);
              onAdded();
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : t("knowledge.sourceAddFailed"));
            } finally {
              setBusy(false);
            }
          }}
        >
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium">{t("knowledge.pasteName")}</span>
            <Input required maxLength={200} value={name} onChange={(event) => setName(event.target.value)} placeholder={t("knowledge.pasteNamePlaceholder")} autoFocus />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium">{t("knowledge.pasteText")}</span>
            <textarea required value={text} onChange={(event) => setText(event.target.value)} placeholder={t("knowledge.pasteTextPlaceholder")} className="bg-muted/60 focus-visible:ring-ring/50 min-h-40 rounded-lg border p-2 text-sm outline-none focus-visible:ring-2" />
          </label>
          {error && <p role="alert" className="text-destructive text-xs">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
            <Button type="submit" disabled={busy || !name.trim() || !text.trim()}>
              {busy && <Loader2Icon className="animate-spin motion-reduce:animate-none" />} {t("knowledge.add")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function UrlDialog({ open, onOpenChange, collectionId, onAdded }: { open: boolean; onOpenChange: (open: boolean) => void; collectionId: string; onAdded: () => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-3 sm:max-w-md">
        <DialogTitle className="text-base">{t("knowledge.urlTitle")}</DialogTitle>
        <form
          className="flex flex-col gap-3"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await api(`/knowledge/collections/${encodeURIComponent(collectionId)}/sources/url`, { method: "POST", json: { url } });
              setUrl("");
              onOpenChange(false);
              onAdded();
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : t("knowledge.sourceAddFailed"));
            } finally {
              setBusy(false);
            }
          }}
        >
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium">{t("knowledge.url")}</span>
            <Input required type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder={t("knowledge.urlPlaceholder")} autoFocus />
            <span className="text-muted-foreground">{t("knowledge.urlHelp")}</span>
          </label>
          {error && <p role="alert" className="text-destructive text-xs">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
            <Button type="submit" disabled={busy || !url.trim()}>
              {busy && <Loader2Icon className="animate-spin motion-reduce:animate-none" />} {t("knowledge.add")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
