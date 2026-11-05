import {
  CHANNEL_ICONS,
  CHANNEL_REACTIONS,
  CHANNEL_ROLES,
  CHANNEL_VISIBILITIES,
  type ChannelReaction,
  type ChannelRole,
  type ChannelVisibility,
} from "../../../shared/channels.js";
import {
  isRoomArchiveHash,
  isRoomArchiveKey,
  ROOM_ARCHIVE_FORMAT,
  ROOM_ARCHIVE_LIMITS,
  ROOM_ARCHIVE_VERSION,
  type RoomArchiveAttachmentEntry,
  type RoomArchiveIdentity,
  type RoomArchiveMember,
  type RoomArchiveMessage,
  type RoomArchiveQuote,
  type RoomArchiveV1,
} from "../../../shared/room-archive.js";

/**
 * Strict room manifest validation. Every object is closed, every array is ordered, every reference is
 * resolved in one linear pass, and every count/size cap fails the whole archive. The parser never
 * normalizes away a difference: an invalid span, a noncanonical CRLF, or an extra field is a rejection,
 * because normalizing would silently change what the sender archived.
 */

export class RoomArchiveFormatError extends Error {
  constructor(
    readonly code: "invalid_archive" | "wrong_format" | "unsupported_version" | "limit_exceeded" | "attachment_invalid" | "attachment_type" | "interrupted",
    message: string,
    readonly item?: string,
  ) {
    super(message);
  }
}

/** ES2024 String.isWellFormed is not in this project's lib; check surrogate pairs directly. */
function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function fail(message: string, code: RoomArchiveFormatError["code"] = "invalid_archive", item?: string): never {
  throw new RoomArchiveFormatError(code, message, item);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isSafeInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Control characters the room itself refuses; tab and newline stay allowed. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const CRLF = /\r/u;

export interface ManifestLexicalResult {
  text: string;
}

/**
 * Lexical pass before JSON.parse. It rejects duplicate object keys, excessive nesting, overlong strings,
 * lone surrogate escapes, and raw U+FEFF. It does not build a second parser: it only tracks braces,
 * brackets, strings, and object key positions.
 */
export function scanManifestJson(bytes: Uint8Array): string {
  if (bytes.byteLength > ROOM_ARCHIVE_LIMITS.manifestBytes) fail("The manifest is too large.", "limit_exceeded");
  // TextDecoder strips a UTF-8 BOM by default, so the raw bytes are the only reliable check.
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) fail("The manifest must not start with a byte order mark.");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("The manifest is not valid UTF-8.");
  }
  if (text.charCodeAt(0) === 0xfeff) fail("The manifest must not start with a byte order mark.");
  let depth = 0;
  let index = 0;
  const stack: Array<{ object: boolean; keys: Set<string> | null; expectKey: boolean }> = [];
  while (index < text.length) {
    const char = text[index]!;
    if (char === '"') {
      let value = "";
      let closed = false;
      index++;
      while (index < text.length) {
        const next = text[index]!;
        if (next === "\\") {
          const escape = text[index + 1];
          if (escape === undefined) fail("The manifest ends inside a string.");
          if (escape === "u") {
            const hex = text.slice(index + 2, index + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("The manifest has an invalid escape.");
            value += String.fromCharCode(Number.parseInt(hex, 16));
            index += 6;
            continue;
          }
          const decoded: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
          const replacement = decoded[escape];
          if (!replacement) fail("The manifest has an invalid escape.");
          value += replacement;
          index += 2;
          continue;
        }
        if (next === '"') {
          closed = true;
          index++;
          break;
        }
        value += next;
        index++;
      }
      if (!closed) fail("The manifest ends inside a string.");
      if (value.length > 2 * 1024 * 1024) fail("A manifest string is too long.", "limit_exceeded");
      if (!wellFormed(value)) fail("The manifest contains an invalid Unicode sequence.");
      const top = stack.at(-1);
      if (top?.object && top.expectKey) {
        if (top.keys!.has(value)) fail("The manifest repeats an object property.");
        top.keys!.add(value);
        top.expectKey = false;
      }
      continue;
    }
    if (char === "{" || char === "[") {
      depth++;
      if (depth > ROOM_ARCHIVE_LIMITS.manifestDepth) fail("The manifest is nested too deeply.", "limit_exceeded");
      stack.push({ object: char === "{", keys: char === "{" ? new Set() : null, expectKey: char === "{" });
      index++;
      continue;
    }
    if (char === "}" || char === "]") {
      const top = stack.pop();
      if (!top || (char === "}" && !top.object) || (char === "]" && top.object)) fail("The manifest is not valid JSON.");
      depth--;
      index++;
      continue;
    }
    if (char === ",") {
      const top = stack.at(-1);
      if (top?.object) top.expectKey = true;
      index++;
      continue;
    }
    index++;
  }
  if (stack.length) fail("The manifest is not valid JSON.");
  return text;
}

