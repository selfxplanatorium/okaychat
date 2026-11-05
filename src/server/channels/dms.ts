import { createHash } from "node:crypto";
import { afterCommit, db, tx } from "../db.js";
import { AppError } from "../errors.js";
import { assertStorage } from "../quota.js";
import { CHANNEL_LIMITS, type ChannelDmBlock, type CreateDmInput } from "../../shared/channels.js";
import { featureAllowed } from "../permissions/guard.js";
import { accountRole, assertChannelMember, assertWritable, channelRow, conflict, memberRow, notFound, type ChannelRow } from "./access.js";
import { insertEvent, insertSync } from "./events.js";
import { chargeRate } from "./rate.js";
import { purgeChannelNotices } from "../notifications.js";
import { requestChannelRevocation } from "./revocation.js";
import { removeChannelMedia } from "./attachments.js";
import { dmCounts, type StoreResult } from "./store.js";

/**
 * Direct messages are `channels` rows with `kind='dm'`, `visibility='private'`, an empty name, and a
 * `dm_key` over the sorted member ids. Membership, ACL, events, read state, and quota all keep working;
 * admins never see them, AI never runs in one, and no audit row names a DM.
 */

export const dmKey = (userIds: string[]): string => createHash("sha256").update([...userIds].sort().join("\n")).digest("hex");

export function isBlockedEitherWay(a: string, b: string): boolean {
  return !!db.prepare("SELECT 1 FROM channel_dm_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)").get(a, b, b, a);
}

/** A person-level block applies both ways; the shared-group rule is the only discovery gate besides an exact email. */
export function assertDmPairAllowed(callerId: string, targetId: string): void {
  if (targetId === callerId) throw invalidDm("Choose another account.");
  const target = db.prepare("SELECT id FROM users WHERE id = ?").get(targetId);
  if (!target || !featureAllowed(targetId, "channels")) throw invalidDm("That account cannot be messaged.");
  if (isBlockedEitherWay(callerId, targetId)) throw conflict("dm_blocked", "One of you blocked the other.");
  if (accountRole(callerId) !== "admin") {
    const shared = db
      .prepare("SELECT 1 FROM user_group_members a JOIN user_group_members b ON b.group_id = a.group_id WHERE a.user_id = ? AND b.user_id = ?")
      .get(callerId, targetId);
    if (!shared) throw new AppError({ code: "forbidden", message: "You can only message people who share a group with you." });
  }
}

function invalidDm(message: string): AppError {
  return new AppError({ code: "validation", status: 422, message, details: { reason: "dm_unavailable" } });
}

function bumpRevision(channelId: string): number {
  db.prepare("UPDATE channels SET revision = revision + 1 WHERE id = ?").run(channelId);
  return (db.prepare("SELECT revision FROM channels WHERE id = ?").get(channelId) as { revision: number }).revision;
}

function insertSyncFor(userId: string): void {
  insertEvent({ targetUserId: userId, kind: "sync" });
}

