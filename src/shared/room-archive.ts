import type { ChannelIcon, ChannelReaction, ChannelRole, ChannelVisibility } from "./channels.js";

/**
 * Room archive v1 wire contract. This module is pure: the server and the web app share these types,
 * limits, and closed unions. Nothing here reads the database or the filesystem.
 *
 * A room archive contains exactly one room: never a DM, a personal chat, a Library object, AI settings,
 * credentials, usage, read state, or membership authority. Import always creates a new private room.
 */

export const ROOM_ARCHIVE_FORMAT = "okaychat.room-archive";
export const ROOM_ARCHIVE_VERSION = 1;
export const ROOM_ARCHIVE_SUFFIX = ".okaychat-room.zip";
export const ROOM_ARCHIVE_MIME = "application/zip";

const MiB = 1024 * 1024;

export const ROOM_ARCHIVE_LIMITS = {
  /** Uploaded ZIP and the built export ZIP. */
  uploadBytes: 64 * MiB,
  outputBytes: 64 * MiB,
  /** Sum of every expanded entry, the manifest included. */
  expandedBytes: 64 * MiB,
  manifestBytes: 8 * MiB,
  /** Lexical JSON nesting, checked before `JSON.parse`. */
  manifestDepth: 16,
  entries: 2_001,
  assets: 2_000,
  messages: 5_000,
  roots: 500,
  repliesPerRoot: 500,
  attachmentsPerMessage: 5,
  attachmentRefs: 2_000,
  assetMaxBytes: 10 * MiB,
  /** Sum of attachment reference sizes, deliberately not deduplicated by asset hash. */
  attachmentTotalBytes: 64 * MiB,
  identities: 2_000,
  members: 200,
  mentionsPerMessage: 20,
  mentionRows: 20_000,
  reactionRows: 50_000,
  reactionsPerIdentity: 3,
  reactionIdentitiesPerEmoji: 200,
  maxImagePixels: 100_000_000,
  /** One job per account across export and import; four waiting globally; one executing. */
  activeJobsPerAccount: 1,
  queuedJobs: 4,
  workers: 1,
  uploads: 2,
  newJobsPerAccountPerHour: 6,
  newJobsGlobalPerHour: 30,
  jobReadsPerMinute: 60,
  confirmsPerMinute: 10,
  jobLifetimeMs: 30 * 60_000,
  awaitingUploadMs: 60_000,
  uploadDeadlineMs: 60_000,
  phaseDeadlineMs: 60_000,
  snapshotBudgetMs: 2_000,
  commitBudgetMs: 5_000,
  /** Raw + expanded staging plus the promotion footprint. */
  stageReservationBytes: 256 * MiB,
  /** The whole process, personal archive staging included. */
  globalStagingBytes: 512 * MiB,
  /** Final logical room bytes (bodies, metadata, historical JSON, identity rows, attachment references). */
  finalRoomBytes: 80 * MiB,
  /** Fixed quota reservation per imported identity row. */
  identityReservationBytes: 1_024,
  summaryBytes: 64 * 1024,
  warningSamples: 10,
  warningCodes: 50,
  receiptRetentionMs: 24 * 60 * 60_000,
  terminalReceiptsPerAccount: 100,
  downloadAuditMs: 60_000,
  /** Preview in inspect: bounded text only, never file bytes or remote assets. */
  previewMessages: 20,
  previewBodyCodePoints: 160,
  rosterPage: 20,
  rosterPageMax: 50,
  /** Request bodies. */
  requestBytes: 16 * 1024,
  selectionBytes: 80 * 1024,
} as const;

export const ROOM_ARCHIVE_SUPPORTED_METHODS = [0, 8] as const;

/** Request selection: the whole room, or named roots plus all of their live replies. */
export type RoomArchiveSelection =
  | { mode: "all" }
  | { mode: "roots"; rootIds: string[]; includeReplies: boolean };

export type RoomArchiveState = "uploading" | "queued" | "preparing" | "ready" | "committing" | "done" | "failed" | "cancelled" | "expired";

export type RoomArchivePhase = "upload" | "snapshot" | "zip" | "validate" | "inspect" | "promote" | "commit" | "download" | "cleanup" | "complete";

export type RoomArchiveProgressUnit = "bytes" | "messages" | "assets";

export type RoomArchiveErrorCode =
  | "invalid_archive"
  | "wrong_format"
  | "unsupported_version"
  | "limit_exceeded"
  | "asset_unavailable"
  | "attachment_type"
  | "attachment_invalid"
  | "room_busy"
  | "busy"
  | "queue_full"
  | "rate_limited"
  | "storage_quota"
  | "staging_full"
  | "capacity"
  | "review_changed"
  | "expired"
  | "interrupted"
  | "timeout"
  | "import_failed"
  | "export_failed"
  | "not_ready"
  | "imported_read_only"
  | "imported_source";

export type RoomArchiveWarningCode =
  | "plaintextSensitive"
  | "membersNotJoined"
  | "rolesInactive"
  | "privateDestination"
  | "aiSettingsOmitted"
  | "aiHistoryOnly"
  | "quoteUnavailable"
  | "unknownAuthors"
  | "emailsIncluded"
  | "emailsDiscarded"
  | "historicalRolesFlattened"
  | "reactionProvenanceFlattened"
  | "linksNotRewritten"
  | "sourceMetadataHistorical";

