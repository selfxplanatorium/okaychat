// Threads with a turn generating: an interactive turn (the client stores it when it ends) or a scheduled run.
// A scheduled run waits for an interactive one, and message edits are refused while either runs.
// Kept out of chat.ts so light modules can check it without loading the chat stack.
const busyThreads = new Map<string, number>();

export const threadBusy = (threadId: string) => busyThreads.has(threadId);

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
