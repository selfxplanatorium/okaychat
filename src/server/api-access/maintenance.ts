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

// Bounded batches of 500 rows per tick. Each sweep keeps its own cursor so later accounts are reached
// on the next tick instead of the first 500 starving the rest forever.
let userCursor: string | null = null;
let auditCursor: string | null = null;
let keyCursor: string | null = null;

/** Never evicts an active receipt or key; a short page restarts that sweep from the beginning. */
export function pruneApiMaintenance(): void {
  const now = Date.now();
  const users = db
    .prepare(
      `SELECT user_id FROM (
         SELECT user_id FROM api_requests UNION SELECT user_id FROM api_rate_windows
         UNION SELECT user_id FROM api_key_audit)
       WHERE user_id > ? ORDER BY user_id LIMIT 500`,
    )
    .all(userCursor ?? "") as Array<{ user_id: string }>;
  userCursor = users.length < 500 ? null : users.at(-1)!.user_id;
  for (const row of users) pruneApiTelemetry(row.user_id, now);
  const auditUsers = db
    .prepare("SELECT DISTINCT user_id FROM api_key_audit WHERE user_id > ? ORDER BY user_id LIMIT 500")
    .all(auditCursor ?? "") as Array<{ user_id: string }>;
  auditCursor = auditUsers.length < 500 ? null : auditUsers.at(-1)!.user_id;
  for (const row of auditUsers) pruneAudit(row.user_id);
  // Retained key rows become tombstones 30 days after they go inactive; pruning them frees their 1 KiB.
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;
  const stale = db
    .prepare(
      `SELECT id, user_id, revoked_at FROM api_keys
       WHERE (revoked_at IS NOT NULL OR expires_at IS NOT NULL) AND COALESCE(revoked_at, expires_at) <= ?
         AND id > ? ORDER BY id LIMIT 500`,
    )
    .all(cutoff, keyCursor ?? "") as Array<{ id: string; user_id: string; revoked_at: number | null }>;
  keyCursor = stale.length < 500 ? null : stale.at(-1)!.id;
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
