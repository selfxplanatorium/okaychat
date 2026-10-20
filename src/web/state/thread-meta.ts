import { useAuiState } from "@assistant-ui/react";
import { useEffect } from "react";
import { create } from "zustand";
import type { AssistantMetadata, CompactionState, UsageRow } from "@shared/types";
import { api } from "@/lib/api";
import { isAnonymousChat } from "./chat-privacy";

interface ThreadMeta {
  memoryDisabled: boolean;
  compaction: CompactionState | null;
  usage: UsageRow | null;
}

interface ThreadMetaState {
  byId: Record<string, ThreadMeta>;
  refresh: (threadId: string) => Promise<void>;
}

export const useThreadMetaStore = create<ThreadMetaState>((set) => ({
  byId: {},
  refresh: async (threadId) => {
    if (isAnonymousChat(threadId)) return;
    try {
      const t = await api<{ compaction: CompactionState | null; usage: UsageRow; memoryDisabled: boolean }>(`/threads/${threadId}`);
      set((s) => ({ byId: { ...s.byId, [threadId]: { compaction: t.compaction, usage: t.usage, memoryDisabled: t.memoryDisabled } } }));
    } catch {
      // Thread not created yet.
    }
  },
}));

export const useCurrentThreadId = () => useAuiState((s) => s.threadListItem.remoteId ?? null);

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
