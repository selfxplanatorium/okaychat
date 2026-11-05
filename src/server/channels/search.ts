import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "../db.js";
import { env } from "../env.js";
import { AppError } from "../errors.js";
import { SNIPPET_CLOSE, SNIPPET_OPEN, toFtsQuery } from "../fts.js";
import { channelAccess, notFound, requireChannelsFeature } from "./access.js";
import { chargeRate } from "./rate.js";
import { CHANNEL_LIMITS, type ChannelSearchHit, type ChannelSearchPage } from "../../shared/channels.js";

/**
 * Room search is its own FTS index. Authorization is inside the SQL and applied BEFORE the limit:
 * a private or group room the caller may not read can never consume a page slot or leak a snippet.
 * It is never unioned into the private chat spotlight or memory conversation search.
 */

const cursorKey = createHmac("sha256", env.secret).update("okaychat:channel-search-cursor:v1").digest();

interface Cursor {
  v: 1;
  key: string;
  createdAt: number;
  id: string;
}

function queryKey(query: string, channelId: string | null): string {
  return createHmac("sha256", cursorKey).update(`${query}\n${channelId ?? "*"}`).digest("hex");
}

function encodeCursor(query: string, channelId: string | null, row: { createdAt: number; id: string }): string {
  const payload: Cursor = { v: 1, key: queryKey(query, channelId), createdAt: row.createdAt, id: row.id };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${createHmac("sha256", cursorKey).update(body).digest("base64url")}`;
}

function decodeCursor(raw: string, query: string, channelId: string | null): { createdAt: number; id: string } {
  const dot = raw.lastIndexOf(".");
  if (dot <= 0 || raw.length > 512) throw invalidCursor();
  const body = raw.slice(0, dot);
  const expected = createHmac("sha256", cursorKey).update(body).digest();
  const actual = Buffer.from(raw.slice(dot + 1), "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw invalidCursor();
  let payload: Cursor;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Cursor;
  } catch {
    throw invalidCursor();
  }
  if (payload.v !== 1 || payload.key !== queryKey(query, channelId) || !Number.isSafeInteger(payload.createdAt) || typeof payload.id !== "string") throw invalidCursor();
  return { createdAt: payload.createdAt, id: payload.id };
}

function invalidCursor(): AppError {
  return new AppError({ code: "validation", status: 400, message: "That search cursor is not valid.", details: { reason: "cursor_invalid" } });
}

export function searchChannels(
  userId: string,
  input: { query: string; channelId?: string; before?: string; limit?: number },
): ChannelSearchPage {
  requireChannelsFeature(userId);
  const query = input.query.trim();
  if (!query || [...query].length > CHANNEL_LIMITS.searchQueryChars) {
    throw new AppError({ code: "validation", message: `Search needs a word of at most ${CHANNEL_LIMITS.searchQueryChars} characters.` });
  }
  const channelId = input.channelId ?? null;
  if (channelId) {
    const access = channelAccess(userId, channelId);
    if (!access || !access.member || !access.eligible) throw notFound();
  }
  const fts = toFtsQuery(query);
  if (!fts) return { items: [], nextCursor: null };
  const before = input.before ? decodeCursor(input.before, query, channelId) : null;
  const requested = input.limit ?? 20;
  if (!Number.isFinite(requested)) throw new AppError({ code: "validation", message: "Invalid page size." });
  const limit = Math.min(CHANNEL_LIMITS.searchPage, Math.max(1, Math.floor(requested)));
  chargeRate(userId, "search");
  const rows = db
    .prepare(
      `SELECT cm.channel_id AS channelId, cm.id AS messageId, cm.seq AS seq, cm.thread_root AS threadRootId,
              snippet(channel_messages_fts, 0, '${SNIPPET_OPEN}', '${SNIPPET_CLOSE}', '…', 12) AS snippet,
              cm.created_at AS createdAt
       FROM channel_messages_fts
       JOIN channel_search_keys k ON k.search_id = channel_messages_fts.rowid
       JOIN channel_messages cm ON cm.id = k.message_id
       JOIN channels c ON c.id = cm.channel_id
       JOIN channel_members m ON m.channel_id = c.id AND m.user_id = ?
       WHERE channel_messages_fts MATCH ? AND cm.deleted_at IS NULL
         ${channelId ? "" : "AND c.kind = 'room'"}
         AND (c.visibility <> 'group' OR EXISTS (
           SELECT 1 FROM channel_groups g JOIN user_group_members gm ON gm.group_id = g.group_id
           WHERE g.channel_id = c.id AND gm.user_id = ?))
         ${channelId ? "AND cm.channel_id = ?" : ""}
         ${before ? "AND (cm.created_at < ? OR (cm.created_at = ? AND cm.id < ?))" : ""}
       ORDER BY cm.created_at DESC, cm.id DESC
       LIMIT ?`,
    )
    .all(
      ...[
        userId,
        fts,
        userId,
        ...(channelId ? [channelId] : []),
        ...(before ? [before.createdAt, before.createdAt, before.id] : []),
        limit + 1,
      ],
    ) as unknown as Array<ChannelSearchHit & { createdAt: number }>;
  const page = rows.slice(0, limit);
  const items: ChannelSearchHit[] = page.map(({ channelId: room, messageId, seq, snippet, threadRootId }) => ({ channelId: room, messageId, seq, snippet, threadRootId }));
  const last = page.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && last ? encodeCursor(query, channelId, { createdAt: last.createdAt, id: last.messageId }) : null,
  };
}