/** Inspect preview labels: neutral values, never a server-translated string. */
export type RoomArchiveAuthorLabel = { kind: "known"; id: string; name: string } | { kind: "unknown" } | { kind: "ai" };

export interface RoomArchiveSummary {
  name: string;
  sourceVisibility: ChannelVisibility;
  sourceArchived: boolean;
  roots: number;
  replies: number;
  attachments: number;
  distinctAssets: number;
  members: number;
  identities: number;
  recognizedAuthors: number;
  unknownAuthors: number;
  zipBytes: number;
  expandedBytes: number;
  attachmentBytes: number;
  finalStorageBytes: number;
  temporaryReservationBytes: number;
  quotaUsedBytes: number;
  quotaLimitBytes: number;
  warnings: Array<{ code: RoomArchiveWarningCode; count: number; sampleKeys: string[] }>;
  preview: Array<{ kind: "human" | "ai"; authorLabel: RoomArchiveAuthorLabel; createdAt: number; bodyExcerpt: string }>;
}

export interface RoomArchiveJob {
  id: string;
  kind: "export" | "import";
  state: RoomArchiveState;
  phase: RoomArchivePhase;
  expiresAt: number;
  cancelRequested: boolean;
  cleanupPending: boolean;
  progress: { unit: RoomArchiveProgressUnit; done: number; total: number | null };
  summary: RoomArchiveSummary | null;
  result: { channelId: string } | null;
  error: { code: RoomArchiveErrorCode } | null;
}

export interface RoomArchiveIdentityRosterItem {
  key: string;
  /** The archive-provided historical name, or null. Never a live display label. */
  historicalName: string | null;
  role: ChannelRole | null;
  /** The current local account name once its proof revalidates; otherwise null. */
  recognizedName: string | null;
}

export interface RoomArchiveRosterPage {
  items: RoomArchiveIdentityRosterItem[];
  nextAfter: string | null;
}

export interface RoomArchiveInspectResult {
  summary: RoomArchiveSummary;
  reviewDigest: string;
}

export type RoomArchiveJobKind = RoomArchiveJob["kind"];
export type RoomArchiveJobState = RoomArchiveState;

/** Hash and key shapes used by the manifest. */
export const isRoomArchiveHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const isRoomArchiveKey = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

/** Whole-room exports are up to 5,000 messages; explicit root selection is capped. */
export const isRoomArchiveSelection = (value: unknown): value is RoomArchiveSelection => {
  if (!value || typeof value !== "object") return false;
  const selection = value as { mode?: unknown; rootIds?: unknown; includeReplies?: unknown };
  if (selection.mode === "all") return Object.keys(value).length === 1;
  if (selection.mode !== "roots") return false;
  if (Object.keys(value).length !== 3) return false;
  return (
    Array.isArray(selection.rootIds) &&
    selection.rootIds.length >= 1 &&
    selection.rootIds.length <= ROOM_ARCHIVE_LIMITS.roots &&
    selection.rootIds.every(isRoomArchiveKey) &&
    typeof selection.includeReplies === "boolean"
  );
};

/** Suggested download name. UTC, server-generated, never user-controlled. */
export function roomArchiveFileName(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `okaychat-room-${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(
    now.getUTCSeconds(),
  )}${ROOM_ARCHIVE_SUFFIX}`;
}

export type RoomArchiveIcon = ChannelIcon;
export type RoomArchiveReaction = ChannelReaction;

/** Manifest value shapes. Every object is strict; unknown fields are rejected by the server validator. */
export interface RoomArchiveIdentity {
  key: string;
  localId: string | null;
  displayName: string | null;
  localProof: string | null;
  email?: string;
}

export interface RoomArchiveMember {
  identityKey: string;
  role: ChannelRole;
  joinedAt: number;
}

export type RoomArchiveQuote = { kind: "message"; messageKey: string } | { kind: "unavailable" } | null;

export interface RoomArchiveMention {
  identityKey: string;
  start: number;
  end: number;
}

export interface RoomArchiveReactionEntry {
  identityKey: string;
  emoji: ChannelReaction;
  createdAt: number;
}

export interface RoomArchiveAttachmentEntry {
  key: string;
  asset: string;
  name: string;
  declaredMime: string;
  createdAt: number;
}

export interface RoomArchiveMessage {
  key: string;
  order: number;
  kind: "human" | "ai";
  authorKey: string | null;
  body: string;
  createdAt: number;
  editedAt: number | null;
  threadRootKey: string | null;
  quote: RoomArchiveQuote;
  mentions: RoomArchiveMention[];
  reactions: RoomArchiveReactionEntry[];
  attachments: RoomArchiveAttachmentEntry[];
}

export interface RoomArchiveAsset {
  key: string;
  size: number;
}

export interface RoomArchiveRoom {
  key: string;
  name: string;
  description: string;
  icon: RoomArchiveIcon;
  visibility: ChannelVisibility;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface RoomArchiveV1 {
  format: typeof ROOM_ARCHIVE_FORMAT;
  version: typeof ROOM_ARCHIVE_VERSION;
  exportedAt: number;
  room: RoomArchiveRoom;
  selection: { mode: "all" | "roots"; includedReplies: boolean };
  identities: RoomArchiveIdentity[];
  members: RoomArchiveMember[];
  messages: RoomArchiveMessage[];
  assets: RoomArchiveAsset[];
}
