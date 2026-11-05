import { createHash } from "node:crypto";
import { Unzip, UnzipInflate, zipSync } from "fflate";
import type { ArchiveAssetEntry, ArchiveChat, ArchiveManifest, ArchiveMessage, ArchivePart } from "../shared/chat-archive.js";
import {
  ARCHIVE_FORMAT,
  ARCHIVE_LIMITS,
  ARCHIVE_VERSION,
  isArchiveKey,
  isAssetHash,
} from "../shared/chat-archive.js";
import { ASSISTANT_ICONS, MAX_PRESET_INSTRUCTIONS } from "../shared/assistant-presets.js";
import { newId } from "./crypto.js";
import { AppError } from "./errors.js";

/**
 * Native archive v1 wire format. A manifest plus one stored entry per asset hash. Reading is bounded at
 * every step: compressed input, expanded bytes, entry count, JSON depth, string length, graph depth, and
 * every declared size and hash is rechecked against the actual bytes.
 */

export class ArchiveFormatError extends Error {}

export interface ReadArchive {
  manifest: ArchiveManifest;
  assets: Map<string, Uint8Array>;
}

function fail(message: string): never {
  throw new ArchiveFormatError(message);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown, max = ARCHIVE_LIMITS.stringBytes): value is string => typeof value === "string" && Buffer.byteLength(value) <= max;
const isTime = (value: unknown, max: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
const safeString = (value: unknown, max: number): string => (isString(value, max) ? value : fail("A value is too long."));

/** JSON nesting is bounded before any recursive walk can be asked to descend arbitrarily deep. */
function checkDepth(value: unknown): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (stack.length) {
    const item = stack.pop()!;
    if (item.depth > ARCHIVE_LIMITS.jsonDepth) fail("JSON is nested too deeply.");
    const candidate = item.value;
    if (Array.isArray(candidate)) for (const child of candidate) stack.push({ value: child, depth: item.depth + 1 });
    else if (isRecord(candidate)) for (const child of Object.values(candidate)) stack.push({ value: child, depth: item.depth + 1 });
    else if (typeof candidate === "string" && Buffer.byteLength(candidate) > ARCHIVE_LIMITS.stringBytes) fail("A string in the manifest is too long.");
  }
}

const allowedEntry = (name: string) => name === "manifest.json" || /^assets\/[a-f0-9]{64}$/.test(name);

/** Streams one stored/deflated entry with a hard output ceiling, so a lying header cannot allocate. */
function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const entries = new Map<string, Uint8Array>();
  let total = 0;
  let failure: Error | undefined;
  const guard = () => {
    if (failure) throw failure;
  };
  const unzip = new Unzip((file) => {
    try {
      if (failure) return;
      if (!allowedEntry(file.name)) throw new ArchiveFormatError("The archive contains an unexpected file.");
      if (entries.has(file.name)) throw new ArchiveFormatError("The archive contains duplicate entries.");
      if (file.compression !== 0 && file.compression !== 8) throw new ArchiveFormatError("Unsupported compression method.");
      const chunks: Uint8Array[] = [];
      let size = 0;
      file.ondata = (error, chunk, final) => {
        if (failure) return;
        if (error) {
          failure = new ArchiveFormatError("The archive entry could not be read.");
          return;
        }
        size += chunk.byteLength;
        total += chunk.byteLength;
        if (size > ARCHIVE_LIMITS.entryBytes || total > ARCHIVE_LIMITS.expandedBytes) {
          failure = new ArchiveFormatError("The archive expands beyond the supported size.");
          return;
        }
        if (chunk.byteLength) chunks.push(chunk);
        if (final) {
          if (file.originalSize !== undefined && file.originalSize !== size) {
            failure = new ArchiveFormatError("An entry's declared size does not match its bytes.");
            return;
          }
          const joined = new Uint8Array(size);
          let at = 0;
          for (const part of chunks) {
            joined.set(part, at);
            at += part.byteLength;
          }
          entries.set(file.name, joined);
        }
      };
      file.start();
    } catch (error) {
      failure = error instanceof Error ? error : new ArchiveFormatError("The archive could not be read.");
    }
  });
  unzip.register(UnzipInflate);
  try {
    unzip.push(bytes, true);
  } catch {
    failure ??= new ArchiveFormatError("The file is not a valid ZIP archive.");
  }
  guard();
  if (failure) throw failure;
  if (entries.size > ARCHIVE_LIMITS.entries) throw new ArchiveFormatError("The archive contains too many entries.");
  return entries;
}

