import { ConversationImportDialog } from "./ConversationImportDialog";
import { DownloadIcon, FileArchiveIcon, Loader2Icon, UploadIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ArchiveWarning } from "@shared/chat-archive";
import type { ThreadSummary } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { t, type MessageKey } from "@/i18n";
import { api } from "@/lib/api";
import { formatBytes, formatNumber } from "@/i18n/format";
import { useChatArchives } from "@/state/chat-archives";
import { useData } from "@/state/data";

/**
 * Export and import review. The dialog only holds the current job; closing it leaves no archive bytes or
 * manifest in the browser, and a finished import never switches the open chat.
 */

const WARNING_KEYS: Record<ArchiveWarning["code"], MessageKey> = {
  missingAsset: "chatArchives.missingAsset",
  unsupportedPart: "chatArchives.unsupportedPart",
  unsupportedFormat: "chatArchives.unsupportedFormat",
  draftExcluded: "chatArchives.draftExcluded",
  portableSettingsInactive: "chatArchives.portableSettingsInactive",
  embeddedLinks: "chatArchives.embeddedLinks",
  unknownModel: "chatArchives.unknownModel",
  mcpToolsOmitted: "chatArchives.portableSettingsInactive",
  knowledgeOmitted: "chatArchives.portableSettingsInactive",
  editedTextOnly: "chatArchives.embeddedLinks",
  attachmentMissing: "chatArchives.missingAsset",
};

function WarningList({ warnings }: { warnings: ArchiveWarning[] }) {
  if (!warnings.length) return null;
  return (
    <ul className="text-muted-foreground ms-4 list-disc text-xs">
      {warnings.map((warning, index) => (
        <li key={`${warning.code}-${index}`}>
          {t(WARNING_KEYS[warning.code] ?? "chatArchives.warnings", {
            name: warning.name ?? "",
            type: warning.type ?? "",
            model: warning.model ?? "",
            count: formatNumber(warning.count ?? 1),
          } as never)}
        </li>
      ))}
    </ul>
  );
}

