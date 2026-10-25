import { useAuiState } from "@assistant-ui/react";
import { create } from "zustand";

export interface ChatPrivacy {
  temporary: boolean;
  personalized: boolean;
}
const NORMAL: ChatPrivacy = { temporary: false, personalized: true };
const TEMPORARY: ChatPrivacy = { temporary: true, personalized: false };
interface PrivacyState {
  byId: Record<string, ChatPrivacy>;
  set: (id: string, privacy: ChatPrivacy) => void;
  bind: (localId: string, remoteId: string) => void;
}

/** Temporary choices exist only in this page's memory, never browser storage. */
export const useChatPrivacyStore = create<PrivacyState>((set, get) => ({
  byId: {},
  set: (id, privacy) => set((state) => ({ byId: { ...state.byId, [id]: privacy } })),
  bind: (localId, remoteId) => {
    const privacy = get().byId[localId];
    if (privacy) set((state) => ({ byId: { ...state.byId, [remoteId]: privacy } }));
  },
}));

export const isTemporaryChat = (id: string | null | undefined) => !!id?.startsWith("tmp_");
export function chatPrivacyFor(item: { id: string; remoteId?: string | undefined }): ChatPrivacy {
  const choices = useChatPrivacyStore.getState().byId;
  return choices[item.remoteId ?? ""] ?? choices[item.id] ?? (isTemporaryChat(item.remoteId) ? TEMPORARY : NORMAL);
}

export function useChatPrivacy(): ChatPrivacy {
  const id = useAuiState((s) => s.threadListItem.id);
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  return useChatPrivacyStore((state) => state.byId[remoteId ?? ""] ?? state.byId[id] ?? (isTemporaryChat(remoteId) ? TEMPORARY : NORMAL));
}
