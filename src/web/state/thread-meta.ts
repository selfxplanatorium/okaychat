import { useAuiState } from "@assistant-ui/react";
import { useEffect } from "react";
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

interface ThreadMetaState {
  byId: Record<string, ThreadMeta>;
  refresh: (threadId: string) => Promise<void>;
}

// Every useThreadMeta instance (one per compaction marker) refreshes when a thread mounts, spread over a few
// commits. Calls within one frame share a request that starts after all of them, so it is never older than a call.
const batched = new Map<string, Promise<void>>();

export const useThreadMetaStore = create<ThreadMetaState>((set) => ({
  byId: {},
  refresh: (threadId) => {
    if (isTemporaryChat(threadId)) return Promise.resolve();
    let pending = batched.get(threadId);
    if (!pending) {
      pending = new Promise<void>((resolve) => setTimeout(resolve, 16)).then(async () => {
        batched.delete(threadId);
        try {
          const t = await api<ThreadSummary & { compaction: CompactionState | null; usage: UsageRow }>(`/threads/${threadId}`);
          set((s) => ({ byId: { ...s.byId, [threadId]: { compaction: t.compaction, usage: t.usage, memoryDisabled: t.memoryDisabled, branchedFrom: t.branchedFrom } } }));
        } catch {
          // Thread not created yet.
        }
      });
      batched.set(threadId, pending);
    }
    return pending;
  },
}));

export const useCurrentThreadId = () => useAuiState((s) => s.threadListItem.remoteId ?? null);

/** The model of the open chat: its own choice once it has a thread, the new-chat choice before. */
export const useChatModel = (): ModelInfo | undefined => useActiveModel(useCurrentThreadId());

/** Keeps compaction + usage for the open thread fresh: on switch and whenever a run ends. */
export function useThreadMeta(): ThreadMeta | null {
  const threadId = useCurrentThreadId();
  const running = useAuiState((s) => s.thread.isRunning);
  const refresh = useThreadMetaStore((s) => s.refresh);
  useEffect(() => {
    if (threadId && !running) void refresh(threadId);
  }, [threadId, running, refresh]);
  return useThreadMetaStore((s) => (threadId ? (s.byId[threadId] ?? null) : null));
}

/** Context after the newest reply or trim. Selectors return primitives to keep renders stable. */
export function useContextUsage(compaction: CompactionState | null): { tokens: number; window: number } | null {
  const tokens = useAuiState((s) => contextUsage(s.thread.messages, compaction)?.tokens ?? null);
  const window = useAuiState((s) => contextUsage(s.thread.messages, compaction)?.window ?? 0);
  return tokens !== null ? { tokens, window } : null;
}
