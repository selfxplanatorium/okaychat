import { z } from "zod";
import {
  CHANNEL_ICONS,
  CHANNEL_LIMITS,
  CHANNEL_NOTIFY_MODES,
  CHANNEL_VISIBILITIES,
  isChannelIcon,
  type ChannelAiBinding,
  type ChannelIcon,
  type ChannelMentionInput,
} from "../../shared/channels.js";
import { canonicalJson } from "../../shared/permissions.js";
import { AppError } from "../errors.js";

/**
 * Strict wire shapes for channels. Every object is strict: an unknown field (author, role, content
 * parts, attachment ids, visibility on an update) is a rejected request, not silently dropped input.
 */

const clientId = z.string().min(1).max(64);
const groupId = z.string().min(1).max(200);

export const iconSchema = z.enum(CHANNEL_ICONS);
export const visibilitySchema = z.enum(CHANNEL_VISIBILITIES);
export const notifyModeSchema = z.enum(CHANNEL_NOTIFY_MODES);

export const bindingSchema = z.strictObject({
  kind: z.enum(["model", "preset"]),
  modelRef: z.string().min(1).max(300).optional(),
  presetId: z.string().min(1).max(200).optional(),
  confirmReduced: z.boolean().optional(),
});

export const createChannelSchema = z.strictObject({
  clientId,
  name: z.string(),
  description: z.string().optional(),
  icon: iconSchema.optional(),
  visibility: visibilitySchema,
  groupIds: z.array(groupId).max(CHANNEL_LIMITS.groupsPerRoom).optional(),
  ai: bindingSchema.nullable().optional(),
});

export const patchChannelSchema = z.strictObject({
  revision: z.number().int().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  icon: iconSchema.optional(),
  groupIds: z.array(groupId).max(CHANNEL_LIMITS.groupsPerRoom).optional(),
  ai: bindingSchema.nullable().optional(),
});

export const mentionSchema = z.strictObject({
  userId: z.string().min(1).max(200),
  start: z.number().int().min(0),
  end: z.number().int().min(0),
});

export const postMessageSchema = z.strictObject({
  clientId,
  body: z.string(),
  replyTo: z.string().min(1).max(200).optional(),
  mentions: z.array(mentionSchema).max(CHANNEL_LIMITS.mentions).optional(),
  requestAi: z.boolean().optional(),
});

export const editMessageSchema = z.strictObject({
  revision: z.number().int().min(1),
  body: z.string(),
  mentions: z.array(mentionSchema).max(CHANNEL_LIMITS.mentions).optional(),
});

export const deleteMessageSchema = z.strictObject({
  revision: z.number().int().min(1),
  reason: z.string().max(CHANNEL_LIMITS.reasonChars).optional(),
});

export const readSchema = z.strictObject({ throughSeq: z.number().int().min(0) });
export const preferencesSchema = z.strictObject({ notifyMode: notifyModeSchema });
export const inviteSchema = z.strictObject({ userIds: z.array(z.string().min(1).max(200)).min(1).max(20) });
export const roleSchema = z.strictObject({ revision: z.number().int().min(1), role: z.enum(["moderator", "member"]) });
export const transferSchema = z.strictObject({ revision: z.number().int().min(1), userId: z.string().min(1).max(200) });
export const archiveSchema = z.strictObject({ revision: z.number().int().min(1), archived: z.boolean() });
export const deleteChannelSchema = z.strictObject({ revision: z.number().int().min(1), reason: z.string().max(CHANNEL_LIMITS.reasonChars).optional() });
export const aiRunSchema = z.strictObject({ clientId, sourceId: z.string().min(1).max(200) });

export const inspectSchema = z.strictObject({ reason: z.string().max(CHANNEL_LIMITS.reasonChars) });
export const adminPatchSchema = patchChannelSchema.extend({ reason: z.string().max(CHANNEL_LIMITS.reasonChars) });
export const adminDeleteSchema = z.strictObject({ revision: z.number().int().min(1), reason: z.string().max(CHANNEL_LIMITS.reasonChars) });
export const adminModerateSchema = z.strictObject({
  action: z.enum(["removeMember", "setRole", "archive", "transfer", "deleteMessage", "unblock"]),
  targetId: z.string().min(1).max(200).optional(),
  role: z.enum(["moderator", "member"]).optional(),
  archived: z.boolean().optional(),
  revision: z.number().int().min(1),
  reason: z.string().min(1).max(CHANNEL_LIMITS.reasonChars),
});

/** CRLF becomes LF; NUL and control characters other than tab and newline are rejected. */
export function normalizeBody(raw: string): string {
  const body = raw.replace(/\r\n/g, "\n");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(body)) {
    throw new AppError({ code: "validation", status: 422, message: "Message text contains a control character." });
  }
  return body;
}