export interface ParsedRoomManifest {
  manifest: RoomArchiveV1;
  stats: RoomArchiveStats;
}

export interface RoomArchiveStats {
  roots: number;
  replies: number;
  attachments: number;
  distinctAssets: number;
  attachmentBytes: number;
  mentionRows: number;
  reactionRows: number;
  identities: number;
  members: number;
}

export interface ValidateOptions {
  /** The importer's clock; every Millis is also bounded against it. */
  now: number;
  /** Bytes per declared asset, already expanded from the container. */
  assetSizes: ReadonlyMap<string, number>;
  /** Set when the caller has already proved the archive came from this format. */
  allowForeignFormat?: false;
}

/** Parses the raw manifest bytes and validates the complete semantic graph. */
export function readRoomManifest(bytes: Uint8Array, options: ValidateOptions): ParsedRoomManifest {
  const text = scanManifestJson(bytes);
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    fail("The manifest is not valid JSON.");
  }
  return validateRoomManifest(raw, options);
}

export function validateRoomManifest(raw: unknown, options: ValidateOptions): ParsedRoomManifest {
  if (!isRecord(raw)) fail("The manifest is not an object.");
  if (raw.format !== ROOM_ARCHIVE_FORMAT) {
    // A personal chat archive is the common mistake; the two formats never cross-import.
    fail("This is not an okaychat room archive.", "wrong_format");
  }
  if (raw.version !== ROOM_ARCHIVE_VERSION) fail("This room archive version is not supported.", "unsupported_version");
  exact(raw, ["format", "version", "exportedAt", "room", "selection", "identities", "members", "messages", "assets"], "manifest");

  if (!isSafeInt(raw.exportedAt) || raw.exportedAt < 0) fail("The archive timestamp is invalid.");
  const exportedAt = raw.exportedAt as number;
  const latest = Math.min(exportedAt, options.now) + 86_400_000;
  if (exportedAt > options.now + 86_400_000) fail("The archive timestamp is in the future.");

  const room = readRoom(raw.room, latest);
  const selection = readSelection(raw.selection);

  if (!Array.isArray(raw.identities) || raw.identities.length > ROOM_ARCHIVE_LIMITS.identities) fail("This archive has too many identities.", "limit_exceeded");
  if (!Array.isArray(raw.members) || raw.members.length > ROOM_ARCHIVE_LIMITS.members) fail("This archive has too many members.", "limit_exceeded");
  if (!Array.isArray(raw.messages) || raw.messages.length > ROOM_ARCHIVE_LIMITS.messages) fail("This archive has too many messages.", "limit_exceeded");
  if (!Array.isArray(raw.assets) || raw.assets.length > ROOM_ARCHIVE_LIMITS.assets) fail("This archive has too many assets.", "limit_exceeded");

  const identities = raw.identities.map((entry) => readIdentity(entry));
  const identityKeys = new Set<string>();
  const localIds = new Set<string>();
  for (const identity of identities) {
    if (identityKeys.has(identity.key)) fail("Duplicate identity keys.");
    identityKeys.add(identity.key);
    if (identity.localId !== null) {
      if (localIds.has(identity.localId)) fail("A local account is exported twice.");
      localIds.add(identity.localId);
    }
  }

  const members = raw.members.map((entry) => readMember(entry, identityKeys, latest));
  const memberKeys = new Set<string>();
  for (const member of members) {
    if (memberKeys.has(member.identityKey)) fail("An identity is a member twice.");
    memberKeys.add(member.identityKey);
  }
  const owners = members.filter((member) => member.role === "owner").length;
  if (members.length === 0 ? identities.length !== 0 : owners !== 1) fail("A room archive needs exactly one historical owner.");

  const assets = raw.assets.map((entry) => {
    if (!isRecord(entry)) fail("An asset entry is invalid.");
    exact(entry, ["key", "size"], "asset");
    if (!isRoomArchiveHash(entry.key)) fail("An asset hash is invalid.");
    if (!isSafeInt(entry.size) || entry.size < 1 || entry.size > ROOM_ARCHIVE_LIMITS.assetMaxBytes) fail("An asset size is invalid.", "limit_exceeded");
    const actual = options.assetSizes.get(entry.key);
    if (actual === undefined) fail("An asset declared in the manifest is missing.", "invalid_archive", entry.key);
    if (actual !== entry.size) fail("An asset's declared size does not match its bytes.", "invalid_archive", entry.key);
    return { key: entry.key, size: entry.size };
  });
  const assetKeys = new Set<string>();
  for (const asset of assets) {
    if (assetKeys.has(asset.key)) fail("Duplicate asset entries.");
    assetKeys.add(asset.key);
  }

  const messages: RoomArchiveMessage[] = [];
  const messageByKey = new Map<string, RoomArchiveMessage>();
  const attachmentKeys = new Set<string>();
  const assetUsed = new Set<string>();
  const topLevel = new Map<string, RoomArchiveMessage>();
  const referencedIdentities = new Set<string>();
  let attachmentBytes = 0;
  let attachmentCount = 0;
  let mentionRows = 0;
  let reactionRows = 0;
  const repliesPerRoot = new Map<string, number>();

  raw.messages.forEach((entry, index) => {
    if (!isRecord(entry)) fail("A message is invalid.");
    exact(
      entry,
      ["key", "order", "kind", "authorKey", "body", "createdAt", "editedAt", "threadRootKey", "quote", "mentions", "reactions", "attachments"],
      "message",
    );
    if (!isRoomArchiveKey(entry.key)) fail("A message key is invalid.");
    if (messageByKey.has(entry.key)) fail("Duplicate message keys.");
    if (entry.order !== index + 1) fail("Messages are not in dense archive order.");
    if (entry.kind !== "human" && entry.kind !== "ai") fail("A message kind is invalid.");
    const kind = entry.kind as "human" | "ai";
    if (!isSafeInt(entry.createdAt) || entry.createdAt < 0 || entry.createdAt > latest) fail("A message timestamp is invalid.");
    if (entry.editedAt !== null && (!isSafeInt(entry.editedAt) || entry.editedAt < entry.createdAt || entry.editedAt > latest)) fail("An edit timestamp is invalid.");
    const body = readBody(entry.body, kind);
    const authorKey = entry.authorKey === null ? null : isRoomArchiveKey(entry.authorKey) ? entry.authorKey : fail("An author key is invalid.");
    if (authorKey !== null && !identityKeys.has(authorKey)) fail("A message references a missing author identity.");
    if (authorKey !== null) referencedIdentities.add(authorKey);
    if (kind === "ai" && authorKey !== null) fail("An AI message must not name an author.");

    const threadRootKey = entry.threadRootKey === null ? null : isRoomArchiveKey(entry.threadRootKey) ? entry.threadRootKey : fail("A thread root key is invalid.");
    if (kind === "ai" && threadRootKey !== null) fail("An AI message must be top-level.");
    if (threadRootKey !== null) {
      const root = messageByKey.get(threadRootKey);
      if (!root || root.threadRootKey !== null) fail("A reply points at a missing or non-top-level thread root.");
      if (topLevel.get(threadRootKey) !== root) fail("A reply points at a message that is not a top-level root.");
      const count = (repliesPerRoot.get(threadRootKey) ?? 0) + 1;
      if (count > ROOM_ARCHIVE_LIMITS.repliesPerRoot) fail("A thread has too many replies.", "limit_exceeded");
      repliesPerRoot.set(threadRootKey, count);
    }

    const quote = readQuote(entry.quote, messageByKey, threadRootKey);
    const mentions = readMentions(entry.mentions, body, identityKeys, referencedIdentities, kind);
    mentionRows += mentions.length;
    if (mentionRows > ROOM_ARCHIVE_LIMITS.mentionRows) fail("This archive has too many mentions.", "limit_exceeded");
    const reactions = readReactions(entry.reactions, identityKeys, referencedIdentities, latest);
    reactionRows += reactions.length;
    if (reactionRows > ROOM_ARCHIVE_LIMITS.reactionRows) fail("This archive has too many reactions.", "limit_exceeded");
    const attachments = readAttachments(entry.attachments, assetKeys, attachmentKeys, latest, kind);
    for (const attachment of attachments) {
      assetUsed.add(attachment.asset);
      attachmentBytes += assetSizesOf(attachment.asset, options);
      if (attachmentBytes > ROOM_ARCHIVE_LIMITS.attachmentTotalBytes) fail("Attachments exceed the archive size limit.", "limit_exceeded");
      attachmentCount++;
    }
    if (attachmentCount > ROOM_ARCHIVE_LIMITS.attachmentRefs) fail("This archive has too many attachments.", "limit_exceeded");
    if (kind === "human" && !body.trim() && attachments.length === 0) fail("A human message needs text or an attachment.");

    const message: RoomArchiveMessage = {
      key: entry.key,
      order: index + 1,
      kind,
      authorKey,
      body,
      createdAt: entry.createdAt,
      editedAt: entry.editedAt === null ? null : entry.editedAt,
      threadRootKey,
      quote,
      mentions,
      reactions,
      attachments,
    };
    messages.push(message);
    messageByKey.set(message.key, message);
    if (threadRootKey === null) topLevel.set(message.key, message);
  });

  for (const identityKey of referencedIdentities) {
    if (!identityKeys.has(identityKey)) fail("A message references an identity that was not exported.");
  }
  for (const asset of assetKeys) {
    if (!assetUsed.has(asset)) fail("The archive contains an unreferenced asset.", "invalid_archive", asset);
  }
  for (const identity of identities) {
    if (!memberKeys.has(identity.key) && !referencedIdentities.has(identity.key)) fail("The archive bundles an unrelated account identity.");
  }

  const roots = messages.filter((message) => message.threadRootKey === null).length;
  const stats: RoomArchiveStats = {
    roots,
    replies: messages.length - roots,
    attachments: attachmentCount,
    distinctAssets: assets.length,
    attachmentBytes,
    mentionRows,
    reactionRows,
    identities: identities.length,
    members: members.length,
  };
  return {
    manifest: { format: ROOM_ARCHIVE_FORMAT, version: ROOM_ARCHIVE_VERSION, exportedAt, room, selection, identities, members, messages, assets },
    stats,
  };
}

