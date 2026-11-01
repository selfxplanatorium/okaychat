import { useAuiState } from "@assistant-ui/react";
import { useData } from "./data";
import { chatWebMode, useChatWebStore } from "./chat-web-mode";

export function useChatSearch(): { enabled: boolean; toggle: () => void } {
  const id = useAuiState((s) => s.threadListItem.id);
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  const fallback = useData((s) => s.settings?.webTools ?? true);
  const enabled = useChatWebStore((s) => chatWebMode(s.byId, { id, remoteId }, fallback) === "search");
  return { enabled, toggle: () => useChatWebStore.getState().toggle({ id, remoteId }, "search", fallback) };
}

/** Used by the request bridge; reads the live store so a toggle needs no extra render cycle. */
export function chatSearchFor(item: { id: string; remoteId?: string }): boolean {
  return chatWebMode(useChatWebStore.getState().byId, item, useData.getState().settings?.webTools ?? true) === "search";
}
