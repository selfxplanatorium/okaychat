import { create } from "zustand";

// A transient request to reveal one message in the open branch. It never switches branches: the window consumer
// verifies the id against the runtime's current list and reports when it is missing. Registered roots let the
// consumer focus the real message element without building an id into a CSS selector.

export interface MessageJumpRequest {
  threadId: string;
  messageId: string;
  requestId: number;
}

interface MessageJumpState {
  request: MessageJumpRequest | null;
  jumpTo: (threadId: string, messageId: string) => void;
  clear: (requestId?: number) => void;
}

let nextRequest = 0;

export const useMessageJump = create<MessageJumpState>((set) => ({
  request: null,
  jumpTo: (threadId, messageId) => set({ request: { threadId, messageId, requestId: ++nextRequest } }),
  // A stale consumer must not clear the request that replaced it.
  clear: (requestId) => set((s) => (requestId === undefined || s.request?.requestId === requestId ? { request: null } : s)),
}));

const registry = new Map<string, HTMLElement>();
const key = (threadId: string, messageId: string) => `${threadId} ${messageId}`;

/** Message roots report the element they focus, keyed by chat and message. */
export function registerMessageRoot(threadId: string | null | undefined, messageId: string, element: HTMLElement | null) {
  if (!threadId) return;
  if (element) registry.set(key(threadId, messageId), element);
  else registry.delete(key(threadId, messageId));
}

export const messageRoot = (threadId: string, messageId: string) => registry.get(key(threadId, messageId));

export const clearMessageJump = () => useMessageJump.getState().clear();
