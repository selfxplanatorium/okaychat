import { db } from "../db.js";

/**
 * Denormalized thread counters and per-thread read cursors. This module never projects a message, so
 * `projections.ts` may import it without a cycle; `threads.ts` imports both.
 */

export interface ThreadStateRow {
  root_id: string;
  channel_id: string;
  reply_count: number;
  last_seq: number;
  last_at: number;
  last_author_id: string | null;
}

export function threadState(rootId: string): ThreadStateRow | undefined {
  return db.prepare("SELECT * FROM channel_thread_state WHERE root_id = ?").get(rootId) as ThreadStateRow | undefined;
}

/**
 * Recomputes a root's counters from its live replies. A tombstone calls this instead of decrementing, so
 * a missed increment can never leave a permanent drift. The row disappears when no reply remains.
 */
export function recountThread(rootId: string): void {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS reply_count, COALESCE(MAX(seq), 0) AS last_seq, COALESCE(MAX(created_at), 0) AS last_at,
              (SELECT author_id FROM channel_messages WHERE thread_root = ? AND deleted_at IS NULL ORDER BY seq DESC LIMIT 1) AS last_author_id
       FROM channel_messages WHERE thread_root = ? AND deleted_at IS NULL`,
    )
    .get(rootId, rootId) as { reply_count: number; last_seq: number; last_at: number; last_author_id: string | null };
  if (!row.reply_count) {
    db.prepare("DELETE FROM channel_thread_state WHERE root_id = ?").run(rootId);
    return;
  }
  const channel = db.prepare("SELECT channel_id FROM channel_thread_state WHERE root_id = ?").get(rootId) as { channel_id: string } | undefined;
  if (!channel) return;
  db.prepare(
    `UPDATE channel_thread_state SET reply_count = ?, last_seq = ?, last_at = ?, last_author_id = ?
     WHERE root_id = ?`,
  ).run(row.reply_count, row.last_seq, row.last_at, row.last_author_id, rootId);
}

/**
 * Unread replies per root for one page of messages. One grouped query, bounded by the caller's page
 * size (at most 100 root ids).
 */
export function threadUnreadByRoot(channelId: string, viewerId: string, rootIds: string[]): Map<string, number> {
  if (!rootIds.length) return new Map();
  const rows = db
    .prepare(
      `SELECT m.thread_root AS root, COUNT(*) AS n FROM channel_messages m
       LEFT JOIN channel_thread_reads r ON r.root_id = m.thread_root AND r.user_id = ?
       WHERE m.channel_id = ? AND m.thread_root IN (${rootIds.map(() => "?").join(",")})
         AND m.deleted_at IS NULL AND m.seq > COALESCE(r.read_seq, 0)
         AND (m.author_id IS NULL OR m.author_id <> ?)
       GROUP BY m.thread_root`,
    )
    .all(viewerId, channelId, ...rootIds, viewerId) as Array<{ root: string; n: number }>;
  return new Map(rows.map((row) => [row.root, row.n]));
}

/**
 * The room-level thread dot. Deliberate approximation: it looks at the newest reply only, so your own
 * newest reply hides the dot even when an earlier reply is still unread. A thread's own count is exact.
 */
export function threadsUnreadCount(channelId: string, viewerId: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM channel_thread_state s
         LEFT JOIN channel_thread_reads r ON r.root_id = s.root_id AND r.user_id = ?
         WHERE s.channel_id = ? AND s.last_seq > COALESCE(r.read_seq, 0)
           AND (s.last_author_id IS NULL OR s.last_author_id <> ?)`,
      )
      .get(viewerId, channelId, viewerId) as { n: number }
  ).n;
}

export function threadReadSeq(rootId: string, userId: string): number {
  const row = db.prepare("SELECT read_seq FROM channel_thread_reads WHERE root_id = ? AND user_id = ?").get(rootId, userId) as { read_seq: number } | undefined;
  return row?.read_seq ?? 0;
}
