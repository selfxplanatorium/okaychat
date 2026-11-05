import { useAui, useAuiState } from "@assistant-ui/react";
import { CheckIcon, Loader2Icon, PencilIcon, PlusIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AssistantPreset, AssistantSnapshot } from "@shared/assistant-presets";
import { snapshotOf } from "@shared/assistant-presets";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";
import { ApiError, api } from "@/lib/api";
import { useCommand } from "@/keyboard/registry";
import { isTemporaryChat } from "@/state/chat-privacy";
import { useData } from "@/state/data";
import { useMessageEdits } from "@/state/message-edits";
import { useAssistantPresets } from "@/state/assistant-presets";
import { closeAssistantPicker, openAssistantPicker, useAssistantPicker } from "@/state/assistant-picker";
import { useThreadMetaStore } from "@/state/thread-meta";
import { useThreadSync } from "@/state/thread-sync";
import { AssistantConfirm, AssistantIcon, AssistantPresetEditor } from "./AssistantPresetEditor";

/** The composer's assistant entry: a compact label plus the picker dialog. */
export function AssistantPickerButton({ compact = false }: { compact?: boolean }) {
  const aui = useAui();
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  const localId = useAuiState((s) => s.threadListItem.id);
  const label = useAssistantPresets((s) => {
    const key = remoteId ?? localId;
    return key ? (s.labels[key] ?? null) : null;
  });
  useCommand("composer.assistant", () => openAssistantPicker(), true);
  useCommand("composer.manageAssistants", () => openAssistantPicker({ manage: true }), true);
  const name = label?.name ?? t("assistants.default");
  return (
    <button
      type="button"
      data-command="composer.assistant"
      aria-haspopup="dialog"
      aria-label={t("assistants.selectedLabel", { name })}
      onClick={() => openAssistantPicker()}
      onContextMenu={(event) => {
        event.preventDefault();
        openAssistantPicker({ manage: true });
      }}
      className="hover:bg-muted text-muted-foreground hover:text-foreground aria-expanded:bg-muted flex h-7 min-w-0 shrink items-center gap-1 rounded-lg px-2 text-xs font-medium transition-colors duration-(--motion-fast) ease-out-quart pointer-coarse:h-9 max-sm:hidden pointer-coarse:hidden"
    >
      <AssistantIcon name={label?.icon ?? "sparkles"} className="size-3.5 shrink-0" />
      {!compact && <span className="max-w-32 truncate">{name}</span>}
    </button>
  );
}

type View = "list" | "editor";

/**
 * One dialog for choosing, creating, editing, and publishing assistants. Choosing copies a snapshot into
 * the chat through the server API; nothing here holds or sends instructions on a request.
 */
