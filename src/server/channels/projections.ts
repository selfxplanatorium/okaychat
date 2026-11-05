import { db } from "../db.js";
import type {
  ChannelAiSummary,
  ChannelAttachment,
  ChannelCapabilities,
  ChannelDirectoryEntry,
  ChannelInviteSummary,
  ChannelMemberSummary,
  ChannelMessage,
  ChannelMessageAuthor,
  ChannelQuote,
  ChannelReactionSummary,
  ChannelRole,
  ChannelRunProjection,
  ChannelRunState,
  ChannelSummary,
  ChannelVisibility,
  ChannelReaction,
  ChannelNotifyMode,
} from "../../shared/channels.js";
import { CHANNEL_LIMITS, CHANNEL_REACTIONS, channelAttachmentUrl, isChannelRunState } from "../../shared/channels.js";
import type { ChannelRow, MemberRow } from "./access.js";
import { threadsUnreadCount, threadUnreadByRoot } from "./thread-counts.js";

/** Read-only projections shared by REST, sync, and events. No authorization decision lives here. */

export interface ChannelMessageRow {
  id: string;
  channel_id: string;
  seq: number;
  author_id: string | null;
  kind: "human" | "ai";
  body: string;
  reply_to: string | null;
  thread_root: string | null;
  client_id: string | null;
  request_hash: string | null;
  revision: number;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
}

export interface ChannelRunRow {
  id: string;
  channel_id: string;
  requester_id: string | null;
  source_id: string;
  message_id: string;
  client_id: string;
  model_ref: string;
  config_json: string;
  state: ChannelRunState;
  output_version: number;
  finish_reason: string | null;
  error_code: string | null;
  usage_json: string | null;
  requester_name?: string | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
}

export function parseAi(value: string | null): ChannelAiSummary | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<ChannelAiSummary>;
    if ((parsed.kind === "model" || parsed.kind === "preset") && typeof parsed.modelRef === "string" && typeof parsed.label === "string") {
      return { kind: parsed.kind, label: parsed.label, modelRef: parsed.modelRef };
    }
  } catch {
    // A malformed stored binding behaves like no binding: human chat keeps working.
  }
  return null;
}

export function capabilitiesOf(channel: Pick<ChannelRow, "archived_at" | "ai_json" | "kind">, member: MemberRow | null, eligible: boolean): ChannelCapabilities {
  const present = !!member && eligible;
  // Archive blocks posting and AI, but moderators still need unarchive, removal, and owner transfer.
  const post = present && channel.archived_at === null;
  // A DM is never a room: it has no AI, invites, roles, archive, or audience surface.
  const room = channel.kind !== "dm";
  return {
    post,
    moderate: present && room && (member.role === "owner" || member.role === "moderator"),
    manage: present && room && member.role === "owner",
    requestAi: post && room && !!channel.ai_json,
    attach: post,
    thread: post,
  };
}

export function memberCount(channelId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM channel_members WHERE channel_id = ?").get(channelId) as { n: number }).n;
}

export function unreadCounts(channelId: string, userId: string, readSeq: number): { unread: number; mentionsUnread: number } {
  const unread = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM channel_messages
         WHERE channel_id = ? AND seq > ? AND deleted_at IS NULL AND thread_root IS NULL
           AND (kind = 'ai' OR author_id IS NULL OR author_id <> ?)`,
      )
      .get(channelId, readSeq, userId) as { n: number }
  ).n;
  const mentionsUnread = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM channel_messages m
         JOIN channel_mentions mm ON mm.message_id = m.id
         WHERE m.channel_id = ? AND m.seq > ? AND m.deleted_at IS NULL AND m.thread_root IS NULL
           AND m.kind = 'human' AND m.author_id <> ? AND mm.user_id = ?`,
      )
      .get(channelId, readSeq, userId, userId) as { n: number }
  ).n;
  return { unread, mentionsUnread };
}

