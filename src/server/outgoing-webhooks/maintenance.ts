import { setTimeout as delay } from "node:timers/promises";
import {
  deleteExpiredTestPreparations,
  clearExpiredBodies,
  enforceProcessCap,
  expireDeliveries,
  pruneAllAccounts,
  pruneOldRateWindows,
  pruneProcessDeliveries,
  scrubTextDisabledBodies,
} from "./store.js";
import { abortDeliverySend } from "./runtime.js";
/**
 * Bounded maintenance: retention, body scrubbing, expired active rows, old rate windows, and stale
 * test previews. It never opens a network request and never deletes an active row without aborting it
 * first. One unref'ed 60-second timer; each pass continues on setImmediate while work remains.
 */

let timer: NodeJS.Timeout | null = null;
let stopped = true;
let running = false;

export function runOutgoingWebhookMaintenance(now = Date.now()): void {
  const expired = expireDeliveries(now);
  for (const id of expired) abortDeliverySend(id);
  deleteExpiredTestPreparations(now);
  clearExpiredBodies(now);
  scrubTextDisabledBodies();
  pruneOldRateWindows(now);
  pruneProcessDeliveries(now);
  enforceProcessCap(now);
  pruneAllAccounts(now);
}

function tick(): void {
  if (stopped || running) return;
  running = true;
  try {
    runOutgoingWebhookMaintenance();
  } finally {
    running = false;
  }
}

export function startOutgoingWebhookMaintenance(): void {
  if (!stopped) return;
  stopped = false;
  timer = setInterval(tick, 60_000);
  timer.unref?.();
  // Startup does one pass promptly; the worker has already recovered interrupted sends.
  setImmediate(tick);
}

export function stopOutgoingWebhookMaintenance(): void {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = null;
}

/** A single bounded batch used by tests that assert scrub/retention effects without a timer. */
export async function drainOutgoingWebhookMaintenance(now = Date.now()): Promise<void> {
  for (let i = 0; i < 20; i++) {
    runOutgoingWebhookMaintenance(now);
    await delay(0);
  }
}
