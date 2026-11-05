import { newId } from "../crypto.js";
import { db, tx } from "../db.js";
import { AppError } from "../errors.js";
import type { BucketLimits } from "../../shared/permissions.js";
import { resolvePermissions } from "./resolve.js";
import { OPERATIONS, type OperationKey } from "./operations.js";
import { assertFeature, policyInvalidError } from "./guard.js";

// Operation rate and concurrency limits (§2.4). Each reservation charges the account aggregate bucket and,
// when an exact-model row sets one, the model bucket, atomically in one synchronous transaction. Rate
// windows are fixed UTC minutes; started or failed operations keep their charge. Concurrency is counted
// from live leases, which a heartbeat extends and an expired lease no longer holds.

export const PROCESS_ID = newId("proc");
export const LEASE_TTL_MS = 90_000;
const HEARTBEAT_MS = 20_000;
const WINDOW_MS = 60_000;

/** Test seam: a fake clock. */
let now = () => Date.now();
export function setLimitClock(clock: (() => number) | null) {
  now = clock ?? (() => Date.now());
}

/** One app process owns the database (the supported deployment), so leases of earlier boots are stale. */
export function clearStaleLeases(): void {
  db.prepare("DELETE FROM permission_leases WHERE process_id <> ?").run(PROCESS_ID);
}

function rateLimited(retryAfterMs: number, message: string): AppError {
  return new AppError({ code: "rate_limited", message, retryAfterMs, details: { retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) } });
}

function prune(at: number) {
  db.prepare("DELETE FROM permission_rate_windows WHERE rowid IN (SELECT rowid FROM permission_rate_windows WHERE window_start < ? LIMIT 500)").run(at - 2 * WINDOW_MS);
  db.prepare("DELETE FROM permission_leases WHERE rowid IN (SELECT rowid FROM permission_leases WHERE expires_at < ? LIMIT 500)").run(at);
}

interface Scope {
  key: string;
  limits: BucketLimits;
}

function scopesFor(userId: string, modelRef: string | null): Scope[] {
  const account = resolvePermissions(userId, null);
  if (account.invalid) throw policyInvalidError();
  const aggregate = account.buckets.aggregate;
  const scopes: Scope[] = [{ key: "", limits: aggregate }];
  if (modelRef) {
    const effective = resolvePermissions(userId, modelRef);
    if (effective.invalid) throw policyInvalidError();
    const model = effective.buckets.model;
    if (model) scopes.push({ key: modelRef, limits: model });
  }
  return scopes;
}

export interface Lease {
  id: string;
  release: () => void;
  /** Extends the lease; returns false once it expired (the work must stop before its next dispatch). */
  heartbeat: () => boolean;
}

/**
 * Charges one operation and, with `hold`, keeps a concurrency lease until released. Throws `rate_limited`
 * (429) without charging anything when a bucket is full.
 */
export function reserveOperation(
  actor: { userId: string; modelRef?: string | null },
  operation: OperationKey,
  opts: { hold?: boolean; kind?: "operation" | "turn"; operationKey?: string } = {},
): Lease {
  const feature = OPERATIONS[operation].feature;
  if (feature) assertFeature(actor, feature);
  const at = now();
  const windowStart = Math.floor(at / WINDOW_MS) * WINDOW_MS;
  const modelRef = actor.modelRef ?? null;
  const kind = opts.kind ?? "operation";
  const scopes = scopesFor(actor.userId, modelRef);
  const id = newId("lease");
  tx(() => {
    prune(at);
    for (const scope of scopes) {
      const limit = kind === "turn" ? null : scope.limits.operationsPerMinute;
      if (limit === null) continue;
      const row = db.prepare("SELECT used FROM permission_rate_windows WHERE user_id = ? AND scope_key = ? AND window_start = ?")
        .get(actor.userId, scope.key, windowStart) as { used: number } | undefined;
      if ((row?.used ?? 0) >= limit) {
        throw rateLimited(windowStart + WINDOW_MS - at, `Too many operations. Try again in ${Math.max(1, Math.ceil((windowStart + WINDOW_MS - at) / 1000))} seconds.`);
      }
    }
    if (opts.hold !== false) {
      for (const scope of scopes) {
        const limit = kind === "turn" ? scope.limits.concurrentTurns : scope.limits.concurrentOperations;
        if (limit === null) continue;
        const { n } = db.prepare(
          `SELECT COUNT(*) AS n FROM permission_leases WHERE user_id = ? AND kind = ? AND expires_at >= ? ${scope.key ? "AND model_ref = ?" : ""}`,
        ).get(...[actor.userId, kind, at, ...(scope.key ? [scope.key] : [])]) as { n: number };
        if (n >= limit) {
          throw rateLimited(1000, kind === "turn"
            ? `You already have ${limit} replies running. Wait for one to finish or stop it.`
            : "Too many operations are running at once. Try again in a moment.");
        }
      }
    }
    if (kind !== "turn") {
      for (const scope of scopes) {
        if (scope.limits.operationsPerMinute === null) continue;
        db.prepare(
          `INSERT INTO permission_rate_windows (user_id, scope_key, window_start, used) VALUES (?, ?, ?, 1)
           ON CONFLICT (user_id, scope_key, window_start) DO UPDATE SET used = used + 1`,
        ).run(actor.userId, scope.key, windowStart);
      }
    }
    if (opts.hold !== false) {
      db.prepare("INSERT INTO permission_leases (id, user_id, model_ref, kind, operation_key, process_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        id,
        actor.userId,
        modelRef ?? "",
        kind,
        opts.operationKey ?? `${operation}:${id}`,
        PROCESS_ID,
        at + LEASE_TTL_MS,
      );
    }
  });
  let released = opts.hold === false;
  return {
    id,
    release: () => {
      if (released) return;
      released = true;
      db.prepare("DELETE FROM permission_leases WHERE id = ?").run(id);
    },
    heartbeat: () => {
      if (released) return false;
      const result = db.prepare("UPDATE permission_leases SET expires_at = ? WHERE id = ? AND expires_at >= ?").run(now() + LEASE_TTL_MS, id, now());
      return Number(result.changes) > 0;
    },
  };
}

/**
 * Runs costly work under one operation charge and lease. The lease is renewed while the work runs and
 * released exactly once when it settles or aborts.
 */
export async function withOperation<T>(
  actor: { userId: string; modelRef?: string | null },
  operation: OperationKey,
  work: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const lease = reserveOperation(actor, operation);
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setInterval(() => {
    if (!lease.heartbeat()) controller.abort(new AppError({ code: "aborted", message: "The operation lease expired." }));
  }, HEARTBEAT_MS);
  timer.unref?.();
  try {
    return await work(controller.signal);
  } finally {
    clearInterval(timer);
    signal?.removeEventListener("abort", abort);
    lease.release();
  }
}

/** A lease that keeps itself alive until released (stream-owned work: a producer, a voice session). */
export function holdLease(lease: Lease, expired?: () => void): () => void {
  const timer = setInterval(() => { if (!lease.heartbeat()) expired?.(); }, HEARTBEAT_MS);
  timer.unref?.();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    clearInterval(timer);
    lease.release();
  };
}
