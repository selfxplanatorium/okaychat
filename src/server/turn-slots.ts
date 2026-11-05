// The hard per-account concurrency ceiling shared by every caller that produces a reply: interactive
// chat turns, scheduled runs, channel AI, and the external API. One module owns the counter so an API
// call cannot run alongside four app turns. See docs/implementation/api-access.md.

export const MAX_ACTIVE_TURNS = 4;

const activeTurns = new Map<string, number>();

/** Reserves a turn slot for the user, or returns null when all are taken. The release runs once. */
export function reserveTurn(userId: string): (() => void) | null {
  const count = activeTurns.get(userId) ?? 0;
  if (count >= MAX_ACTIVE_TURNS) return null;
  activeTurns.set(userId, count + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (activeTurns.get(userId) ?? 1) - 1;
    if (left > 0) activeTurns.set(userId, left);
    else activeTurns.delete(userId);
  };
}

/** Test seam: the live count for one account. */
export function activeTurnCount(userId: string): number {
  return activeTurns.get(userId) ?? 0;
}
