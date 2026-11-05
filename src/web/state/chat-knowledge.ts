import { useAuiState } from "@assistant-ui/react";
import { useCallback } from "react";
import { create } from "zustand";
import type { KnowledgeCollectionView } from "@shared/knowledge";
import { api } from "@/lib/api";
import { isTemporaryChat } from "./chat-privacy";
import { useData } from "./data";
import { assistantRevisionOf, rememberAssistantRevision } from "./assistant-presets";

/** A knowledge change on a chat with a copied assistant names the snapshot revision it edits. */
async function patchKnowledge(threadId: string, ids: string[], acceptSharedRestrictions: boolean): Promise<void> {
  const revision = assistantRevisionOf(threadId);
  await api(`/threads/${threadId}`, {
    method: "PATCH",
    json: { knowledgeIds: ids, acceptSharedRestrictions, ...(revision !== undefined ? { assistantRevision: revision } : {}) },
  });
  if (revision !== undefined) rememberAssistantRevision(threadId, revision + 1);
}

// Knowledge attachments are per chat, like the model and the search toggle. The server stores them on
// the thread (`threads.knowledge_ids`); this store mirrors that for the composer and binds a choice made
// before the thread exists to its new remote id.

interface ChatKnowledgeState {
  byId: Record<string, string[]>;
  /** Selector data, refreshed when the menu opens. Owned and shared views are discriminated by `access`. */
  collections: KnowledgeCollectionView[] | null;
  loading: boolean;
  set: (id: string, ids: string[]) => void;
  bind: (localId: string, remoteId: string) => void;
  hydrate: (remoteId: string, ids: string[]) => void;
  hydrateMany: (threads: ReadonlyArray<{ id: string; knowledgeIds: string[] }>) => void;
  loadCollections: (projectId: string | null) => Promise<KnowledgeCollectionView[]>;
}

let collectionsRequest = 0;
/** Bounds one selector refresh; a pathological account still stops after a sane number of pages. */
const MAX_PAGES = 20;

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
  hydrateMany: (threads) => {
    // One copy and notification for the whole list, rather than quadratic work per chat.
    set((state) => {
      const byId = { ...state.byId };
      for (const thread of threads) {
        if (thread.knowledgeIds.length) byId[thread.id] = [...thread.knowledgeIds];
        else delete byId[thread.id];
      }
      return { byId };
    });
  },
  loadCollections: async (projectId) => {
    // Only the newest request may write: an older project's answer would offer collections this chat cannot use.
    const request = ++collectionsRequest;
    set({ loading: true });
    try {
      const path = projectId ? `scope=attachable&project=${encodeURIComponent(projectId)}` : "scope=attachable&project=none";
      // Read every page: the selector must never hide a collection behind a default page size.
      const rows: KnowledgeCollectionView[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const pageResult: { collections: KnowledgeCollectionView[]; nextCursor: string | null } = await api<{ collections: KnowledgeCollectionView[]; nextCursor: string | null }>(
          `/knowledge/collections?${path}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        rows.push(...pageResult.collections);
        cursor = pageResult.nextCursor;
        if (!cursor) break;
      }
      if (request === collectionsRequest) set({ collections: rows, loading: false });
      return rows;
    } catch (error) {
      if (request === collectionsRequest) set({ loading: false });
      throw error;
    }
  },
}));

/** Clears another account's selector/panel data when the signed-in account changes. */
export function resetChatKnowledgeForAccount(): void {
  collectionsRequest += 1;
  useChatKnowledgeStore.setState({ byId: {}, collections: null, loading: false });
  useKnowledgeCitationStore.setState({ chunkId: null });
}

/**
 * Persists a new chat's attachment choice after the server created its thread. On failure the stored
 * thread is cleared, so the selector never claims attachments the next request does not have; the
 * optimistic local choice remains for a retry and the error reaches the thread-initialisation path.
 */
export async function persistKnowledgeAttachments(threadId: string, ids: string[], acceptSharedRestrictions = false): Promise<void> {
  try {
    await patchKnowledge(threadId, ids, acceptSharedRestrictions);
  } catch (error) {
    useChatKnowledgeStore.getState().hydrate(threadId, []);
    throw error;
  }
}

let toggleQueue: Promise<void> = Promise.resolve();

export function useChatKnowledge(): {
  ids: string[];
  collections: KnowledgeCollectionView[] | null;
  loading: boolean;
  toggle: (collectionId: string, acceptSharedRestrictions?: boolean) => Promise<void>;
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
    toggle: (collectionId, acceptSharedRestrictions = false) => {
      // Toggles run one after another and read the store when they start, so two quick clicks build on
      // each other instead of on the render-time list. Persist first for a stored chat, so the next
      // request can never see a scope the selector does not.
      const run = async () => {
        const byId = useChatKnowledgeStore.getState().byId;
        const before = byId[remoteId ?? ""] ?? byId[id] ?? [];
        const adding = !before.includes(collectionId);
        const next = adding ? [...before, collectionId] : before.filter((value) => value !== collectionId);
        if (remoteId && !isTemporaryChat(remoteId)) await patchKnowledge(remoteId, next, adding && acceptSharedRestrictions);
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
