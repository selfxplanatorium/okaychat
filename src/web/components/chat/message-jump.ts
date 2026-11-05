// Pure window math for jumping to a bookmarked message. The runtime holds the whole branch; the list only
// mounts a tail-first window, so a target older than `start` needs both bounds lowered before it can be focused.

export interface MessageWindowBounds {
  /** First rendered index. */
  start: number;
  /** How far back automatic reveal may go before the explicit button is needed. */
  floor: number;
}

/** The target's index in the currently displayed branch, or -1. Never consults the server's newest branch. */
export function jumpIndex(ids: readonly string[], messageId: string): number {
  return ids.indexOf(messageId);
}

/** The same window widened just enough to contain the target. Existing bounds are never raised. */
export function widenForJump(bounds: MessageWindowBounds, index: number): MessageWindowBounds {
  return { start: Math.min(bounds.start, index), floor: Math.min(bounds.floor, index) };
}

/** Whether a target is already inside the mounted slice. */
export const isMounted = (bounds: MessageWindowBounds, index: number) => index >= bounds.start;
