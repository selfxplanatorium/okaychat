import { db, tx } from "../db.js";
import { newId } from "../crypto.js";
import { AppError } from "../errors.js";
import { assertStorage } from "../quota.js";
import { CHANNEL_LIMITS } from "../../shared/channels.js";
import type { ChannelAiBinding, ChannelMentionInput } from "../../shared/channels.js";
import { channelRow, conflict, exclusionRow, groupEligible, inviteRow, memberRow, notFound, type ChannelRow, type MemberRow } from "./access.js";
import { insertEvent, insertSync } from "./events.js";
import { chargeRate } from "./rate.js";
import { notifyAiFinished, notifyHumanMessage, notifyInvite, purgeMessageNotices } from "./notifications.js";
import { markChannelNoticesReadThrough, purgeChannelNotices } from "../notifications.js";
import { assertBody, assertDescription, assertName, assertReason, normalizeMentions, requestHash } from "./schema.js";

/** Synchronous channel transactions. Async orchestration (model calls, SSE) lives in routes/worker/events. */

export interface StoreResult<T> {
  value: T;
  replay: boolean;
}

export interface CreateChannelStoreInput {
  clientId: string;
  name: string;
  description: string;
  icon: string;
  visibility: "public" | "private" | "group";
  groupIds: string[];
  aiJson: string | null;
  requestHash: string;
}

const bytesOf = (value: string | null | undefined) => Buffer.byteLength(value ?? "", "utf8");

function touchActivity(channelId: string, at: number): void {
  db.prepare("UPDATE channels SET updated_at = ? WHERE id = ?").run(at, channelId);
}

function bumpRevision(channelId: string): number {
  db.prepare("UPDATE channels SET revision = revision + 1 WHERE id = ?").run(channelId);
  return (db.prepare("SELECT revision FROM channels WHERE id = ?").get(channelId) as { revision: number }).revision;
}

function assertChannelRevision(channel: ChannelRow, revision: number): void {
  if (channel.revision !== revision) throw conflict("revision", "This room changed. Reload and try again.");
}

function allocateSeq(channelId: string): number {
  const row = db.prepare("SELECT next_seq FROM channels WHERE id = ?").get(channelId) as { next_seq: number } | undefined;
  if (!row) throw notFound();
  if (row.next_seq >= Number.MAX_SAFE_INTEGER) throw conflict("capacity", "This room has reached its message limit.");
  const seq = row.next_seq;
  db.prepare("UPDATE channels SET next_seq = ? WHERE id = ?").run(seq + 1, channelId);
  return seq;
}

function assertMessageCapacity(channelId: string): void {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM channel_messages WHERE channel_id = ?").get(channelId) as { n: number };
  if (n >= CHANNEL_LIMITS.messagesPerRoom) throw conflict("capacity", "This room has reached its message limit.");
}

/** Input limits for a room name/description/groups. */
export function validateRoomFields(name: string, description: string | undefined, icon: string, visibility: "public" | "private" | "group", groupIds: string[]): {
  name: string;
  description: string;
  icon: string;
  groupIds: string[];
} {
  const cleanName = assertName(name);
  const cleanDescription = assertDescription(description);
  if (visibility === "group" && groupIds.length === 0) throw new AppError({ code: "validation", status: 422, message: "Choose at least one group for this room." });
  if (visibility !== "group" && groupIds.length) throw new AppError({ code: "validation", status: 422, message: "Only group rooms have a group audience." });
  if (new Set(groupIds).size !== groupIds.length) throw new AppError({ code: "validation", status: 422, message: "A group is listed twice." });
  return { name: cleanName, description: cleanDescription, icon, groupIds };
}

export function assertGroupsOwnedBy(userId: string, groupIds: string[]): void {
  for (const groupId of groupIds) {
    if (!db.prepare("SELECT 1 FROM user_groups WHERE id = ?").get(groupId)) throw new AppError({ code: "validation", status: 422, message: "A chosen group no longer exists." });
    if (!db.prepare("SELECT 1 FROM user_group_members WHERE group_id = ? AND user_id = ?").get(groupId, userId)) {
      throw new AppError({ code: "forbidden", message: "You can only use groups you belong to." });
    }
  }
}

/** Admin audience edits may choose any live group. */
export function assertGroupsExist(groupIds: string[]): void {
  for (const groupId of groupIds) {
    if (!db.prepare("SELECT 1 FROM user_groups WHERE id = ?").get(groupId)) throw new AppError({ code: "validation", status: 422, message: "A chosen group no longer exists." });
  }
}

function roomCounts(userId: string): { total: number; owned: number; joined: number; invites: number } {
  const total = (db.prepare("SELECT COUNT(*) AS n FROM channels").get() as { n: number }).n;
  const owned = (db.prepare("SELECT COUNT(*) AS n FROM channels WHERE owner_id = ?").get(userId) as { n: number }).n;
  const joined = (db.prepare("SELECT COUNT(*) AS n FROM channel_members WHERE user_id = ?").get(userId) as { n: number }).n;
  const invites = (db.prepare("SELECT COUNT(*) AS n FROM channel_invites WHERE user_id = ?").get(userId) as { n: number }).n;
  return { total, owned, joined, invites };
}

function pruneCreateKeys(userId: string, now: number): number {
  db.prepare("DELETE FROM channel_create_keys WHERE user_id = ? AND created_at < ?").run(userId, now - CHANNEL_LIMITS.createKeyMs);
  return (db.prepare("SELECT COUNT(*) AS n FROM channel_create_keys WHERE user_id = ?").get(userId) as { n: number }).n;
}

