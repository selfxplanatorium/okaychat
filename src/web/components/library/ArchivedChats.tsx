import { useAui, useAuiState } from "@assistant-ui/react";
import { ArchiveIcon, ArchiveRestoreIcon, FileDownIcon, FileTextIcon, Loader2Icon, MessageCircleIcon, MoreHorizontalIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import type { ThreadSummary } from "@shared/types";
import { DeleteChatDialog } from "@/components/chat/DeleteChatDialog";
import { useServiceDown } from "@/components/chat/ServiceNotice";
import { ServiceAvailability } from "@/components/ServiceAvailability";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { FloatingSelectionBar, SelectionCheck, SelectModeToggle, useSelection, useSelectionKeys } from "@/components/ui/selection";
import { Delayed, Skeleton } from "@/components/ui/skeleton";
import { t } from "@/i18n";
import { formatDate } from "@/i18n/format";
import { api } from "@/lib/api";
import { runBatch } from "@/lib/selection";
import { cn } from "@/lib/utils";
import { exportThread, type ThreadExportFormat } from "@/lib/thread-export";
import { showChat, useData } from "@/state/data";
import { markUsedServices } from "@/state/services";

/** Appends the first error's message to a bulk failure summary. */
const withReason = (message: string, error: unknown) =>
  error instanceof Error && error.message ? t("library.withReason", { message, reason: error.message }) : message;

/** Archived chats across every project, with restore, open, export, and permanent delete, one by one or selected together. */
export function ArchivedChats({ tabs }: { tabs: ReactNode }) {
  const aui = useAui();
  const [, navigate] = useLocation();
  const projects = useData((s) => s.projects);
  // Archiving or restoring from the sidebar changes the runtime's list; refetch so this view follows.
  const activeIds = useAuiState((s) => s.threads.threadIds);
  const [threads, setThreads] = useState<ThreadSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ThreadSummary | null>(null);
  const requestId = useRef(0);
  // PDF export renders on the server; Markdown and every other action here work without the worker.
  const pdfDown = useServiceDown("browser");

  const load = useCallback(async () => {
    const id = ++requestId.current;
    try {
      const list = await api<ThreadSummary[]>("/threads?status=archived");
      if (id !== requestId.current) return;
      // Older servers ignore the filter; never show active chats here.
      setThreads(list.filter((t) => t.status === "archived").sort((a, b) => b.updatedAt - a.updatedAt));
      setError(null);
    } catch (cause) {
      if (id !== requestId.current) return;
      setThreads((prev) => prev ?? []);
      setError(cause instanceof Error ? cause.message : t("library.archivedLoadFailed"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, activeIds]);

  const projectNames = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);

  const act = async (thread: ThreadSummary, task: () => Promise<void>) => {
    setBusyId(thread.id);
    setError(null);
    try {
      await task();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("common.somethingWentWrong"));
    } finally {
      setBusyId(null);
    }
  };

  const unarchive = async (thread: ThreadSummary) => {
    await api(`/threads/${thread.id}`, { method: "PATCH", json: { status: "regular" } });
    setThreads((prev) => prev?.filter((t) => t.id !== thread.id) ?? null);
  };

  const restore = (thread: ThreadSummary) =>
    act(thread, async () => {
      await unarchive(thread);
      await aui.threads.reload();
    });

  const open = (thread: ThreadSummary) =>
    act(thread, async () => {
      await unarchive(thread);
      // The chat may belong to another project than the sidebar filter, so show every chat.
      useData.getState().setActiveProject(null);
      await aui.threads.reload();
      await aui.threads.switchToThread(thread.id);
      showChat(navigate);
    });

  const exportAs = (thread: ThreadSummary, format: ThreadExportFormat) =>
    act(thread, () => {
      if (format === "pdf") markUsedServices(["browser"]);
      return exportThread(thread.id, format, thread.title);
    });

  const order = useMemo(() => threads?.map((t) => t.id) ?? [], [threads]);
  const selection = useSelection(order);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkDelete, setBulkDelete] = useState({ open: false, count: 0, title: null as string | null });
  const setSelecting = (on: boolean) => {
    selection.setMode(on);
    setBulkError(null);
  };
  useSelectionKeys(selection.selecting, { onExit: () => setSelecting(false), onSelectAll: () => selection.selectAll() });

  /** Runs `task` per selected chat and drops the finished ones; leaves selection mode when none failed. */
  const applyToSelection = async (verb: "restore" | "delete", task: (id: string) => Promise<unknown>, onFailed?: (count: number) => void) => {
    const ids = [...selection.selected];
    const { failed, error } = await runBatch(ids, task);
    const done = new Set(ids.filter((id) => !failed.includes(id)));
    setThreads((prev) => prev?.filter((t) => !done.has(t.id)) ?? null);
    if (failed.length) {
      onFailed?.(failed.length);
      const failure =
        verb === "restore"
          ? failed.length === ids.length ? t("library.restoreChatsFailedAll") : t("library.restoreChatsFailedSome", { failed: failed.length, total: ids.length })
          : failed.length === ids.length ? t("library.deleteChatsFailedAll") : t("library.deleteChatsFailedSome", { failed: failed.length, total: ids.length });
      throw new Error(withReason(failure, error));
    }
    setSelecting(false);
  };

  const restoreSelected = async () => {
    setBulkBusy(true);
    setBulkError(null);
    try {
      await applyToSelection("restore", (id) => api(`/threads/${id}`, { method: "PATCH", json: { status: "regular" } })).finally(() => aui.threads.reload());
    } catch (cause) {
      setBulkError(cause instanceof Error ? cause.message : t("library.restoreChatsFailedAll"));
    } finally {
      setBulkBusy(false);
    }
  };

  const toolbar = (
    <div className="flex items-center justify-between gap-3">
      {tabs}
      <SelectModeToggle selecting={selection.selecting} onChange={setSelecting} disabled={!threads?.length && !selection.selecting} />
    </div>
  );

  if (threads === null) {
    return (
      <>
        {toolbar}
        <Delayed>
          <div className="animate-fade-in flex flex-col gap-2">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-12 rounded-lg" />
            ))}
          </div>
        </Delayed>
      </>
    );
  }

  return (
    <>
      {toolbar}
      {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
      {threads.length === 0 ? (
        <div className="flex flex-col items-center py-16 text-center">
          <ArchiveIcon aria-hidden className="text-muted-foreground mb-5 size-8" />
          <h2 className="text-base font-medium">{t("library.archivedEmptyTitle")}</h2>
          <p className="text-muted-foreground mt-2 max-w-xs text-sm">{t("library.archivedEmptyBody")}</p>
        </div>
      ) : (
        <ul className="bg-card divide-border rounded-xl divide-y shadow-[var(--depth-highlight),var(--shadow-raised)]">
          {threads.map((thread) => {
            const busy = busyId === thread.id;
            const project = thread.projectId ? (projectNames.get(thread.projectId) ?? t("library.unknownProject")) : t("library.noProject");
            const label = (
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{thread.title || t("common.newChat")}</p>
                <p className="text-muted-foreground truncate text-xs">
                  {project} · {formatDate(thread.updatedAt)}
                </p>
              </div>
            );
            if (selection.selecting) {
              const selected = selection.selected.has(thread.id);
              return (
                <li key={thread.id}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={selected}
                    // Without this Shift+click would also select the text between the two clicks.
                    onMouseDown={(event) => event.shiftKey && event.preventDefault()}
                    onClick={(event) => selection.toggle(thread.id, event.shiftKey)}
                    className={cn(
                      "hover:bg-accent/40 focus-visible:bg-accent/40 flex min-h-12 w-full items-center gap-3 px-3 py-2 text-left outline-none transition-colors duration-(--motion-fast) ease-out-quart in-[li:first-child]:rounded-t-xl in-[li:last-child]:rounded-b-xl pointer-coarse:px-4 pointer-coarse:py-3",
                      selected && "bg-primary/10 hover:bg-primary/15",
                    )}
                  >
                    <SelectionCheck checked={selected} />
                    {label}
                  </button>
                </li>
              );
            }
            return (
              <li key={thread.id} className="flex min-h-12 items-center gap-2 px-3 py-2 pointer-coarse:px-4 pointer-coarse:py-3">
                {label}
                {busy && <Loader2Icon aria-label={t("library.working")} className="text-muted-foreground size-4 shrink-0 animate-spin" />}
                <Button variant="outline" size="sm" disabled={busy} onClick={() => void open(thread)}>
                  <MessageCircleIcon /> <span className="max-sm:sr-only">{t("common.open")}</span>
                </Button>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => void restore(thread)}>
                  <ArchiveRestoreIcon /> <span className="max-sm:sr-only">{t("library.restore")}</span>
                </Button>
                <Menu>
                  <MenuTrigger render={<Button variant="ghost" size="icon-sm" disabled={busy} aria-label={t("library.moreActions")} className="pointer-coarse:size-10" />}>
                    <MoreHorizontalIcon />
                  </MenuTrigger>
                  <MenuContent align="end" className="min-w-48">
                    <MenuItem onClick={() => void exportAs(thread, "markdown")}>
                      <FileTextIcon /> {t("library.exportMarkdown")}
                    </MenuItem>
                    <MenuItem
                      aria-disabled={pdfDown || undefined}
                      aria-describedby={pdfDown ? "pdf-export-availability" : undefined}
                      onClick={pdfDown ? undefined : () => void exportAs(thread, "pdf")}
                      className={pdfDown ? "text-muted-foreground" : undefined}
                    >
                      <FileDownIcon /> {t("library.exportPdf")}
                    </MenuItem>
                    {pdfDown && <ServiceAvailability id="browser" className="mx-1 mb-1" describeId="pdf-export-availability" messageKey="services.exportPdfNote" />}
                    <MenuSeparator />
                    <MenuItem destructive onClick={() => setDeleting(thread)}>
                      <Trash2Icon /> {t("library.deletePermanently")}
                    </MenuItem>
                  </MenuContent>
                </Menu>
              </li>
            );
          })}
        </ul>
      )}
      {selection.selecting && (
        <FloatingSelectionBar
          count={selection.selected.size}
          allSelected={selection.allSelected}
          onSelectAll={() => selection.selectAll()}
          onClear={selection.clear}
          error={bulkError}
        >
          {bulkBusy && <Loader2Icon aria-label={t("library.working")} className="text-muted-foreground mx-1 size-4 animate-spin" />}
          <Button variant="ghost" size="sm" disabled={bulkBusy || selection.selected.size === 0} onClick={() => void restoreSelected()} className="pointer-coarse:h-10">
            <ArchiveRestoreIcon /> {t("library.restore")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={bulkBusy || selection.selected.size === 0}
            onClick={() => {
              const count = selection.selected.size;
              setBulkDelete({ open: true, count, title: count === 1 ? (threads.find((t) => selection.selected.has(t.id))?.title ?? null) : null });
            }}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive pointer-coarse:h-10"
          >
            <Trash2Icon /> {t("common.delete")}
          </Button>
        </FloatingSelectionBar>
      )}
      <DeleteChatDialog
        open={bulkDelete.open}
        title={bulkDelete.title}
        count={bulkDelete.count}
        onOpenChange={(open) => setBulkDelete((prev) => ({ ...prev, open }))}
        onConfirm={async () => {
          try {
            await applyToSelection(
              "delete",
              (id) => api(`/threads/${id}`, { method: "DELETE" }),
              (count) => setBulkDelete((prev) => ({ ...prev, count })),
            );
          } finally {
            void useData.getState().refreshStorage().catch(() => {});
          }
        }}
      />
      <DeleteChatDialog
        open={deleting !== null}
        title={deleting?.title}
        onOpenChange={(next) => !next && setDeleting(null)}
        onConfirm={async () => {
          const thread = deleting!;
          await api(`/threads/${thread.id}`, { method: "DELETE" });
          setThreads((prev) => prev?.filter((t) => t.id !== thread.id) ?? null);
          void useData.getState().refreshStorage().catch(() => {});
        }}
      />
    </>
  );
}
