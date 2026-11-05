import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ArchiveAssetEntry, ArchiveChat, ArchiveGeneration, ArchiveManifest, ArchiveMessage, ArchivePart, ArchiveSummary, ArchiveWarning, PortableAssistant } from "../shared/chat-archive.js";
import { ARCHIVE_FORMAT, ARCHIVE_LIMITS, ARCHIVE_VERSION } from "../shared/chat-archive.js";
import { parseSnapshot } from "./assistant-presets.js";
import { artifactData, artifactVersions } from "./artifacts.js";
import { db } from "./db.js";
import { env } from "./env.js";
import { AppError } from "./errors.js";
import { readUpload, readSandboxFile } from "./media/store.js";
import { sniffRaster } from "./media/sniff.js";
import { preferredHead } from "./threads.js";
import { refUploadId } from "./media/refs.js";

/**
 * Exports stored chats as the native v1 manifest. Only current message text, reasoning, sources, durable
 * files, artifact versions, and inert tool records travel. Credentials, memory, turn context, annotations,
 * schedules, drafts, projects, share tokens, and Undo history are never read into the archive.
 */

interface ThreadRow {
  id: string;
  title: string | null;
  status: "regular" | "archived";
  model_ref: string | null;
  assistant_json: string | null;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: string;
  parent_id: string | null;
  format: string;
  content: string;
  created_at: number;
}

class AssetBag {
  readonly bytes = new Map<string, Uint8Array>();
  readonly entries = new Map<string, ArchiveAssetEntry>();

  add(data: Uint8Array, mime: string, name: string): string {
    const key = createHash("sha256").update(data).digest("hex");
    if (!this.bytes.has(key)) {
      this.bytes.set(key, data);
      this.entries.set(key, { key, size: data.byteLength, mime: mime.slice(0, ARCHIVE_LIMITS.mimeChars), name: name.slice(0, ARCHIVE_LIMITS.fileNameCodePoints) });
    }
    return key;
  }
}

const imagePath = (userId: string, id: string) => path.join(env.dataDir, "images", userId, `${id}.png`);

function readGeneratedImage(userId: string, id: string): { data: Uint8Array; mime: string } | null {
  try {
    const data = readFileSync(imagePath(userId, id));
    const mime = (db.prepare("SELECT mime FROM images WHERE id = ? AND user_id = ?").get(id, userId) as { mime?: string } | undefined)?.mime;
    return { data: new Uint8Array(data), mime: mime ?? sniffRaster(data) ?? "application/octet-stream" };
  } catch {
    return null;
  }
}

const ARTIFACT_TOOLS = new Set(["create_artifact", "update_artifact", "create_document", "edit_document", "import_document"]);

const SENSITIVE = /^(?:authorization|api[-_]?key|token|access[-_]?token|refresh[-_]?token|password|secret|credentials?|headers?)$/i;

/** Removes credential-shaped keys in known structures, without censoring ordinary user text. */
function sanitize(value: unknown, depth = 0): unknown {
  if (depth > ARCHIVE_LIMITS.jsonDepth) return null;
  if (Array.isArray(value)) return value.slice(0, 500).map((entry) => sanitize(entry, depth + 1));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE.test(key)) continue;
    out[key] = sanitize(entry, depth + 1);
  }
  return out;
}

/** A tool record never carries a live draft id, approval token, callback, or executable state. */
function inertToolRecord(name: string, input: unknown, output: unknown, state: "completed" | "failed" | "interrupted") {
  const bounded = (value: unknown) => {
    const json = JSON.stringify(sanitize(value));
    if (json === undefined) return null;
    return json.length > 200_000 ? { omitted: "Tool data was too large to include." } : (JSON.parse(json) as unknown);
  };
  return { name, input: bounded(input), output: bounded(output), state };
}

interface ExportResult {
  manifest: ArchiveManifest;
  assets: Map<string, Uint8Array>;
  warnings: ArchiveWarning[];
  lossyConversions: number;
}

const warning = (warnings: ArchiveWarning[], code: ArchiveWarning["code"], extra: Omit<ArchiveWarning, "code"> = {}) => {
  warnings.push({ code, ...extra });
};