export function createChannel(userId: string, input: CreateChannelStoreInput): StoreResult<ChannelRow> {
  return tx(() => {
    const fields = validateRoomFields(input.name, input.description, input.icon, input.visibility, input.groupIds);
    const now = Date.now();
    const existing = db.prepare("SELECT * FROM channel_create_keys WHERE user_id = ? AND client_id = ?").get(userId, input.clientId) as
      | { channel_id: string | null; request_hash: string; created_at: number }
      | undefined;
    if (existing && existing.created_at >= now - CHANNEL_LIMITS.createKeyMs) {
      if (existing.request_hash !== input.requestHash) throw conflict("capacity", "That request id was already used for a different room.");
      if (!existing.channel_id) throw new AppError({ code: "not_found", status: 410, message: "That earlier room was deleted. Start a new request." });
      const replay = channelRow(existing.channel_id);
      if (replay) return { value: replay, replay: true };
    }
    const liveKeys = pruneCreateKeys(userId, now);
    if (liveKeys >= CHANNEL_LIMITS.createKeysMax) throw conflict("capacity", "Too many recent room creations. Wait before creating another.");
    // Room metadata is the owner's content from the first write, before any message exists.
    assertStorage(userId, bytesOf(fields.name) + bytesOf(fields.description) + bytesOf(input.aiJson));
    const counts = roomCounts(userId);
    if (counts.total >= CHANNEL_LIMITS.roomsTotal) throw conflict("capacity", "This server has reached its room limit.");
    if (counts.owned >= CHANNEL_LIMITS.roomsOwned) throw conflict("capacity", `You can own at most ${CHANNEL_LIMITS.roomsOwned} rooms.`);
    if (counts.joined >= CHANNEL_LIMITS.roomsJoined) throw conflict("capacity", `You can join at most ${CHANNEL_LIMITS.roomsJoined} rooms.`);
    chargeRate(userId, "create");
    const id = newId("chn");
    db.prepare(
      `INSERT INTO channels (id, owner_id, name, description, icon, visibility, ai_json, revision, next_seq, archived_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, NULL, ?, ?)`,
    ).run(id, userId, fields.name, fields.description, fields.icon, input.visibility, input.aiJson, now, now);
    db.prepare("INSERT INTO channel_members (channel_id, user_id, role, read_seq, notify_mode, joined_at) VALUES (?, ?, 'owner', 0, 'mentions', ?)").run(id, userId, now);
    for (const groupId of fields.groupIds) db.prepare("INSERT INTO channel_groups (channel_id, group_id) VALUES (?, ?)").run(id, groupId);
    db.prepare("INSERT INTO channel_create_keys (user_id, client_id, channel_id, request_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(
      userId,
      input.clientId,
      id,
      input.requestHash,
      now,
    );
    audit(userId, id, "create", null, "");
    insertEvent({ channelId: id, kind: "channel.changed", entityId: id, version: 1 });
    return { value: channelRow(id)!, replay: false };
  });
}

export function updateChannel(
  userId: string,
  channelId: string,
  input: { revision: number; name?: string; description?: string; icon?: string; groupIds?: string[]; aiJson?: string | null },
  options: { admin: boolean },
): ChannelRow {
  return tx(() => {
    const channel = channelRow(channelId);
    if (!channel) throw notFound();
    assertChannelRevision(channel, input.revision);
    const groupIds = input.groupIds ?? groupIdsOf(channelId);
    const nextVisibility = channel.visibility;
    if (nextVisibility === "group" && groupIds.length === 0) throw new AppError({ code: "validation", status: 422, message: "Choose at least one group for this room." });
    const fields = validateRoomFields(input.name ?? channel.name, input.description ?? channel.description, input.icon ?? channel.icon, nextVisibility, groupIds);
    if (options.admin) assertGroupsExist(fields.groupIds);
    else assertGroupsOwnedBy(userId, fields.groupIds);
    chargeRate(userId, "membership");
    const bindingChanged = input.aiJson !== undefined && input.aiJson !== channel.ai_json;
    if (bindingChanged && openRun(channelId)) throw conflict("ai_busy", "Stop the running reply before changing the AI binding.");
    const nextAi = input.aiJson === undefined ? channel.ai_json : input.aiJson;
    const metadataDelta =
      bytesOf(fields.name) + bytesOf(fields.description) + bytesOf(nextAi) -
      (bytesOf(channel.name) + bytesOf(channel.description) + bytesOf(channel.ai_json));
    if (metadataDelta > 0) assertStorage(channel.owner_id, metadataDelta);
    db.prepare("UPDATE channels SET name = ?, description = ?, icon = ?, ai_json = ? WHERE id = ?").run(
      fields.name,
      fields.description,
      fields.icon,
      input.aiJson === undefined ? channel.ai_json : input.aiJson,
      channelId,
    );
    if (input.groupIds !== undefined) {
      db.prepare("DELETE FROM channel_groups WHERE channel_id = ?").run(channelId);
      for (const groupId of fields.groupIds) db.prepare("INSERT INTO channel_groups (channel_id, group_id) VALUES (?, ?)").run(channelId, groupId);
    }
    const revision = bumpRevision(channelId);
    audit(userId, channelId, "update", null, "");
    // A group audience change can grant or revoke access for people who are not in this room yet.
    if (input.groupIds !== undefined) insertSync();
    insertEvent({ channelId, kind: "channel.changed", entityId: channelId, version: revision });
    return channelRow(channelId)!;
  });
}

export function groupIdsOf(channelId: string): string[] {
  return (db.prepare("SELECT group_id FROM channel_groups WHERE channel_id = ? ORDER BY group_id").all(channelId) as Array<{ group_id: string }>).map((row) => row.group_id);
}

export function archiveChannel(userId: string, channelId: string, revision: number, archived: boolean): ChannelRow {
  return tx(() => {
    const channel = channelRow(channelId);
    if (!channel) throw notFound();
    assertChannelRevision(channel, revision);
    chargeRate(userId, "membership");
    db.prepare("UPDATE channels SET archived_at = ? WHERE id = ?").run(archived ? Date.now() : null, channelId);
    const next = bumpRevision(channelId);
    audit(userId, channelId, archived ? "archive" : "unarchive", null, "");
    insertEvent({ channelId, kind: "channel.changed", entityId: channelId, version: next });
    return channelRow(channelId)!;
  });
}