const partValidator = (part: unknown, assets: Set<string>, artifactKeys: Set<string>): ArchivePart => {
  if (!isRecord(part) || typeof part.type !== "string") fail("A message part is invalid.");
  switch (part.type) {
    case "text":
    case "reasoning":
      return { type: part.type, text: safeString(part.text, ARCHIVE_LIMITS.stringBytes) };
    case "file": {
      const asset = part.asset === null ? null : isAssetHash(part.asset) ? part.asset : fail("A file asset hash is invalid.");
      if (asset && !assets.has(asset)) fail("A file references a missing asset.");
      if (part.missing !== (asset === null)) fail("A file's missing marker does not match its asset.");
      return {
        type: "file",
        asset,
        name: safeString(part.name, ARCHIVE_LIMITS.fileNameCodePoints * 4),
        mime: safeString(part.mime, ARCHIVE_LIMITS.mimeChars),
        missing: part.missing === true,
      };
    }
    case "source": {
      const url = safeString(part.url, ARCHIVE_LIMITS.stringBytes);
      if (!/^https?:\/\//i.test(url)) fail("A source URL must use http or https.");
      return { type: "source", title: safeString(part.title, 2000), url };
    }
    case "tool-record": {
      if (part.state !== "completed" && part.state !== "failed" && part.state !== "interrupted") fail("Unknown tool state.");
      const referencesRaw = part.references ?? [];
      if (!Array.isArray(referencesRaw) || referencesRaw.length > 500) fail("Too many tool references.");
      const references = referencesRaw.map((reference) => {
        if (!isRecord(reference) || (reference.kind !== "asset" && reference.kind !== "artifact") || !isArchiveKey(reference.key)) fail("A tool reference is invalid.");
        if (reference.kind === "asset" && !assets.has(reference.key)) fail("A tool references a missing asset.");
        // Artifact references are checked after the chat's artifact list is validated.
        return {
          kind: reference.kind as "asset" | "artifact",
          key: reference.key,
          ...(typeof reference.version === "number" && Number.isSafeInteger(reference.version) && reference.version > 0 ? { version: reference.version } : {}),
        };
      });
      if (part.name === "generate_video") return {type:"tool-record",name:"generate_video",input:null,output:{note:"Video not included"},state:"interrupted",references:[]};
      return {
        type: "tool-record",
        name: safeString(part.name, 200),
        input: part.input ?? null,
        output: part.output ?? null,
        state: part.state,
        references,
      };
    }
    default:
      return fail("An unknown message part type was found.");
  }
};

function validateManifest(raw: unknown, assets: Map<string, Uint8Array>, now: number): ArchiveManifest {
  if (!isRecord(raw)) fail("The manifest is not an object.");
  checkDepth(raw);
  if (raw.format !== ARCHIVE_FORMAT) fail("This is not an okaychat archive.");
  if (raw.version !== ARCHIVE_VERSION) fail("This archive version is not supported.");
  const latest = now + 24 * 60 * 60_000;
  const exportedAt = raw.exportedAt;
  if (!isTime(exportedAt, latest)) fail("The archive timestamp is invalid.");
  if (!Array.isArray(raw.chats) || raw.chats.length > ARCHIVE_LIMITS.chats) fail("This archive has too many chats.");
  if (!Array.isArray(raw.assets) || raw.assets.length > ARCHIVE_LIMITS.assets) fail("This archive has too many files.");

  const assetHashes = new Set<string>();
  const assetEntries: ArchiveAssetEntry[] = raw.assets.map((entry) => {
    if (!isRecord(entry) || !isAssetHash(entry.key) || typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0) {
      fail("An asset entry is invalid.");
    }
    if (assetHashes.has(entry.key)) fail("Duplicate asset entries.");
    assetHashes.add(entry.key);
    const bytes = assets.get(entry.key);
    if (!bytes) fail("The archive is missing an entry it lists.");
    if (bytes.byteLength !== entry.size) fail("An asset's declared size does not match its bytes.");
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== entry.key) fail("An asset's hash does not match its bytes.");
    const mime = safeString(entry.mime, ARCHIVE_LIMITS.mimeChars);
    if (mime.toLowerCase().startsWith("video/")) fail("Video bytes are not supported in chat archives.");
    if (!/^[\x21-\x7e]+\/[\x21-\x7e]+$/.test(mime)) fail("An asset MIME type is invalid.");
    return {
      key: entry.key,
      size: entry.size,
      mime,
      name: safeString(entry.name, ARCHIVE_LIMITS.fileNameCodePoints),
    };
  });

  const referenced = new Set<string>();
  let totalMessages = 0;
  let totalVersions = 0;
  const chats: ArchiveChat[] = raw.chats.map((chat) => {
    if (!isRecord(chat) || !isArchiveKey(chat.key)) fail("A chat key is invalid.");
    const title = chat.title === null ? null : safeString(chat.title, ARCHIVE_LIMITS.titleCodePoints * 4);
    if (!isTime(chat.createdAt, latest) || !isTime(chat.updatedAt, latest)) fail("A chat timestamp is invalid.");
    if (chat.status !== "regular" && chat.status !== "archived") fail("A chat status is invalid.");
    const modelRef = chat.modelRef === null ? null : safeString(chat.modelRef, 300);
    if (!Array.isArray(chat.messages)) fail("A chat has no message list.");
    totalMessages += chat.messages.length;
    if (totalMessages > ARCHIVE_LIMITS.messages) fail("This archive has too many messages.");

    const keys = new Set<string>();
    const parents = new Map<string, string | null>();
    const messages = chat.messages.map((message) => {
      if (!isRecord(message) || !isArchiveKey(message.key)) fail("A message key is invalid.");
      if (keys.has(message.key)) fail("Duplicate message keys.");
      keys.add(message.key);
      const parentKey = message.parentKey === null ? null : isArchiveKey(message.parentKey) ? message.parentKey : fail("A parent key is invalid.");
      parents.set(message.key, parentKey);
      if (message.role !== "user" && message.role !== "assistant") fail("A message role is invalid.");
      if (!isTime(message.createdAt, latest)) fail("A message timestamp is invalid.");
      if (!Array.isArray(message.parts) || message.parts.length > ARCHIVE_LIMITS.partsPerMessage) fail("A message has too many parts.");
      const parts = message.parts.map((part) => {
        const parsed = partValidator(part, assetHashes, new Set());
        if (parsed.type === "file" && parsed.asset) referenced.add(parsed.asset);
        return parsed;
      });
      const generation = isRecord(message.generation) ? message.generation : undefined;
      return {
        key: message.key,
        parentKey,
        createdAt: message.createdAt,
        role: message.role,
        parts,
        ...(generation
          ? {
              generation: {
                ...(typeof generation.modelRef === "string" ? { modelRef: generation.modelRef.slice(0, 300) } : {}),
                ...(typeof generation.assistantName === "string" ? { assistantName: generation.assistantName.slice(0, 80) } : {}),
                ...(typeof generation.assistantIcon === "string" && (ASSISTANT_ICONS as readonly string[]).includes(generation.assistantIcon)
                  ? { assistantIcon: generation.assistantIcon as (typeof ASSISTANT_ICONS)[number] }
                  : {}),
                ...(typeof generation.cost === "number" && Number.isFinite(generation.cost) && generation.cost >= 0 ? { cost: generation.cost } : {}),
                ...(typeof generation.durationMs === "number" && Number.isFinite(generation.durationMs) && generation.durationMs >= 0 ? { durationMs: generation.durationMs } : {}),
                ...(generation.finishReason === "stop" || generation.finishReason === "length" || generation.finishReason === "tool-calls" || generation.finishReason === "content-filter" || generation.finishReason === "error" || generation.finishReason === "other" || generation.finishReason === "unknown"
                  ? { finishReason: generation.finishReason }
                  : {}),
              },
            }
          : {}),
      } satisfies ArchiveMessage;
    });

    // Iterative graph checks: every parent exists, no cycle, and depth stays bounded.
    for (const message of messages) {
      if (message.parentKey !== null && !keys.has(message.parentKey)) fail("A message references a missing parent.");
      let depth = 0;
      let cursor: string | null = message.key;
      const seen = new Set<string>();
      while (cursor !== null) {
        if (seen.has(cursor)) fail("The message graph has a cycle.");
        seen.add(cursor);
        if (++depth > ARCHIVE_LIMITS.graphDepth) fail("The message graph is too deep.");
        cursor = parents.get(cursor) ?? null;
      }
    }

    const artifactKeys = new Set<string>();
    if (!Array.isArray(chat.artifacts)) fail("A chat has no artifact list.");
    totalVersions += chat.artifacts.length;
    if (totalVersions > ARCHIVE_LIMITS.artifactVersions) fail("This archive has too many artifact versions.");
    const artifactVersions = new Map<string, number>();
    const artifacts = chat.artifacts.map((artifact) => {
      if (!isRecord(artifact) || !isArchiveKey(artifact.key)) fail("An artifact key is invalid.");
      artifactKeys.add(artifact.key);
      if (!Number.isSafeInteger(artifact.version) || (artifact.version as number) < 1) fail("An artifact version is invalid.");
      const version = artifact.version as number;
      const existing = artifactVersions.get(artifact.key);
      if (existing !== undefined && version !== existing + 1) fail("Artifact versions are not contiguous.");
      artifactVersions.set(artifact.key, version);
      if (!isTime(artifact.createdAt, latest)) fail("An artifact timestamp is invalid.");
      const fileAsset = artifact.fileAsset === null ? null : isAssetHash(artifact.fileAsset) ? artifact.fileAsset : fail("An artifact asset hash is invalid.");
      if (fileAsset && !assetHashes.has(fileAsset)) fail("An artifact references a missing asset.");
      if (fileAsset) referenced.add(fileAsset);
      return {
        key: artifact.key,
        version,
        title: safeString(artifact.title, ARCHIVE_LIMITS.titleCodePoints * 4),
        kind: safeString(artifact.kind, 40),
        language: artifact.language === null ? null : safeString(artifact.language, 40),
        content: safeString(artifact.content, ARCHIVE_LIMITS.stringBytes),
        fileAsset,
        createdAt: artifact.createdAt,
      };
    });

    // Tool references may point at artifacts, which are collected per chat; revalidate them now.
    for (const message of messages) {
      for (const part of message.parts) {
        if (part.type !== "tool-record") continue;
        for (const reference of part.references) {
          if (reference.kind === "artifact" && !artifactKeys.has(reference.key)) fail("A tool references a missing artifact.");
          if (reference.kind === "asset") referenced.add(reference.key);
        }
      }
    }

    const selectedLeaf = chat.selectedLeaf;
    if (selectedLeaf !== null) {
      if (!isArchiveKey(selectedLeaf) || !keys.has(selectedLeaf)) fail("The selected leaf is missing.");
      if (messages.some((message) => message.parentKey === selectedLeaf)) fail("The selected leaf is not a leaf.");
    } else if (messages.length) {
      fail("The archive does not name its visible leaf.");
    }

    const assistant = chat.assistant === null ? null : validatePortableAssistant(chat.assistant);
    return {
      key: chat.key,
      title,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      status: chat.status,
      modelRef,
      selectedLeaf,
      messages,
      artifacts,
      assistant,
    };
  });

  for (const hash of assetHashes) if (!referenced.has(hash)) fail("The archive contains an unreferenced asset.");
  return { format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION, exportedAt, chats, assets: assetEntries };
}

