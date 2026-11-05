// Threads with a turn generating: an interactive turn (the client stores it when it ends) or a scheduled run.
// A scheduled run waits for an interactive one, and message edits are refused while either runs.
// Kept out of chat.ts so light modules can check it without loading the chat stack.
const busyThreads = new Map<string, number>();

/**
 * A logical reply can wait for a tool result or approval with no HTTP stream attached. `chat.ts` injects
 * a synchronous receipt reader at startup, so config edits and schedules stay blocked until it resolves
 * or is cancelled, without importing the chat stack into this module.
 */
let unresolvedRuns: ((threadId: string) => boolean) | null = null;

export function setUnresolvedRunReader(reader: (threadId: string) => boolean): void {
  unresolvedRuns = reader;
}

export const threadBusy = (threadId: string) => busyThreads.has(threadId) || unresolvedRuns?.(threadId) === true;

/** Marks the thread busy until the returned release runs (once). `release` runs with it. */
export function markBusy(threadId: string, release: () => void = () => {}): () => void {
  busyThreads.set(threadId, (busyThreads.get(threadId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (busyThreads.get(threadId) ?? 1) - 1;
    if (left > 0) busyThreads.set(threadId, left);
    else busyThreads.delete(threadId);
    release();
  };
}
