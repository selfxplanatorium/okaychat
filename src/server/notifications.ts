import { Hono } from "hono";
import type { AppEnv } from "./auth.js";
import { newId } from "./crypto.js";
import { db, tx } from "./db.js";
import { featureAllowed } from "./permissions/guard.js";
import {
  isNotificationBodyKey,
  isNotificationTitleKey,
  safeActionPath,
  sanitizeNotificationParams,
  type AppNotification,
  type NotificationBodyKey,
  type NotificationKind,
  type NotificationLevel,
  type NotificationTitleKey,
} from "../shared/notifications.js";

/**
 * Durable notices. The server authors every field: only allowlisted title/body keys and sanitized
 * params reach storage, so a notice can never carry a prompt, model output, provider body, or secret.
 * `source_key` dedupes retried writes (a scheduled run or archive job is one row).
 */

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_ROWS = 200;
const PAGE_LIMIT = 30;

export interface NotificationInput {
  userId: string;
  kind: NotificationKind;
  level: NotificationLevel;
  titleKey: NotificationTitleKey;
  bodyKey?: NotificationBodyKey;
  params?: Record<string, unknown>;
  threadId?: string | null;
  channelId?: string | null;
  channelMessageId?: string | null;
  calendarEventId?: string | null;
  actionPath?: string | null;
  sourceKey?: string | null;
}

interface Row {
  id: string;
  kind: NotificationKind;
  level: NotificationLevel;
  title_key: string;
  body_key: string | null;
  params_json: string;
  thread_id: string | null;
  channel_id: string | null;
  channel_message_id: string | null;
  calendar_event_id: string | null;
  action_path: string | null;
  read_at: number | null;
  created_at: number;
}

const toNotification = (row: Row): AppNotification => ({
  id: row.id,
  kind: row.kind,
  level: row.level,
  titleKey: (isNotificationTitleKey(row.title_key) ? row.title_key : "schedule.ok") as NotificationTitleKey,
  bodyKey: row.body_key && isNotificationBodyKey(row.body_key) ? row.body_key : null,
  params: sanitizeNotificationParams(JSON.parse(row.params_json) as unknown),
  threadId: row.thread_id,
  channelId: row.channel_id,
  channelMessageId: row.channel_message_id,
  calendarEventId: row.calendar_event_id,
  actionPath: row.action_path,
  readAt: row.read_at,
  createdAt: row.created_at,
});

const droppedKeys = new Set<string>();