export function createDm(userId: string, input: CreateDmInput): StoreResult<ChannelRow> {
  return tx(() => {
    if (!featureAllowed(userId, "channels")) {
      throw new AppError({ code: "forbidden", message: "Your administrator has disabled team channels for this account." });
    }
    const others = [...new Set(input.userIds)];
    if (!others.length || others.includes(userId) || others.length > CHANNEL_LIMITS.dmMembers - 1) throw invalidDm("Choose 1 to 7 accounts.");
    const counts = dmCounts(userId);
    if (counts.owned >= CHANNEL_LIMITS.dmsOwned) throw conflict("capacity", `You can own at most ${CHANNEL_LIMITS.dmsOwned} direct messages.`);
    if (counts.joined >= CHANNEL_LIMITS.dmsJoined) throw conflict("capacity", `You can join at most ${CHANNEL_LIMITS.dmsJoined} direct messages.`);
    chargeRate(userId, "membership");
    for (const target of others) assertDmPairAllowed(userId, target);
    const key = dmKey([userId, ...others]);
    const existing = db.prepare("SELECT * FROM channels WHERE dm_key = ?").get(key) as ChannelRow | undefined;
    if (existing) {
      if (memberRow(existing.id, userId)) return { value: existing, replay: true };
      throw conflict("dm_left", "You left this conversation. Ask a member to add you back.");
    }
    const requestHash = JSON.stringify({ clientId: input.clientId, userIds: [...others].sort() });
    const now = Date.now();
    const prior = db.prepare("SELECT channel_id, request_hash, created_at FROM channel_create_keys WHERE user_id = ? AND client_id = ?").get(userId, input.clientId) as
      | { channel_id: string | null; request_hash: string; created_at: number }
      | undefined;
    if (prior && prior.created_at >= now - CHANNEL_LIMITS.createKeyMs && prior.request_hash !== requestHash) {
      throw conflict("capacity", "That request id was already used for a different conversation.");
    }
    // A DM has an empty name and description, so there is nothing to charge; the call documents that.
    assertStorage(userId, 0);
    const id = `chn_${createHash("sha256").update(`${key}:${now}:${input.clientId}`).digest("base64url").slice(0, 16)}`;
    db.prepare(
      `INSERT INTO channels (id, owner_id, name, description, icon, visibility, kind, dm_key, ai_json, revision, next_seq, archived_at, created_at, updated_at)
       VALUES (?, ?, '', '', 'users', 'private', 'dm', ?, NULL, 1, 1, NULL, ?, ?)`,
    ).run(id, userId, key, now, now);
    db.prepare("INSERT INTO channel_members (channel_id, user_id, role, read_seq, notify_mode, joined_at) VALUES (?, ?, 'owner', 0, 'all', ?)").run(id, userId, now);
    for (const target of others) {
      db.prepare("INSERT INTO channel_members (channel_id, user_id, role, read_seq, notify_mode, joined_at) VALUES (?, ?, 'member', 0, 'all', ?)").run(id, target, now);
    }
    db.prepare(
      `INSERT INTO channel_create_keys (user_id, client_id, channel_id, request_hash, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, client_id) DO UPDATE SET channel_id = excluded.channel_id, request_hash = excluded.request_hash, created_at = excluded.created_at`,
    ).run(userId, input.clientId, id, requestHash, now);
    insertEvent({ channelId: id, kind: "channel.changed", version: 1 });
    insertSyncFor(userId);
    for (const target of others) insertSyncFor(target);
    return { value: channelRow(id)!, replay: false };
  });
}

export function addDmMembers(userId: string, channelId: string, userIds: string[]): ChannelRow {
  return tx(() => {
    const channel = channelRow(channelId);
    if (!channel) throw notFound();
    if (channel.kind !== "dm") throw notFound();
    if (channel.owner_id !== userId) throw new AppError({ code: "forbidden", message: "Only the owner can add people." });
    assertWritable(channel);
    const unique = [...new Set(userIds)];
    const current = (db.prepare("SELECT COUNT(*) AS n FROM channel_members WHERE channel_id = ?").get(channelId) as { n: number }).n;
    if (current + unique.length > CHANNEL_LIMITS.dmMembers) throw conflict("capacity", `A direct message holds at most ${CHANNEL_LIMITS.dmMembers} people.`);
    for (const target of unique) {
      if (memberRow(channelId, target)) throw invalidDm("One of those accounts is already a member.");
      assertDmPairAllowed(userId, target);
    }
    const now = Date.now();
    const readSeq = channel.next_seq - 1;
    for (const target of unique) {
      db.prepare("INSERT INTO channel_members (channel_id, user_id, role, read_seq, notify_mode, joined_at) VALUES (?, ?, 'member', ?, 'all', ?)").run(
        channelId,
        target,
        readSeq,
        now,
      );
      insertSyncFor(target);
    }
    const revision = bumpRevision(channelId);
    insertEvent({ channelId, kind: "members.changed", entityId: null, version: revision });
    return channelRow(channelId)!;
  });
}

/** Removes one membership, transfers ownership when the owner leaves, or deletes the empty DM. */
function leaveInTx(userId: string, channel: ChannelRow): void {
  const member = memberRow(channel.id, userId);
  if (!member) throw notFound();
  db.prepare("DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?").run(channel.id, userId);
  purgeChannelNotices(channel.id, userId);
  const remaining = db
    .prepare("SELECT user_id, role FROM channel_members WHERE channel_id = ? ORDER BY joined_at, user_id")
    .all(channel.id) as Array<{ user_id: string; role: string }>;
  if (!remaining.length) {
    db.prepare("UPDATE channel_create_keys SET channel_id = NULL WHERE channel_id = ?").run(channel.id);
    db.prepare("DELETE FROM channel_ai_runs WHERE channel_id = ?").run(channel.id);
    db.prepare("DELETE FROM channels WHERE id = ?").run(channel.id);
    insertSync();
    afterCommit(() => removeChannelMedia(channel.id));
    return;
  }
  if (member.role === "owner") {
    const next = remaining[0]!;
    db.prepare("UPDATE channel_members SET role = 'owner' WHERE channel_id = ? AND user_id = ?").run(channel.id, next.user_id);
    db.prepare("UPDATE channels SET owner_id = ? WHERE id = ?").run(next.user_id, channel.id);
    db.prepare("UPDATE channel_attachments SET owner_id = ? WHERE channel_id = ?").run(next.user_id, channel.id);
    insertSyncFor(next.user_id);
  }
  const revision = bumpRevision(channel.id);
  insertEvent({ channelId: channel.id, kind: "members.changed", entityId: userId, version: revision });
  insertSyncFor(userId);
}

