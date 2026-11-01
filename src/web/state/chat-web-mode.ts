import { create } from "zustand";

export type ChatWebMode = "off" | "search" | "research";
interface ThreadItem { id: string; remoteId?: string | null }

interface ChatWebState {
  byId: Record<string, ChatWebMode>;
  toggle: (item: ThreadItem, mode: "search" | "research", webTools: boolean) => void;
  bind: (localId: string, remoteId: string) => void;
}

/** One web mode per chat, shared by desktop, mobile, shortcuts, and request configuration. */
export const useChatWebStore = create<ChatWebState>((set, get) => ({
  byId: {},
  toggle: (item, mode, webTools) => set((state) => ({
    byId: { ...state.byId, [item.remoteId ?? item.id]: chatWebMode(state.byId, item, webTools) === mode ? "off" : mode },
  })),
  bind: (localId, remoteId) => {
    const mode = get().byId[localId];
    if (mode !== undefined) set((state) => ({ byId: { ...state.byId, [remoteId]: mode } }));
  },
}));

/** A missing override follows the account's web-tools setting; research is always opt-in. */
export function chatWebMode(byId: ChatWebState["byId"], item: ThreadItem, webTools: boolean): ChatWebMode {
  return byId[item.remoteId ?? ""] ?? byId[item.id] ?? (webTools ? "search" : "off");
}