export function channelSummary(channel: ChannelRow, member: MemberRow | null, eligible: boolean, userId: string): ChannelSummary {
  const { unread, mentionsUnread } = member ? unreadCounts(channel.id, userId, member.read_seq) : { unread: 0, mentionsUnread: 0 };
  const dm = channel.kind === "dm";
  return {
    id: channel.id,
    name: channel.name,
    description: channel.description,
    icon: channel.icon as ChannelSummary["icon"],
    visibility: channel.visibility,
    ownerId: channel.owner_id,
    archivedAt: channel.archived_at,
    revision: channel.revision,
    createdAt: channel.created_at,
    updatedAt: channel.updated_at,
    membership: member ? { role: member.role, readSeq: member.read_seq, notifyMode: member.notify_mode as ChannelNotifyMode } : null,
    memberCount: memberCount(channel.id),
    unread,
    mentionsUnread,
    ai: parseAi(channel.ai_json),
    capabilities: capabilitiesOf(channel, member, eligible),
    kind: dm ? "dm" : "room",
    dmMembers: dm ? dmMembersOf(channel.id) : null,
    threadsUnread: member ? threadsUnreadCount(channel.id, userId) : 0,
  };
}

/** DM members for the title and header. Names only; bounded by the DM member cap. */
export function dmMembersOf(channelId: string): ChannelMessageAuthor[] {
  return db
    .prepare(
      `SELECT u.id, u.name FROM channel_members m JOIN users u ON u.id = m.user_id
       WHERE m.channel_id = ? ORDER BY m.joined_at, m.user_id LIMIT ?`,
    )
    .all(channelId, CHANNEL_LIMITS.dmMembers) as unknown as ChannelMessageAuthor[];
}

export function directoryEntry(channel: ChannelRow, joinable: boolean, invited: boolean): ChannelDirectoryEntry {
  return {
    id: channel.id,
    name: channel.name,
    description: channel.description,
    icon: channel.icon as ChannelDirectoryEntry["icon"],
    visibility: channel.visibility,
    archivedAt: channel.archived_at,
    revision: channel.revision,
    createdAt: channel.created_at,
    updatedAt: channel.updated_at,
    joinable,
    invited,
    aiLabel: parseAi(channel.ai_json)?.label ?? null,
  };
}

export function inviteSummary(row: {
  channel_id: string;
  name: string;
  description: string;
  icon: string;
  visibility: ChannelVisibility;
  invited_at: number;
  invited_by: string | null;
}): ChannelInviteSummary {
  return {
    channelId: row.channel_id,
    name: row.name,
    description: row.description,
    icon: row.icon as ChannelInviteSummary["icon"],
    visibility: row.visibility,
    invitedAt: row.invited_at,
    invitedBy: row.invited_by,
  };
}

export function authorOf(id: string | null): ChannelMessageAuthor | null {
  if (!id) return null;
  return (db.prepare("SELECT id, name FROM users WHERE id = ?").get(id) as ChannelMessageAuthor | undefined) ?? null;
}

const plain = (body: string) => body.replace(/\s+/gu, " ").trim();
const excerpt = (body: string) => [...plain(body)].slice(0, 160).join("");

function quoteOf(id: string | null, channelId: string): ChannelQuote | null {
  if (!id) return null;
  const row = db
    .prepare("SELECT id, seq, author_id, body, deleted_at FROM channel_messages WHERE channel_id = ? AND id = ?")
    .get(channelId, id) as { id: string; seq: number; author_id: string | null; body: string; deleted_at: number | null } | undefined;
  if (!row) return { id, seq: 0, authorName: null, excerpt: "", deleted: true };
  return {
    id: row.id,
    seq: row.seq,
    authorName: authorOf(row.author_id)?.name ?? null,
    excerpt: row.deleted_at === null ? excerpt(row.body) : "",
    deleted: row.deleted_at !== null,
  };
}

function reactionsOf(messageId: string, userId: string, deleted: boolean): ChannelReactionSummary[] {
  if (deleted) return [];
  const rows = db
    .prepare("SELECT emoji, COUNT(*) AS count, MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS mine FROM channel_reactions WHERE message_id = ? GROUP BY emoji")
    .all(userId, messageId) as Array<{ emoji: string; count: number; mine: number }>;
  const found = new Map(rows.map((row) => [row.emoji, row]));
  return CHANNEL_REACTIONS.filter((emoji) => found.has(emoji)).map((emoji) => {
    const row = found.get(emoji)!;
    return { emoji: emoji as ChannelReaction, count: row.count, mine: row.mine === 1 };
  });
}

export function runProjection(row: ChannelRunRow | undefined): ChannelRunProjection | null {
  if (!row) return null;
  return {
    id: row.id,
    messageId: row.message_id,
    sourceId: row.source_id,
    state: isChannelRunState(row.state) ? row.state : "failed",
    outputVersion: row.output_version,
    finishReason: row.finish_reason,
    errorCode: row.error_code,
    requesterId: row.requester_id,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    usageReported: row.usage_json !== null,
  };
}

