import { runDueReminders } from "./reminders.js";

/**
 * Calendar reminder ticker. Started from the server entry point after migrations, never on import, so
 * tests can use the stores without timers. One startup catch-up batch, then every 30 seconds.
 */
const TICK_MS = 30_000;
let stop: (() => void) | null = null;

export function startCalendarMaintenance(): () => void {
  if (stop) return stop;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    try {
      runDueReminders();
    } catch (error) {
      // Content-free: a failed batch is retried by the next tick, and the ledger stays pending.
      console.warn("[calendar] reminder tick failed:", (error as Error).message);
    }
  };
  tick();
  const timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  const halt = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    stop = null;
  };
  stop = halt;
  return halt;
}