export function assertBody(body: string): string {
  const normalized = normalizeBody(body);
  if (!normalized.trim()) throw new AppError({ code: "validation", status: 422, message: "Write a message first." });
  if ([...normalized].length > CHANNEL_LIMITS.bodyChars) {
    throw new AppError({ code: "validation", status: 422, message: `Messages are limited to ${CHANNEL_LIMITS.bodyChars} characters.` });
  }
  if (Buffer.byteLength(normalized, "utf8") > CHANNEL_LIMITS.bodyBytes) {
    throw new AppError({ code: "validation", status: 422, message: "That message is too large." });
  }
  // V1 is text only. Images and app-owned asset references are refused before storage, and the renderer
  // blocks image nodes again regardless of author, including AI output.
  if (/!\[[^\]]*\]\([^)]*\)/u.test(normalized) || /okaychat-upload:/iu.test(normalized)) {
    throw new AppError({ code: "validation", status: 422, message: "Images and file attachments are not supported in channels." });
  }
  return normalized;
}

export function assertName(raw: string): string {
  const name = raw.replace(/\r\n/g, "\n").trim();
  const chars = [...name].length;
  if (chars < 1 || chars > CHANNEL_LIMITS.nameChars) {
    throw new AppError({ code: "validation", status: 422, message: `Room names must be 1–${CHANNEL_LIMITS.nameChars} characters.` });
  }
  if (/[\u0000-\u001f\u007f]/u.test(name)) throw new AppError({ code: "validation", status: 422, message: "Room name contains a control character." });
  return name;
}

export function assertDescription(raw: string | undefined): string {
  const description = (raw ?? "").replace(/\r\n/g, "\n");
  if ([...description].length > CHANNEL_LIMITS.descriptionChars || Buffer.byteLength(description, "utf8") > CHANNEL_LIMITS.descriptionBytes) {
    throw new AppError({ code: "validation", status: 422, message: "That room description is too long." });
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(description)) {
    throw new AppError({ code: "validation", status: 422, message: "Room description contains a control character." });
  }
  return description;
}

export function assertReason(raw: string | undefined, required: boolean): string {
  const reason = (raw ?? "").replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  if (required && !reason) throw new AppError({ code: "validation", message: "A reason is required." });
  return reason.slice(0, CHANNEL_LIMITS.reasonChars);
}

/** Mentions are UTF-16 offsets into the normalized body, nonoverlapping, one span per member. */
export function normalizeMentions(body: string, mentions: ChannelMentionInput[] | undefined): ChannelMentionInput[] {
  if (!mentions?.length) return [];
  const seen = new Set<string>();
  const spans: Array<[number, number]> = [];
  const out: ChannelMentionInput[] = [];
  for (const mention of mentions) {
    if (mention.start >= mention.end || mention.end > body.length) {
      throw new AppError({ code: "validation", status: 422, message: "A mention points outside the message." });
    }
    if (seen.has(mention.userId)) throw new AppError({ code: "validation", status: 422, message: "A member can be mentioned once per message." });
    seen.add(mention.userId);
    const text = body.slice(mention.start, mention.end);
    if (!text.startsWith("@") || text.length < 2) {
      throw new AppError({ code: "validation", status: 422, message: "A mention must point at an @name." });
    }
    for (const [start, end] of spans) {
      if (mention.start < end && start < mention.end) {
        throw new AppError({ code: "validation", status: 422, message: "Mentions overlap." });
      }
    }
    spans.push([mention.start, mention.end]);
    out.push({ userId: mention.userId, start: mention.start, end: mention.end });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Canonical admission hash: replays compare intent, not a reformatted body. */
export function requestHash(value: unknown): string {
  return canonicalJson(value);
}

/** The stored binding keeps only what a run needs; origin ids, knowledge, tool policies, and projects are gone. */
export const MAX_BINDING_INSTRUCTIONS = 16 * 1024;

export function reducedBinding(value: ChannelAiBinding): ChannelAiBinding {
  const instructions = value.instructions?.replace(/\r\n/g, "\n").slice(0, MAX_BINDING_INSTRUCTIONS);
  return {
    kind: value.kind,
    label: value.label.slice(0, 120),
    modelRef: value.modelRef,
    ...(instructions ? { instructions } : {}),
    ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}),
    ...(value.sampling && Object.keys(value.sampling).length ? { sampling: value.sampling } : {}),
  };
}

export const isIcon = (value: string): value is ChannelIcon => isChannelIcon(value);

export const REQUEST_SCHEMAS = {
  create: createChannelSchema,
  patch: patchChannelSchema,
  post: postMessageSchema,
  edit: editMessageSchema,
  deleteMessage: deleteMessageSchema,
  read: readSchema,
  preferences: preferencesSchema,
  invite: inviteSchema,
  role: roleSchema,
  transfer: transferSchema,
  archive: archiveSchema,
  deleteChannel: deleteChannelSchema,
  aiRun: aiRunSchema,
  inspect: inspectSchema,
  adminPatch: adminPatchSchema,
  adminDelete: adminDeleteSchema,
  adminModerate: adminModerateSchema,
} as const;