function mentionsOf(messageId: string): Array<{ userId: string; start: number; end: number }> {
  return (
    db.prepare("SELECT user_id AS userId, start_offset AS start, end_offset AS end FROM channel_mentions WHERE message_id = ? ORDER BY start_offset").all(messageId) as Array<{
      userId: string;
      start: number;
      end: number;
    }>
  );
}

export function attachmentProjection(row: {
  id: string;
  channel_id: string;
  name: string;
  mime: string;
  size: number;
  file: 0 | 1;
  width: number | null;
  height: number | null;
}): ChannelAttachment {
  return {
    id: row.id,
    name: row.name,
    mime: row.mime,
    size: row.size,
    width: row.width,
    height: row.height,
    image: row.file === 1,
    url: channelAttachmentUrl(row.channel_id, row.id),
  };
}

/** One page of messages, best-first input order is preserved. */
export function projectMessages(rows: ChannelMessageRow[], userId: string): ChannelMessage[] {
  if (!rows.length) return [];
  const runRows = db
    .prepare(
      `SELECT r.*, u.name AS requester_name FROM channel_ai_runs r LEFT JOIN users u ON u.id = r.requester_id
       WHERE r.message_id IN (${rows.map(() => "?").join(",")})`,
    )
    .all(...rows.map((row) => row.id)) as unknown as ChannelRunRow[];
  const runs = new Map(runRows.map((row) => [row.message_id, row]));

  const rootIds = rows.filter((row) => row.thread_root === null).map((row) => row.id);
  const threadRows = rootIds.length
    ? (db.prepare(`SELECT * FROM channel_thread_state WHERE root_id IN (${rootIds.map(() => "?").join(",")})`).all(...rootIds) as Array<{
        root_id: string;
        reply_count: number;
        last_seq: number;
        last_at: number;
        last_author_id: string | null;
      }>)
    : [];
  const threads = new Map(threadRows.map((row) => [row.root_id, row]));
  const unread = threadUnreadByRoot(rows[0]!.channel_id, userId, rootIds);

  const attachmentRows = db
    .prepare(
      `SELECT id, channel_id, message_id, name, mime, size, file, width, height FROM channel_attachments
       WHERE message_id IN (${rows.map(() => "?").join(",")}) ORDER BY id`,
    )
    .all(...rows.map((row) => row.id)) as Array<{
    id: string;
    channel_id: string;
    message_id: string;
    name: string;
    mime: string;
    size: number;
    file: 0 | 1;
    width: number | null;
    height: number | null;
  }>;
  const attachments = new Map<string, ChannelAttachment[]>();
  for (const row of attachmentRows) {
    const list = attachments.get(row.message_id) ?? [];
    list.push(attachmentProjection(row));
    attachments.set(row.message_id, list);
  }

  return rows.map((row) => {
    const run = runs.get(row.id);
    const deleted = row.deleted_at !== null;
    const aiConfig = run ? (JSON.parse(run.config_json) as { binding?: { label?: string }; injectionFlagged?: boolean }) : null;
    const state = row.thread_root === null && !deleted ? threads.get(row.id) : undefined;
    return {
      id: row.id,
      channelId: row.channel_id,
      seq: row.seq,
      kind: row.kind,
      author: deleted ? null : authorOf(row.author_id),
      body: deleted ? "" : row.body,
      replyTo: deleted ? null : quoteOf(row.reply_to, row.channel_id),
      mentions: deleted ? [] : mentionsOf(row.id),
      reactions: reactionsOf(row.id, userId, deleted),
      revision: row.revision,
      createdAt: row.created_at,
      editedAt: row.edited_at,
      deletedAt: row.deleted_at,
      aiRun: runProjection(run),
      ...(row.kind === "ai" ? { aiLabel: aiConfig?.binding?.label ?? null, aiRequester: run?.requester_id ? authorOf(run.requester_id) : null, injectionFlagged: aiConfig?.injectionFlagged === true } : {}),
      threadRootId: row.thread_root,
      thread: state
        ? { replyCount: state.reply_count, lastReplySeq: state.last_seq, lastReplyAt: state.last_at, unread: unread.get(row.id) ?? 0 }
        : null,
      attachments: deleted ? [] : (attachments.get(row.id) ?? []),
    };
  });
}

export function memberSummary(row: { id: string; name: string; role: ChannelRole }): ChannelMemberSummary {
  return { id: row.id, name: row.name, role: row.role };
}
