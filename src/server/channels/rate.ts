import { db } from "../db.js";
import { AppError } from "../errors.js";

/**
 * Durable fixed-window rate buckets for channels. They are separate from model operation limits:
 * local reads and reconnects are never `llm.call`, and an SSE stream is not a costly operation.
 */
export type ChannelBucket = "write" | "membership" | "create" | "ai" | "read" | "search" | "candidate" | "connect";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const BUCKETS: Record<ChannelBucket, { limit: number; windowMs: number }> = {
  write: { limit: 60, windowMs: MINUTE },
  membership: { limit: 20, windowMs: MINUTE },
  create: { limit: 5, windowMs: HOUR },
  ai: { limit: 5, windowMs: MINUTE },
  read: { limit: 30, windowMs: MINUTE },
  search: { limit: 30, windowMs: MINUTE },
  candidate: { limit: 10, windowMs: MINUTE },
  connect: { limit: 12, windowMs: MINUTE },
};

export function chargeRate(userId: string, bucket: ChannelBucket): void {
  const { limit, windowMs } = BUCKETS[bucket];
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const row = db
    .prepare("SELECT used FROM channel_rate_windows WHERE user_id = ? AND bucket = ? AND window_start = ?")
    .get(userId, bucket, windowStart) as { used: number } | undefined;
  if ((row?.used ?? 0) >= limit) {
    const retryAfterMs = windowStart + windowMs - now;
    throw new AppError({
      code: "rate_limited",
      status: 429,
      message: "Too many channel requests. Try again shortly.",
      retryAfterMs,
      details: { bucket, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) },
    });
  }
  db.prepare(
    `INSERT INTO channel_rate_windows (user_id, bucket, window_start, used) VALUES (?, ?, ?, 1)
     ON CONFLICT (user_id, bucket, window_start) DO UPDATE SET used = used + 1`,
  ).run(userId, bucket, windowStart);
}

/** Bounded maintenance: expired rows go in small batches, never a full-table rewrite. */
export function pruneRateWindows(batch = 500): number {
  const cutoff = Date.now() - HOUR;
  return Number(
    db.prepare("DELETE FROM channel_rate_windows WHERE rowid IN (SELECT rowid FROM channel_rate_windows WHERE window_start < ? LIMIT ?)").run(cutoff, batch).changes,
  );
}