function validatePortableAssistant(raw: unknown): ArchiveChat["assistant"] {
  if (!isRecord(raw)) fail("The assistant block is invalid.");
  const instructions = safeString(raw.instructions, MAX_PRESET_INSTRUCTIONS * 4);
  const icon = typeof raw.icon === "string" && (ASSISTANT_ICONS as readonly string[]).includes(raw.icon) ? (raw.icon as (typeof ASSISTANT_ICONS)[number]) : "sparkles";
  const samplingRaw = isRecord(raw.sampling) ? raw.sampling : {};
  const sampling: { temperature?: number; topP?: number; maxOutputTokens?: number } = {};
  for (const key of ["temperature", "topP", "maxOutputTokens"] as const) {
    const value = samplingRaw[key];
    if (typeof value === "number" && Number.isFinite(value)) sampling[key] = value;
  }
  const builtins = Array.isArray(raw.builtins) ? raw.builtins.filter((entry): entry is string => typeof entry === "string").slice(0, 20) : [];
  return {
    name: safeString(raw.name, 320),
    icon,
    instructions,
    modelRef: raw.modelRef === null ? null : typeof raw.modelRef === "string" ? raw.modelRef.slice(0, 300) : null,
    sampling,
    ...(typeof raw.reasoningEffort === "string" ? { reasoningEffort: raw.reasoningEffort.slice(0, 20) } : {}),
    builtins,
    omittedTools: raw.omittedTools === true,
    omittedKnowledge: raw.omittedKnowledge === true,
  };
}

