import { canonicalJson } from "../../shared/permissions.js";
import { decrypt, encrypt, sha256 } from "../crypto.js";
import { afterCommit, db } from "../db.js";

// Every permission configuration write bumps one global revision and appends one audit row in the same
// transaction. The summary holds only ids, selectors, keys, counts, and hashes; exact before/after values
// are encrypted with OKAYCHAT_SECRET and decrypted only for an admin's detail view.

export type AuditKind = "policy" | "prompt" | "audience" | "entitlement" | "membership" | "group_order" | "subject_delete" | "migration";

export const AUDIT_RETENTION_DAYS = 365;
const RETENTION_MS = AUDIT_RETENTION_DAYS * 86_400_000;

export interface AuditEntry {
  destination: string;
  before: unknown;
  after: unknown;
}

export const hashValue = (value: unknown) => (value === null || value === undefined ? null : sha256(canonicalJson(value)).slice(0, 16));

export function currentRevision(): number {
  const row = db.prepare("SELECT revision FROM permission_state WHERE singleton = 1").get() as { revision: number } | undefined;
  return row?.revision ?? 0;
}

const listeners = new Set<(revision: number) => void>();
/** In-process invalidation: active work subscribes to stop itself after a revoke. */
export function onPermissionChange(listener: (revision: number) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Bumps the revision and records one audit event. Call inside the writer's `tx()`; no-op writers must not
 * call it. Listeners run after the enclosing transaction commits.
 */
export function recordRevision(kind: AuditKind, actorId: string | null, entries: AuditEntry[], extra: Record<string, unknown> = {}): number {
  db.prepare("UPDATE permission_state SET revision = revision + 1 WHERE singleton = 1").run();
  const revision = currentRevision();
  const summary = {
    ...extra,
    count: entries.length,
    changes: entries.slice(0, 200).map((entry) => ({ destination: entry.destination, before: hashValue(entry.before), after: hashValue(entry.after) })),
  };
  db.prepare("INSERT INTO permission_audit (revision, actor_id, occurred_at, kind, summary_json, changes_enc) VALUES (?, ?, ?, ?, ?, ?)").run(
    revision,
    actorId && db.prepare("SELECT 1 FROM users WHERE id = ?").get(actorId) ? actorId : null,
    Date.now(),
    kind,
    JSON.stringify(summary),
    encrypt(JSON.stringify(entries)),
  );
  afterCommit(() => {
    for (const listener of listeners) {
      try {
        listener(revision);
      } catch (error) {
        console.error("[permissions] invalidation listener failed:", (error as Error).message);
      }
    }
  });
  pruneAudit();
  return revision;
}

export interface AuditRow {
  revision: number;
  actorId: string | null;
  occurredAt: number;
  kind: AuditKind;
  summary: Record<string, unknown>;
  reason: string | null;
}

export function listAudit(opts: { before?: number; limit: number; subjectId?: string }): { rows: AuditRow[]; nextCursor: string | null } {
  const rows = db
    .prepare(
      `SELECT revision, actor_id, occurred_at, kind, summary_json FROM permission_audit
       WHERE revision < ? ${opts.subjectId ? "AND instr(summary_json, ?) > 0" : ""}
       ORDER BY revision DESC LIMIT ?`,
    )
    .all(...[opts.before ?? Number.MAX_SAFE_INTEGER, ...(opts.subjectId ? [JSON.stringify(opts.subjectId).slice(1, -1)] : []), opts.limit + 1]) as Array<{
      revision: number;
      actor_id: string | null;
      occurred_at: number;
      kind: AuditKind;
      summary_json: string;
    }>;
  const page = rows.slice(0, opts.limit).map((row) => {
    const summary = JSON.parse(row.summary_json) as Record<string, unknown>;
    return {
      revision: row.revision,
      actorId: row.actor_id,
      occurredAt: row.occurred_at,
      kind: row.kind,
      summary,
      reason: typeof summary.reason === "string" ? summary.reason : null,
    };
  });
  return { rows: page, nextCursor: rows.length > opts.limit ? String(page.at(-1)!.revision) : null };
}

export function getAuditDetail(revision: number): (AuditRow & { changes: AuditEntry[] }) | null {
  const row = db.prepare("SELECT revision, actor_id, occurred_at, kind, summary_json, changes_enc FROM permission_audit WHERE revision = ?").get(revision) as
    | { revision: number; actor_id: string | null; occurred_at: number; kind: AuditKind; summary_json: string; changes_enc: string }
    | undefined;
  if (!row) return null;
  const summary = JSON.parse(row.summary_json) as Record<string, unknown>;
  let changes: AuditEntry[] = [];
  if (row.changes_enc) {
    try {
      changes = JSON.parse(decrypt(row.changes_enc)) as AuditEntry[];
    } catch {
      changes = [];
    }
  }
  return {
    revision: row.revision,
    actorId: row.actor_id,
    occurredAt: row.occurred_at,
    kind: row.kind,
    summary,
    reason: typeof summary.reason === "string" ? summary.reason : null,
    changes,
  };
}

let lastPrune = 0;
/** Bounded batches, at most once a day per process (and at startup through the first write or call). */
export function pruneAudit(now = Date.now()): void {
  if (now - lastPrune < 86_400_000) return;
  lastPrune = now;
  db.prepare("DELETE FROM permission_audit WHERE revision IN (SELECT revision FROM permission_audit WHERE occurred_at < ? ORDER BY revision LIMIT 1000)").run(now - RETENTION_MS);
}
