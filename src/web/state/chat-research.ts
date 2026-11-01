import { useAuiState } from "@assistant-ui/react";
import type { PlainMessageKey } from "@/i18n";
import { useData } from "./data";
import { chatWebMode, useChatWebStore } from "./chat-web-mode";
import { useChatModel } from "./thread-meta";

/**
 * The current chat's choice, and why research cannot run here (null when it can). The server checks the
 * same conditions and refuses the request with the same reason.
 */
export function useChatResearch(): { enabled: boolean; toggle: () => void; unavailable: PlainMessageKey | null; searches: number; steps: number } {
  const id = useAuiState((s) => s.threadListItem.id);
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  const enabled = useChatWebStore((s) => chatWebMode(s.byId, { id, remoteId }, false) === "research");
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
  return { enabled, toggle: () => useChatWebStore.getState().toggle({ id, remoteId }, "research", webTools), unavailable, searches, steps };
}

/** Used by the request bridge; reads the live store so a toggle needs no extra render cycle. */
export function chatResearchFor(item: { id: string; remoteId?: string }): boolean {
  return chatWebMode(useChatWebStore.getState().byId, item, false) === "research";
}
