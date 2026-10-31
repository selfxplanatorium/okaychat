"use client";

import { useAui, useAuiState } from "@assistant-ui/react";
import { Loader2Icon, PencilLineIcon, SquarePenIcon } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MAX_EDITED_TEXT, type MessageEditResult } from "@shared/types";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { formatDateTime, formatNumber, formatRelativeTime } from "@/i18n/format";
import { useCommand } from "@/keyboard/registry";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { applyEditWhenReady, editBlock, replaceMessageParts, textsOf, undoBlock, type EditBlock } from "@/runtime/message-edit";
import { editStoredMessage, undoStoredMessage } from "@/runtime/RuntimeProvider";
import { isTemporaryChat } from "@/state/chat-privacy";
import { useData } from "@/state/data";
import { closeReplyEditor, editKey, openReplyEditor, setEditedAt, useMessageEdits } from "@/state/message-edits";
import { useThreadMetaStore } from "@/state/thread-meta";
import { useThreadSync } from "@/state/thread-sync";

// Inline editing of a finished assistant reply. Only text parts change; the server keeps every tool, reasoning,
// file, and source part, the message id, and its place in the branch. See docs/implementation/message-editing.md.

const errorText = (error: unknown) => (error instanceof ApiError ? error.message : t("common.somethingWentWrong"));

/** Capture a fixed thread before a request; the main-thread client follows chat switches. */
function replyTarget(aui: ReturnType<typeof useAui>, messageId: string) {
  const localId = aui.threadListItem.getState().id;
  const threads = aui.threads.__internal_getAssistantRuntime?.().threads;
  if (!threads) throw new Error("Thread runtime unavailable");
  const runtime = threads.getById(localId);
  return (result: MessageEditResult) => {
    applyEditWhenReady(
      () => threads.getState().mainThreadId === localId && !runtime.getState().isRunning && !runtime.getState().isLoading,
      threads.subscribe,
      () => {
        const parts = (result.message.content as { parts?: unknown[] }).parts ?? [];
        runtime.importExternalState(replaceMessageParts(runtime.exportExternalState(), messageId, parts));
      },
    );
  };
}

/** The message's summary boundary, when the open chat has one. */
function useSummaryBoundary(): string | undefined {
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  return useThreadMetaStore((s) => {
    const compaction = remoteId ? s.byId[remoteId]?.compaction : undefined;
    return compaction?.summary && compaction.boundaryMessageId ? compaction.boundaryMessageId : undefined;
  });
}

/** True when the chat's summary replaces this reply, so an edit would never reach the model. */
function useSummarized(): boolean {
  const boundary = useSummaryBoundary();
  return useAuiState((s) => {
    if (!boundary) return false;
    const index = s.thread.messages.findIndex((message) => message.id === boundary);
    return index !== -1 && s.message.index <= index;
  });
}

/** Everything the pencil and the Undo action need, read as primitives so streaming re-renders stay cheap. */
export function useReplyEditorGate(): {
  block: EditBlock;
  remoteId: string | undefined;
  temporary: boolean;
  running: boolean;
  syncing: boolean;
  summarized: boolean;
} {
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  const temporary = useAuiState((s) => isTemporaryChat(s.threadListItem.remoteId));
  const role = useAuiState((s) => s.message.role);
  const complete = useAuiState((s) => s.message.status?.type === "complete");
  const hasText = useAuiState((s) => s.message.parts.some((part) => part.type === "text" && (part.text ?? "").trim().length > 0));
  const running = useAuiState((s) => s.thread.isRunning || s.thread.isLoading);
  const syncing = !!useThreadSync();
  const summarized = useSummarized();
  const enabled = useData((s) => s.settings?.editAssistantMessages === true);
  const block = editBlock({ enabled, remoteId, temporary, role, complete, hasText, running, syncing, summarized });
  return { block, remoteId, temporary, running, syncing, summarized };
}

/** Pencil in the assistant action bar. Disabled, with the reason in its tooltip, while an edit cannot save. */
export function ReplyEditAction() {
  const { block, remoteId } = useReplyEditorGate();
  const messageId = useAuiState((s) => s.message.id);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const enabled = block === null && !!remoteId;
  // The shortcut acts on the message with focus. The DOM fallback would pick the newest action bar, which is
  // the last message, not the one the reader is on.
  useCommand("message.editReply", () => {
    if (!enabled) return false;
    const root = buttonRef.current?.closest("[data-message-root]");
    if (!root?.contains(document.activeElement) || !remoteId) return false;
    openReplyEditor(remoteId, messageId);
    return true;
  }, enabled);
  if (block === "hidden" || !remoteId) return null;
  const tooltip = block === "summarized" ? t("thread.editReplySummarized") : block === "busy" ? t("thread.editReplyBusy") : t("thread.editReply");
  return (
    <TooltipIconButton
      ref={buttonRef}
      command="message.editReply"
      tooltip={tooltip}
      disabled={block !== null}
      onClick={() => openReplyEditor(remoteId, messageId)}
    >
      <SquarePenIcon />
    </TooltipIconButton>
  );
}

