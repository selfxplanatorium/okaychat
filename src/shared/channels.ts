/**
 * Team channels: named shared rooms with membership, moderation, text messages, reactions, resumable
 * events, search, and explicitly requested AI replies. This module is pure: constants and wire shapes
 * shared by the server and the web app.
 *
 * Channels are a separate aggregate. A room is never a private chat thread, so no thread, message,
 * upload, artifact, memory, knowledge, or share row belongs to one.
 */

export const CHANNEL_VISIBILITIES = ["public", "private", "group"] as const;
export type ChannelVisibility = (typeof CHANNEL_VISIBILITIES)[number];

/** A room is the shared surface; a DM is a member-only conversation stored as a channel row. */
export const CHANNEL_KINDS = ["room", "dm"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export const CHANNEL_ROLES = ["owner", "moderator", "member"] as const;
export type ChannelRole = (typeof CHANNEL_ROLES)[number];

/** A fixed icon key. No remote or user-supplied icon is ever fetched or rendered. */
export const CHANNEL_ICONS = ["hash", "messages-square", "users", "megaphone", "book-open", "code", "lightbulb", "coffee"] as const;
export type ChannelIcon = (typeof CHANNEL_ICONS)[number];

/** The six supported reactions, in menu order. */
export const CHANNEL_REACTIONS = ["👍", "❤️", "🎉", "😄", "👀", "✅"] as const;
export type ChannelReaction = (typeof CHANNEL_REACTIONS)[number];

export const CHANNEL_NOTIFY_MODES = ["all", "mentions", "none"] as const;
export type ChannelNotifyMode = (typeof CHANNEL_NOTIFY_MODES)[number];

export const CHANNEL_RUN_STATES = ["queued", "running", "finished", "cancelled", "failed", "interrupted"] as const;
export type ChannelRunState = (typeof CHANNEL_RUN_STATES)[number];

export const CHANNEL_EVENT_KINDS = ["channel.changed", "message.changed", "members.changed", "read.changed", "sync"] as const;
export type ChannelEventKind = (typeof CHANNEL_EVENT_KINDS)[number];

/** Hard limits, enforced server-side and mirrored in controls. */
export const CHANNEL_LIMITS = {
  roomsTotal: 1_000,
  roomsOwned: 50,
  roomsJoined: 100,
  invitations: 100,
  members: 200,
  invitesPerRoom: 200,
  groupsPerRoom: 20,
  nameChars: 80,
  descriptionChars: 2_000,
  descriptionBytes: 8 * 1024,
  bodyChars: 8_000,
  bodyBytes: 32 * 1024,
  messagesPerRoom: 100_000,
  mentions: 20,
  reactionsPerUser: 3,
  reactionUsers: 200,
  aiContextBytes: 48 * 1024,
  aiContextMessages: 60,
  aiOutputBytes: 64 * 1024,
  aiOutputTokens: 4_096,
  aiQueue: 20,
  aiActive: 2,
  aiQueueTtlMs: 60_000,
  aiDeadlineMs: 120_000,
  /** Ordinary JSON body ceiling; PATCH /channels/:id may bind AI settings and uses the larger value. */
  requestBytes: 48 * 1024,
  aiRequestBytes: 128 * 1024,
  historyPage: 100,
  listPage: 50,
  searchPage: 50,
  searchQueryChars: 200,
  channelQueryChars: 100,
  eventPage: 200,
  eventScan: 1_000,
  eventRetentionMs: 24 * 60 * 60 * 1000,
  eventMaxRows: 100_000,
  createKeyMs: 24 * 60 * 60 * 1000,
  createKeysMax: 100,
  auditRetentionMs: 90 * 24 * 60 * 60 * 1000,
  auditMaxRows: 10_000,
  reasonChars: 500,
  /** One attachment's bytes; the upload router enforces the same cap with its own body limit. */
  attachmentBytes: 10 * 1024 * 1024,
  attachmentsPerMessage: 5,
  attachmentNameChars: 200,
  attachmentsPerRoom: 2_000,
  attachmentPendingPerUser: 20,
  attachmentPendingMs: 60 * 60 * 1000,
  /** Tombstoned attachments keep their bytes this long so an undo-style restore never loses them. */
  attachmentRetentionMs: 30 * 24 * 60 * 60 * 1000,
  threadReplies: 500,
  threadPage: 50,
  dmMembers: 8,
  dmsOwned: 50,
  dmsJoined: 200,
  peopleQueryChars: 200,
  dmBlockedMax: 500,
} as const;

export interface ChannelMembershipView {
  role: ChannelRole;
  readSeq: number;
  notifyMode: ChannelNotifyMode;
}

export interface ChannelCapabilities {
  post: boolean;
  moderate: boolean;
  manage: boolean;
  requestAi: boolean;
  /** Post with attachments (post && not archived). */
  attach: boolean;
  /** Post into a thread (post && not archived). Reading a thread needs no capability. */
  thread: boolean;
}

/** Public binding summary. Instructions and sampling are detail-only and never sent to ordinary readers. */
export interface ChannelAiSummary {
  kind: "model" | "preset";
  label: string;
  modelRef: string;
}

export interface ChannelAiBinding extends ChannelAiSummary {
  /** Present only for a reduced preset snapshot; capped at 16 KiB by the server. */
  instructions?: string;
  reasoningEffort?: string;
  sampling?: { temperature?: number; topP?: number; maxOutputTokens?: number };
}

export interface ChannelSummary {
  id: string;
  name: string;
  description: string;
  icon: ChannelIcon;
  visibility: ChannelVisibility;
  ownerId: string;
  archivedAt: number | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  membership: ChannelMembershipView | null;
  memberCount: number;
  unread: number;
  mentionsUnread: number;
  ai: ChannelAiSummary | null;
  capabilities: ChannelCapabilities;
  kind: ChannelKind;
  /** DM only: the other members (owner included), bounded by CHANNEL_LIMITS.dmMembers, id+name only. */
  dmMembers: ChannelMessageAuthor[] | null;
  /** Rooms with at least one unread thread reply (see docs/implementation/channels.md). */
  threadsUnread: number;
  /** Null for a native room; imported rooms carry the source metadata for display only. */
  imported?: ChannelImportedMeta | null;
}

/** What an eligible nonmember or invitee may see. No counts, owner id, members, history, or AI settings. */
export interface ChannelDirectoryEntry {
  id: string;
  name: string;
  description: string;
  icon: ChannelIcon;
  visibility: ChannelVisibility;
  archivedAt: number | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  joinable: boolean;
  invited: boolean;
  aiLabel: string | null;
}

export interface ChannelMemberSummary {
  id: string;
  name: string;
  role: ChannelRole;
}

export interface ChannelInviteSummary {
  channelId: string;
  name: string;
  description: string;
  icon: ChannelIcon;
  visibility: ChannelVisibility;
  invitedAt: number;
  invitedBy: string | null;
}

export interface ChannelMessageAuthor {
  id: string;
  name: string;
}

/**
 * A historical author is deliberately discriminated: a recognized local account is the only case that
 * carries an id and a live name. Everything else is neutral and translated by the client, so an
 * archive-controlled display name can never look like a live account label.
 */
export type ChannelHistoricalAuthor = { kind: "known"; id: string; name: string } | { kind: "unknown" };

export interface ChannelHistoricalMention {
  start: number;
  end: number;
  author: ChannelHistoricalAuthor;
}

/** Read-only counts from the archive. They never join live reactions or notify anyone. */
export interface ChannelHistoricalReaction {
  emoji: ChannelReaction;
  count: number;
}

/** Source room metadata kept for display only; it never becomes live settings. */
export interface ChannelImportedMeta {
  sourceCreatedAt: number;
  sourceUpdatedAt: number;
  sourceArchivedAt: number | null;
  sourceVisibility: ChannelVisibility;
  importedAt: number;
}

export interface ChannelQuote {
  id: string;
  seq: number;
  authorName: string | null;
  /** Present for an imported target author; the neutral/recognized rules match the timeline. */
  author?: ChannelHistoricalAuthor | null;
  excerpt: string;
  deleted: boolean;
}

export interface ChannelReactionSummary {
  emoji: ChannelReaction;
  count: number;
  mine: boolean;
}

export interface ChannelAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  /** Raster the browser can preview (png/jpeg/webp/gif/avif). */
  image: boolean;
  /** App-owned, authorization-checked on every request. Never a storage path. */
  url: string;
}

