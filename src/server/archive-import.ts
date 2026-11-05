import type { ArchiveChat, ArchiveManifest, ArchiveMessage, ArchiveSummary, ArchiveWarning } from "../shared/chat-archive.js";
import { ARCHIVE_LIMITS } from "../shared/chat-archive.js";
import type { UIMessage } from "ai";
import { putMedia } from "./media/store.js";
import { sniffRaster } from "./media/sniff.js";
import { db, tx } from "./db.js";
import { AppError } from "./errors.js";
import { newId } from "./crypto.js";
import { assertStorage, messageBytes } from "./quota.js";
import { uploadRef } from "./media/refs.js";

/**
 * Import validation and the all-or-nothing commit. Validation is pure against the parsed manifest;
 * commit allocates fresh owned ids, writes durable bytes, and inserts every chat in one transaction.
 * Import never connects to a provider, mailbox, MCP server, sandbox, or knowledge index.
 */

export interface ImportPreview {
  summary: ArchiveSummary;
  byKey: Map<string, ArchiveChat>;
}

/** Counts and warnings shown before the user confirms. No raw manifest is sent to the browser. */
export function previewArchive(manifest: ArchiveManifest, assets: Map<string, Uint8Array>, availableModels: ReadonlySet<string>): ImportPreview {
  const byKey = new Map<string, ArchiveChat>();
  const chats: ArchiveSummary["chats"] = manifest.chats.map((chat) => {
    byKey.set(chat.key, chat);
    const warnings: ArchiveWarning[] = [];
    let bytes = 0;
    let missing = 0;
    for (const message of chat.messages) {
      for (const part of message.parts) {
        if (part.type === "file") {
          if (part.asset) bytes += assets.get(part.asset)?.byteLength ?? 0;
          if (part.missing) missing++;
        }
        if (part.type === "tool-record") {
          for (const reference of part.references) {
            if (reference.kind === "asset") bytes += assets.get(reference.key)?.byteLength ?? 0;
          }
        }
      }
    }
    for (const artifact of chat.artifacts) if (artifact.fileAsset) bytes += assets.get(artifact.fileAsset)?.byteLength ?? 0;
    if (missing) warnings.push({ code: "missingAsset", count: missing });
    if (chat.assistant?.omittedTools) warnings.push({ code: "mcpToolsOmitted", count: 1 });
    if (chat.assistant?.omittedKnowledge) warnings.push({ code: "knowledgeOmitted", count: 1 });
    if (chat.assistant) warnings.push({ code: "portableSettingsInactive", count: 1 });
    if (chat.modelRef && !availableModels.has(chat.modelRef)) warnings.push({ code: "unknownModel", model: chat.modelRef });
    const leaves = new Set(chat.messages.map((message) => message.key));
    for (const message of chat.messages) if (message.parentKey) leaves.delete(message.parentKey);
    return {
      key: chat.key,
      title: chat.title,
      messages: chat.messages.length,
      branches: Math.max(1, leaves.size),
      assets: new Set(chat.messages.flatMap((message) => message.parts.flatMap((part) => (part.type === "file" && part.asset ? [part.asset] : part.type === "tool-record" ? part.references.filter((reference) => reference.kind === "asset").map((reference) => reference.key) : [])))).size,
      bytes,
      warnings,
    };
  });
  const assetBytes = [...assets.values()].reduce((sum, data) => sum + data.byteLength, 0);
  return {
    summary: {
      chats,
      totalBytes: assetBytes,
      lossyConversions: chats.reduce((sum, chat) => sum + chat.warnings.filter((entry) => entry.code === "missingAsset").length, 0),
    },
    byKey,
  };
}

export interface CommitInput {
  userId: string;
  manifest: ArchiveManifest;
  assets: Map<string, Uint8Array>;
  keys: string[];
  availableModels: ReadonlySet<string>;
}

export interface CommitResult {
  threads: Array<{ archiveKey: string; id: string; title: string | null }>;
  warnings: ArchiveWarning[];
}

