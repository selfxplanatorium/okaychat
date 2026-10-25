import { useAuiState } from "@assistant-ui/react";
import { useEffect } from "react";
import { create } from "zustand";
import type { AssistantMetadata, CompactionState, ThreadSummary, UsageRow } from "@shared/types";
import type { ModelInfo } from "@shared/types";
import { api } from "@/lib/api";
import { useActiveModel } from "./data";
import { isTemporaryChat } from "./chat-privacy";

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

export const metadataOf = (metadata: unknown): AssistantMetadata =>
  ((metadata as { custom?: AssistantMetadata } | undefined)?.custom ?? {}) as AssistantMetadata;

function lastContext(messages: readonly { role: string; metadata: unknown }[]): AssistantMetadata | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    const meta = metadataOf(m.metadata);
    if (meta.contextTokens) return meta;
  }
  return null;
}

/** Context occupied after the newest finished assistant turn. Selectors return primitives to keep renders stable. */
export function useContextUsage(): { tokens: number; window: number } | null {
  const tokens = useAuiState((s) => lastContext(s.thread.messages)?.contextTokens ?? 0);
  const window = useAuiState((s) => lastContext(s.thread.messages)?.contextWindow ?? 0);
  return tokens ? { tokens, window } : null;
}
