import { db } from "../db.js";
import { AppError } from "../errors.js";
import { CHANNEL_LIMITS, type ChannelThreadPage } from "../../shared/channels.js";
import { notFound } from "./access.js";
import { currentCursor, insertEvent } from "./events.js";
import { projectMessages, type ChannelMessageRow } from "./projections.js";
import { chargeRate } from "./rate.js";
import { threadReadSeq, threadUnreadByRoot } from "./thread-counts.js";
import { markChannelThreadNoticesReadThrough } from "../notifications.js";

/**
 * One level of thread replies under a top-level message. Placement validation runs inside the write
 * transaction, so a concurrent tombstone or a foreign room id cannot become a root.
 */

export interface ThreadPlacement {
  threadRoot: string | null;
}

function messageInChannel(channelId: string, id: string): ChannelMessageRow | undefined {
  return db.prepare("SELECT * FROM channel_messages WHERE channel_id = ? AND id = ?").get(channelId, id) as ChannelMessageRow | undefined;
}

export function resolveThreadPlacement(channelId: string, threadRootId: string | undefined, replyTo: string | undefined): ThreadPlacement {
  let threadRoot = threadRootId ?? null;
  if (threadRootId) {
    const root = messageInChannel(channelId, threadRootId);
    if (!root || root.deleted_at !== null) throw notFound();
    if (root.thread_root !== null) {
      throw new AppError({ code: "validation", status: 422, message: "A reply cannot start a thread.", details: { reason: "invalid_thread" } });
    }
  }
  if (replyTo) {
    const quoted = messageInChannel(channelId, replyTo);
    if (!quoted || quoted.deleted_at !== null) throw notFound();
    if (quoted.thread_root !== null) {
      // A top-level post that quotes a reply belongs in that reply's thread, not in the room timeline.
      if (threadRoot !== null && threadRoot !== quoted.thread_root) {
        throw new AppError({ code: "validation", status: 422, message: "The quoted reply is in another thread.", details: { reason: "invalid_thread" } });
      }
      threadRoot = quoted.thread_root;
    } else if (threadRoot !== null && threadRoot !== quoted.id) {
      throw new AppError({ code: "validation", status: 422, message: "The quoted message is not in this thread.", details: { reason: "invalid_thread" } });
    }
  }
  return { threadRoot };
}

function rootOf(channelId: string, id: string): ChannelMessageRow {
  const row = messageInChannel(channelId, id);
  if (!row) throw notFound();
  if (row.thread_root === null) return row;
  const root = messageInChannel(channelId, row.thread_root);
  if (!root || root.thread_root !== null) throw notFound();
  return root;
}

export function setThreadRead(userId: string, channelId: string, rootId: string, throughSeq: number): { readSeq: number; unread: number; changed: boolean } {
  const root = messageInChannel(channelId, rootId);
  if (!root || root.thread_root !== null || root.deleted_at !== null) {
    throw new AppError({ code: "validation", status: 422, message: "That message is not a thread root.", details: { reason: "invalid_thread" } });
  }
  const current = threadReadSeq(rootId, userId);
  const newest = (
    db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM channel_messages WHERE channel_id = ? AND thread_root = ? AND deleted_at IS NULL").get(channelId, rootId) as {
      seq: number;
    }
  ).seq;
  const capped = Math.min(throughSeq, newest);
  if (capped <= current) {
    const unread = threadUnreadByRoot(channelId, userId, [rootId]).get(rootId) ?? 0;
    return { readSeq: current, unread, changed: false };
  }
  chargeRate(userId, "read");
  db.prepare(
    `INSERT INTO channel_thread_reads (root_id, user_id, channel_id, read_seq, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(root_id, user_id) DO UPDATE SET read_seq = excluded.read_seq, updated_at = excluded.updated_at`,
  ).run(rootId, userId, channelId, capped, Date.now());
  markChannelThreadNoticesReadThrough(userId, channelId, rootId, capped);
  insertEvent({ channelId, targetUserId: userId, kind: "read.changed", entityId: userId, version: capped, rootId });
  const unread = threadUnreadByRoot(channelId, userId, [rootId]).get(rootId) ?? 0;
  return { readSeq: capped, unread, changed: true };
}