const assetSizesOf = (hash: string, options: ValidateOptions): number => options.assetSizes.get(hash) ?? 0;

function exact(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`A ${label} has an unknown property.`);
  for (const key of allowed) if (!(key in value)) fail(`A ${label} is missing a property.`);
}

function readRoom(value: unknown, latest: number): RoomArchiveV1["room"] {
  if (!isRecord(value)) fail("The room block is invalid.");
  exact(value, ["key", "name", "description", "icon", "visibility", "archivedAt", "createdAt", "updatedAt"], "room");
  if (!isRoomArchiveKey(value.key)) fail("The room key is invalid.");
  const name = readName(value.name, "room");
  const description = readDescription(value.description);
  if (typeof value.icon !== "string" || !(CHANNEL_ICONS as readonly string[]).includes(value.icon)) fail("The room icon is invalid.");
  if (typeof value.visibility !== "string" || !(CHANNEL_VISIBILITIES as readonly string[]).includes(value.visibility)) fail("The room visibility is invalid.");
  if (!isSafeInt(value.createdAt) || value.createdAt < 0 || value.createdAt > latest) fail("The room creation time is invalid.");
  if (!isSafeInt(value.updatedAt) || value.updatedAt < value.createdAt || value.updatedAt > latest) fail("The room update time is invalid.");
  const archivedAt = value.archivedAt;
  if (archivedAt !== null && (!isSafeInt(archivedAt) || archivedAt < value.createdAt || archivedAt > latest)) fail("The archive timestamp is invalid.");
  return {
    key: value.key,
    name,
    description,
    icon: value.icon as RoomArchiveV1["room"]["icon"],
    visibility: value.visibility as ChannelVisibility,
    archivedAt: archivedAt as number | null,
    createdAt: value.createdAt as number,
    updatedAt: value.updatedAt as number,
  };
}

