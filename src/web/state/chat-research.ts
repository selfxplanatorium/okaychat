import { useAuiState } from "@assistant-ui/react";
import { create } from "zustand";
import type { PlainMessageKey } from "@/i18n";
import { useData } from "./data";
import { useChatModel } from "./thread-meta";

interface ChatResearchState {
  /** Per-chat composer choice. Missing means off. */
  byId: Record<string, boolean>;
  set: (id: string, enabled: boolean) => void;
  bind: (localId: string, remoteId: string) => void;
}

/** Deep research choice for each chat, kept in page memory like the Search toggle. */
export const useChatResearchStore = create<ChatResearchState>((set, get) => ({
  byId: {},
  set: (id, enabled) => set((state) => ({ byId: { ...state.byId, [id]: enabled } })),
  bind: (localId, remoteId) => {
    const enabled = get().byId[localId];
    if (enabled !== undefined) set((state) => ({ byId: { ...state.byId, [remoteId]: enabled } }));
  },
}));

/**
 * The current chat's choice, and why research cannot run here (null when it can). The server checks the
 * same conditions and refuses the request with the same reason.
 */
export function useChatResearch(): { enabled: boolean; toggle: () => void; unavailable: PlainMessageKey | null; searches: number; steps: number } {
  const id = useAuiState((s) => s.threadListItem.id);
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  const enabled = useChatResearchStore((s) => s.byId[remoteId ?? ""] ?? s.byId[id] ?? false);
  const model = useChatModel();
  const webTools = useData((s) => s.settings?.webTools ?? true);
  const searches = useData((s) => s.settings?.maxSearches ?? 0);
  const steps = useData((s) => s.settings?.maxSteps ?? 0);
  const unavailable: PlainMessageKey | null = !model?.toolCall
    ? "composer.researchNeedsTools"
    : !webTools
      ? "composer.researchNeedsWeb"
      : searches === 0
        ? "composer.researchNeedsSearches"
        : null;
  return { enabled, toggle: () => useChatResearchStore.getState().set(remoteId ?? id, !enabled), unavailable, searches, steps };
}

/** Used by the request bridge; reads the live store so a toggle needs no extra render cycle. */
export function chatResearchFor(item: { id: string; remoteId?: string }): boolean {
  const state = useChatResearchStore.getState();
  return state.byId[item.remoteId ?? ""] ?? state.byId[item.id] ?? false;
}
