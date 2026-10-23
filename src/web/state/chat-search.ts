import { useAuiState } from "@assistant-ui/react";
import { create } from "zustand";
import { useData } from "./data";

interface ChatSearchState {
  /** Per-chat composer choice. Missing means the account's webTools setting. */
  byId: Record<string, boolean>;
  set: (id: string, enabled: boolean) => void;
  bind: (localId: string, remoteId: string) => void;
}

/** Search preference for the current chat, kept in page memory like the composer's model choice. */
export const useChatSearchStore = create<ChatSearchState>((set, get) => ({
  byId: {},
  set: (id, enabled) => set((state) => ({ byId: { ...state.byId, [id]: enabled } })),
  bind: (localId, remoteId) => {
    const enabled = get().byId[localId];
    if (enabled !== undefined) set((state) => ({ byId: { ...state.byId, [remoteId]: enabled } }));
  },
}));

export function useChatSearch(): { enabled: boolean; toggle: () => void } {
  const id = useAuiState((s) => s.threadListItem.id);
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  const fallback = useData((s) => s.settings?.webTools ?? true);
  const enabled = useChatSearchStore((s) => s.byId[remoteId ?? ""] ?? s.byId[id] ?? fallback);
  return { enabled, toggle: () => useChatSearchStore.getState().set(remoteId ?? id, !enabled) };
}

/** Used by the request bridge; reads the live store so a toggle needs no extra render cycle. */
export function chatSearchFor(item: { id: string; remoteId?: string }): boolean {
  const state = useChatSearchStore.getState();
  return state.byId[item.remoteId ?? ""] ?? state.byId[item.id] ?? (useData.getState().settings?.webTools ?? true);
}