function readSelection(value: unknown): RoomArchiveV1["selection"] {
  if (!isRecord(value)) fail("The selection block is invalid.");
  exact(value, ["mode", "includedReplies"], "selection");
  if (value.mode !== "all" && value.mode !== "roots") fail("The archive selection is invalid.");
  if (typeof value.includedReplies !== "boolean") fail("The archive selection is invalid.");
  return { mode: value.mode, includedReplies: value.includedReplies };
}

function readIdentity(value: unknown): RoomArchiveIdentity {
  if (!isRecord(value)) fail("An identity is invalid.");
  const allowed = "email" in value ? ["key", "localId", "displayName", "localProof", "email"] : ["key", "localId", "displayName", "localProof"];
  exact(value, allowed, "identity");
  if (!isRoomArchiveKey(value.key)) fail("An identity key is invalid.");
  const absent = value.localId === null && value.displayName === null && value.localProof === null;
  if (!absent) {
    if (!isRoomArchiveKey(value.localId)) fail("An identity local id is invalid.");
    if (typeof value.localProof !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.localProof)) fail("An identity proof is invalid.");
    if (typeof value.displayName !== "string") fail("An identity display name is invalid.");
    readDisplayName(value.displayName);
  }
  const identity: RoomArchiveIdentity = {
    key: value.key,
    localId: value.localId as string | null,
    displayName: value.displayName as string | null,
    localProof: value.localProof as string | null,
  };
  if ("email" in value) {
    if (typeof value.email !== "string") fail("An identity email is invalid.");
    readEmail(value.email);
    identity.email = value.email;
  }
  return identity;
}

