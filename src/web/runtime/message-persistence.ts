// Messages the server has confirmed it stores, per chat. History is persisted asynchronously after a run ends, so
// "not running" does not mean "stored". Annotation writes target stored rows only, and the history adapter reports
// ids here from a trustworthy GET or an acknowledged write. A cached copy never counts.

const stored = new Map<string, Set<string>>();
const listeners = new Set<() => void>();
let epoch = 0;

const changed = () => {
  epoch++;
  for (const listener of listeners) listener();
};

export const storedMessageExists = (threadId: string, messageId: string) => stored.get(threadId)?.has(messageId) === true;

/**
 * Every id of a GET the server answered. Merged rather than replaced: a GET that started before an acknowledged
 * write may lack that row, and stored messages are never removed from a chat that still exists.
 */
export function reportStoredRows(threadId: string, ids: Iterable<string>) {
  const known = stored.get(threadId) ?? new Set<string>();
  for (const id of ids) known.add(id);
  stored.set(threadId, known);
  changed();
}

/** One message the server acknowledged writing. */
export function reportStoredMessage(threadId: string, messageId: string) {
  const ids = stored.get(threadId) ?? new Set<string>();
  if (ids.has(messageId)) return;
  ids.add(messageId);
  stored.set(threadId, ids);
  changed();
}

export function forgetStoredThread(threadId: string) {
  if (stored.delete(threadId)) changed();
}

/** Sign-out or another account. */
export function clearStoredMessages() {
  stored.clear();
  changed();
}

/** For `useSyncExternalStore`: the epoch changes whenever any chat's stored set does. */
export function subscribeStoredMessages(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const storedMessagesEpoch = () => epoch;