export interface ThreadQuery {
  beforeSeq?: number;
  afterSeq?: number;
  limit?: number;
  /** A reply to land on; without a cursor it bounds the returned page around that reply. */
  focusId?: string;
}

const existsOlder = (channelId: string, rootId: string, seq: number) =>
  !!db.prepare("SELECT 1 FROM channel_messages WHERE channel_id = ? AND thread_root = ? AND seq < ?").get(channelId, rootId, seq);

function replyRows(channelId: string, rootId: string, sql: string, ...params: Array<string | number>): ChannelMessageRow[] {
  return db
    .prepare(`SELECT * FROM channel_messages WHERE channel_id = ? AND thread_root = ? ${sql}`)
    .all(channelId, rootId, ...params) as unknown as ChannelMessageRow[];
}

export function threadPage(channelId: string, requestedId: string, viewerId: string, query: ThreadQuery): ChannelThreadPage {
  const channel = db.prepare("SELECT revision FROM channels WHERE id = ?").get(channelId) as { revision: number } | undefined;
  if (!channel) throw notFound();
  const requested = messageInChannel(channelId, requestedId);
  if (!requested) throw notFound();
  const root = rootOf(channelId, requestedId);
  // A jump names the reply to land on. Without a cursor, that reply's own position bounds the page so an
  // old reply is loaded instead of the newest page where it does not appear.
  const focusRow = query.focusId && query.beforeSeq === undefined && query.afterSeq === undefined
    ? messageInChannel(channelId, query.focusId)
    : undefined;
  const focusId = focusRow && focusRow.thread_root === root.id ? focusRow.id : requested.thread_root !== null ? requested.id : null;
  const beforeSeq = query.beforeSeq ?? (focusRow && focusRow.thread_root === root.id ? focusRow.seq + 1 : undefined);
  const readSeq = threadReadSeq(root.id, viewerId);
  const liveCount = (
    db.prepare("SELECT COUNT(*) AS n FROM channel_messages WHERE channel_id = ? AND thread_root = ? AND deleted_at IS NULL").get(channelId, root.id) as { n: number }
  ).n;
  const limit = Math.min(CHANNEL_LIMITS.threadPage, Math.max(1, query.limit ?? 30));
  const base = {
    readSeq,
    replyCount: liveCount,
    channelRevision: channel.revision,
    cursor: currentCursor(viewerId),
    focusId,
  };
  if (root.deleted_at !== null) {
    return { root: projectMessages([root], viewerId)[0]!, items: [], nextBeforeSeq: null, hasMore: false, ...base };
  }
  if (query.afterSeq !== undefined) {
    if (!Number.isSafeInteger(query.afterSeq) || query.afterSeq < 0) throw new AppError({ code: "validation", message: "Invalid message position." });
    const fetched = replyRows(channelId, root.id, "AND seq > ? ORDER BY seq ASC LIMIT ?", query.afterSeq, limit + 1);
    const page = fetched.slice(0, limit);
    const projected = projectMessages([root, ...page], viewerId);
    return {
      root: projected[0]!,
      items: projected.slice(1),
      nextBeforeSeq: page.length && existsOlder(channelId, root.id, page[0]!.seq) ? page[0]!.seq : null,
      hasMore: fetched.length > limit,
      ...base,
    };
  }
  const fetched = replyRows(
    channelId,
    root.id,
    beforeSeq === undefined ? "ORDER BY seq DESC LIMIT ?" : "AND seq < ? ORDER BY seq DESC LIMIT ?",
    ...(beforeSeq === undefined ? [limit + 1] : [beforeSeq, limit + 1]),
  );
  const page = fetched.slice(0, limit).reverse();
  const projected = projectMessages([root, ...page], viewerId);
  return {
    root: projected[0]!,
    items: projected.slice(1),
    nextBeforeSeq: fetched.length > limit && page.length ? page[0]!.seq : null,
    hasMore: fetched.length > limit,
    ...base,
  };
}