function readMember(value: unknown, identities: Set<string>, latest: number): RoomArchiveMember {
  if (!isRecord(value)) fail("A member is invalid.");
  exact(value, ["identityKey", "role", "joinedAt"], "member");
  if (!isRoomArchiveKey(value.identityKey) || !identities.has(value.identityKey)) fail("A member references a missing identity.");
  if (typeof value.role !== "string" || !(CHANNEL_ROLES as readonly string[]).includes(value.role)) fail("A member role is invalid.");
  if (!isSafeInt(value.joinedAt) || value.joinedAt < 0 || value.joinedAt > latest) fail("A member join time is invalid.");
  return { identityKey: value.identityKey, role: value.role as ChannelRole, joinedAt: value.joinedAt };
}

function readQuote(value: unknown, messages: Map<string, RoomArchiveMessage>, threadRootKey: string | null): RoomArchiveQuote {
  if (value === null) return null;
  if (!isRecord(value)) fail("A quote is invalid.");
  if (value.kind === "unavailable") {
    exact(value, ["kind"], "quote");
    return { kind: "unavailable" };
  }
  if (value.kind !== "message") fail("A quote kind is invalid.");
  exact(value, ["kind", "messageKey"], "quote");
  if (!isRoomArchiveKey(value.messageKey)) fail("A quote key is invalid.");
  const target = messages.get(value.messageKey);
  if (!target) fail("A quote points at a missing message.");
  if (threadRootKey === null) {
    if (target.threadRootKey !== null) fail("A top-level quote must target a top-level message.");
  } else if (target.key !== threadRootKey && target.threadRootKey !== threadRootKey) {
    fail("A reply quote must target its root or an earlier reply in the same thread.");
  }
  return { kind: "message", messageKey: value.messageKey };
}