interface AssetUpload {
  id: string;
  mime: string;
  name: string;
}

const TOPO_LIMIT = ARCHIVE_LIMITS.graphDepth;

/** Parents before children, ties by manifest order then timestamp. Iterative, never recursive. */
function topological(chat: ArchiveChat): ArchiveMessage[] {
  const byKey = new Map(chat.messages.map((message) => [message.key, message]));
  const depth = new Map<string, number>();
  for (const message of chat.messages) {
    const chain: string[] = [];
    let cursor: string | null = message.key;
    let guard = 0;
    while (cursor !== null && !depth.has(cursor)) {
      chain.push(cursor);
      if (++guard > TOPO_LIMIT) throw new AppError({ code: "validation", message: "The archive graph is too deep." });
      cursor = byKey.get(cursor)?.parentKey ?? null;
    }
    let level = cursor ? (depth.get(cursor) ?? 0) : 0;
    for (let i = chain.length - 1; i >= 0; i--) depth.set(chain[i]!, ++level);
  }
  return chat.messages
    .map((message, index) => ({ message, index }))
    .sort((a, b) => (depth.get(a.message.key) ?? 0) - (depth.get(b.message.key) ?? 0) || a.index - b.index || a.message.createdAt - b.message.createdAt)
    .map((entry) => entry.message);
}