/** Builds one chat's entry. Returns null for a stored format the exporter does not understand. */
function exportChat(
  userId: string,
  thread: ThreadRow,
  selectedLeaf: string | undefined,
  assets: AssetBag,
  warnings: ArchiveWarning[],
): { chat: ArchiveChat; lossy: number } | null {
  const rows = db.prepare("SELECT id, parent_id, format, content, created_at FROM messages WHERE thread_id = ? ORDER BY created_at, rowid").all(thread.id) as unknown as MessageRow[];
  if (rows.some((row) => row.format !== "ai-sdk/v6")) {
    warning(warnings, "unsupportedFormat", { name: thread.title ?? "Untitled chat" });
    return null;
  }
  let lossy = 0;
  const artifactVersionsUsed = new Map<string, number>();
  const messages: ArchiveMessage[] = [];
  for (const row of rows) {
    const content = JSON.parse(row.content) as { role?: unknown; parts?: unknown; metadata?: unknown };
    if (content.role !== "user" && content.role !== "assistant") {
      warning(warnings, "unsupportedPart", { type: String(content.role) });
      lossy++;
      continue;
    }
    const parts: ArchivePart[] = [];
    for (const raw of Array.isArray(content.parts) ? content.parts : []) {
      const part = raw as Record<string, unknown>;
      const type = String(part.type ?? "");
      if (type === "text" || type === "reasoning") {
        if (typeof part.text === "string") parts.push({ type: type as "text" | "reasoning", text: part.text });
        continue;
      }
      if (type === "file" || type === "image") {
        const url = typeof part.url === "string" ? part.url : typeof part.image === "string" ? part.image : undefined;
        const uploadId = refUploadId(url);
        let stored: { data: Uint8Array; mime: string; name: string } | undefined;
        if (uploadId) {
          const upload = readUpload(userId, uploadId);
          if (upload) stored = { data: upload.data, mime: upload.mime, name: upload.name };
        } else if (url?.startsWith("data:")) {
          const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
          if (match) {
            try {
              const data = match[2] ? Buffer.from(match[3]!, "base64") : Buffer.from(decodeURIComponent(match[3]!), "utf8");
              stored = { data: new Uint8Array(data), mime: match[1] ?? "application/octet-stream", name: "attachment" };
            } catch {
              stored = undefined;
            }
          }
        }
        if (stored?.mime.toLowerCase().startsWith("video/")) stored = undefined;
        if (!stored) {
          warning(warnings, "missingAsset", { name: typeof part.filename === "string" ? part.filename : undefined });
          parts.push({ type: "file", asset: null, name: String(part.filename ?? part.name ?? "attachment").slice(0, 200), mime: String(part.mediaType ?? part.mimeType ?? "application/octet-stream").slice(0, 100), missing: true });
          continue;
        }
        const key = assets.add(stored.data, stored.mime, stored.name);
        parts.push({ type: "file", asset: key, name: stored.name || String(part.filename ?? "attachment").slice(0, 200), mime: stored.mime, missing: false });
        continue;
      }
      if (type === "source-url") {
        const url = typeof part.url === "string" ? part.url : "";
        if (!/^https?:\/\//i.test(url)) continue;
        parts.push({ type: "source", title: typeof part.title === "string" ? part.title.slice(0, 2000) : url.slice(0, 2000), url });
        continue;
      }
      if (type === "source-document" || type === "step-start") continue;
      if (type.startsWith("data-imported-tool") || type === "data-imported-tool") {
        const nested = (part.data ?? {}) as Record<string, unknown>;
        parts.push({
          type: "tool-record",
          name: String(nested.name ?? "tool").slice(0, 200),
          input: nested.name === "generate_video" ? null : sanitize(nested.input),
          output: nested.name === "generate_video" ? { note: "Video not included" } : sanitize(nested.output),
          state: nested.state === "failed" ? "failed" : nested.state === "interrupted" ? "interrupted" : "completed",
          references: [],
        });
        continue;
      }
      if (type.startsWith("tool-")) {
        const name = typeof part.toolName === "string" ? part.toolName : type.slice(5);
        const state = part.state === "output-available" ? "completed" : part.state === "output-error" || part.state === "output-denied" ? "failed" : "interrupted";
        const output = (part.output ?? null) as Record<string, unknown> | null;
        const references: Array<{ kind: "asset" | "artifact"; key: string; version?: number }> = [];
        if (name === "generate_video") {
          parts.push({type:"tool-record",name,input:null,output:{note:"Video not included"},state:"interrupted",references:[]});
          lossy++;
          continue;
        }
        if (name === "draft_email" || name === "draft_text") {
          // A draft is a live, mutable editor: export only that it existed, never its id or text.
          parts.push({ type: "tool-record", name, input: null, output: { note: "Draft not included" }, state: state === "completed" ? "interrupted" : state, references });
          warning(warnings, "draftExcluded", { count: 1 });
          lossy++;
          continue;
        }
        if (ARTIFACT_TOOLS.has(name) && output && typeof output.id === "string" && typeof output.version === "number") {
          const versions = artifactVersions(thread.id, output.id);
          for (const version of versions) {
            artifactVersionsUsed.set(output.id, Math.max(artifactVersionsUsed.get(output.id) ?? 0, version.version));
          }
          references.push({ kind: "artifact", key: output.id, version: output.version });
        }
        if (output && Array.isArray(output.images)) {
          for (const image of output.images as Array<{ id?: unknown }>) {
            if (typeof image?.id !== "string") continue;
            const stored = readGeneratedImage(userId, image.id);
            if (stored) references.push({ kind: "asset", key: assets.add(stored.data, stored.mime, `${image.id}.png`) });
            else warning(warnings, "missingAsset", { name: image.id });
          }
        }
        if (output && Array.isArray(output.files)) {
          for (const file of output.files as Array<{ path?: unknown }>) {
            if (typeof file?.path !== "string") continue;
            const stored = db.prepare("SELECT id FROM sandbox_files WHERE user_id = ? AND thread_id = ? AND path = ?").get(userId, thread.id, file.path) as { id: string } | undefined;
            if (!stored) continue;
            const bytes = readSandboxFile(userId, stored.id);
            if (bytes) references.push({ kind: "asset", key: assets.add(bytes.data, bytes.mime, file.path) });
          }
        }
        const record = inertToolRecord(name, part.input, output, state);
        parts.push({ type: "tool-record", ...record, references });
        continue;
      }
      warning(warnings, "unsupportedPart", { type });
      parts.push({ type: "text", text: `[Unsupported archived part: ${type}]` });
      lossy++;
    }
    messages.push({
      key: row.id,
      parentKey: row.parent_id,
      createdAt: row.created_at,
      role: content.role,
      parts,
      ...(exportGeneration(content.metadata) ? { generation: exportGeneration(content.metadata) } : {}),
    });
  }

  const artifacts: ArchiveChat["artifacts"] = [];
  for (const [artifactId, maxVersion] of artifactVersionsUsed) {
    for (const version of artifactVersions(thread.id, artifactId)) {
      if (version.version > maxVersion) break;
      const file = artifactData(thread.id, artifactId, version.version);
      artifacts.push({
        key: artifactId,
        version: version.version,
        title: version.title,
        kind: version.kind,
        language: version.language,
        content: version.content,
        fileAsset: file ? assets.add(file, "application/octet-stream", `${artifactId}-v${version.version}.bin`) : null,
        createdAt: version.createdAt,
      });
    }
  }

  const snapshot = parseSnapshot(thread.assistant_json);
  let assistant: PortableAssistant | null = null;
  if (snapshot) {
    const omittedTools = snapshot.tools.mode === "selected" && snapshot.tools.mcpTools.length > 0;
    const omittedKnowledge = snapshot.knowledge.mode === "selected" && snapshot.knowledge.ids.length > 0;
    assistant = {
      name: snapshot.name,
      icon: snapshot.icon,
      instructions: snapshot.instructions,
      modelRef: snapshot.modelRef,
      sampling: snapshot.sampling,
      ...(snapshot.reasoningEffort ? { reasoningEffort: snapshot.reasoningEffort } : {}),
      builtins: snapshot.tools.mode === "selected" ? [...snapshot.tools.builtins] : [],
      omittedTools,
      omittedKnowledge,
    };
    if (omittedTools) warning(warnings, "mcpToolsOmitted", { count: 1 });
    if (omittedKnowledge) warning(warnings, "knowledgeOmitted", { count: 1 });
    warning(warnings, "portableSettingsInactive", { count: 1 });
  }

  const leaf = selectedLeaf ?? preferredHead(userId, thread.id) ?? rows.at(-1)?.id ?? null;
  const messageKeys = new Set(messages.map((message) => message.key));
  if (leaf && !messageKeys.has(leaf)) warning(warnings, "missingAsset", { name: "selected branch" });
  return {
    chat: {
      key: thread.id,
      title: thread.title,
      createdAt: thread.created_at,
      updatedAt: thread.updated_at,
      status: thread.status,
      modelRef: thread.model_ref,
      selectedLeaf: leaf && messageKeys.has(leaf) ? leaf : null,
      messages,
      artifacts,
      assistant,
    },
    lossy,
  };
}

/** Allowlisted, display-only generation values; never a run id, segment, or provider option. */
function exportGeneration(metadata: unknown): ArchiveGeneration | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const source = metadata as { generation?: unknown; custom?: { generation?: unknown } };
  const generation = (source.custom?.generation ?? source.generation) as Record<string, unknown> | undefined;
  if (!generation) return undefined;
  const out: ArchiveGeneration = {};
  if (typeof generation.modelRef === "string") out.modelRef = generation.modelRef.slice(0, 300);
  if (typeof generation.assistantName === "string") out.assistantName = generation.assistantName.slice(0, 80);
  if (typeof generation.assistantIcon === "string") out.assistantIcon = generation.assistantIcon as ArchiveGeneration["assistantIcon"];
  if (typeof generation.cost === "number" && Number.isFinite(generation.cost) && generation.cost >= 0) out.cost = generation.cost;
  if (typeof generation.durationMs === "number" && Number.isFinite(generation.durationMs) && generation.durationMs >= 0) out.durationMs = generation.durationMs;
  if (typeof generation.finishReason === "string") out.finishReason = generation.finishReason as ArchiveGeneration["finishReason"];
  return Object.keys(out).length ? out : undefined;
}

