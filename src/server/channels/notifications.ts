import { db } from "../db.js";
import { notify, purgeChannelMessageNotices } from "../notifications.js";
import type { ChannelRow } from "./access.js";

/** A notice failure must never roll back the message, invitation, or run that produced it. */
function safeNotify(input: Parameters<typeof notify>[0]): void {
  try {
    notify(input);
  } catch (error) {
    console.error("[channels] notice failed:", (error as Error).message);
  }
}

/**
 * Channel notices are server-authored and generic: no room name, sender name, message text, or private
 * id ever appears in a displayed string. Title/body keys carry the meaning; `channel_id` and
 * `channel_message_id` exist for ACL filtering and cursor-based read marking.
 */

export function notifyInvite(channel: ChannelRow, userId: string, invitedAt: number): void {
  safeNotify({
    userId,
    kind: "channel",
    level: "info",
    titleKey: "channel.invited",
    bodyKey: "channel.openRoom",
    params: {},
    channelId: channel.id,
    actionPath: `/channels?invite=${channel.id}`,
    sourceKey: `channel:invite:${channel.id}:${userId}:${invitedAt}`,
  });
}

interface MemberNoticeRow {
  user_id: string;
  read_seq: number;
  notify_mode: "all" | "mentions" | "none";
}

/**
 * A human message notice is created in the message transaction. Structured mentions win over a plain
 * message; `all` opt-in covers messages by others; `none` suppresses both. The recipient's read cursor
 * already covering the sequence suppresses it.
 */
export function notifyHumanMessage(channel: ChannelRow, messageId: string, seq: number, authorId: string, mentionedUserIds: readonly string[]): void {
  const members = db.prepare("SELECT user_id, read_seq, notify_mode FROM channel_members WHERE channel_id = ?").all(channel.id) as unknown as MemberNoticeRow[];
  const mentioned = new Set(mentionedUserIds);
  for (const member of members) {
    if (member.user_id === authorId) continue;
    if (member.read_seq >= seq) continue;
    if (member.notify_mode === "none") continue;
    const mention = mentioned.has(member.user_id);
    if (!mention && member.notify_mode !== "all") continue;
    safeNotify({
      userId: member.user_id,
      kind: "channel",
      level: "info",
      titleKey: mention ? "channel.mention" : "channel.message",
      bodyKey: "channel.openMessage",
      params: {},
      channelId: channel.id,
      channelMessageId: messageId,
      actionPath: `/channels/${channel.id}?message=${messageId}`,
      sourceKey: `channel:message:${messageId}:${member.user_id}`,
    });
  }
}

/** Terminal AI completion. The requester gets one notice; `all` members get it too. */
export function notifyAiFinished(channel: ChannelRow, messageId: string, seq: number, runId: string, requesterId: string | null): void {
  if (!requesterId) return;
  const members = db.prepare("SELECT user_id, read_seq, notify_mode FROM channel_members WHERE channel_id = ?").all(channel.id) as unknown as MemberNoticeRow[];
  const requester = members.find((member) => member.user_id === requesterId);
  if (requester && requester.notify_mode !== "none" && requester.read_seq < seq) {
    safeNotify({
      userId: requesterId,
      kind: "channel",
      level: "success",
      titleKey: "channel.aiFinished",
      bodyKey: "channel.openMessage",
      params: {},
      channelId: channel.id,
      channelMessageId: messageId,
      actionPath: `/channels/${channel.id}?message=${messageId}`,
      sourceKey: `channel:ai:${runId}:${requesterId}`,
    });
  }
  for (const member of members) {
    if (member.user_id === requesterId) continue;
    if (member.notify_mode !== "all" || member.read_seq >= seq) continue;
    safeNotify({
      userId: member.user_id,
      kind: "channel",
      level: "info",
      titleKey: "channel.aiFinished",
      bodyKey: "channel.openMessage",
      params: {},
      channelId: channel.id,
      channelMessageId: messageId,
      actionPath: `/channels/${channel.id}?message=${messageId}`,
      sourceKey: `channel:message:${messageId}:${member.user_id}`,
    });
  }
}

export function purgeMessageNotices(channelId: string, messageId: string): void {
  purgeChannelMessageNotices(channelId, messageId);
}