/** One upload per distinct asset hash, reused across chats and threads in this import. */
function createUpload(userId: string, hash: string, data: Uint8Array, entry: { mime: string; name: string }): AssetUpload {
  const id = newId("upl");
  if (sniffRaster(data)) {
    const media = putMedia(userId, data, (bytes) => { assertStorage(userId, bytes); });
    db.prepare("INSERT INTO uploads (id, user_id, name, mime, data, created_at, media_id) VALUES (?, ?, ?, ?, x'', ?, ?)").run(
      id,
      userId,
      entry.name,
      media.media.mime,
      Date.now(),
      media.media.id,
    );
    return { id, mime: media.media.mime, name: entry.name };
  }
  assertStorage(userId, data.byteLength);
  db.prepare("INSERT INTO uploads (id, user_id, name, mime, data, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, userId, entry.name, entry.mime, Buffer.from(data), Date.now());
  return { id, mime: entry.mime, name: entry.name };
}

/** Imports the selected chats as new owned chats. Same keys on a done job are handled by the route. */
export function commitArchive(input: CommitInput): CommitResult {
  const wanted = [...new Set(input.keys)];
  if (!wanted.length) throw new AppError({ code: "validation", message: "Choose at least one chat." });
  const chats = wanted.map((key) => input.manifest.chats.find((chat) => chat.key === key));
  if (chats.some((chat) => !chat)) throw new AppError({ code: "validation", message: "A selected chat is not in this archive." });

  const warnings: ArchiveWarning[] = [];
  const threads: CommitResult["threads"] = [];
  return tx(() => {
    const uploads = new Map<string, AssetUpload>();
    const ensureUpload = (hash: string): AssetUpload => {
      const existing = uploads.get(hash);
      if (existing) return existing;
      const data = input.assets.get(hash);
      if (!data) throw new AppError({ code: "validation", message: "An archive file is missing." });
      const entry = input.manifest.assets.find((asset) => asset.key === hash)!;
      const upload = createUpload(input.userId, hash, data, entry);
      uploads.set(hash, upload);
      return upload;
    };

    for (const chat of chats as ArchiveChat[]) {
      const threadId = newId("thr");
      const messageIds = new Map<string, string>();
      for (const message of chat.messages) messageIds.set(message.key, newId("msg"));
      const artifactIds = new Map<string, string>();
      for (const artifact of chat.artifacts) if (!artifactIds.has(artifact.key)) artifactIds.set(artifact.key, newId("art"));

      // Build message rows first so one quota check and one insert pass cover the whole chat.
      const converted: Array<{ id: string; parentId: string | null; json: string; createdAt: number; imported: true }> = [];
      const ordered = topological(chat);
      for (const message of ordered) {
        const parts = message.parts.map((part) => {
          if (part.type === "text") return { type: "text", text: part.text };
          if (part.type === "reasoning") return { type: "reasoning", text: part.text };
          if (part.type === "source") return { type: "source-url", sourceId: newId("src"), url: part.url, title: part.title };
          if (part.type === "file") {
            if (!part.asset) {
              warnings.push({ code: "attachmentMissing", name: part.name });
              return { type: "text", text: `[Attachment not included: ${part.name}]` };
            }
            const upload = ensureUpload(part.asset);
            return { type: "file", filename: upload.name, mediaType: upload.mime, url: uploadRef(upload.id) };
          }
          // A historical tool is inert data: no tool call id, approval, callback, or retry affordance.
          const references = part.references.map((reference) =>
            reference.kind === "asset"
              ? { kind: "asset" as const, key: ensureUpload(reference.key).id }
              : { kind: "artifact" as const, key: artifactIds.get(reference.key) ?? reference.key, ...(reference.version ? { version: reference.version } : {}) },
          );
          return { type: "data-imported-tool", data: { name: part.name, input: part.input, output: part.output, state: part.state, references } };
        });
        const content = { role: message.role, parts, ...(message.generation ? { metadata: { custom: { importedGeneration: message.generation } } } : {}) };
        const json = JSON.stringify(content);
        converted.push({
          id: messageIds.get(message.key)!,
          parentId: message.parentKey ? (messageIds.get(message.parentKey) ?? null) : null,
          json,
          createdAt: message.createdAt,
          imported: true,
        });
      }
      assertStorage(input.userId, converted.reduce((sum, row) => sum + messageBytes(row.json), 0));

      const leaf = chat.selectedLeaf ? (messageIds.get(chat.selectedLeaf) ?? null) : null;
      const importedAssistant = chat.assistant ? JSON.stringify(chat.assistant) : null;
      if (importedAssistant) assertStorage(input.userId, Buffer.byteLength(importedAssistant));
      const modelRef = chat.modelRef && input.availableModels.has(chat.modelRef) ? chat.modelRef : null;
      db.prepare(
        `INSERT INTO threads (id, user_id, title, status, model_ref, project_id, compaction_json, memory_disabled, pinned, knowledge_ids, assistant_json, assistant_revision, imported_assistant_json, preferred_head, memory_cursor, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, 1, 0, '[]', NULL, 0, ?, ?, ?, ?, ?)`,
      ).run(threadId, input.userId, chat.title, chat.status, modelRef, importedAssistant, leaf, leaf, chat.createdAt, chat.updatedAt);

      const insert = db.prepare("INSERT INTO messages (id, thread_id, parent_id, format, content, bytes, created_at, imported) VALUES (?, ?, ?, 'ai-sdk/v6', ?, ?, ?, 1)");
      for (const row of converted) insert.run(row.id, threadId, row.parentId, row.json, messageBytes(row.json), row.createdAt);

      let artifactBytes = 0;
      for (const artifact of chat.artifacts) {
        const artifactId = artifactIds.get(artifact.key)!;
        const data = artifact.fileAsset ? input.assets.get(artifact.fileAsset) : undefined;
        artifactBytes += Buffer.byteLength(artifact.content, "utf8") + (data?.byteLength ?? 0);
        db.prepare("INSERT INTO artifacts (thread_id, id, version, title, kind, language, content, data, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
          threadId,
          artifactId,
          artifact.version,
          artifact.title,
          artifact.kind,
          artifact.language,
          artifact.content,
          data ? Buffer.from(data) : null,
          data?.byteLength ?? 0,
          artifact.createdAt,
        );
      }
      if (artifactBytes) assertStorage(input.userId, artifactBytes);

      threads.push({ archiveKey: chat.key, id: threadId, title: chat.title });
    }
    return { threads, warnings };
  });
}