export interface ChannelThreadSummary {
  replyCount: number;
  lastReplySeq: number;
  lastReplyAt: number;
  /** Replies after this viewer's thread cursor, excluding their own. */
  unread: number;
}

export interface ChannelThreadPage {
  root: ChannelMessage;
  items: ChannelMessage[];
  /** The reply the caller asked for, when the requested id was a reply. */
  focusId: string | null;
  nextBeforeSeq: number | null;
  hasMore: boolean;
  readSeq: number;
  replyCount: number;
  channelRevision: number;
  cursor: string;
}

export interface ChannelDmBlock {
  id: string;
  name: string;
}

/** The app-owned URL of one channel attachment. Pure, shared by the server projection and the web. */
export const channelAttachmentUrl = (channelId: string, attachmentId: string): string =>
  `/api/channels/${encodeURIComponent(channelId)}/attachments/${encodeURIComponent(attachmentId)}`;

export interface ChannelRunProjection {
  id: string;
  messageId: string;
  sourceId: string;
  state: ChannelRunState;
  outputVersion: number;
  finishReason: string | null;
  errorCode: string | null;
  requesterId: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  /** False when the provider reported no usage; the UI then says so instead of showing zero. */
  usageReported: boolean;
}

export interface ChannelMessage {
  id: string;
  channelId: string;
  seq: number;
  kind: "human" | "ai";
  author: ChannelMessageAuthor | null;
  body: string;
  replyTo: ChannelQuote | null;
  mentions: Array<{ userId: string; start: number; end: number }>;
  reactions: ChannelReactionSummary[];
  revision: number;
  createdAt: number;
  editedAt: number | null;
  deletedAt: number | null;
  aiRun: ChannelRunProjection | null;
  /** Display label for an AI message, resolved from the run's frozen binding summary. */
  aiLabel?: string | null;
  /** The requester, shown only while that account still exists. */
  aiRequester?: ChannelMessageAuthor | null;
  /** Advisory scanner result for the frozen input; never a security guarantee. */
  injectionFlagged?: boolean;
  threadRootId: string | null;
  thread: ChannelThreadSummary | null;
  attachments: ChannelAttachment[];
  /** Server-derived: this row came from an archive and has no native author or edit rights. */
  imported?: boolean;
  /** Imported author projection. Never grants "mine", edit rights, or presence. */
  historicalAuthor?: ChannelHistoricalAuthor | null;
  historicalMentions?: ChannelHistoricalMention[];
  historicalReactions?: ChannelHistoricalReaction[];
}

