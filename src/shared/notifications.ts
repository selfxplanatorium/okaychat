/**
 * Durable in-app notices. The server writes only allowlisted title/body keys and sanitized params,
 * so a notice can never carry a prompt, model output, provider body, or another account's text.
 */

export const NOTIFICATION_KINDS = ["schedule", "import", "export", "channel", "calendar"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_LEVELS = ["info", "success", "error"] as const;
export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];

export const NOTIFICATION_TITLE_KEYS = [
  "schedule.ok",
  "schedule.error",
  "schedule.skipped",
  "export.ready",
  "export.failed",
  "import.done",
  "import.failed",
  "channel.invited",
  "channel.mention",
  "channel.message",
  "channel.dmMessage",
  "channel.threadReply",
  "channel.aiFinished",
  "calendar.reminder",
] as const;
export type NotificationTitleKey = (typeof NOTIFICATION_TITLE_KEYS)[number];

export const NOTIFICATION_BODY_KEYS = [
  "schedule.okBody",
  "schedule.errorBody",
  "schedule.skippedBody",
  "export.readyBody",
  "export.failedBody",
  "import.doneBody",
  "import.failedBody",
  "channel.openRoom",
  "channel.openMessage",
  "channel.openThread",
  "calendar.openEvent",
] as const;
export type NotificationBodyKey = (typeof NOTIFICATION_BODY_KEYS)[number];

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  level: NotificationLevel;
  titleKey: NotificationTitleKey;
  bodyKey: NotificationBodyKey | null;
  /** Values for the `{placeholders}` in the two keys. */
  params: Record<string, string | number>;
  threadId: string | null;
  /** The room whose ACL governs this notice; null for private-chat notices. */
  channelId?: string | null;
  channelMessageId?: string | null;
  /** The calendar event a reminder notice opens; null for every other kind. */
  calendarEventId?: string | null;
  /** An app path the notice opens, or null. Always a same-origin path. */
  actionPath: string | null;
  readAt: number | null;
  createdAt: number;
}

export const MAX_NOTIFICATION_PARAM_KEYS = 12;
export const MAX_NOTIFICATION_PARAM_LENGTH = 500;

/** Strings are bounded, numbers must be finite, and only the first 12 keys survive. */
export function sanitizeNotificationParams(value: unknown): Record<string, string | number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string | number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (Object.keys(out).length >= MAX_NOTIFICATION_PARAM_KEYS) break;
    if (!/^\w{1,40}$/.test(key)) continue;
    if (typeof entry === "string") out[key] = entry.slice(0, MAX_NOTIFICATION_PARAM_LENGTH);
    else if (typeof entry === "number" && Number.isFinite(entry)) out[key] = entry;
  }
  return out;
}

export const isNotificationTitleKey = (value: string): value is NotificationTitleKey =>
  (NOTIFICATION_TITLE_KEYS as readonly string[]).includes(value);
export const isNotificationBodyKey = (value: string): value is NotificationBodyKey =>
  (NOTIFICATION_BODY_KEYS as readonly string[]).includes(value);

/** Only an app path: no scheme, no protocol-relative URL, bounded length. */
export function safeActionPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("://") || value.length > 300) return null;
  return value;
}
