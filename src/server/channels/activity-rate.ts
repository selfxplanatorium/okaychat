import { AppError } from "../errors.js";
import { CHANNEL_ACTIVITY_LIMITS } from "../../shared/channel-activity.js";
import { activityNow } from "./activity-clock.js";

/**
 * In-memory fixed windows for ephemeral input. Durable channel rate rows exist for writes and
 * connects; typing and activity heartbeats must never touch SQLite, so they get their own bounded
 * maps that vanish on restart. Saturating the map is refused rather than evicting a live account's
 * window in a churn loop.
 */

export type ActivityRateKind = "activity" | "typing";

interface Bucket {
  windowStart: number;
  activity: number;
  typing: number;
  touchedAt: number;
}

const { windowMs, bucketIdleMs, maxBuckets } = CHANNEL_ACTIVITY_LIMITS.rate;
const buckets = new Map<string, Bucket>();

const LIMITS: Record<"account" | "connection", Record<ActivityRateKind, number>> = {
  account: { activity: CHANNEL_ACTIVITY_LIMITS.rate.accountActivity, typing: CHANNEL_ACTIVITY_LIMITS.rate.accountTyping },
  connection: { activity: CHANNEL_ACTIVITY_LIMITS.rate.connectionActivity, typing: CHANNEL_ACTIVITY_LIMITS.rate.connectionTyping },
};

function rateLimited(retryAfterMs: number): AppError {
  return new AppError({
    code: "rate_limited",
    status: 429,
    message: "Too many activity updates. Try again shortly.",
    retryAfterMs: Math.max(1, Math.ceil(retryAfterMs)),
  });
}

function prune(now: number): void {
  for (const [key, bucket] of buckets) {
    if (now - bucket.touchedAt > bucketIdleMs) buckets.delete(key);
  }
}

function charge(scope: "account" | "connection", id: string, kind: ActivityRateKind): void {
  const now = activityNow();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const key = `${scope === "account" ? "a" : "c"}:${id}`;
  let bucket = buckets.get(key);
  if (!bucket) {
    if (buckets.size >= maxBuckets) {
      prune(now);
      // Still saturated: refuse rather than grow without bound.
      if (buckets.size >= maxBuckets) throw rateLimited(windowStart + windowMs - now);
    }
    bucket = { windowStart, activity: 0, typing: 0, touchedAt: now };
    buckets.set(key, bucket);
  } else if (bucket.windowStart !== windowStart) {
    bucket.windowStart = windowStart;
    bucket.activity = 0;
    bucket.typing = 0;
  }
  bucket.touchedAt = now;
  const retryAfterMs = windowStart + windowMs - now;
  bucket[kind]++;
  if (bucket[kind] > LIMITS[scope][kind]) throw rateLimited(retryAfterMs);
  if (scope === "account") {
    // The combined ceiling keeps one account from spending both buckets at once.
    const total = bucket.activity + bucket.typing;
    if (total > CHANNEL_ACTIVITY_LIMITS.rate.accountCombined) throw rateLimited(retryAfterMs);
  }
}

/** Charged for every well-formed authenticated attempt, including repeats and no-ops. */
export function chargeAccountActivityRate(userId: string, kind: ActivityRateKind): void {
  charge("account", userId, kind);
}

/** Only after the request's connection binding (account + session) has been proven. */
export function chargeConnectionActivityRate(connectionId: string, kind: ActivityRateKind): void {
  charge("connection", connectionId, kind);
}

export function pruneActivityRates(): void {
  prune(activityNow());
}

/** Tests assert saturation and cleanup without reaching into the map. */
export function activityRateState(): { buckets: number; used: number } {
  let used = 0;
  for (const bucket of buckets.values()) used += bucket.activity + bucket.typing;
  return { buckets: buckets.size, used };
}

export function resetActivityRates(): void {
  buckets.clear();
}