/** Hard cleanup. FTS, events, mentions, reactions, invites, and notices follow their foreign keys. */
export function deleteChannel(userId: string, channelId: string, revision: number, reason: string): void {
  tx(() => {
    const channel = channelRow(channelId);
    if (!channel) throw notFound();
    assertChannelRevision(channel, revision);
    db.prepare("UPDATE channel_create_keys SET channel_id = NULL WHERE channel_id = ?").run(channelId);
    db.prepare("DELETE FROM channel_ai_runs WHERE channel_id = ?").run(channelId);
    db.prepare("DELETE FROM channels WHERE id = ?").run(channelId);
    audit(userId, channelId, "delete", null, reason);
    // The room is gone, so the invalidation has no private metadata and reaches every client.
    insertSync();
  });
}

export function transferOwner(userId: string, channelId: string, revision: number, targetId: string): ChannelRow {
  return tx(() => {
    const channel = channelRow(channelId);
    if (!channel) throw notFound();
    assertChannelRevision(channel, revision);
    const target = memberRow(channelId, targetId);
    if (!target) throw new AppError({ code: "validation", status: 422, message: "Choose a current member." });
    if (!groupEligible(targetId, channel)) throw conflict("owner_transfer_required", "That member no longer has access to this room.");
    if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get(targetId)) throw new AppError({ code: "validation", status: 422, message: "That account no longer exists." });
    // The new owner pays for every byte this room stores, so the transfer checks the target's limit first.
    assertStorage(targetId, channelStorageBytes(channelId));
    chargeRate(userId, "membership");
    // Demote the current owner, not the caller: an admin transfer is made by a non-owner.
    db.prepare("UPDATE channel_members SET role = 'moderator' WHERE channel_id = ? AND role = 'owner' AND user_id <> ?").run(channelId, targetId);
    db.prepare("UPDATE channel_members SET role = 'owner' WHERE channel_id = ? AND user_id = ?").run(channelId, targetId);
    db.prepare("UPDATE channels SET owner_id = ? WHERE id = ?").run(targetId, channelId);
    const next = bumpRevision(channelId);
    audit(userId, channelId, "transfer", targetId, "");
    insertEvent({ channelId, kind: "members.changed", entityId: targetId, version: next });
    return channelRow(channelId)!;
  });
}

export function setMemberRole(userId: string, channelId: string, revision: number, targetId: string, role: "moderator" | "member"): void {
  tx(() => {
    const channel = channelRow(channelId);
    if (!channel) throw notFound();
    assertChannelRevision(channel, revision);
    const target = memberRow(channelId, targetId);
    if (!target) throw notFound();
    if (target.role === "owner") throw conflict("owner_transfer_required", "Transfer ownership instead of changing the owner's role.");
    chargeRate(userId, "membership");
    db.prepare("UPDATE channel_members SET role = ? WHERE channel_id = ? AND user_id = ?").run(role, channelId, targetId);
    const next = bumpRevision(channelId);
    audit(userId, channelId, "role", targetId, role);
    insertEvent({ channelId, kind: "members.changed", entityId: targetId, version: next });
  });
}

export function joinChannel(userId: string, channelId: string): StoreResult<MemberRow> {
  return tx(() => {
    const channel = channelRow(channelId);
    if (!channel) throw notFound();
    if (channel.visibility === "private") throw notFound();
    if (channel.archived_at !== null) throw conflict("archived", "This room is archived.");
    if (!groupEligible(userId, channel)) throw notFound();
    const current = memberRow(channelId, userId);
    if (current) return { value: current, replay: true };
    if (exclusionRow(channelId, userId)) throw conflict("excluded", "You cannot join this room until a moderator unblocks you.");
    chargeRate(userId, "membership");
    const joined = (db.prepare("SELECT COUNT(*) AS n FROM channel_members WHERE user_id = ?").get(userId) as { n: number }).n;
    if (joined >= CHANNEL_LIMITS.roomsJoined) throw conflict("capacity", `You can join at most ${CHANNEL_LIMITS.roomsJoined} rooms.`);
    const count = (db.prepare("SELECT COUNT(*) AS n FROM channel_members WHERE channel_id = ?").get(channelId) as { n: number }).n;
    if (count >= CHANNEL_LIMITS.members) throw conflict("capacity", "This room is full.");
    const joinedAt = Date.now();
    db.prepare("INSERT INTO channel_members (channel_id, user_id, role, read_seq, notify_mode, joined_at) VALUES (?, ?, 'member', ?, 'mentions', ?)").run(
      channelId,
      userId,
      channel.next_seq - 1,
      joinedAt,
    );
    const revision = bumpRevision(channelId);
    insertEvent({ channelId, kind: "members.changed", entityId: userId, version: revision });
    insertEvent({ targetUserId: userId, kind: "sync" });
    return { value: memberRow(channelId, userId)!, replay: false };
  });
}

export function acceptInvite(userId: string, channelId: string): MemberRow {
  return tx(() => {
    const channel = channelRow(channelId);
    const invite = inviteRow(channelId, userId);
    if (!channel || !invite) throw notFound();
    if (channel.archived_at !== null) throw conflict("archived", "This room is archived.");
    if (!groupEligible(userId, channel)) throw notFound();
    if (exclusionRow(channelId, userId)) throw conflict("excluded", "You cannot join this room until a moderator unblocks you.");
    if (memberRow(channelId, userId)) throw notFound();
    chargeRate(userId, "membership");
    const joined = (db.prepare("SELECT COUNT(*) AS n FROM channel_members WHERE user_id = ?").get(userId) as { n: number }).n;
    if (joined >= CHANNEL_LIMITS.roomsJoined) throw conflict("capacity", `You can join at most ${CHANNEL_LIMITS.roomsJoined} rooms.`);
    const count = (db.prepare("SELECT COUNT(*) AS n FROM channel_members WHERE channel_id = ?").get(channelId) as { n: number }).n;
    if (count >= CHANNEL_LIMITS.members) throw conflict("capacity", "This room is full.");
    db.prepare("INSERT INTO channel_members (channel_id, user_id, role, read_seq, notify_mode, joined_at) VALUES (?, ?, 'member', ?, 'mentions', ?)").run(
      channelId,
      userId,
      channel.next_seq - 1,
      Date.now(),
    );
    db.prepare("DELETE FROM channel_invites WHERE channel_id = ? AND user_id = ?").run(channelId, userId);
    purgeChannelNotices(channelId, userId);
    const revision = bumpRevision(channelId);
    insertEvent({ channelId, kind: "members.changed", entityId: userId, version: revision });
    insertEvent({ targetUserId: userId, kind: "sync" });
    return memberRow(channelId, userId)!;
  });
}

