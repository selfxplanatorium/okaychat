import { create } from "zustand";

/**
 * Edited assistant replies, from the server's `edited_at` row field, and the reply whose editor is open.
 * Keys are `<thread id> <message id>`. The history adapter keeps edit times alongside raw cache rows;
 * the server also refuses stale writes to replies that have been edited.
 */
interface MessageEditsState {
  editedAt: Record<string, number>;
  editing: string | null;
}

export const editKey = (threadId: string, messageId: string) => `${threadId} ${messageId}`;

export const useMessageEdits = create<MessageEditsState>(() => ({ editedAt: {}, editing: null }));

/** Takes the edit state of every row the server (or the cache copy of its rows) returned for a chat. */
export function rememberEdits(threadId: string, rows: ReadonlyArray<{ id: string; edited_at?: number | null }>) {
  useMessageEdits.setState((s) => {
    const editedAt = { ...s.editedAt };
    for (const row of rows) {
      const key = editKey(threadId, row.id);
      if (typeof row.edited_at === "number") editedAt[key] = row.edited_at;
      else delete editedAt[key];
    }
    return { editedAt };
  });
}

export function setEditedAt(threadId: string, messageId: string, at: number | null) {
  rememberEdits(threadId, [{ id: messageId, edited_at: at }]);
}

export const isEdited = (threadId: string, messageId: string) => editKey(threadId, messageId) in useMessageEdits.getState().editedAt;

export const editedAtOf = (threadId: string, messageId: string) => useMessageEdits.getState().editedAt[editKey(threadId, messageId)];

export function openReplyEditor(threadId: string, messageId: string) {
  useMessageEdits.setState({ editing: editKey(threadId, messageId) });
}

export function closeReplyEditor() {
  useMessageEdits.setState({ editing: null });
}

/** Sign-out or another account: no edited-reply state may survive the session it belongs to. */
export function clearMessageEdits() {
  useMessageEdits.setState({ editedAt: {}, editing: null });
}