export function ChatArchiveDialog({
  open,
  onOpenChange,
  mode,
  initialThreadIds,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "export" | "import";
  initialThreadIds?: string[];
}) {
  const job = useChatArchives((s) => s.job);
  const busy = useChatArchives((s) => s.busy);
  const error = useChatArchives((s) => s.error);
  const startExport = useChatArchives((s) => s.startExport);
  const startImport = useChatArchives((s) => s.startImport);
  const poll = useChatArchives((s) => s.poll);
  const confirm = useChatArchives((s) => s.confirm);
  const cancel = useChatArchives((s) => s.cancel);
  const reset = useChatArchives((s) => s.reset);

  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set(initialThreadIds ?? []));
  const [importKeys, setImportKeys] = useState<Set<string>>(new Set());
  const [loadingChats, setLoadingChats] = useState(false);
  const [phase, setPhase] = useState<"choose" | "job">("choose");
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      reset();
      setPhase("choose");
      setImportKeys(new Set());
      return;
    }
    setSelected(new Set(initialThreadIds ?? []));
  }, [open, initialThreadIds, reset]);

  useEffect(() => {
    if (!open || mode !== "export" || phase !== "choose") return;
    setLoadingChats(true);
    api<ThreadSummary[]>("/threads")
      .then((rows) => setThreads(rows))
      .catch(() => useChatArchives.getState().setError(t("chatArchives.loadChatsFailed")))
      .finally(() => setLoadingChats(false));
  }, [open, mode, phase]);

  // Poll only while this dialog shows a preparing/committing job; after 10 s the interval backs off to 2 s.
  useEffect(() => {
    if (!open || !job || (job.state !== "preparing" && job.state !== "committing")) return;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const next = await poll(job.id);
      if (!next || next.state === "ready" || next.state === "done" || next.state === "failed" || next.state === "cancelled") {
        if (next?.state === "ready" && next.kind === "import") setImportKeys(new Set(next.summary?.chats.map((chat) => chat.key) ?? []));
        return;
      }
      timer = setTimeout(tick, Date.now() - started > 10_000 ? 2_000 : 1_000);
    };
    timer = setTimeout(tick, Date.now() - started > 10_000 ? 2_000 : 1_000);
    return () => clearTimeout(timer);
  }, [open, job, poll]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return threads.filter((thread) => !query || (thread.title ?? "").toLowerCase().includes(query));
  }, [threads, search]);

  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const start = async () => {
    if (!selected.size) return useChatArchives.getState().setError(t("chatArchives.noSelection"));
    if (selected.size > 100) return useChatArchives.getState().setError(t("chatArchives.splitArchive", { count: 100 }));
    setPhase("job");
    await startExport([...selected].map((id) => ({ id })));
  };

  const upload = async (file: File) => {
    setPhase("job");
    const next = await startImport(file);
    if (next?.summary) setImportKeys(new Set(next.summary.chats.map((chat) => chat.key)));
  };

  const warnings = job?.summary?.chats.flatMap((chat) => chat.warnings) ?? [];
  const result = job?.result;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85dvh] w-[calc(100vw-1rem)] max-w-2xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="text-base">{mode === "export" ? t("chatArchives.exportChats") : t("chatArchives.importArchive")}</DialogTitle>
          <DialogDescription>{t("chatArchives.archiveNotice")}</DialogDescription>
        </DialogHeader>

        {error && <p role="alert" className="text-destructive text-sm">{error}</p>}

        {phase === "choose" && mode === "export" && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Input value={search} onChange={(event) => setSearch(event.currentTarget.value)} placeholder={t("chatArchives.chooseChats")} aria-label={t("chatArchives.chooseChats")} className="min-w-40 flex-1" />
              <Button type="button" variant="outline" size="sm" onClick={() => setSelected(new Set(threads.map((thread) => thread.id)))}>
                {t("chatArchives.allChats")}
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">{t("chatArchives.selectedCount", { count: selected.size })}</p>
            <div className="min-h-0 flex-1 overflow-y-auto pe-1">
              {loadingChats && <Loader2Icon className="text-muted-foreground size-4 animate-spin" />}
              {visible.map((thread) => (
                <label key={thread.id} className="hover:bg-accent/60 flex items-center gap-2 rounded-lg px-2 py-2 text-sm">
                  <input type="checkbox" checked={selected.has(thread.id)} onChange={() => toggle(thread.id)} />
                  <span className="truncate">{thread.title ?? t("common.newChat")}</span>
                  <span className="text-muted-foreground ms-auto text-xs">{thread.status === "archived" ? t("chatArchives.archived") : ""}</span>
                </label>
              ))}
            </div>
            <p className="text-muted-foreground text-xs">{t("chatArchives.privateDataNotice")}</p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t("chatArchives.cancel")}</Button>
              <Button type="button" onClick={() => void start()} disabled={busy || !selected.size}>
                {t("chatArchives.exportChats")}
              </Button>
            </div>
          </>
        )}

        {phase === "choose" && mode === "import" && (
          <>
            <p className="text-sm">{t("chatArchives.importNotice")}</p>
            <p className="text-muted-foreground text-xs">{t("chatArchives.privateDataNotice")}</p>
            <input
              ref={fileInput}
              type="file"
              accept=".zip,.okaychat.zip,application/zip"
              className="sr-only"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) void upload(file);
              }}
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t("chatArchives.cancel")}</Button>
              <Button type="button" onClick={() => fileInput.current?.click()}>
                <UploadIcon /> {t("chatArchives.chooseFile")}
              </Button>
            </div>
          </>
        )}

        {phase === "job" && (
          <>
            {(!job || job.state === "preparing" || job.state === "committing") && (
              <p role="status" className="text-muted-foreground flex items-center gap-2 text-sm">
                <Loader2Icon className="size-4 animate-spin" />
                {job?.state === "committing" ? t("chatArchives.committing") : mode === "import" ? t("chatArchives.reviewing") : t("chatArchives.preparing")}
              </p>
            )}
            {job?.state === "failed" && (
              <p role="alert" className="text-destructive text-sm">
                {job.error?.code === "invalid_archive" ? t("chatArchives.invalidArchive") : mode === "import" ? t("chatArchives.importFailed") : t("chatArchives.prepareFailed")}
              </p>
            )}
            {job?.state === "cancelled" && <p className="text-muted-foreground text-sm">{t("chatArchives.cancelled")}</p>}
            {job?.state === "ready" && job.summary && (
              <>
                <div className="min-h-0 flex-1 overflow-y-auto pe-1">
                  <p className="text-muted-foreground mb-2 text-xs">
                    {formatBytes(job.summary.totalBytes)} · {t("chatArchives.selectedCount", { count: job.summary.chats.length })}
                  </p>
                  {job.summary.chats.map((chat) => (
                    <label key={chat.key} className="flex flex-col gap-1 rounded-lg px-2 py-2 text-sm">
                      <span className="flex items-center gap-2">
                        {job.kind === "import" && (
                          <input
                            type="checkbox"
                            checked={importKeys.has(chat.key)}
                            onChange={() =>
                              setImportKeys((current) => {
                                const next = new Set(current);
                                if (next.has(chat.key)) next.delete(chat.key);
                                else next.add(chat.key);
                                return next;
                              })
                            }
                          />
                        )}
                        <span className="truncate font-medium">{chat.title ?? t("common.newChat")}</span>
                      </span>
                      <span className="text-muted-foreground ps-6 text-xs">
                        {chat.messages} · {chat.branches} · {chat.assets} · {formatBytes(chat.bytes)}
                      </span>
                      <div className="ps-6"><WarningList warnings={chat.warnings} /></div>
                    </label>
                  ))}
                  {warnings.length > 0 && <p className="text-muted-foreground mt-2 text-xs">{t("chatArchives.warnings")}</p>}
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button type="button" variant="outline" onClick={() => (job ? void cancel(job.id) : undefined)}>{t("chatArchives.cancel")}</Button>
                  {job.kind === "export" ? (
                    <a
                      href={`/api/chat-archives/${job.id}/download`}
                      download
                      className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-9 items-center gap-2 rounded-lg px-3 text-sm font-medium"
                    >
                      <DownloadIcon className="size-4" /> {t("chatArchives.download")}
                    </a>
                  ) : (
                    <Button type="button" disabled={busy || !importKeys.size} onClick={() => job && void confirm(job.id, [...importKeys])}>
                      <FileArchiveIcon /> {t("chatArchives.importSelected", { count: importKeys.size })}
                    </Button>
                  )}
                </div>
              </>
            )}
            {job?.state === "done" && result && (
              <>
                <p role="status" className="text-sm">{t("chatArchives.importedCount", { count: result.threads.length })}</p>
                <div className="min-h-0 flex-1 overflow-y-auto pe-1">
                  {result.threads.map((thread) => (
                    <a key={thread.id} href={`/c/${encodeURIComponent(thread.id)}`} className="hover:bg-accent block rounded-lg px-2 py-2 text-sm">
                      {thread.title ?? t("common.newChat")} · {t("chatArchives.openChat")}
                    </a>
                  ))}
                </div>
                <div className="flex justify-end">
                  <Button type="button" onClick={() => onOpenChange(false)}>{t("common.close")}</Button>
                </div>
              </>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Settings entry: export a selection or import a file. */
export function ChatDataSection() {
  const [jsonMode,setJsonMode] = useState<"import"|"export"|null>(null);
  const [mode, setMode] = useState<"export" | "import" | null>(null);
  const refreshStorage = useData((s) => s.refreshStorage);
  return (
    <div className="flex flex-wrap gap-2 px-4 py-3">
      <Button type="button" variant="outline" onClick={() => setMode("export")}>
        <DownloadIcon /> {t("chatArchives.exportChats")}
      </Button>
      <Button type="button" variant="outline" onClick={() => setMode("import")}>
        <UploadIcon /> {t("chatArchives.importArchive")}
      </Button>
      <p className="text-muted-foreground w-full text-xs">{t("chatArchives.archiveNotice")}</p>
      <Button type="button" variant="outline" className="min-h-11" onClick={()=>setJsonMode("import")}><UploadIcon />{t("conversationImport.import")}</Button>
      <Button type="button" variant="outline" className="min-h-11" onClick={()=>setJsonMode("export")}><DownloadIcon />{t("conversationImport.export")}</Button>
      <ConversationImportDialog open={jsonMode!==null} mode={jsonMode??"import"} onOpenChange={(open)=>{if(!open) setJsonMode(null);}} />
      <ChatArchiveDialog
        open={mode !== null}
        mode={mode ?? "export"}
        onOpenChange={(open) => {
          if (!open) {
            setMode(null);
            void refreshStorage().catch(() => {});
          }
        }}
      />
    </div>
  );
}
