import { useAuiState } from "@assistant-ui/react";
import { useCallback } from "react";
import { create } from "zustand";
import type { KnowledgeCollection } from "@shared/knowledge";
import { api } from "@/lib/api";
import { isTemporaryChat } from "./chat-privacy";
import { useData } from "./data";

// Knowledge attachments are per chat, like the model and the search toggle. The server stores them on
// the thread (`threads.knowledge_ids`); this store mirrors that for the composer and binds a choice made
// before the thread exists to its new remote id.

interface ChatKnowledgeState {
  byId: Record<string, string[]>;
  /** Selector data, refreshed when the menu opens. */
  collections: KnowledgeCollection[] | null;
  loading: boolean;
  set: (id: string, ids: string[]) => void;
  bind: (localId: string, remoteId: string) => void;
  hydrate: (remoteId: string, ids: string[]) => void;
  loadCollections: (projectId: string | null) => Promise<KnowledgeCollection[]>;
}

let collectionsRequest = 0;

export const useChatKnowledgeStore = create<ChatKnowledgeState>((set, get) => ({
  byId: {},
  collections: null,
  loading: false,
  set: (id, ids) => set((state) => ({ byId: { ...state.byId, [id]: [...new Set(ids)] } })),
  bind: (localId, remoteId) => {
    const ids = get().byId[localId];
    if (ids !== undefined) set((state) => ({ byId: { ...state.byId, [remoteId]: ids } }));
  },
  hydrate: (remoteId, ids) => {
    set((state) => ({ byId: { ...state.byId, [remoteId]: [...ids] } }));
  },
  loadCollections: async (projectId) => {
    // Only the newest request may write: an older project's answer would offer collections this chat cannot use.
    const request = ++collectionsRequest;
    set({ loading: true });
    try {
      const path = projectId ? `/knowledge/collections?project=${encodeURIComponent(projectId)}` : "/knowledge/collections?project=none";
      const { collections } = await api<{ collections: KnowledgeCollection[] }>(path);
      if (request === collectionsRequest) set({ collections, loading: false });
      return collections;
    } catch (error) {
      if (request === collectionsRequest) set({ loading: false });
      throw error;
    }
  },
}));

/**
 * Persists a new chat's attachment choice after the server created its thread. On failure the stored
 * thread is cleared, so the selector never claims attachments the next request does not have; the
 * optimistic local choice remains for a retry and the error reaches the thread-initialisation path.
 */
export async function persistKnowledgeAttachments(threadId: string, ids: string[]): Promise<void> {
  try {
    await api(`/threads/${threadId}`, { method: "PATCH", json: { knowledgeIds: ids } });
  } catch (error) {
    useChatKnowledgeStore.getState().hydrate(threadId, []);
    throw error;
  }
}

let toggleQueue: Promise<void> = Promise.resolve();

export function useChatKnowledge(): {
  ids: string[];
  collections: KnowledgeCollection[] | null;
  loading: boolean;
  toggle: (collectionId: string) => Promise<void>;
  refresh: () => Promise<void>;
  temporary: boolean;
} {
  const id = useAuiState((s) => s.threadListItem.id);
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  // A chat opened from the search spotlight can be in another project while the sidebar filter is null;
  // the thread's own metadata, not the filter, decides which collections it may attach.
  const threadProject = useAuiState((s) => {
    const custom = s.threadListItem.custom as { projectId?: string | null } | undefined;
    return custom && "projectId" in custom ? custom.projectId ?? null : undefined;
  });
  const stored = useChatKnowledgeStore((s) => s.byId[remoteId ?? ""] ?? s.byId[id]);
  const collections = useChatKnowledgeStore((s) => s.collections);
  const loading = useChatKnowledgeStore((s) => s.loading);
  const temporary = !!remoteId && isTemporaryChat(remoteId);
  const set = useChatKnowledgeStore((s) => s.set);
  const ids = stored ?? [];
  const key = remoteId ?? id;
  // Stable per chat and project: the selector's load effect reruns when the open chat or its project changes.
  const refresh = useCallback(async () => {
    const projectId = remoteId && threadProject !== undefined ? threadProject : useData.getState().activeProject;
    await useChatKnowledgeStore.getState().loadCollections(projectId);
  }, [remoteId, threadProject]);
  return {
    ids,
    collections,
    loading,
    temporary,
    refresh,
    toggle: (collectionId) => {
      // Toggles run one after another and read the store when they start, so two quick clicks build on
      // each other instead of on the render-time list. Persist first for a stored chat, so the next
      // request can never see a scope the selector does not.
      const run = async () => {
        const byId = useChatKnowledgeStore.getState().byId;
        const before = byId[remoteId ?? ""] ?? byId[id] ?? [];
        const next = before.includes(collectionId) ? before.filter((value) => value !== collectionId) : [...before, collectionId];
        if (remoteId && !isTemporaryChat(remoteId)) await api(`/threads/${remoteId}`, { method: "PATCH", json: { knowledgeIds: next } });
        set(key, next);
      };
      const result = toggleQueue.then(run, run);
      toggleQueue = result.catch(() => {});
      return result;
    },
  };
}

interface CitationState {
  chunkId: string | null;
  open: (chunkId: string) => void;
  close: () => void;
}

/** One passage panel at a time, opened by an inline citation or a knowledge tool card. */
export const useKnowledgeCitationStore = create<CitationState>((set) => ({
  chunkId: null,
  open: (chunkId) => set({ chunkId }),
  close: () => set({ chunkId: null }),
}));
