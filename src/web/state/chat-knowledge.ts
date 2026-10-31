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
    set({ loading: true });
    try {
      const path = projectId ? `/knowledge/collections?project=${encodeURIComponent(projectId)}` : "/knowledge/collections?project=none";
      const { collections } = await api<{ collections: KnowledgeCollection[] }>(path);
      set({ collections, loading: false });
      return collections;
    } catch (error) {
      set({ loading: false });
      throw error;
    }
  },
}));

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
  const stored = useChatKnowledgeStore((s) => s.byId[remoteId ?? ""] ?? s.byId[id]);
  const collections = useChatKnowledgeStore((s) => s.collections);
  const loading = useChatKnowledgeStore((s) => s.loading);
  const temporary = !!remoteId && isTemporaryChat(remoteId);
  const set = useChatKnowledgeStore((s) => s.set);
  const ids = stored ?? [];
  const key = remoteId ?? id;
  // Stable: the selector's load effect runs once per mount, even as attachments change.
  const refresh = useCallback(async () => {
    await useChatKnowledgeStore.getState().loadCollections(useData.getState().activeProject);
  }, []);
  return {
    ids,
    collections,
    loading,
    temporary,
    refresh,
    toggle: async (collectionId) => {
      const next = ids.includes(collectionId) ? ids.filter((value) => value !== collectionId) : [...ids, collectionId];
      // Persist first for a stored chat, so the next request can never see a scope the sidebar does not.
      if (remoteId && !isTemporaryChat(remoteId)) await api(`/threads/${remoteId}`, { method: "PATCH", json: { knowledgeIds: next } });
      set(key, next);
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
