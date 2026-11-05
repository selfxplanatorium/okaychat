import { db } from "../db.js";
import { AppError } from "../errors.js";
import { featureAllowed } from "../permissions/guard.js";
import type { ChannelRole, ChannelVisibility } from "../../shared/channels.js";

/**
 * Channel authorization. Every ordinary route, every SSE frame, and every worker dispatch calls these
 * helpers, so a policy or group change revokes access on the next read. Private/group rooms never become
 * discoverable through a global search, a notification, or a room-list filter.
 */

export interface ChannelRow {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  icon: string;
  visibility: ChannelVisibility;
  ai_json: string | null;
  revision: number;
  next_seq: number;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface MemberRow {
  channel_id: string;
  user_id: string;
  role: ChannelRole;
  read_seq: number;
  notify_mode: "all" | "mentions" | "none";
  joined_at: number;
}

export function channelRow(channelId: string): ChannelRow | undefined {
  return db.prepare("SELECT * FROM channels WHERE id = ?").get(channelId) as ChannelRow | undefined;
}

export function memberRow(channelId: string, userId: string): MemberRow | undefined {
  return db.prepare("SELECT * FROM channel_members WHERE channel_id = ? AND user_id = ?").get(channelId, userId) as MemberRow | undefined;
}

export function inviteRow(channelId: string, userId: string): { channel_id: string; user_id: string; created_at: number } | undefined {
  return db.prepare("SELECT channel_id, user_id, created_at FROM channel_invites WHERE channel_id = ? AND user_id = ?").get(channelId, userId) as
    | { channel_id: string; user_id: string; created_at: number }
    | undefined;
}

export function exclusionRow(channelId: string, userId: string): boolean {
  return !!db.prepare("SELECT 1 FROM channel_exclusions WHERE channel_id = ? AND user_id = ?").get(channelId, userId);
}

/** A live account. Deleted accounts cascade, but an in-flight request can still be holding an id. */
export function liveUser(userId: string): boolean {
  return !!db.prepare("SELECT 1 FROM users WHERE id = ?").get(userId);
}

/** Group-scoped rooms narrow even an owner or moderator: leaving the group revokes the room with it. */
export function groupEligible(userId: string, channel: Pick<ChannelRow, "id" | "visibility">): boolean {
  if (channel.visibility !== "group") return true;
  return !!db
    .prepare(
      `SELECT 1 FROM channel_groups g JOIN user_group_members m ON m.group_id = g.group_id
       WHERE g.channel_id = ? AND m.user_id = ?`,
    )
    .get(channel.id, userId);
}

export function channelEligibility(userId: string, channel: Pick<ChannelRow, "id" | "visibility">): boolean {
  return liveUser(userId) && groupEligible(userId, channel);
}

/** The SQL form of eligibility for lists and search. Bind the user id once. */
export const groupEligibleSql = (channelAlias: string) => `(
  ${channelAlias}.visibility <> 'group' OR EXISTS (
    SELECT 1 FROM channel_groups cg
    JOIN user_group_members cgm ON cgm.group_id = cg.group_id
    WHERE cg.channel_id = ${channelAlias}.id AND cgm.user_id = ?
  )
)`;

/** Membership and eligibility, which is what reading message history requires. */
export const memberAccessSql = (channelAlias: string) => `EXISTS (
  SELECT 1 FROM channel_members cm WHERE cm.channel_id = ${channelAlias}.id AND cm.user_id = ?
) AND ${groupEligibleSql(channelAlias)}`;

export interface ChannelAccess {
  channel: ChannelRow;
  member: MemberRow | null;
  eligible: boolean;
  invited: boolean;
}

export function channelAccess(userId: string, channelId: string): ChannelAccess | null {
  const channel = channelRow(channelId);
  if (!channel) return null;
  return {
    channel,
    member: memberRow(channelId, userId) ?? null,
    eligible: channelEligibility(userId, channel),
    invited: !!inviteRow(channelId, userId),
  };
}

/** The feature is account-level. A model denial is a separate check and only after room authorization. */
export function requireChannelsFeature(userId: string): void {
  if (!featureAllowed(userId, "channels")) {
    throw new AppError({
      code: "forbidden",
      message: "Your administrator has disabled team channels for this account.",
      hint: "Ask an administrator to allow it.",
      details: { feature: "channels" },
    });
  }
}

/**
 * A member-only content read. Unknown, ineligible, removed, uninvited private, and misspelled ids all
 * answer the same 404 so an outsider cannot tell a private room from a missing one.
 */
export function assertChannelMember(userId: string, channelId: string): { channel: ChannelRow; member: MemberRow; access: ChannelAccess } {
  requireChannelsFeature(userId);
  const access = channelAccess(userId, channelId);
  if (!access || !access.member || !access.eligible) throw notFound();
  return { channel: access.channel, member: access.member, access };
}

/** Role authorization after membership. A role below the requirement gets a named 403. */
export function assertChannelRole(
  userId: string,
  channelId: string,
  roles: readonly ChannelRole[],
): { channel: ChannelRow; member: MemberRow; access: ChannelAccess } {
  const resolved = assertChannelMember(userId, channelId);
  if (!roles.includes(resolved.member.role)) {
    throw new AppError({ code: "forbidden", message: "Your role in this room does not allow that action." });
  }
  return resolved;
}

/** Writes in an archived room are refused; reads, search, leave, and owner recovery stay allowed. */
export function assertWritable(channel: ChannelRow): void {
  if (channel.archived_at !== null) {
    throw new AppError({ code: "conflict", status: 409, message: "This room is archived.", details: { reason: "archived" } });
  }
}

export function notFound(): AppError {
  return new AppError({ code: "not_found", message: "Room not found." });
}

export function conflict(reason: string, message: string): AppError {
  return new AppError({ code: "conflict", status: 409, message, details: { reason } });
}

export function invalid(message: string, reason?: string): AppError {
  return new AppError({ code: "validation", status: reason ? 422 : 400, message, ...(reason ? { details: { reason } } : {}) });
}

/** The signed-in account's role is live, never cached from the event stream. */
export function accountRole(userId: string): "admin" | "user" | null {
  return (db.prepare("SELECT role FROM users WHERE id = ?").get(userId) as { role: "admin" | "user" } | undefined)?.role ?? null;
}
