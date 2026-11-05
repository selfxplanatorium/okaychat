import { db, tx } from "../db.js";
import { CHANNEL_LIMITS } from "../../shared/channels.js";
import { eventState } from "./events.js";
import { pruneRateWindows } from "./rate.js";

/**
 * Bounded operational cleanup. Events keep at most 100,000 rows and 24 hours; the floor advances in
 * the same transaction as the delete, so an expired cursor resets honestly. Audit keeps 90 days and
 * 10,000 rows. Each pass deletes at most a few thousand rows, never a full-table rewrite.
 */

function pruneEventsOnce(batch = 1_000): number {
  return tx(() => {
    const cutoff = Date.now() - CHANNEL_LIMITS.eventRetentionMs;
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM channel_events").get() as { n: number };
    const excess = Math.max(0, n - CHANNEL_LIMITS.eventMaxRows);
    const ids = new Set<number>();
    for (const row of db.prepare("SELECT id FROM channel_events WHERE created_at < ? ORDER BY id LIMIT ?").all(cutoff, batch) as Array<{ id: number }>) ids.add(row.id);
    if (excess) {
      for (const row of db.prepare("SELECT id FROM channel_events ORDER BY id LIMIT ?").all(Math.min(batch - ids.size, excess)) as Array<{ id: number }>) ids.add(row.id);
    }
    if (!ids.size) return 0;
    const list = [...ids];
    const max = BigInt(Math.max(...list));
    const deleteIds = list.map(() => "?").join(",");
    db.prepare(`DELETE FROM channel_events WHERE id IN (${deleteIds})`).run(...list);
    const state = eventState();
    if (max > state.floor) db.prepare("UPDATE channel_event_state SET floor_id = ? WHERE singleton = 1").run(max);
    return list.length;
  });
}

function pruneAuditOnce(batch = 1_000): number {
  const cutoff = Date.now() - CHANNEL_LIMITS.auditRetentionMs;
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM channel_moderation_audit").get() as { n: number };
  const excess = Math.max(0, n - CHANNEL_LIMITS.auditMaxRows);
  const ids = new Set<number>();
  for (const row of db.prepare("SELECT id FROM channel_moderation_audit WHERE created_at < ? ORDER BY id LIMIT ?").all(cutoff, batch) as Array<{ id: number }>) ids.add(row.id);
  if (excess) {
    for (const row of db.prepare("SELECT id FROM channel_moderation_audit ORDER BY id LIMIT ?").all(Math.min(batch - ids.size, excess)) as Array<{ id: number }>) ids.add(row.id);
  }
  if (!ids.size) return 0;
  const list = [...ids];
  db.prepare(`DELETE FROM channel_moderation_audit WHERE id IN (${list.map(() => "?").join(",")})`).run(...list);
  return list.length;
}

function pruneCreateKeys(): number {
  return Number(db.prepare("DELETE FROM channel_create_keys WHERE created_at < ?").run(Date.now() - CHANNEL_LIMITS.createKeyMs).changes);
}

export function runChannelMaintenance(): void {
  pruneRateWindows();
  pruneCreateKeys();
  for (let i = 0; i < 4 && pruneEventsOnce(); i++) { /* bounded batches */ }
  for (let i = 0; i < 2 && pruneAuditOnce(); i++) { /* bounded batches */ }
}

export function startChannelMaintenance(): void {
  runChannelMaintenance();
  const timer = setInterval(runChannelMaintenance, 60_000);
  timer.unref?.();
}