interface ReplyEditorValue {
  drafts: string[];
  setDraft: (index: number, value: string) => void;
  save: () => void;
  cancel: () => void;
  saving: boolean;
  busy: boolean;
  canSave: boolean;
  error: string | null;
}

const ReplyEditorContext = createContext<ReplyEditorValue | null>(null);

/**
 * Provides edit state only to the reply being edited. A component rather than a conditional hook, so the
 * message tree below stays the same in both modes.
 */
export function ReplyEditorShell({ active, threadId, messageId, parts, children }: { active: boolean; threadId: string; messageId: string; parts: ReadonlyArray<{ type: string; text?: string }>; children: ReactNode }) {
  return active ? (
    <ReplyEditorProvider threadId={threadId} messageId={messageId} parts={parts}>{children}</ReplyEditorProvider>
  ) : (
    <>{children}</>
  );
}

/** Drafts, save, and cancel for one reply, shared by its text fields and footer. */
export function ReplyEditorProvider({ threadId, messageId, parts, children }: { threadId: string; messageId: string; parts: ReadonlyArray<{ type: string; text?: string }>; children: ReactNode }) {
  const aui = useAui();
  const initial = useMemo(() => textsOf(parts), [parts]);
  const [drafts, setDrafts] = useState<string[]>(initial);
  const [saving, setSaving] = useState(false);
  const savePending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const running = useAuiState((s) => s.thread.isRunning || s.thread.isLoading);
  const syncing = !!useThreadSync();
  const enabled = useData((s) => s.settings?.editAssistantMessages === true);
  const editorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = editorRef.current?.closest<HTMLElement>("[data-message-root]");
    return () => {
      // Do not steal focus when closing because the user selected another chat/control.
      if (root?.isConnected && (root.contains(document.activeElement) || document.activeElement === document.body)) root.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    setDrafts((current) => (current.length === initial.length && current.every((text, i) => text === initial[i]) ? current : initial));
  }, [initial]);
  // Turning editing off closes the open editor immediately; Undo on an existing edit stays available.
  useEffect(() => {
    if (!enabled) closeReplyEditor();
  }, [enabled]);

  const busy = running || syncing;
  const total = drafts.reduce((sum, text) => sum + text.length, 0);
  const canSave = !saving && !busy && drafts.some((text) => text.trim().length > 0) && total <= MAX_EDITED_TEXT;

  const save = async () => {
    if (!canSave || savePending.current) return;
    savePending.current = true;
    setSaving(true);
    setError(null);
    try {
      const apply = replyTarget(aui, messageId);
      const result = await editStoredMessage(threadId, messageId, drafts.length === 1
        ? { text: drafts[0]! }
        : { parts: drafts.map((text) => ({ type: "text" as const, text })) });
      setEditedAt(threadId, messageId, result.editedAt);
      apply(result);
      // The server may have shifted a trim estimate; the context meter owner re-reads it explicitly.
      void useThreadMetaStore.getState().refresh(threadId);
      if (useMessageEdits.getState().editing === editKey(threadId, messageId)) closeReplyEditor();
    } catch (failure) {
      setError(t("thread.editReplyFailed", { error: errorText(failure) }));
    } finally {
      savePending.current = false;
      setSaving(false);
    }
  };

  const value: ReplyEditorValue = {
    drafts,
    setDraft: (index, text) => setDrafts((current) => current.map((draft, i) => (i === index ? text : draft))),
    save: () => void save(),
    cancel: closeReplyEditor,
    saving,
    busy,
    canSave,
    error,
  };

  return (
    <ReplyEditorContext.Provider value={value}>
      <div
        ref={editorRef}
        data-slot="aui_reply-editor"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            // A save in flight must finish so its failure can show here; Cancel is disabled for the same reason.
            event.preventDefault();
            if (!savePending.current) closeReplyEditor();
          } else if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            void save();
          }
        }}
      >
        {children}
      </div>
    </ReplyEditorContext.Provider>
  );
}

const useReplyEditor = () => {
  const value = useContext(ReplyEditorContext);
  if (!value) throw new Error("ReplyEditor components must be rendered inside ReplyEditorProvider");
  return value;
};

