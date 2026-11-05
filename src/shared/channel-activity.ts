/**
 * Ephemeral channel activity: advisory presence and typing over the existing channel event stream.
 *
 * This module is pure: no web or server imports, no DOM globals. Both sides share the wire contract and
 * the exact limits so a reviewer can read one file to see what is bounded where. Nothing here is stored
 * or replayed; a frame is only meaningful to the connection that is currently watching.
 */

export type ChannelPresenceState = "online" | "away" | "offline";

export interface ChannelPresenceEntry {
  userId: string;
  state: ChannelPresenceState;
}

export interface ChannelTypingEntry {
  rootId: string | null;
  userId: string;
  /** Milliseconds left on the accepted typing lease, always 1..typingLeaseMs. */
  remainingMs: number;
}

export interface ChannelTypingScope {
  rootId: string | null;
  items: Array<{ userId: string; remainingMs: number }>;
}

/** A snapshot is a full view; a patch replaces the entries and scopes it names; clear names nothing. */
export type ChannelActivityFrame =
  | {
      v: 1;
      kind: "snapshot";
      watchRevision: number;
      channelId: string;
      presence: ChannelPresenceEntry[];
      typing: ChannelTypingEntry[];
    }
  | {
      v: 1;
      kind: "patch";
      watchRevision: number;
      channelId: string;
      presence: ChannelPresenceEntry[];
      typingScopes: ChannelTypingScope[];
    }
  | { v: 1; kind: "clear"; watchRevision: number };

export interface ChannelActivitySettings {
  /** Publish an online/away contribution while this account is using a tab. */
  sharePresence: boolean;
  /** Publish typing in the watched room or thread. Independent of presence. */
  shareTyping: boolean;
}

export const DEFAULT_CHANNEL_ACTIVITY_SETTINGS: ChannelActivitySettings = { sharePresence: true, shareTyping: true };

/** One place for every number the protocol promises. Server and client both import this table. */
export const CHANNEL_ACTIVITY_LIMITS = {
  /** The client must refresh activity at least this often while usable. */
  activityLeaseMs: 75_000,
  /** A fresh active signal counts online for this long, then degrades to away until the lease ends. */
  activeHoldMs: 60_000,
  /** A client declares itself idle after this long without trusted input. */
  idleAfterMs: 60_000,
  /** A closed but otherwise valid contribution bridges a stream rotation for this long. */
  graceMs: 10_000,
  /** Largest accepted typing lease; the client refreshes no faster than typingRefreshMs. */
  typingLeaseMs: 6_000,
  typingRefreshMs: 3_000,
  /** The client stops typing after this long without further input. */
  typingSilenceMs: 4_000,
  /** Visible active tab refresh cadence. */
  activityRefreshMs: 30_000,
  /** At most one state frame per connection in this window. */
  outputCoalesceMs: 2_000,
  /** A watched connection receives a full snapshot at least this often. */
  snapshotMs: 30_000,
  /** No state frame for this long invalidates indicators locally. */
  displayFreshMs: 45_000,
  /** Keepalive cadence of the durable stream. */
  heartbeatMs: 15_000,
  maxFrameBytes: 64 * 1024,
  maxPresenceEntries: 200,
  maxTypingEntries: 400,
  maxTypingScopeMembers: 200,
  maxRequestBytes: 4 * 1024,
  maxConnectionIdChars: 128,
  /** At most two retained disconnect-grace entries per account and 512 process-wide. */
  maxGracePerAccount: 2,
  maxGraceEntries: 512,
  /** Account and per-connection request windows, all in one minute. */
  rate: {
    accountActivity: 12,
    accountTyping: 60,
    accountCombined: 72,
    connectionActivity: 8,
    connectionTyping: 24,
    windowMs: 60_000,
    bucketIdleMs: 120_000,
    maxBuckets: 1_024,
  },
} as const;

/** Opaque identifiers only: URL-safe ASCII, 1..128 characters. */
export const CHANNEL_ACTIVITY_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** A 256-bit base64url connection id (43 characters, no padding). */
export const CHANNEL_CONNECTION_ID = /^[A-Za-z0-9_-]{43}$/;

export const isChannelPresenceState = (value: unknown): value is ChannelPresenceState =>
  value === "online" || value === "away" || value === "offline";

