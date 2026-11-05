import { API_LIMITS } from "../../shared/api-access.js";
import { db, tx } from "../db.js";
import { AppError } from "../errors.js";
import { reserveOperation, type Lease } from "../permissions/limits.js";
import { reserveTurn } from "../turn-slots.js";

// Durable external-API request rates, concurrency slots, and the shared turn lease
// (docs/implementation/api-access.md). One authenticated HTTP request costs one API rate unit regardless
// of provider retries; rejected rate checks increment neither bucket.

const WINDOW_MS = 60_000;

/** Test seam: a fake clock shared with the route boundary. */
let now = () => Date.now();
export function setApiLimitClock(clock: (() => number) | null): void {
  now = clock ?? (() => Date.now());
}

export class ApiRateLimited extends AppError {
  constructor(readonly retryAfterMs: number, message = "Too many API requests. Try again shortly.") {
    super({ code: "rate_limited", message, retryAfterMs });
  }
}

export class ApiConcurrentLimit extends AppError {
  constructor(message = "Too many API requests are running at once. Try again shortly.") {
    super({ code: "rate_limited", message, retryAfterMs: 1_000 });
  }
}

const windowStart = (at: number) => Math.floor(at / WINDOW_MS) * WINDOW_MS;

function pruneWindows(at: number): void {
  db.prepare("DELETE FROM api_rate_windows WHERE rowid IN (SELECT rowid FROM api_rate_windows WHERE window_start < ? LIMIT 500)")
    .run(at - 2 * WINDOW_MS);
}

/**
 * Atomically checks and increments the key and account minute buckets. Both are charged or neither is.
 * A rejection carries the ceiling of the stricter bucket so Retry-After is actionable.
 */
export function chargeApiRate(userId: string, keyId: string, at = now()): void {
  const start = windowStart(at);
  tx(() => {
    pruneWindows(at);
    const read = (bucket: string) =>
      (db.prepare("SELECT used FROM api_rate_windows WHERE user_id = ? AND key_id = ? AND window_start = ?")
        .get(userId, bucket, start) as { used: number } | undefined)?.used ?? 0;
    const keyUsed = read(keyId);
    const accountUsed = read("");
    if (keyUsed >= API_LIMITS.requestsPerKeyMinute || accountUsed >= API_LIMITS.requestsPerAccountMinute) {
      throw new ApiRateLimited(start + WINDOW_MS - at);
    }
    const bump = db.prepare(
      `INSERT INTO api_rate_windows (user_id, key_id, window_start, used) VALUES (?, ?, ?, 1)
       ON CONFLICT (user_id, key_id, window_start) DO UPDATE SET used = used + 1`,
    );
    bump.run(userId, keyId, start);
    bump.run(userId, "", start);
  });
}

// Concurrency -------------------------------------------------------------------------------------------

const perKey = new Map<string, number>();
const perAccount = new Map<string, number>();
let processCalls = 0;
let catalogCalls = 0;

function take(map: Map<string, number>, id: string, limit: number): boolean {
  const current = map.get(id) ?? 0;
  if (current >= limit) return false;
  map.set(id, current + 1);
  return true;
}

function give(map: Map<string, number>, id: string): void {
  const left = (map.get(id) ?? 1) - 1;
  if (left > 0) map.set(id, left);
  else map.delete(id);
}

export interface ApiCallAdmission {
  /** Idempotent: releases the process slots, the shared turn slot, and the policy lease. */
  release: () => void;
  heartbeat: () => boolean;
}

/**
 * Reserves the API slots, the hard account turn slot, and the policy's kind:'turn' lease without an await
 * between check and register. A partial failure rolls back everything already taken.
 */
export function admitApiCall(userId: string, keyId: string, modelRef: string | null = null): ApiCallAdmission {
  if (processCalls >= API_LIMITS.concurrentProcess) throw new ApiConcurrentLimit("The server is handling too many API requests. Try again shortly.");
  if (!take(perKey, keyId, API_LIMITS.concurrentPerKey)) throw new ApiConcurrentLimit("This API key has too many requests running at once.");
  if (!take(perAccount, userId, API_LIMITS.concurrentPerAccount)) {
    give(perKey, keyId);
    throw new ApiConcurrentLimit("This account has too many API requests running at once.");
  }
  processCalls++;
  const releaseTurn = reserveTurn(userId);
  if (!releaseTurn) {
    processCalls--;
    give(perAccount, userId);
    give(perKey, keyId);
    throw new ApiConcurrentLimit("You already have the maximum number of replies running.");
  }
  let lease: Lease;
  try {
    // kind:'turn' charges no operation; it only holds the administrator's concurrent-turn bucket.
    lease = reserveOperation({ userId, modelRef }, "llm.call", { kind: "turn" });
  } catch (error) {
    releaseTurn();
    processCalls--;
    give(perAccount, userId);
    give(perKey, keyId);
    // A policy turn-lease denial is a concurrency outcome, not a generic rate limit.
    if (error instanceof AppError && error.code === "rate_limited") throw new ApiConcurrentLimit(error.message);
    throw error;
  }
  let released = false;
  return {
    heartbeat: () => lease.heartbeat(),
    release: () => {
      if (released) return;
      released = true;
      lease.release();
      releaseTurn();
      processCalls--;
      give(perAccount, userId);
      give(perKey, keyId);
    },
  };
}

/** The catalog listing has no generation slots, only its own process cap. */
export function admitCatalogCall(): () => void {
  if (catalogCalls >= API_LIMITS.catalogConcurrentProcess) throw new ApiConcurrentLimit("The model catalog is busy. Try again shortly.");
  catalogCalls++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    catalogCalls--;
  };
}

// Live calls and local revocation -----------------------------------------------------------------------

const liveCalls = new Map<string, Set<AbortController>>();

function keyOf(userId: string, keyId: string): string {
  return `${userId}\u0000${keyId}`;
}

export function registerApiCall(userId: string, keyId: string, controller: AbortController): () => void {
  const key = keyOf(userId, keyId);
  const set = liveCalls.get(key) ?? new Set<AbortController>();
  set.add(controller);
  liveCalls.set(key, set);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    set.delete(controller);
    if (!set.size) liveCalls.delete(key);
  };
}

/** Local revocation aborts every active call of the key; polling still covers expiry and policy edits. */
export function abortApiCalls(userId: string, keyId?: string): void {
  const prefixes = keyId === undefined ? `${userId}\u0000` : keyOf(userId, keyId);
  for (const [key, set] of liveCalls) {
    if (keyId === undefined ? !key.startsWith(prefixes) : key !== prefixes) continue;
    for (const controller of set) controller.abort(new AppError({ code: "forbidden", status: 403, message: "This API key is no longer active." }));
  }
}

/** Test seam: live registrations, so leaks are observable. */
export function liveApiCallCount(): number {
  let total = 0;
  for (const set of liveCalls.values()) total += set.size;
  return total;
}