export function declineInvite(userId: string, channelId: string): void {
  tx(() => {
    if (!inviteRow(channelId, userId)) throw notFound();
    chargeRate(userId, "membership");
    db.prepare("DELETE FROM channel_invites WHERE channel_id = ? AND user_id = ?").run(channelId, userId);
    purgeChannelNotices(channelId, userId);
    insertEvent({ targetUserId: userId, kind: "sync" });
  });
}

export function leaveChannel(userId: string, channelId: string): void {
  tx(() => {
    const member = memberRow(channelId, userId);
    if (!member) throw notFound();
    if (member.role === "owner") throw conflict("owner_transfer_required", "Transfer ownership or delete the room before leaving.");
    chargeRate(userId, "membership");
    db.prepare("DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?").run(channelId, userId);
    purgeChannelNotices(channelId, userId);
    const revision = bumpRevision(channelId);
    insertEvent({ channelId, kind: "members.changed", entityId: userId, version: revision });
    insertEvent({ targetUserId: userId, kind: "sync" });
  });
}

export function inviteMembers(userId: string, channelId: string, userIds: string[]): { added: string[]; replayed: string[] } {
  return tx(() => {
    const channel = channelRow(channelId);
    if (!channel) throw notFound();
    const unique = [...new Set(userIds)];
    const count = (db.prepare("SELECT COUNT(*) AS n FROM channel_invites WHERE channel_id = ?").get(channelId) as { n: number }).n;
    const memberCount = (db.prepare("SELECT COUNT(*) AS n FROM channel_members WHERE channel_id = ?").get(channelId) as { n: number }).n;
    if (count + unique.length > CHANNEL_LIMITS.invitesPerRoom) throw conflict("capacity", "This room has too many pending invitations.");
    if (memberCount + count + unique.length > CHANNEL_LIMITS.members) throw conflict("capacity", "This room cannot hold that many members.");
    for (const targetId of unique) {
      if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get(targetId)) throw new AppError({ code: "validation", status: 422, message: "One of those accounts no longer exists." });
      if (exclusionRow(channelId, targetId)) throw conflict("excluded", "One of those accounts is blocked from this room.");
      if (memberRow(channelId, targetId)) throw new AppError({ code: "validation", status: 422, message: "One of those accounts is already a member." });
      if (!groupEligible(targetId, channel)) throw new AppError({ code: "validation", status: 422, message: "One of those accounts cannot access this room." });
      if (!inviteRow(channelId, targetId)) {
        const pending = (db.prepare("SELECT COUNT(*) AS n FROM channel_invites WHERE user_id = ?").get(targetId) as { n: number }).n;
        if (pending >= CHANNEL_LIMITS.invitations) throw conflict("capacity", "One of those accounts has too many pending invitations.");
      }
    }
    if (unique.some((targetId) => !inviteRow(channelId, targetId))) chargeRate(userId, "membership");
    const added: string[] = [];
    const replayed: string[] = [];
    for (const targetId of unique) {
      if (inviteRow(channelId, targetId)) {
        replayed.push(targetId);
        continue;
      }
      const at = Date.now();
      db.prepare("INSERT INTO channel_invites (channel_id, user_id, invited_by, created_at) VALUES (?, ?, ?, ?)").run(channelId, targetId, userId, at);
      notifyInvite(channel, targetId, at);
      added.push(targetId);
      insertEvent({ targetUserId: targetId, kind: "sync" });
    }
    if (added.length) {
      const revision = bumpRevision(channelId);
      audit(userId, channelId, "invite", added.join(","), "");
      insertEvent({ channelId, kind: "members.changed", entityId: null, version: revision });
    }
    return { added, replayed };
  });
}

export function revokeInvite(userId: string, channelId: string, targetId: string): void {
  tx(() => {
    if (!channelRow(channelId)) throw notFound();
    if (!inviteRow(channelId, targetId)) throw notFound();
    chargeRate(userId, "membership");
    db.prepare("DELETE FROM channel_invites WHERE channel_id = ? AND user_id = ?").run(channelId, targetId);
    purgeChannelNotices(channelId, targetId);
    insertEvent({ targetUserId: targetId, kind: "sync" });
  });
}

export function removeMember(userId: string, channelId: string, targetId: string): void {
  tx(() => {
    const channel = channelRow(channelId);
    if (!channel) throw notFound();
    const target = memberRow(channelId, targetId);
    if (!target) throw notFound();
    if (target.role === "owner") throw conflict("owner_transfer_required", "The owner must transfer ownership or delete the room.");
    chargeRate(userId, "membership");
    db.prepare("DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?").run(channelId, targetId);
    db.prepare("DELETE FROM channel_invites WHERE channel_id = ? AND user_id = ?").run(channelId, targetId);
    db.prepare("INSERT OR IGNORE INTO channel_exclusions (channel_id, user_id, created_at) VALUES (?, ?, ?)").run(channelId, targetId, Date.now());
    purgeChannelNotices(channelId, targetId);
    const revision = bumpRevision(channelId);
    audit(userId, channelId, "remove", targetId, "");
    insertEvent({ channelId, kind: "members.changed", entityId: targetId, version: revision });
    insertEvent({ targetUserId: targetId, kind: "sync" });
  });
}