export const isChannelActivitySettings = (value: unknown): value is ChannelActivitySettings => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes("sharePresence") || !keys.includes("shareTyping")) return false;
  return typeof record.sharePresence === "boolean" && typeof record.shareTyping === "boolean";
};

/** Re-orders a set deterministically; tests and clients rely on stable user id order. */
export const byUserId = <T extends { userId: string }>(a: T, b: T): number => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0);

/**
 * Strict frame validation. A malformed or future frame is dropped whole: indicators then expire on
 * their own deadline instead of showing text the server never authorized.
 */
export function parseChannelActivityFrame(value: unknown): ChannelActivityFrame | null {
  if (!value || typeof value !== "object") return null;
  const frame = value as Record<string, unknown>;
  if (frame.v !== 1 || typeof frame.watchRevision !== "number" || !Number.isSafeInteger(frame.watchRevision) || frame.watchRevision < 0) return null;
  if (frame.kind === "clear") return { v: 1, kind: "clear", watchRevision: frame.watchRevision };
  if (typeof frame.channelId !== "string" || !CHANNEL_ACTIVITY_ID.test(frame.channelId)) return null;
  if (frame.kind === "snapshot") {
    const presence = presenceList(frame.presence);
    const typing = typingList(frame.typing);
    if (!presence || !typing) return null;
    return { v: 1, kind: "snapshot", watchRevision: frame.watchRevision, channelId: frame.channelId, presence, typing };
  }
  if (frame.kind === "patch") {
    const presence = presenceList(frame.presence);
    const scopes = typingScopes(frame.typingScopes);
    if (!presence || !scopes) return null;
    return { v: 1, kind: "patch", watchRevision: frame.watchRevision, channelId: frame.channelId, presence, typingScopes: scopes };
  }
  return null;
}

function presenceList(value: unknown): ChannelPresenceEntry[] | null {
  if (!Array.isArray(value) || value.length > CHANNEL_ACTIVITY_LIMITS.maxPresenceEntries) return null;
  const out: ChannelPresenceEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const entry = item as Record<string, unknown>;
    if (typeof entry.userId !== "string" || !CHANNEL_ACTIVITY_ID.test(entry.userId) || !isChannelPresenceState(entry.state)) return null;
    out.push({ userId: entry.userId, state: entry.state });
  }
  return out;
}

function remaining(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= CHANNEL_ACTIVITY_LIMITS.typingLeaseMs;
}

function typingList(value: unknown): ChannelTypingEntry[] | null {
  if (!Array.isArray(value) || value.length > CHANNEL_ACTIVITY_LIMITS.maxTypingEntries) return null;
  const out: ChannelTypingEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const entry = item as Record<string, unknown>;
    if (typeof entry.userId !== "string" || !CHANNEL_ACTIVITY_ID.test(entry.userId) || !remaining(entry.remainingMs)) return null;
    const rootId = entry.rootId;
    if (rootId !== null && (typeof rootId !== "string" || !CHANNEL_ACTIVITY_ID.test(rootId))) return null;
    out.push({ rootId, userId: entry.userId, remainingMs: entry.remainingMs });
  }
  return out;
}

function typingScopes(value: unknown): ChannelTypingScope[] | null {
  if (!Array.isArray(value) || value.length > 2) return null;
  const out: ChannelTypingScope[] = [];
  for (const scope of value) {
    if (!scope || typeof scope !== "object") return null;
    const entry = scope as Record<string, unknown>;
    const rootId = entry.rootId;
    if (rootId !== null && (typeof rootId !== "string" || !CHANNEL_ACTIVITY_ID.test(rootId))) return null;
    if (!Array.isArray(entry.items) || entry.items.length > CHANNEL_ACTIVITY_LIMITS.maxTypingScopeMembers) return null;
    const items: Array<{ userId: string; remainingMs: number }> = [];
    for (const item of entry.items) {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      if (typeof row.userId !== "string" || !CHANNEL_ACTIVITY_ID.test(row.userId) || !remaining(row.remainingMs)) return null;
      items.push({ userId: row.userId, remainingMs: row.remainingMs });
    }
    out.push({ rootId, items });
  }
  return out;
}

/** The watched scope a frame describes; a room frame carries typing for its root-less line. */
export const channelTypingScopeKey = (channelId: string, rootId: string | null): string => `${channelId}\u0000${rootId ?? ""}`;
