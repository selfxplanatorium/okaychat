import { db } from "../db.js";
import { prune, settleOnStartup } from "./store.js";

// Custom-tool maintenance: restart settles formerly running rows as unknown, expired approvals are
// cleared, and bounded pruning runs at startup and once a minute. There is no execution queue.

export function initCustomTools(): void {
  settleOnStartup();
  pruneAll();
}

function pruneAll(): void {
  const users = db.prepare("SELECT DISTINCT user_id FROM custom_tools").all() as unknown as Array<{ user_id: string }>;
  for (const user of users) {
    try {
      prune(user.user_id);
    } catch {
      // A single user's corrupt rows must not stop maintenance for everyone else.
    }
  }
}

/** Returns a stop function; the timer never keeps the process alive. */
export function startCustomToolMaintenance(): () => void {
  const timer = setInterval(pruneAll, 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