export function unblockMember(userId: string, channelId: string, targetId: string): void {
  tx(() => {
    if (!channelRow(channelId)) throw notFound();
    if (!db.prepare("SELECT 1 FROM channel_exclusions WHERE channel_id = ? AND user_id = ?").get(channelId, targetId)) {
      return;
    }
    chargeRate(userId, "membership");
    db.prepare("DELETE FROM channel_exclusions WHERE channel_id = ? AND user_id = ?").run(channelId, targetId);
    audit(userId, channelId, "unblock", targetId, "");
    insertEvent({ targetUserId: targetId, kind: "sync" });
  });
}

export function setReadCursor(userId: string, channelId: string, throughSeq: number): { readSeq: number; changed: boolean } {
  return tx(() => {
    const channel = channelRow(channelId);
    const member = memberRow(channelId, userId);
    if (!channel || !member) throw notFound();
    if (!Number.isSafeInteger(throughSeq) || throughSeq < 0) throw new AppError({ code: "validation", message: "Invalid read position." });
    const capped = Math.min(throughSeq, channel.next_seq - 1);
    if (capped <= member.read_seq) return { readSeq: member.read_seq, changed: false };
    chargeRate(userId, "read");
    db.prepare("UPDATE channel_members SET read_seq = ? WHERE channel_id = ? AND user_id = ?").run(capped, channelId, userId);
    markChannelNoticesReadThrough(userId, channelId, capped);
    insertEvent({ channelId, targetUserId: userId, kind: "read.changed", entityId: userId, version: capped });
    return { readSeq: capped, changed: true };
  });
}

export function setNotifyMode(userId: string, channelId: string, mode: "all" | "mentions" | "none"): void {
  tx(() => {
    const member = memberRow(channelId, userId);
    if (!member) throw notFound();
    if (member.notify_mode === mode) return;
    chargeRate(userId, "membership");
    db.prepare("UPDATE channel_members SET notify_mode = ? WHERE channel_id = ? AND user_id = ?").run(mode, channelId, userId);
    insertEvent({ targetUserId: userId, kind: "sync" });
  });
}

// ---------------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------------

export interface PostedMessage {
  messageId: string;
  seq: number;
  runId: string | null;
  replay: boolean;
}

function validateReply(channelId: string, replyTo: string | undefined): string | null {
  if (!replyTo) return null;
  const row = db.prepare("SELECT id FROM channel_messages WHERE channel_id = ? AND id = ?").get(channelId, replyTo);
  if (!row) throw new AppError({ code: "validation", status: 422, message: "The quoted message is not in this room." });
  return replyTo;
}

/** Mentions must name current eligible members, and every structured span must match that member's displayed name. */
function validateMentions(channelId: string, body: string, mentions: ChannelMentionInput[]): ChannelMentionInput[] {
  for (const mention of mentions) {
    const row = db
      .prepare(
        `SELECT u.name FROM channel_members m JOIN users u ON u.id = m.user_id
         WHERE m.channel_id = ? AND m.user_id = ?`,
      )
      .get(channelId, mention.userId) as { name: string } | undefined;
    if (!row) throw new AppError({ code: "validation", status: 422, message: "A mentioned account is not a member of this room." });
    const shown = body.slice(mention.start + 1, mention.end);
    if (shown !== row.name) throw new AppError({ code: "validation", status: 422, message: "A mention does not match the member's name." });
  }
  return mentions;
}

export interface PostMessageInput {
  clientId: string;
  body: string;
  replyTo?: string;
  mentions?: ChannelMentionInput[];
  requestAi?: boolean;
  requestHash: string;
}

export function postHumanMessage(
  userId: string,
  channelId: string,
  input: PostMessageInput,
  makeRun: (human: { messageId: string; seq: number }) => { runId: string } | null,
): StoreResult<PostedMessage> {
  return tx(() => {
    const channel = channelRow(channelId);
    if (!channel) throw notFound();
    const existing = db.prepare("SELECT * FROM channel_messages WHERE channel_id = ? AND author_id = ? AND client_id = ? AND kind = 'human'").get(
      channelId,
      userId,
      input.clientId,
    ) as { id: string; seq: number; request_hash: string | null } | undefined;
    if (existing) {
      if (existing.request_hash !== input.requestHash) throw conflict("capacity", "That message id was already used for different text.");
      const run = db.prepare("SELECT id FROM channel_ai_runs WHERE source_id = ?").get(existing.id) as { id: string } | undefined;
      return { value: { messageId: existing.id, seq: existing.seq, runId: run?.id ?? null, replay: true }, replay: true };
    }
    assertMessageCapacity(channelId);
    const body = assertBody(input.body);
    const replyTo = validateReply(channelId, input.replyTo);
    const mentions = validateMentions(channelId, body, normalizeMentions(body, input.mentions));
    assertStorage(channel.owner_id, bytesOf(body));
    chargeRate(userId, "write");
    const now = Date.now();
    const seq = allocateSeq(channelId);
    const id = newId("cmsg");
    db.prepare(
      `INSERT INTO channel_messages (id, channel_id, seq, author_id, kind, body, reply_to, client_id, request_hash, revision, created_at, edited_at, deleted_at)
       VALUES (?, ?, ?, ?, 'human', ?, ?, ?, ?, 1, ?, NULL, NULL)`,
    ).run(id, channelId, seq, userId, body, replyTo, input.clientId, input.requestHash, now);
    for (const mention of mentions) {
      db.prepare("INSERT INTO channel_mentions (message_id, user_id, start_offset, end_offset) VALUES (?, ?, ?, ?)").run(
        id,
        mention.userId,
        mention.start,
        mention.end,
      );
    }
    touchActivity(channelId, now);
    let runId: string | null = null;
    if (input.requestAi) {
      const run = makeRun({ messageId: id, seq });
      runId = run?.runId ?? null;
    }
    notifyHumanMessage(channel, id, seq, userId, mentions.map((mention) => mention.userId));
    insertEvent({ channelId, kind: "message.changed", entityId: id, version: 1 });
    insertEvent({ channelId, kind: "channel.changed", entityId: channelId, version: channel.revision });
    return { value: { messageId: id, seq, runId, replay: false }, replay: false };
  });
}