/** The review table's counts. Warnings are structured codes, never server-translated strings. */
export function archiveSummary(result: ExportResult): ArchiveSummary {
  return {
    chats: result.manifest.chats.map((chat) => {
      const leaves = new Set(chat.messages.map((message) => message.key));
      for (const message of chat.messages) if (message.parentKey) leaves.delete(message.parentKey);
      const assets = new Set<string>();
      for (const message of chat.messages) {
        for (const part of message.parts) {
          if (part.type === "file" && part.asset) assets.add(part.asset);
          if (part.type === "tool-record") for (const reference of part.references) if (reference.kind === "asset") assets.add(reference.key);
        }
      }
      for (const artifact of chat.artifacts) if (artifact.fileAsset) assets.add(artifact.fileAsset);
      const bytes = [...assets].reduce((sum, hash) => sum + (result.assets.get(hash)?.byteLength ?? 0), 0);
      return {
        key: chat.key,
        title: chat.title,
        messages: chat.messages.length,
        branches: Math.max(1, leaves.size),
        assets: assets.size,
        bytes,
        warnings: result.warnings,
      };
    }),
    totalBytes: [...result.assets.values()].reduce((sum, data) => sum + data.byteLength, 0),
    lossyConversions: result.lossyConversions,
  };
}

export interface ExportInput {
  userId: string;
  threads: Array<{ id: string; selectedLeaf?: string }>;
  now?: number;
  /** Injected for tests; production uses the real clock to enforce a 60 s preparation deadline. */
  deadline?: number;
}