export function AssistantPickerDialog() {
  const open = useAssistantPicker((s) => s.open);
  const startInManage = useAssistantPicker((s) => s.manage);
  const aui = useAui();
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  const localId = useAuiState((s) => s.threadListItem.id);
  const running = useAuiState((s) => s.thread.isRunning);
  const messageCount = useAuiState((s) => s.thread.messages.length);
  const syncing = useThreadSync() !== undefined;
  const editing = useMessageEdits((s) => s.editing !== null);
  const busy = running || syncing || editing;

  const mine = useAssistantPresets((s) => s.mine);
  const published = useAssistantPresets((s) => s.published);
  const nextCursor = useAssistantPresets((s) => s.nextCursor);
  const loading = useAssistantPresets((s) => s.loading);
  const publishedLoading = useAssistantPresets((s) => s.publishedLoading);
  const options = useAssistantPresets((s) => s.options);
  const loadMine = useAssistantPresets((s) => s.loadMine);
  const loadPublished = useAssistantPresets((s) => s.loadPublished);
  const loadOptions = useAssistantPresets((s) => s.loadOptions);
  const applySelection = useAssistantPresets((s) => s.apply);
  const revisionOf = useAssistantPresets((s) => s.revisionOf);
  const rememberRevision = useAssistantPresets((s) => s.rememberRevision);
  const setDraft = useAssistantPresets((s) => s.setDraft);
  const setTemporary = useAssistantPresets((s) => s.setTemporary);
  const setLabel = useAssistantPresets((s) => s.setLabel);

  const [view, setView] = useState<View>("list");
  const [editingPreset, setEditingPreset] = useState<AssistantPreset | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState<AssistantPreset | null>(null);
  const [deleting, setDeleting] = useState<AssistantPreset | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const key = remoteId ?? localId;
  const current = useAssistantPresets((s) => (key ? (s.labels[key] ?? null) : null));

  useEffect(() => {
    if (!open) return;
    setError(null);
    setNotice(null);
    if (startInManage) setView("list");
    void loadMine();
    void loadPublished(true);
    void loadOptions(remoteId).catch(() => {});
  }, [open, startInManage, loadMine, loadPublished, loadOptions, remoteId]);

  const visibleMine = useMemo(
    () => mine.filter((preset) => !query.trim() || preset.name.toLowerCase().includes(query.trim().toLowerCase())),
    [mine, query],
  );
  const visiblePublished = useMemo(
    () => published.filter((preset) => !query.trim() || preset.name.toLowerCase().includes(query.trim().toLowerCase())),
    [published, query],
  );

  const revision = async (): Promise<number> => {
    if (!remoteId) return 0;
    const known = revisionOf(remoteId);
    if (known !== undefined) return known;
    const detail = await api<{ revision: number }>(`/threads/${remoteId}/assistant`);
    rememberRevision(remoteId, detail.revision);
    return detail.revision;
  };

  const applyNow = async (preset: AssistantPreset | null) => {
    setApplying(null);
    setError(null);
    try {
      if (!remoteId) {
        // A new chat has no server snapshot yet; RuntimeProvider applies it when initialize() creates the thread.
        setDraft(localId, preset ? { presetId: preset.id, presetRevision: preset.revision } : null);
        setLabel(localId, preset ? { name: preset.name, icon: preset.icon, revision: preset.revision, modelRef: preset.config.modelRef } : null);
        setNotice(preset ? t("assistants.applied", { name: preset.name }) : t("assistants.cleared"));
        return;
      }
      if (isTemporaryChat(remoteId)) {
        // Temporary chats keep the validated snapshot in memory only; nothing is written to history.
        const snapshot: AssistantSnapshot | null = preset ? snapshotOf(preset) : null;
        setTemporary(remoteId, snapshot);
        setLabel(remoteId, snapshot ? { name: snapshot.name, icon: snapshot.icon, revision: snapshot.sourceRevision, modelRef: snapshot.modelRef } : null);
        setNotice(preset ? t("assistants.applied", { name: preset.name }) : t("assistants.cleared"));
        return;
      }
      const expected = await revision();
      const result = await applySelection(remoteId, preset ? { presetId: preset.id, presetRevision: preset.revision } : null, expected);
      if (result.snapshot?.modelRef) useData.setState((s) => ({ threadModels: { ...s.threadModels, [remoteId]: result.snapshot!.modelRef! } }));
      void useThreadMetaStore.getState().refresh(remoteId);
      setNotice(preset ? t("assistants.applied", { name: preset.name }) : t("assistants.cleared"));
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 409 ? t("assistants.conflict") : cause instanceof Error ? cause.message : t("assistants.saveFailed"));
    }
  };

  const choose = (preset: AssistantPreset) => {
    if (busy) return;
    if (remoteId && !isTemporaryChat(remoteId) && messageCount > 0) setApplying(preset);
    else void applyNow(preset);
  };

  const clear = () => {
    if (busy) return;
    void applyNow(null);
  };

  const startCreate = () => {
    setEditingPreset(null);
    setView("editor");
  };

  const close = () => {
    closeAssistantPicker();
    setView("list");
    setError(null);
    setNotice(null);
  };

  const optionsReady = options;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="flex max-h-[85dvh] w-[calc(100vw-1rem)] max-w-2xl flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-base">{view === "editor" ? (editingPreset ? t("assistants.edit") : t("assistants.create")) : t("assistants.pickerTitle")}</DialogTitle>
          <DialogDescription className="sr-only">{t("assistants.pickerTitle")}</DialogDescription>
        </DialogHeader>

        {view === "editor" && optionsReady ? (
          <AssistantPresetEditor
            preset={editingPreset}
            options={optionsReady}
            onSaved={(saved) => {
              setNotice(t("assistants.applied", { name: saved.name }));
              setView("list");
              void loadMine();
            }}
            onCancel={() => setView("list")}
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-40 flex-1">
                <SearchIcon className="text-muted-foreground pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2" />
                <Input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder={t("assistants.search")} aria-label={t("assistants.search")} className="ps-8" />
              </div>
              <Button type="button" size="sm" variant="outline" data-command="composer.manageAssistants" onClick={startCreate}>
                <PlusIcon /> {t("assistants.create")}
              </Button>
            </div>

            {busy && <p className="text-muted-foreground text-xs" role="status">{syncing ? t("assistants.syncRequired") : t("assistants.busy")}</p>}
            {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
            {notice && <p className="text-muted-foreground text-xs" role="status">{notice}</p>}

            <div className="min-h-0 flex-1 overflow-y-auto pe-1">
              <button
                type="button"
                disabled={busy || !current}
                onClick={clear}
                className="hover:bg-accent mb-2 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-start disabled:opacity-50"
              >
                <AssistantIcon name="sparkles" className="text-muted-foreground size-4" />
                <span className="flex-1 text-sm">{t("assistants.default")}</span>
                {!current && <CheckIcon className="size-4" />}
              </button>

              <h3 className="text-muted-foreground mt-3 mb-1 text-xs font-medium uppercase">{t("assistants.mine")}</h3>
              {loading && <Loader2Icon className="text-muted-foreground size-4 animate-spin" />}
              {!loading && !visibleMine.length && <p className="text-muted-foreground px-3 py-2 text-sm">{t("assistants.empty")}</p>}
              {visibleMine.map((preset) => (
                <PresetRow
                  key={preset.id}
                  preset={preset}
                  selected={current?.name === preset.name && current?.revision === preset.revision}
                  disabled={busy}
                  onChoose={() => choose(preset)}
                  actions={
                    <>
                      <button
                        type="button"
                        aria-label={t("assistants.edit")}
                        className="hover:bg-muted rounded-md p-1.5"
                        onClick={() => {
                          setEditingPreset(preset);
                          setView("editor");
                        }}
                      >
                        <PencilIcon className="size-4" />
                      </button>
                      <button type="button" aria-label={t("common.delete")} className="hover:bg-muted text-destructive rounded-md p-1.5" onClick={() => setDeleting(preset)}>
                        <Trash2Icon className="size-4" />
                      </button>
                    </>
                  }
                />
              ))}

              <h3 className="text-muted-foreground mt-4 mb-1 text-xs font-medium uppercase">{t("assistants.published")}</h3>
              {publishedLoading && <Loader2Icon className="text-muted-foreground size-4 animate-spin" />}
              {!publishedLoading && !visiblePublished.length && <p className="text-muted-foreground px-3 py-2 text-sm">{t("assistants.noResults")}</p>}
              {visiblePublished.map((preset) => (
                <PresetRow
                  key={preset.id}
                  preset={preset}
                  selected={current?.name === preset.name && current?.revision === preset.revision}
                  disabled={busy}
                  onChoose={() => choose(preset)}
                  actions={
                    <button
                      type="button"
                      className="hover:bg-muted rounded-md px-2 py-1 text-xs"
                      onClick={async () => {
                        const cloned = await api<AssistantPreset>("/assistant-presets", {
                          method: "POST",
                          json: { name: preset.name, description: preset.description, icon: preset.icon, config: preset.config, visibility: "private" },
                        });
                        void loadMine();
                        setEditingPreset(cloned);
                        setView("editor");
                      }}
                    >
                      {t("assistants.clone")}
                    </button>
                  }
                />
              ))}
              {nextCursor && (
                <Button type="button" variant="ghost" size="sm" disabled={publishedLoading} onClick={() => void loadPublished(false)}>
                  {t("assistants.loadMore")}
                </Button>
              )}
            </div>
          </>
        )}

        <AssistantConfirm
          open={!!applying}
          title={applying ? t("assistants.applyTitle", { name: applying.name }) : ""}
          description={t("assistants.applyNotice")}
          confirmLabel={t("assistants.apply")}
          onOpenChange={(next) => !next && setApplying(null)}
          onConfirm={() => applying && void applyNow(applying)}
        />

        <AssistantConfirm
          open={!!deleting}
          title={deleting ? t("assistants.deleteConfirm", { name: deleting.name }) : ""}
          confirmLabel={t("common.delete")}
          onOpenChange={(next) => !next && setDeleting(null)}
          onConfirm={async () => {
            if (!deleting) return;
            const target = deleting;
            setDeleting(null);
            try {
              await api(`/assistant-presets/${target.id}`, { method: "DELETE", json: { expectedRevision: target.revision } });
              void loadMine();
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : t("assistants.saveFailed"));
            }
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function PresetRow({
  preset,
  selected,
  disabled,
  onChoose,
  actions,
}: {
  preset: AssistantPreset;
  selected: boolean;
  disabled: boolean;
  onChoose: () => void;
  actions: ReactNode;
}) {
  return (
    <div className="hover:bg-accent/60 flex items-center gap-2 rounded-lg px-2">
      <button type="button" disabled={disabled} onClick={onChoose} className="flex min-w-0 flex-1 items-center gap-3 py-2 text-start disabled:opacity-50">
        <AssistantIcon name={preset.icon} className="text-muted-foreground size-4 shrink-0" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm">{preset.name}</span>
          {preset.description && <span className="text-muted-foreground truncate text-xs">{preset.description}</span>}
          <span className="text-muted-foreground truncate text-xs">{preset.owned ? "" : preset.owner.name} {preset.config.modelRef ?? t("assistants.useChatModel")}</span>
        </span>
        {selected && <CheckIcon className="size-4 shrink-0" />}
      </button>
      {preset.owned && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      {!preset.owned && actions}
    </div>
  );
}

/** The mobile plus-menu entry. */
export function AssistantMenuItem() {
  return (
    <button type="button" data-command="composer.assistant" onClick={() => openAssistantPicker()} className="hover:bg-accent flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm">
      <AssistantIcon name="sparkles" className="size-4" />
      {t("assistants.pickerTitle")}
    </button>
  );
}