export function editHumanMessage(userId: string, channelId: string, messageId: string, revision: number, bodyInput: string, mentionsInput: ChannelMentionInput[] | undefined): void {
  tx(() => {
    const channel = channelRow(channelId);
    const message = db.prepare("SELECT * FROM channel_messages WHERE channel_id = ? AND id = ?").get(channelId, messageId) as
      | { id: string; author_id: string | null; kind: string; revision: number; deleted_at: number | null; body: string }
      | undefined;
    if (!channel || !message) throw notFound();
    if (message.kind !== "human" || message.author_id !== userId) throw new AppError({ code: "forbidden", message: "You can only edit your own messages." });
    if (message.deleted_at !== null) throw conflict("revision", "That message was deleted.");
    if (message.revision !== revision) throw conflict("revision", "This message changed. Reload and try again.");
    if (db.prepare("SELECT 1 FROM channel_ai_runs WHERE source_id = ? AND state IN ('queued', 'running')").get(messageId)) {
      throw conflict("source_busy", "A reply to this message is still being written.");
    }
    const body = assertBody(bodyInput);
    const mentions = validateMentions(channelId, body, normalizeMentions(body, mentionsInput));
    const growth = bytesOf(body) - bytesOf(message.body);
    if (growth > 0) assertStorage(channel.owner_id, growth);
    chargeRate(userId, "write");
    db.prepare("UPDATE channel_messages SET body = ?, revision = revision + 1, edited_at = ? WHERE channel_id = ? AND id = ?").run(body, Date.now(), channelId, messageId);
    db.prepare("DELETE FROM channel_mentions WHERE message_id = ?").run(messageId);
    for (const mention of mentions) {
      db.prepare("INSERT INTO channel_mentions (message_id, user_id, start_offset, end_offset) VALUES (?, ?, ?, ?)").run(
        messageId,
        mention.userId,
        mention.start,
        mention.end,
      );
    }
    const next = (db.prepare("SELECT revision FROM channel_messages WHERE id = ?").get(messageId) as { revision: number }).revision;
    insertEvent({ channelId, kind: "message.changed", entityId: messageId, version: next });
  });
}

/** Tombstone: text, mentions, and reactions go; id, sequence, replies, and the original digest stay. */
export function deleteHumanMessage(userId: string, channelId: string, messageId: string, revision: number, options: { moderator: boolean; reason: string }): { seq: number } {
  return tx(() => {
    const channel = channelRow(channelId);
    const message = db.prepare("SELECT * FROM channel_messages WHERE channel_id = ? AND id = ?").get(channelId, messageId) as
      | { id: string; author_id: string | null; kind: string; revision: number; deleted_at: number | null; seq: number }
      | undefined;
    if (!channel || !message) throw notFound();
    if (message.deleted_at !== null) throw conflict("revision", "That message is already deleted.");
    if (message.revision !== revision) throw conflict("revision", "This message changed. Reload and try again.");
    if (message.kind !== "human") throw new AppError({ code: "forbidden", message: "Stop the reply instead of deleting it." });
    if (message.author_id !== userId && !options.moderator) throw new AppError({ code: "forbidden", message: "You can only delete your own messages." });
    chargeRate(userId, "write");
    db.prepare("UPDATE channel_messages SET body = '', deleted_at = ?, revision = revision + 1 WHERE channel_id = ? AND id = ?").run(Date.now(), channelId, messageId);
    db.prepare("DELETE FROM channel_mentions WHERE message_id = ?").run(messageId);
    db.prepare("DELETE FROM channel_reactions WHERE message_id = ?").run(messageId);
    purgeMessageNotices(channelId, messageId);
    const next = (db.prepare("SELECT revision FROM channel_messages WHERE id = ?").get(messageId) as { revision: number }).revision;
    audit(userId, channelId, "deleteMessage", messageId, options.reason);
    insertEvent({ channelId, kind: "message.changed", entityId: messageId, version: next });
    return { seq: message.seq };
  });
}

export function toggleReaction(userId: string, channelId: string, messageId: string, emoji: string, add: boolean): { revision: number } {
  return tx(() => {
    const channel = channelRow(channelId);
    const message = db.prepare("SELECT id, deleted_at FROM channel_messages WHERE channel_id = ? AND id = ?").get(channelId, messageId) as
      | { id: string; deleted_at: number | null }
      | undefined;
    if (!channel || !message) throw notFound();
    if (message.deleted_at !== null) throw conflict("revision", "That message was deleted.");
    if (!db.prepare("SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?").get(channelId, userId)) throw notFound();
    const exists = db.prepare("SELECT 1 FROM channel_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?").get(messageId, userId, emoji);
    if (add && exists) return currentRevision(messageId);
    if (!add && !exists) return currentRevision(messageId);
    chargeRate(userId, "write");
    if (add) {
      const distinct = (db.prepare("SELECT COUNT(*) AS n FROM channel_reactions WHERE message_id = ? AND user_id = ?").get(messageId, userId) as { n: number }).n;
      if (distinct >= CHANNEL_LIMITS.reactionsPerUser) throw conflict("capacity", "You can use at most three reactions on one message.");
      const users = (db.prepare("SELECT COUNT(*) AS n FROM channel_reactions WHERE message_id = ? AND emoji = ?").get(messageId, emoji) as { n: number }).n;
      if (users >= CHANNEL_LIMITS.reactionUsers) throw conflict("capacity", "That reaction is full.");
      db.prepare("INSERT INTO channel_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)").run(messageId, userId, emoji, Date.now());
    } else {
      db.prepare("DELETE FROM channel_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?").run(messageId, userId, emoji);
    }
    db.prepare("UPDATE channel_messages SET revision = revision + 1 WHERE channel_id = ? AND id = ?").run(channelId, messageId);
    const next = currentRevision(messageId).revision;
    insertEvent({ channelId, kind: "message.changed", entityId: messageId, version: next });
    return { revision: next };
  });
}

