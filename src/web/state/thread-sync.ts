import { useAuiState } from "@assistant-ui/react";
import { create } from "zustand";

/** `pending`: painted from the browser cache, server rows not in yet. `stale`: the server could not be reached. */
export type ThreadSync = "pending" | "stale";

export const useThreadSyncStore = create<{ byId: Record<string, ThreadSync> }>(() => ({ byId: {} }));

export function setThreadSync(remoteId: string, state: ThreadSync | null) {
  useThreadSyncStore.setState((s) => {
    const byId = { ...s.byId };
    if (state) byId[remoteId] = state;
    else delete byId[remoteId];
    return { byId };
  });
}

/** Set while the current chat shows cached rows. A send then would parent the reply on what the cache showed. */
export function useThreadSync(): ThreadSync | undefined {
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  return useThreadSyncStore((s) => (remoteId ? s.byId[remoteId] : undefined));
}
