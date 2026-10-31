// Pure pieces of assistant-reply editing, kept free of React so they can be tested on their own.

/** Why the edit control is hidden or disabled for a reply, or null when it can be edited now. */
export type EditBlock = "hidden" | "busy" | "summarized" | null;

export interface EditGate {
  /** The account setting "Edit assistant messages". */
  enabled: boolean;
  /** Stored thread id; undefined before the chat has one. */
  remoteId: string | undefined;
  temporary: boolean;
  role: string;
  /** The reply finished (`status.type === "complete"`): not streaming, stopped, or waiting for a tool. */
  complete: boolean;
  hasText: boolean;
  running: boolean;
  /** The chat shows cached rows (`pending`) or could not sync (`stale`). */
  syncing: boolean;
  /** The chat's summary replaces this reply, so an edit would never reach the model. */
  summarized: boolean;
}

export function editBlock(gate: EditGate): EditBlock {
  if (!gate.enabled || gate.temporary || !gate.remoteId || gate.role !== "assistant" || !gate.complete || !gate.hasText) return "hidden";
  if (gate.running || gate.syncing) return "busy";
  if (gate.summarized) return "summarized";
  return null;
}

/** Undo has no setting check: turning editing off must not trap an edit. */
export function undoBlock(gate: Pick<EditGate, "remoteId" | "temporary" | "running" | "syncing" | "summarized">): boolean {
  return !gate.remoteId || gate.temporary || gate.running || gate.syncing || gate.summarized;
}

/** The texts of a message's text parts, in order: what the editor shows and the API replaces. */
export const textsOf = (parts: ReadonlyArray<{ type: string; text?: string }>): string[] =>
  parts.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : []));

type ExternalState = { headId?: string | null; messages: Array<{ parentId: string | null; message: { id: string; parts?: unknown } }> };

/**
 * `thread.exportExternalState()` with one message's parts replaced by the stored ones. Ids, parents, the head,
 * and every other message are kept, so importing it neither forks nor moves the branch on screen.
 */
export function replaceMessageParts<S extends ExternalState>(state: S, messageId: string, parts: unknown[]): S {
  return {
    ...state,
    messages: state.messages.map((item) => (item.message.id === messageId ? { ...item, message: { ...item.message, parts } } : item)),
  };
}

/** Defer a saved edit until its owning thread is visible and idle; imports can emit synchronously. */
export function applyEditWhenReady(ready: () => boolean, subscribe: (listener: () => void) => () => void, apply: () => void): void {
  if (ready()) { apply(); return; }
  let applying = false;
  const unsubscribe = subscribe(() => {
    if (applying || !ready()) return;
    applying = true;
    unsubscribe();
    apply();
  });
}