function currentRevision(messageId: string): { revision: number } {
  return db.prepare("SELECT revision FROM channel_messages WHERE id = ?").get(messageId) as { revision: number };
}

// ---------------------------------------------------------------------------------------------------
// AI runs (synchronous admission and settlement; the model call lives in worker.ts)
// ---------------------------------------------------------------------------------------------------

export interface ChannelRunRowFull {
  id: string;
  channel_id: string;
  requester_id: string | null;
  source_id: string;
  message_id: string;
  client_id: string;
  request_hash: string;
  model_ref: string;
  config_json: string;
  input_enc: string | null;
  state: "queued" | "running" | "finished" | "cancelled" | "failed" | "interrupted";
  output_version: number;
  finish_reason: string | null;
  error_code: string | null;
  usage_json: string | null;
  cost: number;
  usage_recorded: number;
  reserved_bytes: number;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
}

export function runRow(runId: string): ChannelRunRowFull | undefined {
  return db.prepare("SELECT * FROM channel_ai_runs WHERE id = ?").get(runId) as ChannelRunRowFull | undefined;
}

export function runByClient(channelId: string, requesterId: string, clientId: string): ChannelRunRowFull | undefined {
  return db.prepare("SELECT * FROM channel_ai_runs WHERE channel_id = ? AND requester_id = ? AND client_id = ?").get(channelId, requesterId, clientId) as
    | ChannelRunRowFull
    | undefined;
}

export function openRun(channelId: string): ChannelRunRowFull | undefined {
  return db.prepare("SELECT * FROM channel_ai_runs WHERE channel_id = ? AND state IN ('queued', 'running')").get(channelId) as ChannelRunRowFull | undefined;
}

export interface CreateRunInput {
  clientId: string;
  requestHash: string;
  modelRef: string;
  configJson: string;
  inputEnc: string;
  reservedBytes: number;
}

/** Creates the AI placeholder and its run in the caller's open transaction. */
export function createRunInTx(
  userId: string,
  channel: ChannelRow,
  source: { messageId: string; seq: number },
  input: CreateRunInput,
): { runId: string; messageId: string } {
  const existing = runByClient(channel.id, userId, input.clientId);
  if (existing) {
    if (existing.request_hash !== input.requestHash) throw conflict("capacity", "That reply id was already used for a different request.");
    return { runId: existing.id, messageId: existing.message_id };
  }
  if (openRun(channel.id)) throw conflict("ai_busy", "A reply is already running in this room.");
  if (db.prepare("SELECT 1 FROM channel_ai_runs WHERE requester_id = ? AND state IN ('queued', 'running')").get(userId)) {
    throw conflict("ai_busy", "You already have a room reply running.");
  }
  assertMessageCapacity(channel.id);
  const now = Date.now();
  const messageId = newId("cmsg");
  const seq = allocateSeq(channel.id);
  db.prepare(
    `INSERT INTO channel_messages (id, channel_id, seq, author_id, kind, body, reply_to, client_id, request_hash, revision, created_at, edited_at, deleted_at)
     VALUES (?, ?, ?, NULL, 'ai', '', ?, NULL, NULL, 1, ?, NULL, NULL)`,
  ).run(messageId, channel.id, seq, source.messageId, now);
  const runId = newId("crun");
  db.prepare(
    `INSERT INTO channel_ai_runs (id, channel_id, requester_id, source_id, message_id, client_id, request_hash, model_ref, config_json, input_enc,
       state, output_version, finish_reason, error_code, usage_json, cost, usage_recorded, reserved_bytes, created_at, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, NULL, NULL, NULL, 0, 0, ?, ?, NULL, NULL)`,
  ).run(
    runId,
    channel.id,
    userId,
    source.messageId,
    messageId,
    input.clientId,
    input.requestHash,
    input.modelRef,
    input.configJson,
    input.inputEnc,
    input.reservedBytes,
    now,
  );
  touchActivity(channel.id, now);
  insertEvent({ channelId: channel.id, kind: "message.changed", entityId: messageId, version: 1 });
  insertEvent({ channelId: channel.id, kind: "channel.changed", entityId: channel.id, version: channel.revision });
  return { runId, messageId };
}

export function setRunQueued(id: string): void {
  db.prepare("UPDATE channel_ai_runs SET state = 'queued' WHERE id = ? AND state = 'queued'").run(id);
}

export function markRunRunning(runId: string): ChannelRunRowFull | null {
  return tx(() => {
    const run = runRow(runId);
    if (!run || run.state !== "queued") return null;
    const now = Date.now();
    db.prepare("UPDATE channel_ai_runs SET state = 'running', started_at = ? WHERE id = ?").run(now, runId);
    insertEvent({ channelId: run.channel_id, kind: "message.changed", entityId: run.message_id, version: checkpointRevision(run.message_id) });
    return runRow(runId)!;
  });
}

function checkpointRevision(messageId: string): number {
  return (db.prepare("SELECT revision FROM channel_messages WHERE id = ?").get(messageId) as { revision: number } | undefined)?.revision ?? 0;
}

