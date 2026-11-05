import { db } from "../db.js";
import { AppError } from "../errors.js";
import { CHANNEL_LIMITS, type ChannelMessagePage } from "../../shared/channels.js";
import { projectMessages, type ChannelMessageRow } from "./projections.js";
import { currentCursor } from "./events.js";

/** Room history pages. The caller has already proven membership, so this file only reads. */

export interface HistoryQuery {
  beforeSeq?: number;
  afterSeq?: number;
  aroundId?: string;
  limit?: number;
}

function rows(channelId: string, sql: string, ...params: Array<string | number>): ChannelMessageRow[] {
  return db.prepare(`SELECT * FROM channel_messages WHERE channel_id = ? AND thread_root IS NULL ${sql}`).all(channelId, ...params) as unknown as ChannelMessageRow[];
}

const existsOlder = (channelId: string, seq: number) =>
  !!db.prepare("SELECT 1 FROM channel_messages WHERE channel_id = ? AND thread_root IS NULL AND seq < ?").get(channelId, seq);
const existsNewer = (channelId: string, seq: number) =>
  !!db.prepare("SELECT 1 FROM channel_messages WHERE channel_id = ? AND thread_root IS NULL AND seq > ?").get(channelId, seq);

export function channelHistory(channelId: string, viewerId: string, query: HistoryQuery): ChannelMessagePage {
  const channel = db.prepare("SELECT revision FROM channels WHERE id = ?").get(channelId) as { revision: number } | undefined;
  if (!channel) throw new AppError({ code: "not_found", message: "Room not found." });
  const limit = Math.min(CHANNEL_LIMITS.historyPage, Math.max(1, query.limit ?? 50));
  const modes = [query.beforeSeq !== undefined, query.afterSeq !== undefined, query.aroundId !== undefined].filter(Boolean).length;
  if (modes > 1) throw new AppError({ code: "validation", message: "Use one history position at a time." });

  if (query.afterSeq !== undefined) {
    if (!Number.isSafeInteger(query.afterSeq) || query.afterSeq < 0) throw new AppError({ code: "validation", message: "Invalid message position." });
    const fetched = rows(channelId, "AND seq > ? ORDER BY seq ASC LIMIT ?", query.afterSeq, limit + 1);
    const page = fetched.slice(0, limit);
    return {
      items: projectMessages(page, viewerId),
      nextBeforeSeq: page.length && existsOlder(channelId, page[0]!.seq) ? page[0]!.seq : null,
      nextAfterSeq: fetched.length > limit ? page.at(-1)!.seq : null,
      hasMore: fetched.length > limit,
      cursor: currentCursor(viewerId),
      channelRevision: channel.revision,
    };
  }

  if (query.aroundId !== undefined) {
    const target = db.prepare("SELECT seq FROM channel_messages WHERE channel_id = ? AND thread_root IS NULL AND id = ?").get(channelId, query.aroundId) as { seq: number } | undefined;
    if (!target) throw new AppError({ code: "not_found", message: "That message was not found." });
    const before = rows(channelId, "AND seq < ? ORDER BY seq DESC LIMIT ?", target.seq, 50).reverse();
    const after = rows(channelId, "AND seq >= ? ORDER BY seq ASC LIMIT ?", target.seq, 50);
    const page = [...before, ...after];
    return {
      items: projectMessages(page, viewerId),
      nextBeforeSeq: page.length && existsOlder(channelId, page[0]!.seq) ? page[0]!.seq : null,
      nextAfterSeq: page.length && existsNewer(channelId, page.at(-1)!.seq) ? page.at(-1)!.seq : null,
      hasMore: !!(page.length && (existsOlder(channelId, page[0]!.seq) || existsNewer(channelId, page.at(-1)!.seq))),
      cursor: currentCursor(viewerId),
      channelRevision: channel.revision,
    };
  }

  if (query.beforeSeq !== undefined && (!Number.isSafeInteger(query.beforeSeq) || query.beforeSeq < 0)) {
    throw new AppError({ code: "validation", message: "Invalid message position." });
  }
  const fetched = rows(
    channelId,
    query.beforeSeq === undefined ? "ORDER BY seq DESC LIMIT ?" : "AND seq < ? ORDER BY seq DESC LIMIT ?",
    ...(query.beforeSeq === undefined ? [limit + 1] : [query.beforeSeq, limit + 1]),
  );
  const page = fetched.slice(0, limit).reverse();
  const hasMore = fetched.length > limit;
  return {
    items: projectMessages(page, viewerId),
    nextBeforeSeq: hasMore && page.length ? page[0]!.seq : null,
    nextAfterSeq: page.length && existsNewer(channelId, page.at(-1)!.seq) ? page.at(-1)!.seq : null,
    hasMore,
    cursor: currentCursor(viewerId),
    channelRevision: channel.revision,
  };
}