export function leaveDm(userId: string, channelId: string): void {
  tx(() => {
    const channel = channelRow(channelId);
    if (!channel) throw notFound();
    if (channel.kind !== "dm") throw notFound();
    leaveInTx(userId, channel);
    afterCommit(requestChannelRevocation);
  });
}

/** The owner can remove a conversation outright; no audit row ever names a DM. */
export function deleteDm(userId: string, channelId: string, revision: number): void {
  tx(() => {
    const channel = channelRow(channelId);
    if (!channel || channel.kind !== "dm") throw notFound();
    const member = memberRow(channelId, userId);
    if (!member) throw notFound();
    if (member.role !== "owner") throw new AppError({ code: "forbidden", message: "Only the owner can delete this conversation." });
    if (channel.revision !== revision) throw conflict("revision", "This conversation changed. Reload and try again.");
    db.prepare("UPDATE channel_create_keys SET channel_id = NULL WHERE channel_id = ?").run(channelId);
    db.prepare("DELETE FROM channel_ai_runs WHERE channel_id = ?").run(channelId);
    db.prepare("DELETE FROM channels WHERE id = ?").run(channelId);
    insertSync();
    afterCommit(() => removeChannelMedia(channelId));
    afterCommit(requestChannelRevocation);
  });
}

export function blockUser(blockerId: string, targetId: string): void {
  tx(() => {
    if (blockerId === targetId) throw invalidDm("You cannot block yourself.");
    if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get(targetId)) throw invalidDm("That account no longer exists.");
    const existing = db.prepare("SELECT 1 FROM channel_dm_blocks WHERE blocker_id = ? AND blocked_id = ?").get(blockerId, targetId);
    if (!existing) {
      const count = (db.prepare("SELECT COUNT(*) AS n FROM channel_dm_blocks WHERE blocker_id = ?").get(blockerId) as { n: number }).n;
      if (count >= CHANNEL_LIMITS.dmBlockedMax) throw conflict("capacity", "You have blocked too many accounts.");
      db.prepare("INSERT OR IGNORE INTO channel_dm_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)").run(blockerId, targetId, Date.now());
    }
    // A person-level block also leaves every 2-member DM between them.
    const shared = db
      .prepare(
        `SELECT c.id FROM channels c
         JOIN channel_members a ON a.channel_id = c.id AND a.user_id = ?
         JOIN channel_members b ON b.channel_id = c.id AND b.user_id = ?
         WHERE c.kind = 'dm' AND (SELECT COUNT(*) FROM channel_members m WHERE m.channel_id = c.id) = 2`,
      )
      .all(blockerId, targetId) as Array<{ id: string }>;
    for (const row of shared) {
      const channel = channelRow(row.id);
      if (channel) leaveInTx(blockerId, channel);
    }
    insertSync();
    afterCommit(requestChannelRevocation);
  });
}

export function unblockUser(blockerId: string, targetId: string): void {
  tx(() => {
    db.prepare("DELETE FROM channel_dm_blocks WHERE blocker_id = ? AND blocked_id = ?").run(blockerId, targetId);
    insertSync();
  });
}

export function listBlocks(userId: string): ChannelDmBlock[] {
  return db
    .prepare(
      `SELECT u.id, u.name FROM channel_dm_blocks b JOIN users u ON u.id = b.blocked_id
       WHERE b.blocker_id = ? ORDER BY u.name COLLATE NOCASE, u.id`,
    )
    .all(userId) as unknown as ChannelDmBlock[];
}

/** Route helper: a DM the caller is not in is the same 404 as a missing room. */
export function assertDmMember(userId: string, channelId: string): ChannelRow {
  const { channel } = assertChannelMember(userId, channelId);
  if (channel.kind !== "dm") throw notFound();
  return channel;
}