/** One durable text checkpoint; the whole visible body replaces the previous snapshot. */
export function checkpointRun(runId: string, body: string): { version: number; outputVersion: number } | null {
  return tx(() => {
    const run = runRow(runId);
    if (!run || run.state !== "running") return null;
    db.prepare("UPDATE channel_messages SET body = ?, revision = revision + 1 WHERE id = ?").run(body, run.message_id);
    const outputVersion = run.output_version + 1;
    db.prepare("UPDATE channel_ai_runs SET output_version = ? WHERE id = ?").run(outputVersion, runId);
    const version = checkpointRevision(run.message_id);
    insertEvent({ channelId: run.channel_id, kind: "message.changed", entityId: run.message_id, version });
    return { version, outputVersion };
  });
}

export interface RunSettlement {
  state: "finished" | "cancelled" | "failed" | "interrupted";
  finishReason: string | null;
  errorCode: string | null;
  body?: string;
  usageJson?: string | null;
  cost?: number;
  usageRecorded?: boolean;
  recordedUsageId?: number | null;
}

export function settleRun(runId: string, settlement: RunSettlement): { messageId: string; seq: number; channelId: string; requesterId: string | null } | null {
  return tx(() => {
    const run = runRow(runId);
    if (!run) return null;
    if (run.state === "finished" || run.state === "cancelled" || run.state === "failed" || run.state === "interrupted") return null;
    const now = Date.now();
    if (settlement.body !== undefined) {
      db.prepare("UPDATE channel_messages SET body = ?, revision = revision + 1 WHERE id = ?").run(settlement.body, run.message_id);
    }
    db.prepare(
      `UPDATE channel_ai_runs SET state = ?, finish_reason = ?, error_code = ?, ended_at = ?,
         usage_json = COALESCE(?, usage_json), cost = COALESCE(?, cost), usage_recorded = ?, input_enc = NULL, reserved_bytes = 0
       WHERE id = ?`,
    ).run(
      settlement.state,
      settlement.finishReason,
      settlement.errorCode,
      now,
      settlement.usageJson ?? null,
      settlement.cost ?? null,
      settlement.usageRecorded ? 1 : 0,
      runId,
    );
    const seq = (db.prepare("SELECT seq FROM channel_messages WHERE id = ?").get(run.message_id) as { seq: number }).seq;
    insertEvent({ channelId: run.channel_id, kind: "message.changed", entityId: run.message_id, version: checkpointRevision(run.message_id) });
    insertEvent({ channelId: run.channel_id, kind: "channel.changed", entityId: run.channel_id });
    return { messageId: run.message_id, seq, channelId: run.channel_id, requesterId: run.requester_id };
  });
}

/** Queued cancellation is terminal without spending a model call. */
export function cancelQueuedRun(runId: string, requesterId: string | null): boolean {
  return tx(() => {
    const run = runRow(runId);
    if (!run || run.state !== "queued") return false;
    db.prepare(
      "UPDATE channel_ai_runs SET state = 'cancelled', ended_at = ?, input_enc = NULL, reserved_bytes = 0 WHERE id = ?",
    ).run(Date.now(), runId);
    insertEvent({ channelId: run.channel_id, kind: "message.changed", entityId: run.message_id, version: checkpointRevision(run.message_id) });
    return true;
  });
}

/** Startup recovery: work from an earlier process is never re-dispatched. */
export function interruptOpenRuns(): number {
  return tx(() => {
    const rows = db.prepare("SELECT id, channel_id, message_id FROM channel_ai_runs WHERE state IN ('queued', 'running')").all() as Array<{
      id: string;
      channel_id: string;
      message_id: string;
    }>;
    if (!rows.length) return 0;
    db.prepare(
      "UPDATE channel_ai_runs SET state = 'interrupted', ended_at = ?, input_enc = NULL, reserved_bytes = 0 WHERE state IN ('queued', 'running')",
    ).run(Date.now());
    for (const row of rows) {
      insertEvent({ channelId: row.channel_id, kind: "message.changed", entityId: row.message_id, version: checkpointRevision(row.message_id) });
    }
    insertSync();
    return rows.length;
  });
}

/** Bytes this room attributes to its owner, matching quota.ts. */
export function channelStorageBytes(channelId: string): number {
  const row = db
    .prepare(
      `SELECT
        (SELECT length(CAST(name AS BLOB)) + length(CAST(description AS BLOB)) + COALESCE(length(CAST(ai_json AS BLOB)), 0)
           FROM channels WHERE id = ?) +
        (SELECT COALESCE(SUM(length(CAST(body AS BLOB))), 0) FROM channel_messages WHERE channel_id = ?) +
        (SELECT COALESCE(SUM(length(CAST(config_json AS BLOB)) + COALESCE(length(CAST(input_enc AS BLOB)), 0) + 1024
           + CASE WHEN r.state IN ('queued', 'running') THEN MAX(0, 65536 - length(CAST(m.body AS BLOB))) ELSE 0 END), 0)
           FROM channel_ai_runs r JOIN channel_messages m ON m.id = r.message_id WHERE r.channel_id = ?) AS bytes`,
    )
    .get(channelId, channelId, channelId) as { bytes: number };
  return row.bytes;
}

export function audit(actorId: string | null, channelId: string | null, action: string, targetId: string | null, reason: string): void {
  db.prepare("INSERT INTO channel_moderation_audit (actor_id, channel_id, action, target_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    actorId,
    channelId,
    action,
    targetId,
    reason.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, CHANNEL_LIMITS.reasonChars),
    Date.now(),
  );
}

/** The canonical hash of a message post: replay compares meaning, not whitespace. */
export function postRequestHash(input: { body: string; replyTo?: string; mentions?: ChannelMentionInput[]; requestAi?: boolean }): string {
  return requestHash({
    body: input.body.replace(/\r\n/g, "\n"),
    replyTo: input.replyTo ?? null,
    mentions: [...(input.mentions ?? [])].sort((a, b) => a.start - b.start).map((m) => [m.userId, m.start, m.end]),
    requestAi: input.requestAi === true,
  });
}

/** A label for an AI binding. Kept private to owners and admins. */
export function bindingJson(binding: ChannelAiBinding): string {
  return JSON.stringify(binding);
}