/** The editable text of a reply, in the same glass shell as the composer. Non-text parts stay rendered above it. */
export function EditableReplyTexts() {
  const { drafts, setDraft, saving } = useReplyEditor();
  const tooLong = drafts.reduce((sum, text) => sum + text.length, 0) > MAX_EDITED_TEXT;
  return (
    <div className="depth-composer mt-2 flex flex-col gap-2 rounded-(--composer-radius) border bg-(--composer-bg) p-2">
      {drafts.map((text, index) => {
        const label = drafts.length > 1 ? t("thread.editReplySection", { index: index + 1, total: drafts.length }) : t("thread.editReplyLabel");
        return (
          <label key={index} className="flex flex-col gap-1">
            <span className={drafts.length > 1 ? "text-muted-foreground text-xs" : "sr-only"}>{label}</span>
            <Textarea
              autoFocus={index === 0}
              aria-label={label}
              className="aui-reply-edit-input min-h-24 max-h-72 resize-y overflow-y-auto border-0 bg-transparent px-1 py-1 text-base leading-6 shadow-none focus-visible:bg-transparent focus-visible:ring-2 focus-visible:ring-ring"
              value={text}
              disabled={saving}
              onChange={(event) => setDraft(index, event.target.value)}
            />
          </label>
        );
      })}
      {tooLong && <p role="alert" className="text-destructive text-xs">{t("thread.editReplyTooLong", { max: formatNumber(MAX_EDITED_TEXT) })}</p>}
    </div>
  );
}

/** Save and Cancel under the editable text, with touch sizing and a translated failure message. */
export function ReplyEditorFooter() {
  const { save, cancel, saving, busy, canSave, error } = useReplyEditor();
  return (
    <div className="mt-2 flex flex-col gap-2">
      {busy && <p className="text-muted-foreground px-1 text-xs">{t("thread.editReplyBusy")}</p>}
      {error && <p role="alert" className="text-destructive px-1 text-xs">{error}</p>}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" className="min-h-9 pointer-coarse:min-h-11 px-3" disabled={saving} onClick={cancel}>
          {t("common.cancel")}
        </Button>
        <Button type="button" size="sm" className="min-h-9 pointer-coarse:min-h-11 px-3" disabled={!canSave} onClick={save}>
          {saving && <Loader2Icon className="size-3.5 animate-spin motion-reduce:animate-none" />}
          {saving ? t("common.saving") : t("common.save")}
        </Button>
      </div>
    </div>
  );
}

/** "Edited <time>" with Undo, under a reply that the user rewrote. Works after the setting is turned off. */
export function EditedReplyBadge() {
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  const messageId = useAuiState((s) => s.message.id);
  const editedAt = useMessageEdits((s) => (remoteId ? s.editedAt[editKey(remoteId, messageId)] : undefined));
  // Most replies are not edited: keep their render free of the gate's subscriptions and summary scan.
  if (editedAt === undefined || !remoteId) return null;
  return <EditedReplyBadgeContent threadId={remoteId} messageId={messageId} editedAt={editedAt} />;
}

function EditedReplyBadgeContent({ threadId, messageId, editedAt }: { threadId: string; messageId: string; editedAt: number }) {
  const aui = useAui();
  const { remoteId, temporary, running, syncing, summarized } = useReplyEditorGate();
  const [undoing, setUndoing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const disabled = undoBlock({ remoteId, temporary, running, syncing, summarized }) || undoing;
  const reason = summarized ? t("thread.editReplySummarized") : running || syncing ? t("thread.editReplyBusy") : t("thread.undoEdit");

  const undo = async () => {
    if (disabled) return;
    setUndoing(true);
    setError(null);
    try {
      const apply = replyTarget(aui, messageId);
      const result = await undoStoredMessage(threadId, messageId);
      const root = buttonRef.current?.closest<HTMLElement>("[data-message-root]");
      setEditedAt(threadId, messageId, null);
      // The badge unmounts with the edit; keep focus in the message unless the user moved it elsewhere.
      if (root?.isConnected && (root.contains(document.activeElement) || document.activeElement === document.body)) root.focus({ preventScroll: true });
      apply(result);
      void useThreadMetaStore.getState().refresh(threadId);
    } catch (failure) {
      setError(t("thread.undoEditFailed", { error: errorText(failure) }));
    } finally {
      setUndoing(false);
    }
  };

  const canUndo = !disabled;
  useCommand("message.undoEdit", () => {
    if (!canUndo) return false;
    const root = buttonRef.current?.closest("[data-message-root]");
    if (!root?.contains(document.activeElement)) return false;
    void undo();
    return true;
  }, canUndo);

  return (
    <div data-slot="aui_reply-edited" className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-xs">
      <span className="inline-flex items-center gap-1" title={formatDateTime(editedAt)}>
        <PencilLineIcon className="size-3" aria-hidden />
        {t("thread.editedAt", { time: formatRelativeTime(editedAt) })}
      </span>
      <span aria-hidden>·</span>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        title={reason}
        aria-label={reason}
        onClick={() => void undo()}
        className={cn(
          "hover:text-foreground focus-visible:outline-ring rounded-sm underline underline-offset-2 transition-colors duration-(--motion-fast) ease-out-quart focus-visible:outline-2 focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-60",
          undoing && "inline-flex items-center gap-1",
        )}
      >
        {undoing && <Loader2Icon className="size-3 animate-spin motion-reduce:animate-none" />}
        {undoing ? t("common.saving") : t("thread.undoEdit")}
      </button>
      {error && <span role="alert" className="text-destructive basis-full">{error}</span>}
    </div>
  );
}
