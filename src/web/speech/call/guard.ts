import type { useAui } from "@assistant-ui/react";
import { useThreadSyncStore } from "@/state/thread-sync";
import type { CallFailureCode } from "./messages";

type Aui = ReturnType<typeof useAui>;

/** Web-only reasons a call cannot start in this chat right now. */
export type CallBlock = Extract<CallFailureCode, "chatBusy" | "chatLoading">;

/**
 * Why a call may not start in this chat right now. A local call appends its transcript as a normal user
 * message and starts that turn, so it must not share the chat with a running reply, dictation, or a cached
 * history paint that the server has not replaced yet. The composer button and the command both use this, and
 * the controller checks it again so no side path can bypass the cached-history barrier.
 */
export function callBlock(aui: Aui): CallBlock | null {
  const item = aui.threadListItem.getState();
  if (item.remoteId && useThreadSyncStore.getState().byId[item.remoteId]) return "chatLoading";
  const thread = aui.thread.getState();
  if (thread.isLoading) return "chatLoading";
  if (thread.isRunning) return "chatBusy";
  try {
    if (aui.composer().getState().dictation) return "chatBusy";
  } catch {
    // A runtime without a composer cannot be dictating.
  }
  return null;
}

export const callBlockDetail: Record<"chatBusy" | "chatLoading", string> = {
  chatBusy: "This chat is running a reply or dictation.",
  chatLoading: "This chat is still loading.",
};
