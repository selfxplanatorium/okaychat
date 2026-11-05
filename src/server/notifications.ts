import { Hono } from "hono";
import type { AppEnv } from "./auth.js";
import { newId } from "./crypto.js";
import { db, tx } from "./db.js";
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
      `INSERT OR IGNORE INTO notifications (id, user_id, kind, level, title_key, body_key, params_json, thread_id, action_path, source_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId("ntf"),
      input.userId,
      input.kind,
      input.level,
      input.titleKey,
      input.bodyKey ?? null,
      params,
      input.threadId ?? null,
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

export function unreadCount(userId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL").get(userId) as { n: number }).n;
}

export function listNotifications(
  userId: string,
  opts: { before?: string; limit?: number } = {},
): { items: AppNotification[]; unread: number; nextCursor: string | null } {
  const limit = Math.min(PAGE_LIMIT, Math.max(1, opts.limit ?? PAGE_LIMIT));
  const before = parseCursor(opts.before);
  const rows = (before
    ? db
        .prepare(
          `SELECT * FROM notifications WHERE user_id = ?
             AND (created_at < ? OR (created_at = ? AND id < ?))
           ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(userId, before.createdAt, before.createdAt, before.id, limit)
    : db.prepare("SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?").all(userId, limit)) as unknown as Row[];
  return {
    items: rows.map(toNotification),
    unread: unreadCount(userId),
    nextCursor: rows.length === limit ? cursorOf(rows.at(-1)!) : null,
  };
}

export function markRead(userId: string, id: string): number {
  db.prepare("UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL").run(Date.now(), id, userId);
  return unreadCount(userId);
}

export function markUnread(userId: string, id: string): number {
  db.prepare("UPDATE notifications SET read_at = NULL WHERE id = ? AND user_id = ?").run(id, userId);
  return unreadCount(userId);
}

export function markAllRead(userId: string): number {
  db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").run(Date.now(), userId);
  return 0;
}

export function dismiss(userId: string, id: string): number {
  db.prepare("DELETE FROM notifications WHERE id = ? AND user_id = ?").run(id, userId);
  return unreadCount(userId);
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