/** Parses an uploaded archive within every bound. Throws `ArchiveFormatError` for an unusable file. */
export function readArchive(bytes: Uint8Array, now = Date.now()): ReadArchive {
  if (bytes.byteLength > ARCHIVE_LIMITS.uploadBytes) throw new ArchiveFormatError("The archive is too large.");
  const entries = readZip(bytes);
  const manifestBytes = entries.get("manifest.json");
  if (!manifestBytes) throw new ArchiveFormatError("The archive has no manifest.");
  if (manifestBytes.byteLength > ARCHIVE_LIMITS.manifestBytes) throw new ArchiveFormatError("The manifest is too large.");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes);
  if (text.charCodeAt(0) === 0xfeff) throw new ArchiveFormatError("The manifest must not start with a BOM.");
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new ArchiveFormatError("The manifest is not valid JSON.");
  }
  const assets = new Map<string, Uint8Array>();
  for (const [name, data] of entries) {
    if (name === "manifest.json") continue;
    assets.set(name.slice("assets/".length), data);
  }
  const manifest = validateManifest(raw, assets, now);
  return { manifest, assets };
}

/** Builds the ZIP with stored entries; the manifest is a normal entry too. */
export function writeArchive(manifest: ArchiveManifest, assets: Map<string, Uint8Array>): Uint8Array {
  const files: Record<string, Uint8Array> = { "manifest.json": new TextEncoder().encode(JSON.stringify(manifest)) };
  for (const [hash, bytes] of assets) files[`assets/${hash}`] = bytes;
  // ZIP stores MS-DOS dates; clamp a legitimate ancient timestamp so export never throws on it.
  return zipSync(files, { level: 0, mtime: Math.max(manifest.exportedAt, Date.UTC(1980, 0, 1)) });
}

/** Download name in UTC: okaychat-chats-YYYYMMDD-HHMMSS.okaychat.zip. */
export function archiveFileName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `okaychat-chats-${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}.okaychat.zip`;
}

/** A hash used for an asset; exported so tests can construct fixtures. */
export const assetHash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export const archiveThreadId = () => newId("thr");

/** Clear, safe error mapping for the route boundary. */
export const isArchiveFormatError = (error: unknown): error is ArchiveFormatError => error instanceof ArchiveFormatError;