function readMentions(value: unknown, body: string, identities: Set<string>, referenced: Set<string>, kind: "human" | "ai"): RoomArchiveMessage["mentions"] {
  if (!Array.isArray(value)) fail("A message has no mention list.");
  if (kind === "ai" && value.length) fail("An AI message cannot mention an account.");
  if (value.length > ROOM_ARCHIVE_LIMITS.mentionsPerMessage) fail("A message has too many mentions.", "limit_exceeded");
  const seen = new Set<string>();
  const spans: Array<[number, number]> = [];
  return value.map((entry) => {
    if (!isRecord(entry)) fail("A mention is invalid.");
    exact(entry, ["identityKey", "start", "end"], "mention");
    if (!isRoomArchiveKey(entry.identityKey) || !identities.has(entry.identityKey)) fail("A mention references a missing identity.");
    if (seen.has(entry.identityKey)) fail("A message mentions an identity twice.");
    seen.add(entry.identityKey);
    if (!isSafeInt(entry.start) || !isSafeInt(entry.end) || entry.start < 0 || entry.end <= entry.start || entry.end > body.length) fail("A mention span is invalid.");
    const start = entry.start as number;
    const end = entry.end as number;
    if (body.charCodeAt(start) !== 64) fail("A mention must start at an @ character.");
    if (start > 0 && isHighSurrogate(body.charCodeAt(start - 1)) && isLowSurrogate(body.charCodeAt(start))) fail("A mention splits a surrogate pair.");
    if (end < body.length && isHighSurrogate(body.charCodeAt(end - 1)) && isLowSurrogate(body.charCodeAt(end))) fail("A mention splits a surrogate pair.");
    for (const [otherStart, otherEnd] of spans) if (start < otherEnd && otherStart < end) fail("Mentions overlap.");
    spans.push([start, end]);
    referenced.add(entry.identityKey);
    return { identityKey: entry.identityKey, start, end };
  });
}

function readReactions(value: unknown, identities: Set<string>, referenced: Set<string>, latest: number): RoomArchiveMessage["reactions"] {
  if (!Array.isArray(value)) fail("A message has no reaction list.");
  const seen = new Set<string>();
  const perIdentity = new Map<string, Set<string>>();
  const perEmoji = new Map<string, Set<string>>();
  return value.map((entry) => {
    if (!isRecord(entry)) fail("A reaction is invalid.");
    exact(entry, ["identityKey", "emoji", "createdAt"], "reaction");
    if (!isRoomArchiveKey(entry.identityKey) || !identities.has(entry.identityKey)) fail("A reaction references a missing identity.");
    if (typeof entry.emoji !== "string" || !(CHANNEL_REACTIONS as readonly string[]).includes(entry.emoji)) fail("A reaction emoji is unsupported.");
    if (!isSafeInt(entry.createdAt) || entry.createdAt < 0 || entry.createdAt > latest) fail("A reaction timestamp is invalid.");
    const key = `${entry.identityKey}\u0000${entry.emoji}`;
    if (seen.has(key)) fail("A reaction is listed twice.");
    seen.add(key);
    const mine = perIdentity.get(entry.identityKey) ?? new Set<string>();
    if (!mine.has(entry.emoji)) {
      if (mine.size >= ROOM_ARCHIVE_LIMITS.reactionsPerIdentity) fail("An identity has too many reactions on one message.", "limit_exceeded");
      mine.add(entry.emoji);
    }
    perIdentity.set(entry.identityKey, mine);
    const same = perEmoji.get(entry.emoji) ?? new Set<string>();
    same.add(entry.identityKey);
    if (same.size > ROOM_ARCHIVE_LIMITS.reactionIdentitiesPerEmoji) fail("Too many identities used one reaction.", "limit_exceeded");
    perEmoji.set(entry.emoji, same);
    referenced.add(entry.identityKey);
    return { identityKey: entry.identityKey, emoji: entry.emoji as ChannelReaction, createdAt: entry.createdAt };
  });
}

