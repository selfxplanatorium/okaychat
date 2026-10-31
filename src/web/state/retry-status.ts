import { create } from "zustand";
import { isErrorCode, type ErrorCode, type RetryNotice } from "@shared/errors";

/**
 * The live "Retrying in Ns…" state per chat. It comes from transient `data-retry` stream chunks,
 * so it is never stored with a message or replayed into the prompt.
 */
export interface RetryState {
  attempt: number;
  delayMs: number;
  code: ErrorCode;
  /** Client clock when the notice arrived; the countdown is relative so server/client skew does not matter. */
  receivedAt: number;
}

interface RetryStatusStore {
  byThread: Record<string, RetryState>;
  set: (threadId: string, state: RetryState) => void;
  clear: (threadId: string) => void;
}

export const useRetryStatusStore = create<RetryStatusStore>((set) => ({
  byThread: {},
  set: (threadId, state) => set((current) => ({ byThread: { ...current.byThread, [threadId]: state } })),
  clear: (threadId) => set((current) => {
    if (!current.byThread[threadId]) return current;
    const byThread = { ...current.byThread };
    delete byThread[threadId];
    return { byThread };
  }),
}));

/** The chat a live retry notice belongs to: the remote id, never the local assistant-ui id. */
export interface RetryOwner {
  id: string;
  remoteId?: string | null;
}

/**
 * Resolves the store key for a runtime's own thread. Each runtime is scoped to its own
 * `threadListItem`, so reading this lazily in a stream callback follows the chat that started the
 * run even after the user switches chats. A brand-new chat is still optimistic (`remote-` unset)
 * until `initialize()` resolves; its notice is applied once that id exists.
 */
export function retryOwnerId(item: RetryOwner | null | undefined): string | undefined {
  return item?.remoteId || undefined;
}

/** The payload of a transient `data-retry` chunk; every other data chunk is ignored. */
export function retryChunkData(chunk: unknown): unknown {
  if (typeof chunk !== "object" || chunk === null) return undefined;
  const part = chunk as { type?: unknown; data?: unknown };
  return part.type === "data-retry" ? part.data : undefined;
}

/** Applies one `data-retry` chunk. Unknown shapes are ignored, so a server change cannot break the chat. */
export function applyRetryNotice(threadId: string, data: unknown, now = Date.now()): void {
  if (!threadId || typeof data !== "object" || data === null) return;
  const notice = data as Partial<RetryNotice> & { status?: unknown };
  if (notice.status === "done") {
    useRetryStatusStore.getState().clear(threadId);
    return;
  }
  if (typeof notice.attempt !== "number" || typeof notice.delayMs !== "number" || !isErrorCode(notice.code)) return;
  useRetryStatusStore.getState().set(threadId, {
    attempt: notice.attempt,
    delayMs: Math.max(0, notice.delayMs),
    code: notice.code,
    receivedAt: now,
  });
}

export function clearRetryNotice(threadId: string | undefined): void {
  if (threadId) useRetryStatusStore.getState().clear(threadId);
}

/** Whole seconds still to wait, never below zero. */
export function retrySecondsLeft(state: RetryState, now = Date.now()): number {
  return Math.max(0, Math.ceil((state.receivedAt + state.delayMs - now) / 1000));
}

export const useRetryStatus = (threadId: string | undefined) =>
  useRetryStatusStore((store) => (threadId ? store.byThread[threadId] : undefined));
