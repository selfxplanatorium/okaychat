import { useAuiState } from "@assistant-ui/react";
import { useEffect, useRef } from "react";
import { create } from "zustand";
import type { CompactionState, ThreadSummary, UsageRow } from "@shared/types";
import type { ModelInfo } from "@shared/types";
import { api } from "@/lib/api";
import { useActiveModel } from "./data";
import { isTemporaryChat } from "./chat-privacy";
import { contextUsage } from "./context-usage";
export { metadataOf } from "./context-usage";

interface ThreadMeta {
  memoryDisabled: boolean;
  compaction: CompactionState | null;
  usage: UsageRow | null;
  branchedFrom: ThreadSummary["branchedFrom"];
}

/** `GET /threads/:id`: the thread list adapter's `fetch()` and the metadata refresh read the same response. */
export type ThreadDetail = ThreadSummary & { compaction: CompactionState | null; usage: UsageRow | null };

interface ThreadMetaState {
  byId: Record<string, ThreadMeta>;
  /**
   * Starts a new request whose answer reflects every change made before the call (compaction, trim, memory
   * toggle, a finished run). `reuse` shares a request already in flight instead, for callers that only need
   * the chat's current metadata, such as opening it.
   */
  refresh: (threadId: string, options?: { reuse?: boolean }) => Promise<void>;
}

// One request in flight per chat, so the open chat's owner, the thread list's fetch, and explicit refreshes
// share it where they can. Sequence numbers keep a slower, older answer from overwriting a newer one.
const inflight = new Map<string, { seq: number; promise: Promise<ThreadDetail> }>();
const applied = new Map<string, number>();
let sequence = 0;

/** The request behind `refresh`, which rejects so `fetch()` can report a missing thread. */
export function loadThreadDetail(threadId: string, options?: { reuse?: boolean }): Promise<ThreadDetail> {
  const current = inflight.get(threadId);
  if (options?.reuse && current) return current.promise;
  const seq = ++sequence;
  const promise = api<ThreadDetail>(`/threads/${threadId}`).then((t) => {
    if (seq > (applied.get(threadId) ?? 0)) {
      applied.set(threadId, seq);
      const meta = { compaction: t.compaction, usage: t.usage, memoryDisabled: t.memoryDisabled, branchedFrom: t.branchedFrom };
      useThreadMetaStore.setState((s) => ({ byId: { ...s.byId, [threadId]: meta } }));
    }
    return t;
  });
  const settle = () => {
    if (inflight.get(threadId)?.seq === seq) inflight.delete(threadId);
  };
  promise.then(settle, settle);
  inflight.set(threadId, { seq, promise });
  return promise;
}

export const useThreadMetaStore = create<ThreadMetaState>(() => ({
  byId: {},
  refresh: (threadId, options) =>
    isTemporaryChat(threadId)
      ? Promise.resolve()
      : loadThreadDetail(threadId, options).then(
          () => {},
          () => {}, // Thread not created yet.
        ),
}));

export const useCurrentThreadId = () => useAuiState((s) => s.threadListItem.remoteId ?? null);

/** The model of the open chat: its own choice once it has a thread, the new-chat choice before. */
export const useChatModel = (): ModelInfo | undefined => useActiveModel(useCurrentThreadId());

/**
 * The single owner of the open chat's metadata lifecycle, mounted once beside the runtime: refreshes when a chat
 * opens and when its run ends. Readers use `useThreadMeta`, so mounting messages never sends requests.
 */
export function ThreadMetaSync() {
  const threadId = useCurrentThreadId();
  const running = useAuiState((s) => s.thread.isRunning);
  const seen = useRef<{ threadId: string | null; running: boolean }>({ threadId: null, running: false });
  useEffect(() => {
    const previous = seen.current;
    seen.current = { threadId, running };
    if (!threadId || running) return;
    const { refresh } = useThreadMetaStore.getState();
    // A finished run changed usage on the server, so an answer already in flight may predate it.
    if (previous.threadId === threadId && previous.running) void refresh(threadId);
    else if (previous.threadId !== threadId) void refresh(threadId, { reuse: true });
  }, [threadId, running]);
  return null;
}

/** Compaction, usage, and fork source of the open chat, as last loaded by `ThreadMetaSync` or a refresh. */
export function useThreadMeta(): ThreadMeta | null {
  const threadId = useCurrentThreadId();
  return useThreadMetaStore((s) => (threadId ? (s.byId[threadId] ?? null) : null));
}

/** Context after the newest reply or trim. Selectors return primitives to keep renders stable. */
export function useContextUsage(compaction: CompactionState | null): { tokens: number; window: number } | null {
  const tokens = useAuiState((s) => contextUsage(s.thread.messages, compaction)?.tokens ?? null);
  const window = useAuiState((s) => contextUsage(s.thread.messages, compaction)?.window ?? 0);
  return tokens !== null ? { tokens, window } : null;
}