function readAttachments(
  value: unknown,
  assets: Set<string>,
  keys: Set<string>,
  latest: number,
  kind: "human" | "ai",
): RoomArchiveAttachmentEntry[] {
  if (!Array.isArray(value)) fail("A message has no attachment list.");
  if (kind === "ai" && value.length) fail("An AI message cannot carry attachments.");
  if (value.length > ROOM_ARCHIVE_LIMITS.attachmentsPerMessage) fail("A message has too many attachments.", "limit_exceeded");
  return value.map((entry) => {
    if (!isRecord(entry)) fail("An attachment is invalid.");
    exact(entry, ["key", "asset", "name", "declaredMime", "createdAt"], "attachment");
    if (!isRoomArchiveKey(entry.key)) fail("An attachment key is invalid.");
    if (keys.has(entry.key)) fail("An attachment key is used twice.");
    keys.add(entry.key);
    if (!isRoomArchiveHash(entry.asset) || !assets.has(entry.asset)) fail("An attachment references a missing asset.");
    const name = readAttachmentName(entry.name);
    const declaredMime = readMime(entry.declaredMime);
    if (!isSafeInt(entry.createdAt) || entry.createdAt < 0 || entry.createdAt > latest) fail("An attachment timestamp is invalid.");
    return { key: entry.key, asset: entry.asset, name, declaredMime, createdAt: entry.createdAt };
  });
}

// ---------------------------------------------------------------------------------------------------
// Text helpers shared with the exporter.
// ---------------------------------------------------------------------------------------------------

export function readBody(value: unknown, kind: "human" | "ai"): string {
  if (typeof value !== "string") fail("A message body is invalid.");
  if (CRLF.test(value)) fail("A message body contains a carriage return.");
  if (CONTROL.test(value)) fail("A message body contains a control character.");
  const bytes = Buffer.byteLength(value, "utf8");
  if (kind === "human" && ([...value].length > 8000 || bytes > 32 * 1024)) fail("A human message is too long.", "limit_exceeded");
  if (kind === "ai" && bytes > 64 * 1024) fail("An AI message is too long.", "limit_exceeded");
  if (/!\[[^\]]*\]\([^)]*\)/u.test(value) || /okaychat-upload:/iu.test(value)) fail("A message contains an image or app upload reference.");
  return value;
}

export function readName(value: unknown, label: string): string {
  if (typeof value !== "string") fail(`A ${label} name is invalid.`);
  if (value !== value.trim()) fail(`A ${label} name is not canonical.`);
  const chars = [...value].length;
  if (chars < 1 || chars > 80) fail(`A ${label} name is too long.`, "limit_exceeded");
  if (CONTROL.test(value)) fail(`A ${label} name contains a control character.`);
  return value;
}

export function readDescription(value: unknown): string {
  if (typeof value !== "string") fail("A room description is invalid.");
  if (CRLF.test(value) || CONTROL.test(value)) fail("A room description contains a control or carriage return.");
  if ([...value].length > 2000 || Buffer.byteLength(value, "utf8") > 8 * 1024) fail("A room description is too long.", "limit_exceeded");
  return value;
}

export function readAttachmentName(value: unknown): string {
  if (typeof value !== "string") fail("An attachment name is invalid.");
  if (!value || value !== value.trim()) fail("An attachment name is not canonical.");
  if ([...value].length > 200) fail("An attachment name is too long.", "limit_exceeded");
  if (CONTROL.test(value) || /[\\/]/u.test(value) || value === "." || value === "..") fail("An attachment name is unsafe.");
  return value;
}

export function readMime(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "ascii") > 100) fail("An attachment MIME type is invalid.");
  if (!/^[\x21-\x7e]+\/[\x21-\x7e]+$/.test(value)) fail("An attachment MIME type is invalid.");
  return value;
}

export function readDisplayName(value: string): string {
  if (value !== value.trim()) fail("A historical display name is not canonical.");
  if ([...value].length > 200 || Buffer.byteLength(value, "utf8") > 800) fail("A historical display name is too long.", "limit_exceeded");
  if (CONTROL.test(value)) fail("A historical display name contains a control character.");
  if (!value) fail("A historical display name is empty.");
  return value;
}

const MAILBOX = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function readEmail(value: string): string {
  if (Buffer.byteLength(value, "ascii") > 254 || !MAILBOX.test(value)) fail("An identity email is invalid.");
  return value;
}

/** Export-side normalization: strip any path component and control characters, then validate. */
export function exportAttachmentName(raw: string): string {
  const base = raw.split(/[\\/]/u).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, 200);
  return readAttachmentName(clean || "file");
}

/** Bodies are exported exactly as stored, but a legacy CRLF cannot be represented. */
export function exportBody(raw: string, kind: "human" | "ai"): string {
  return readBody(raw.replace(/\r\n/gu, "\n"), kind);
}