/** One historical participant in the separate "Imported roster" view. */
export interface ChannelImportedRosterEntry {
  key: string;
  author: ChannelHistoricalAuthor;
  role: ChannelRole;
  joinedAt: number;
}

export interface ChannelImportedRosterPage {
  items: ChannelImportedRosterEntry[];
  nextAfter: string | null;
}

export interface ChannelMessagePage {
  items: ChannelMessage[];
  nextBeforeSeq: number | null;
  nextAfterSeq: number | null;
  hasMore: boolean;
  cursor: string;
  channelRevision: number;
}

/** Durable events are invalidations, never body deltas. */
export interface ChannelEvent {
  type: ChannelEventKind;
  channelId?: string;
  entityId?: string;
  version?: number;
  /** Thread root for a reply invalidation or a thread read. */
  rootId?: string;
}

export interface ChannelEventFrame {
  cursor: string;
  event: ChannelEvent;
}

export interface ChannelChangesPage {
  events: ChannelEventFrame[];
  cursor: string;
  hasMore: boolean;
  reset: false;
}

export interface ChannelChangesReset {
  reset: true;
  reason: "history_expired";
}

export interface ChannelSync {
  items: ChannelSummary[];
  invites: ChannelInviteSummary[];
  cursor: string;
}

export interface ChannelSearchHit {
  channelId: string;
  messageId: string;
  seq: number;
  snippet: string;
  /** Set when the hit is a thread reply; the client opens that thread. */
  threadRootId: string | null;
}

export interface ChannelSearchPage {
  items: ChannelSearchHit[];
  nextCursor: string | null;
}

/** Request bodies the client sends. Kept here so the server and the web app cannot drift. */
export interface CreateChannelInput {
  clientId: string;
  name: string;
  description?: string;
  icon?: ChannelIcon;
  visibility: ChannelVisibility;
  groupIds?: string[];
  ai?: ChannelAiBinding | null;
}

export interface ChannelBindingInput {
  kind: "model" | "preset";
  modelRef?: string;
  presetId?: string;
  /** Required for a preset: the owner explicitly accepted the reduced snapshot notice. */
  confirmReduced?: boolean;
}

export interface ChannelMentionInput {
  userId: string;
  start: number;
  end: number;
}

export interface PostChannelMessageInput {
  clientId: string;
  body: string;
  replyTo?: string;
  threadRootId?: string;
  mentions?: ChannelMentionInput[];
  attachmentIds?: string[];
  requestAi?: boolean;
}

export interface CreateDmInput {
  clientId: string;
  /** The other members; 1..dmMembers-1. */
  userIds: string[];
}

export const isChannelKind = (value: string): value is ChannelKind => (CHANNEL_KINDS as readonly string[]).includes(value);

export const isChannelReaction = (value: string): value is ChannelReaction => (CHANNEL_REACTIONS as readonly string[]).includes(value);
export const isChannelVisibility = (value: string): value is ChannelVisibility => (CHANNEL_VISIBILITIES as readonly string[]).includes(value);
export const isChannelIcon = (value: string): value is ChannelIcon => (CHANNEL_ICONS as readonly string[]).includes(value);
export const isChannelRole = (value: string): value is ChannelRole => (CHANNEL_ROLES as readonly string[]).includes(value);
export const isChannelNotifyMode = (value: string): value is ChannelNotifyMode => (CHANNEL_NOTIFY_MODES as readonly string[]).includes(value);
export const isChannelRunState = (value: string): value is ChannelRunState => (CHANNEL_RUN_STATES as readonly string[]).includes(value);