/** Inserts one notice unless its source key was already recorded, then prunes by age and count. */
export function notify(input: NotificationInput): void {
  if (!isNotificationTitleKey(input.titleKey)) {
    logDropped(input.userId, `unknown title ${input.titleKey}`);
    return;
  }
  if (input.bodyKey !== undefined && !isNotificationBodyKey(input.bodyKey)) {
    logDropped(input.userId, `unknown body ${input.bodyKey}`);
    return;
  }
  const params = JSON.stringify(sanitizeNotificationParams(input.params));
  const now = Date.now();
  tx(() => {
    db.prepare(
      `INSERT OR IGNORE INTO notifications (id, user_id, kind, level, title_key, body_key, params_json, thread_id, channel_id, channel_message_id, calendar_event_id, action_path, source_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId("ntf"),
      input.userId,
      input.kind,
      input.level,
      input.titleKey,
      input.bodyKey ?? null,
      params,
      input.threadId ?? null,
      input.channelId ?? null,
      input.channelMessageId ?? null,
      input.calendarEventId ?? null,
      safeActionPath(input.actionPath),
      input.sourceKey ?? null,
      now,
    );
    db.prepare("DELETE FROM notifications WHERE user_id = ? AND created_at < ?").run(input.userId, now - RETENTION_MS);
    db.prepare(
      `DELETE FROM notifications WHERE user_id = ? AND id NOT IN (
         SELECT id FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?)`,
    ).run(input.userId, input.userId, MAX_ROWS);
  });
}

/** Logs a rejected key once per key, with the user id only. */
function logDropped(userId: string, reason: string): void {
  const key = `${userId}:${reason}`;
  if (droppedKeys.has(key)) return;
  if (droppedKeys.size > 1000) droppedKeys.clear();
  droppedKeys.add(key);
  console.warn(`[notifications] dropped a notice for ${userId}: ${reason}`);
}

const cursorOf = (row: { created_at: number; id: string }) => `${row.created_at}:${row.id}`;

function parseCursor(value: string | undefined): { createdAt: number; id: string } | null {
  if (!value) return null;
  const index = value.indexOf(":");
  if (index <= 0) return null;
  const createdAt = Number(value.slice(0, index));
  const id = value.slice(index + 1);
  if (!Number.isFinite(createdAt) || !id) return null;
  return { createdAt, id };
}

/**
 * SQL condition on the `notifications n` alias: a channel notice follows the room's live ACL, and an
 * invitation notice survives before membership. Feature denial hides every channel notice.
 */
export function channelNoticeVisibleSql(channelEnabled: boolean): string {
  if (!channelEnabled) return "(n.kind <> 'channel')";
  return `(n.kind <> 'channel' OR EXISTS (
    SELECT 1 FROM channels c WHERE c.id = n.channel_id AND (
      (EXISTS (SELECT 1 FROM channel_members m WHERE m.channel_id = c.id AND m.user_id = n.user_id)
        AND (c.visibility <> 'group' OR EXISTS (
          SELECT 1 FROM channel_groups g JOIN user_group_members gm ON gm.group_id = g.group_id
          WHERE g.channel_id = c.id AND gm.user_id = n.user_id)))
      OR (n.channel_message_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM channel_exclusions x WHERE x.channel_id = c.id AND x.user_id = n.user_id)
        AND (c.visibility <> 'group' OR EXISTS (
          SELECT 1 FROM channel_groups g JOIN user_group_members gm ON gm.group_id = g.group_id
          WHERE g.channel_id = c.id AND gm.user_id = n.user_id))
        AND EXISTS (SELECT 1 FROM channel_invites i WHERE i.channel_id = c.id AND i.user_id = n.user_id))
    )
  ))`;
}

/** True while a channel notice still belongs to a room the recipient may see. */
export function channelNoticeVisible(userId: string, notificationId: string): boolean {
  const enabled = featureAllowed(userId, "channels");
  return !!db
    .prepare(`SELECT 1 FROM notifications n WHERE n.id = ? AND n.user_id = ? AND ${channelNoticeVisibleSql(enabled)}`)
    .get(notificationId, userId);
}

/**
 * SQL condition on `notifications n`: a calendar notice is visible only while the account may still use
 * calendar and the event it points at is still owned by the same user. Composed with the channel
 * predicate, never replacing it, so room ACLs keep their current rules.
 */
export function calendarNoticeVisibleSql(calendarEnabled: boolean): string {
  if (!calendarEnabled) return "(n.kind <> 'calendar')";
  return `(n.kind <> 'calendar' OR EXISTS (
    SELECT 1 FROM calendar_events e WHERE e.id = n.calendar_event_id AND e.user_id = n.user_id
  ))`;
}

/** Both feature-dependent predicates, parameterized as constants. */
export function noticeVisibleSql(channelEnabled: boolean, calendarEnabled: boolean): string {
  return `(${channelNoticeVisibleSql(channelEnabled)}) AND (${calendarNoticeVisibleSql(calendarEnabled)})`;
}

function visiblePredicate(userId: string): string {
  return noticeVisibleSql(featureAllowed(userId, "channels"), featureAllowed(userId, "calendar"));
}

/** True while a notice is still visible to its recipient under every source's rules. */
export function noticeVisible(userId: string, notificationId: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM notifications n WHERE n.id = ? AND n.user_id = ? AND ${visiblePredicate(userId)}`)
    .get(notificationId, userId);
}

export function unreadCount(userId: string): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM notifications n WHERE n.user_id = ? AND n.read_at IS NULL AND ${visiblePredicate(userId)}`)
      .get(userId) as { n: number }
  ).n;
}

export function listNotifications(
  userId: string,
  opts: { before?: string; limit?: number } = {},
): { items: AppNotification[]; unread: number; nextCursor: string | null } {
  const limit = Math.min(PAGE_LIMIT, Math.max(1, opts.limit ?? PAGE_LIMIT));
  const before = parseCursor(opts.before);
  const visible = visiblePredicate(userId);
  const rows = (before
    ? db
        .prepare(
          `SELECT n.* FROM notifications n WHERE n.user_id = ?
             AND (n.created_at < ? OR (n.created_at = ? AND n.id < ?)) AND ${visible}
           ORDER BY n.created_at DESC, n.id DESC LIMIT ?`,
        )
        .all(userId, before.createdAt, before.createdAt, before.id, limit)
    : db
        .prepare(`SELECT n.* FROM notifications n WHERE n.user_id = ? AND ${visible} ORDER BY n.created_at DESC, n.id DESC LIMIT ?`)
        .all(userId, limit)) as unknown as Row[];
  return {
    items: rows.map(toNotification),
    unread: unreadCount(userId),
    nextCursor: rows.length === limit ? cursorOf(rows.at(-1)!) : null,
  };
}

export function markRead(userId: string, id: string): number {
  if (!noticeVisible(userId, id)) return unreadCount(userId);
  db.prepare("UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL").run(Date.now(), id, userId);
  return unreadCount(userId);
}

export function markUnread(userId: string, id: string): number {
  if (!noticeVisible(userId, id)) return unreadCount(userId);
  db.prepare("UPDATE notifications SET read_at = NULL WHERE id = ? AND user_id = ?").run(id, userId);
  return unreadCount(userId);
}

export function markAllRead(userId: string): number {
  db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").run(Date.now(), userId);
  return 0;
}

export function dismiss(userId: string, id: string): number {
  if (!noticeVisible(userId, id)) return unreadCount(userId);
  db.prepare("DELETE FROM notifications WHERE id = ? AND user_id = ?").run(id, userId);
  return unreadCount(userId);
}

/**
 * Advancing a room cursor marks the notices for messages at or below it read. This never moves a cursor
 * the other way and never touches a notice for a newer message.
 */
export function markChannelNoticesReadThrough(userId: string, channelId: string, throughSeq: number): void {
  db.prepare(
    `UPDATE notifications SET read_at = ?
     WHERE user_id = ? AND channel_id = ? AND read_at IS NULL AND channel_message_id IN (
       SELECT id FROM channel_messages WHERE channel_id = ? AND seq <= ? AND deleted_at IS NULL
     )`,
  ).run(Date.now(), userId, channelId, channelId, throughSeq);
}

/** ACL cleanup after removal, exclusion, feature loss, or account deletion. */
export function purgeChannelNotices(channelId: string, userId?: string): void {
  if (userId) db.prepare("DELETE FROM notifications WHERE channel_id = ? AND user_id = ?").run(channelId, userId);
  else db.prepare("DELETE FROM notifications WHERE channel_id = ?").run(channelId);
}

/** Message notices disappear with a tombstoned source message. */
export function purgeChannelMessageNotices(channelId: string, messageId: string): void {
  db.prepare("DELETE FROM notifications WHERE channel_id = ? AND channel_message_id = ?").run(channelId, messageId);
}

export function clearRead(userId: string): number {
  db.prepare("DELETE FROM notifications WHERE user_id = ? AND read_at IS NOT NULL").run(userId);
  return unreadCount(userId);
}

const privateHeaders = { "Cache-Control": "private, no-store" };

export const notificationRoutes = new Hono<AppEnv>()
  .get("/notifications", (c) => {
    const limit = Number(c.req.query("limit") ?? PAGE_LIMIT);
    return c.json(
      listNotifications(c.get("user").id, { before: c.req.query("before"), limit: Number.isFinite(limit) ? limit : PAGE_LIMIT }),
      200,
      privateHeaders,
    );
  })
  // Static paths before the `/:id` shapes, as Hono matches in registration order.
  .post("/notifications/read-all", (c) => c.json({ unread: markAllRead(c.get("user").id) }, 200, privateHeaders))
  .delete("/notifications/read", (c) => c.json({ unread: clearRead(c.get("user").id) }, 200, privateHeaders))
  .post("/notifications/:id/read", (c) => c.json({ unread: markRead(c.get("user").id, c.req.param("id")) }, 200, privateHeaders))
  .post("/notifications/:id/unread", (c) => c.json({ unread: markUnread(c.get("user").id, c.req.param("id")) }, 200, privateHeaders))
  .delete("/notifications/:id", (c) => c.json({ unread: dismiss(c.get("user").id, c.req.param("id")) }, 200, privateHeaders));