/** Builds the whole archive in memory. The caller writes it to staging before responding ready. */
export function buildArchive(input: ExportInput): ExportResult {
  if (!input.threads.length || input.threads.length > ARCHIVE_LIMITS.chats) {
    throw new AppError({ code: "validation", message: `Choose between 1 and ${ARCHIVE_LIMITS.chats} chats.` });
  }
  const ids = [...new Set(input.threads.map((entry) => entry.id))];
  const placeholders = ids.map(() => "?").join(",");
  const threads = db.prepare(`SELECT id, title, status, model_ref, assistant_json, created_at, updated_at FROM threads WHERE user_id = ? AND id IN (${placeholders})`).all(input.userId, ...ids) as unknown as ThreadRow[];
  // No partial foreign export: every selected id must be this user's chat.
  if (threads.length !== ids.length) throw new AppError({ code: "not_found", message: "A selected chat was not found." });
  const deadline = input.deadline ?? Date.now() + ARCHIVE_LIMITS.preparationMs;
  const assets = new AssetBag();
  const warnings: ArchiveWarning[] = [];
  const chats: ArchiveChat[] = [];
  let lossy = 0;
  for (const thread of threads) {
    if (Date.now() > deadline) throw new AppError({ code: "validation", message: "Preparing this archive took too long. Export fewer chats." });
    const selectedLeaf = input.threads.find((entry) => entry.id === thread.id)?.selectedLeaf;
    const result = exportChat(input.userId, thread, selectedLeaf, assets, warnings);
    if (!result) continue;
    chats.push(result.chat);
    lossy += result.lossy;
  }
  if (!chats.length) throw new AppError({ code: "validation", message: "None of the selected chats could be exported." });
  const manifest: ArchiveManifest = {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    exportedAt: input.now ?? Date.now(),
    chats,
    assets: [...assets.entries.values()],
  };
  // Export review must name every lossy conversion before Download.
  if (lossy) warning(warnings, "unsupportedPart", { count: lossy });
  return { manifest, assets: assets.bytes, warnings, lossyConversions: lossy };
}
