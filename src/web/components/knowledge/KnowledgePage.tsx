import { ArrowLeftIcon, BookOpenIcon, FileUpIcon, LinkIcon, Loader2Icon, PencilIcon, PlusIcon, RefreshCwIcon, SearchIcon, TrashIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  KnowledgeCollection,
  KnowledgeCollectionDetail,
  KnowledgeEmbeddingOption,
  KnowledgeEmbeddingSetting,
  KnowledgeSearchResult,
  KnowledgeSource,
  KnowledgeSourceStatus,
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
import { useCommand } from "@/keyboard/registry";

const SOURCE_STATUS: Record<KnowledgeSourceStatus, PlainMessageKey> = {
  queued: "knowledge.sourceStatusQueued",
  extracting: "knowledge.sourceStatusExtracting",
  embedding: "knowledge.sourceStatusEmbedding",
  ready: "knowledge.sourceStatusReady",
  failed: "knowledge.sourceStatusFailed",
  cancelled: "knowledge.sourceStatusCancelled",
};

const COLLECTION_STATUS: Record<KnowledgeCollection["status"], PlainMessageKey> = {
  empty: "knowledge.statusEmpty",
  processing: "knowledge.statusProcessing",
  ready: "knowledge.statusReady",
  failed: "knowledge.statusFailed",
};

const processing = (source: KnowledgeSource) => source.status === "queued" || source.status === "extracting" || source.status === "embedding";
const embeddingLabel = (collection: KnowledgeCollection) =>
  collection.embedding.provider === "none" ? t("knowledge.embeddingNone") : `${collection.embedding.provider}${collection.embedding.model ? ` · ${collection.embedding.model}` : ""}`;
const embeddingKeyOf = (embedding: KnowledgeEmbeddingSetting) =>
  embedding.provider === "none" ? "none" : embedding.provider === "compatible" ? `compatible:${embedding.providerId ?? ""}` : embedding.provider;

const projectName = (id: string | null) => (id ? useData.getState().projects.find((project) => project.id === id)?.name ?? "" : t("knowledge.noProject"));

function StatusDot({ status }: { status: KnowledgeCollection["status"] }) {
  const tone =
    status === "ready" ? "bg-success" : status === "processing" ? "bg-warning" : status === "failed" ? "bg-destructive" : "bg-muted-foreground";
  return (
    <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs whitespace-nowrap">
      <span aria-hidden className={cn("size-1.5 rounded-full", tone)} />
      {t(COLLECTION_STATUS[status])}
    </span>
  );
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

export function KnowledgePage() {
  const [collections, setCollections] = useState<KnowledgeCollection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const projects = useData((s) => s.projects);

  const load = useCallback(async () => {
    try {
      const { collections: rows } = await api<{ collections: KnowledgeCollection[] }>("/knowledge/collections");
      setCollections(rows);
      setError(null);
    } catch {
      setError(t("knowledge.loadFailed"));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  // A passage panel belongs to the page that opened it; leaving must not reopen it over a chat later.
  useEffect(() => () => useKnowledgeCitationStore.getState().close(), []);
  useCommand("knowledge.newCollection", () => setCreating(true));
  useCommand("knowledge.retryLoad", () => { setError(null); void load(); }, !!error);

  return (
    <>
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 pt-6 pb-[max(2rem,env(safe-area-inset-bottom))] sm:px-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">{selected ? t("knowledge.title") : t("knowledge.collections")}</h1>
            <p className="text-muted-foreground mt-1 max-w-xl text-sm">{t("knowledge.intro")}</p>
          </div>
          {!selected && (
            <Button data-command="knowledge.newCollection" onClick={() => setCreating(true)}>
              <PlusIcon /> {t("knowledge.newCollection")}
            </Button>
          )}
        </header>

        {selected ? (
          <CollectionDetail id={selected} onBack={() => { setSelected(null); void load(); }} onChanged={() => void load()} />
        ) : (
          <>
            {error && (
              <div className="flex flex-wrap items-center gap-2">
                <p role="alert" className="text-destructive text-sm">{error}</p>
                <Button variant="outline" size="sm" data-command="knowledge.retryLoad" onClick={() => { setError(null); void load(); }}>
                  <RefreshCwIcon /> {t("common.retry")}
                </Button>
              </div>
            )}
            {!collections && !error && <p role="status" className="text-muted-foreground text-sm">{t("common.loading")}</p>}
            {collections && collections.length === 0 && (
              <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-4 py-12 text-center">
                <BookOpenIcon aria-hidden className="text-muted-foreground size-7" />
                <h2 className="font-medium">{t("knowledge.emptyTitle")}</h2>
                <p className="text-muted-foreground max-w-sm text-sm">{t("knowledge.emptyBody")}</p>
                <Button onClick={() => setCreating(true)}>
                  <PlusIcon /> {t("knowledge.createCollection")}
                </Button>
              </div>
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
                        <span className="text-muted-foreground block text-xs">{collection.projectId ? projectName(collection.projectId) : t("knowledge.noProject")}</span>
                      </span>
                      <StatusDot status={collection.status} />
                    </span>
                    <span className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-xs">
                      <span>{t("knowledge.sources", { count: collection.sourceCount })}</span>
                      <span>{t("knowledge.chunks", { count: collection.chunkCount })}</span>
                      <span>{t("knowledge.size")}: {formatBytes(collection.bytes)}</span>
                    </span>
                    <span className="text-muted-foreground line-clamp-1 text-xs">{embeddingLabel(collection)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <NewCollectionDialog
        open={creating}
        onOpenChange={setCreating}
        projects={projects}
        onSaved={(collection) => { setCreating(false); void load().then(() => setSelected(collection.id)); }}
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
  collection?: KnowledgeCollection | null;
  onSaved: (collection: KnowledgeCollection, reindex: boolean) => void;
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
                ? await api<KnowledgeCollection>(`/knowledge/collections/${encodeURIComponent(collection.id)}`, { method: "PATCH", json: body })
                : await api<KnowledgeCollection>("/knowledge/collections", { method: "POST", json: body });
              onSaved(saved, embeddingChanged);
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
            <span className="text-muted-foreground">{t("knowledge.embeddingHelp")}</span>
          </label>
          {provider !== "none" && (
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium">{t("knowledge.model")}</span>
              <Input required maxLength={200} value={model} onChange={(event) => setModel(event.target.value)} placeholder={t("knowledge.modelPlaceholder")} />
            </label>
          )}
          {embeddingChanged && <p role="status" className="text-warning text-xs">{t("knowledge.embeddingChangeWarning")}</p>}
          {error && <p role="alert" className="text-destructive text-xs">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy && <Loader2Icon className="animate-spin motion-reduce:animate-none" />} {editing ? t("common.save") : t("knowledge.createCollection")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CollectionDetail({ id, onBack, onChanged }: { id: string; onBack: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<KnowledgeCollectionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [urlOpen, setUrlOpen] = useState(false);
  const [chunksOpen, setChunksOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const projects = useData((s) => s.projects);

  const load = useCallback(async () => {
    try {
      setDetail(await api<KnowledgeCollectionDetail>(`/knowledge/collections/${encodeURIComponent(id)}`));
      setError(null);
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

  const collection = detail?.collection;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start gap-2">
        <Button variant="ghost" size="sm" className="shrink-0" onClick={onBack}><ArrowLeftIcon /> {t("knowledge.back")}</Button>
        {collection && (
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 className="min-w-0 text-base font-semibold break-words">{collection.name}</h2>
              <StatusDot status={collection.status} />
            </div>
            <p className="text-muted-foreground min-w-0 text-xs break-words">{embeddingLabel(collection)}</p>
            <p className="text-muted-foreground flex min-w-0 flex-wrap gap-x-2 text-xs">
              <span className="break-words">{collection.projectId ? projectName(collection.projectId) : t("knowledge.noProject")}</span>
              <span>{formatBytes(collection.bytes)}</span>
              <span>{t("knowledge.chunks", { count: collection.chunkCount })}</span>
            </p>
            {collection.description && <p className="text-muted-foreground min-w-0 text-xs break-words">{collection.description}</p>}
          </div>
        )}
        {collection && (
          <div className="flex shrink-0 flex-wrap gap-1.5">
            <Button variant="outline" size="sm" data-command="knowledge.editCollection" disabled={busy} onClick={() => setEditing(true)}>
              <PencilIcon /> {t("knowledge.editCollection")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              data-command="knowledge.reindex"
              disabled={busy || !collection.sourceCount}
              onClick={() => void runReindex()}
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
        )}
      </div>

      {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
      {notice && <p role="status" className="text-muted-foreground text-sm">{notice}</p>}
      {!detail && !error && <p role="status" className="text-muted-foreground text-sm">{t("common.loading")}</p>}

      {collection && (
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
              accept=".pdf,.docx,.xlsx,.xlsm,.txt,.md,.csv,.json,.ts,.tsx,.js,.jsx,.py,.go,.rs,.java,.c,.cpp,.h,.html,.css,.yaml,.yml,.xml,.sql,.sh,.toml"
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
            </div>
          </section>

          <section aria-labelledby="knowledge-sources" className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="knowledge-sources" className="text-sm font-medium">{t("knowledge.sources", { count: detail.sources.length })}</h2>
              <Button variant="outline" size="sm" data-command="knowledge.previewChunks" onClick={() => setChunksOpen(true)} disabled={!collection.chunkCount}>
                <BookOpenIcon /> {t("knowledge.chunkPreview")}
              </Button>
            </div>
            {detail.sources.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t("knowledge.noSources")}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {detail.sources.map((source) => (
                  <SourceRow key={source.id} source={source} onChanged={() => { onChanged(); void load(); }} onNotice={setNotice} />
                ))}
              </ul>
            )}
          </section>

          <SearchTest collectionId={id} />
          <ChunkBrowser collection={collection} open={chunksOpen} onOpenChange={setChunksOpen} />
        </>
      )}

      <PasteDialog open={pasteOpen} onOpenChange={setPasteOpen} collectionId={id} onAdded={() => { setNotice(t("knowledge.sourceAdded")); onChanged(); void load(); }} />
      <UrlDialog open={urlOpen} onOpenChange={setUrlOpen} collectionId={id} onAdded={() => { setNotice(t("knowledge.sourceAdded")); onChanged(); void load(); }} />
      {collection && (
        <NewCollectionDialog
          open={editing}
          onOpenChange={setEditing}
          projects={projects}
          collection={collection}
          onSaved={(_saved, reindex) => {
            setEditing(false);
            setNotice(reindex ? t("knowledge.collectionUpdatedReindexed") : t("knowledge.collectionUpdated"));
            onChanged();
            void load();
          }}
        />
      )}
    </div>
  );
}

function SourceRow({ source, onChanged, onNotice }: { source: KnowledgeSource; onChanged: () => void; onNotice: (message: string) => void }) {
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
      setError(cause instanceof Error ? cause.message : t("knowledge.sourceAddFailed"));
      if (path.endsWith("/cancel")) setError(t("knowledge.cancelFailed"));
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
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-1">
          {(source.status === "queued" || source.status === "extracting" || source.status === "embedding") && (
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
      {source.error && <p role="alert" className="text-destructive text-xs">{source.error}</p>}
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

function ChunkBrowser({ collection, open, onOpenChange }: { collection: KnowledgeCollection; open: boolean; onOpenChange: (open: boolean) => void }) {
  type PreviewChunk = { id: string; title: string; sourceName: string; start: number; end: number; excerpt: string; tokens: number };
  const [chunks, setChunks] = useState<PreviewChunk[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setChunks(null);
    setError(null);
    void api<{ chunks: PreviewChunk[] }>(`/knowledge/collections/${encodeURIComponent(collection.id)}/chunks?limit=20`)
      .then(({ chunks: rows }) => setChunks(rows))
      .catch(() => setError(t("knowledge.loadFailed")));
  }, [open, collection.id]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] gap-3 overflow-y-auto sm:max-w-2xl">
        <DialogTitle className="text-base">{t("knowledge.chunkPreview")}</DialogTitle>
        <DialogDescription>{t("knowledge.chunksFor", { count: collection.chunkCount })}</DialogDescription>
        {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
        {!chunks && !error && <p role="status" className="text-muted-foreground text-sm">{t("common.loading")}</p>}
        {chunks?.length === 0 && <p className="text-muted-foreground text-sm">{t("knowledge.noChunks")}</p>}
        {chunks && chunks.length > 0 && chunks.length < collection.chunkCount && (
          <p className="text-muted-foreground text-sm">{t("knowledge.chunksShowing", { count: collection.chunkCount, shown: formatNumber(chunks.length) })}</p>
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
