import { db } from "../db.js";
import { onApiKeyRevoked, pruneAudit } from "./keys.js";
import { abortApiCalls } from "./limits.js";
import { interruptOpenApiRequests, pruneApiTelemetry } from "./store.js";

// External API lifecycle (docs/implementation/api-access.md): startup interruption, local revocation
// abort, and a 10-minute unref'd retention sweep. Nothing resumes across a restart.

const MAINTENANCE_MS = 10 * 60_000;

/** Wires the local revoke notification and interrupts receipts left open by a previous process. */
export function initApiAccess(): void {
  interruptOpenApiRequests();
  onApiKeyRevoked((userId, keyId) => abortApiCalls(userId, keyId));
}

/** Bounded batches of 500 rows, continuing between ticks; never evicts an active receipt. */
export function pruneApiMaintenance(): void {
  const users = db
    .prepare(
      `SELECT DISTINCT user_id FROM (
         SELECT user_id FROM api_requests UNION ALL SELECT user_id FROM api_rate_windows
         UNION ALL SELECT user_id FROM api_key_audit)
       LIMIT 500`,
    )
    .all() as Array<{ user_id: string }>;
  const now = Date.now();
  for (const row of users) pruneApiTelemetry(row.user_id, now);
  const auditUsers = db.prepare("SELECT DISTINCT user_id FROM api_key_audit LIMIT 500").all() as Array<{ user_id: string }>;
  for (const row of auditUsers) pruneAudit(row.user_id);
  // Retained key rows become tombstones 30 days after they go inactive; pruning them frees their 1 KiB.
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;
  const stale = db
    .prepare(
      `SELECT id, user_id, revoked_at FROM api_keys
       WHERE (revoked_at IS NOT NULL OR expires_at IS NOT NULL) AND COALESCE(revoked_at, expires_at) <= ?
       LIMIT 500`,
    )
    .all(cutoff) as Array<{ id: string; user_id: string; revoked_at: number | null }>;
  for (const key of stale) {
    if (key.revoked_at === null) {
      db.prepare("INSERT OR IGNORE INTO api_key_audit (user_id, key_id, event, created_at) VALUES (?, ?, 'expired', ?)").run(key.user_id, key.id, now);
    }
    db.prepare("DELETE FROM api_keys WHERE id = ? AND user_id = ?").run(key.id, key.user_id);
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startApiMaintenance(): void {
  if (timer) return;
  timer = setInterval(() => {
    try {
      pruneApiMaintenance();
    } catch (error) {
      // A maintenance failure must not take the server down; the next tick retries.
      console.error("[api-access] maintenance failed:", (error as Error).message);
    }
  }, MAINTENANCE_MS);
  timer.unref?.();
}

/** Test seam. */
export function stopApiMaintenance(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
