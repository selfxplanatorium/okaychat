/** Public share links: several per chat, live or frozen, optional expiry and password. */

export const SHARE_MODES = ["live", "frozen"] as const;
export type ShareMode = (typeof SHARE_MODES)[number];

export const MIN_SHARE_PASSWORD = 8;
export const MAX_SHARE_PASSWORD = 200;
export const MAX_SHARE_LABEL = 60;
export const MAX_SHARES_PER_THREAD = 10;
export const MAX_SHARES_PER_USER = 100;
/** Frozen snapshots are stored twice (payload + asset allowlist) and count against the storage quota. */
export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
/** The farthest a link's expiry may be set from now. */
export const MAX_SHARE_EXPIRY_MS = 365 * 24 * 60 * 60 * 1000;

/** What the owner sees. The password hash and the snapshot body never leave the server. */
export interface ShareLink {
  token: string;
  threadId: string;
  threadTitle: string | null;
  label: string;
  mode: ShareMode;
  expiresAt: number | null;
  /** When the frozen payload was captured; null for a live link. */
  frozenAt: number | null;
  hasPassword: boolean;
  createdAt: number;
  lastViewedAt: number | null;
  viewCount: number;
  expired: boolean;
}

export interface ShareCreateInput {
  label?: string;
  mode?: ShareMode;
  expiresAt?: number | null;
  password?: string;
}

export interface ShareUpdateInput {
  label?: string;
  mode?: ShareMode;
  expiresAt?: number | null;
  /** A string sets or replaces the password; null or "" removes it. Omitted keeps it. */
  password?: string | null;
  refreshSnapshot?: boolean;
}

export const isShareMode = (value: unknown): value is ShareMode =>
  typeof value === "string" && (SHARE_MODES as readonly string[]).includes(value);

/** A label is stored trimmed; an empty one falls back to the generic name in the UI. */
export const normalizeShareLabel = (value: string): string => value.trim().slice(0, MAX_SHARE_LABEL);

/** True while the link may still be opened. */
export const shareExpired = (expiresAt: number | null, now = Date.now()): boolean => expiresAt !== null && expiresAt <= now;
