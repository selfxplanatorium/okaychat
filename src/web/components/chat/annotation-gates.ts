import { useAuiState } from "@assistant-ui/react";
import { useSyncExternalStore } from "react";
import type { PlainMessageKey } from "@/i18n";
import { subscribeStoredMessages, storedMessageExists } from "@/runtime/message-persistence";
import { isTemporaryChat } from "@/state/chat-privacy";
import { editKey, useMessageEdits } from "@/state/message-edits";
import { useThreadSync } from "@/state/thread-sync";
import { useThreadAnnotations } from "@/state/message-annotations";
import { useData } from "@/state/data";
import { useChatModel } from "@/state/thread-meta";
import { parseAttachmentText } from "@/runtime/message-attachments";
import { isAgentTarget } from "@shared/n8n-agents";
import { translationGateState, type TranslationGateInput } from "./translation-gate";

// The shared write gate for private annotations. History is persisted asynchronously after a turn ends, so
// "not running" is not proof that the server stores the message: only an acknowledged write or GET counts.

/** Whether the server acknowledged storing this chat/message pair. A cached copy never counts. */
export function useStoredMessage(threadId: string | null | undefined, messageId: string | undefined): boolean {
  return useSyncExternalStore(
    subscribeStoredMessages,
    () => !!threadId && !!messageId && storedMessageExists(threadId, messageId),
    () => false,
  );
}

/** The message root holding focus, so a message command acts on that reply and never the newest visible one. */
export function focusedMessageId(): string | null {
  const root = document.activeElement?.closest<HTMLElement>("[data-message-root]");
  return root?.dataset.messageId ?? null;
}

export interface AnnotationGate {
  available: boolean;
  /** Why the control is unavailable, for a translated disabled label. */
  reason: PlainMessageKey | null;
  temporary: boolean;
  threadId: string | null;
  running: boolean;
  syncing: boolean;
  editing: boolean;
  stored: boolean;
}

/**
 * Re-evaluated at render and again at submit by the server. `targeted` is false for controls that act on the
 * open chat rather than one message (the bookmark list).
 */
export function useAnnotationGate(threadId: string | null | undefined, messageId: string | undefined): AnnotationGate {
  const running = useAuiState((s) => s.thread.isRunning || s.thread.isLoading);
  const sync = useThreadSync();
  const syncing = !!sync;
  const editing = useMessageEdits((s) => (threadId && messageId ? s.editing === editKey(threadId, messageId) : false));
  const stored = useStoredMessage(threadId, messageId);
  // Acting before the chat's annotations arrive could turn a toggle into a no-op add.
  const loaded = useThreadAnnotations(threadId ?? undefined).loaded;
  const temporary = isTemporaryChat(threadId);
  const known = !!threadId && !temporary;
  let reason: PlainMessageKey | null = null;
  if (temporary) reason = "annotations.saveChatFirst";
  else if (!threadId) reason = "annotations.saveChatFirst";
  else if (sync === "stale") reason = "annotations.messageNotStored";
  else if (sync) reason = "annotations.syncRequired";
  else if (!stored) reason = "annotations.savingMessage";
  else if (!loaded) reason = "annotations.syncRequired";
  else if (running || editing) reason = "annotations.busy";
  return {
    available: known && !syncing && stored && loaded && !running && !editing,
    reason,
    temporary,
    threadId: threadId ?? null,
    running,
    syncing,
    editing,
    stored,
  };
}

export interface TranslationGate {
  available: boolean;
  /** Why the control is unavailable, for a translated disabled label. */
  reason: PlainMessageKey | null;
  temporary: boolean;
  syncing: boolean;
  stored: boolean;
  running: boolean;
}

/**
 * Translation has its own gate: it needs no annotations load, because a translation is independent of the
 * bookmark list, but it does need the stored message, an idle chat, text, the switch, and a model to call.
 */
export function useTranslationGate(threadId: string | null | undefined, messageId: string | undefined): TranslationGate {
  const running = useAuiState((s) => s.thread.isRunning || s.thread.isLoading);
  const sync = useThreadSync();
  const stored = useStoredMessage(threadId, messageId);
  const editing = useMessageEdits((s) => (threadId && messageId ? s.editing === editKey(threadId, messageId) : false));
  const temporary = isTemporaryChat(threadId);
  // The same rule the server applies: an attachment placeholder or blank text is not translatable.
  const hasText = useAuiState((s) =>
    s.message.parts.some((part) => part.type === "text" && part.text.trim() !== "" && parseAttachmentText(part.text) === undefined),
  );
  const enabled = useData((s) => s.settings?.translateMessages !== false);
  const utilityModel = useData((s) => s.settings?.utilityModel);
  const chatModel = useChatModel();
  // The server falls back to the utility model, the request's model, then the chat's; an agent is not a model.
  const hasModel = !!utilityModel || (!!chatModel && !isAgentTarget(chatModel));
  const state = translationGateState({ threadId, temporary, sync, stored, running, editing, enabled, hasModel, hasText });
  return { ...state, temporary, syncing: !!sync, stored, running };
}
