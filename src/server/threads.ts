import { deletingThreadVideos } from "./video/maintenance.js";
import { isDeepStrictEqual } from "node:util";
import type { UIMessage } from "ai";
import { HTTPException } from "hono/http-exception";
import type { CompactionState, ThreadSummary } from "../shared/types.js";
import { assertStorage, messageBytes } from "./quota.js";
import { storeInlineAttachments } from "./attachment-storage.js";
import { normalizeImages } from "./media/refs.js";
import { db, tx } from "./db.js";
import { copyDraftsForBranch } from "./email/drafts.js";
import { AppError } from "./errors.js";
import { newId } from "./crypto.js";
import { assistantSummary } from "./assistant-presets.js";
import { overlayGenerationMetadata, projectGenerationsForThread } from "./generation-runs.js";
import { normalizeTags } from "../shared/tags.js";
import { assertThreadRedistributable, isRestrictedKnowledgeThread, lockedThreadIds, restrictedThreadIds, restrictedThreadReadable } from "./knowledge/thread-policy.js";

/** Temporary conversations exist only in browser memory; their ids must never become stored threads. */
export const isTemporaryThread = (id: string): boolean => id.startsWith("tmp_");

interface ThreadRow {
  id: string;
  title: string | null;
  status: "regular" | "archived";
  model_ref: string | null;
  project_id: string | null;
  memory_disabled: number;
  pinned: number;
  knowledge_ids: string | null;
  branched_from: string | null;
  compare_group_id: string | null;
  /** Joined from the source thread; null once it is deleted. */
  branched_title: string | null;
  branched_exists: number | null;
  created_at: number;
  updated_at: number;
  assistant_json?: string | null;
  assistant_revision?: number;
  preferred_head?: string | null;
}

// The sidebar reads every chat, so its rows must not carry compaction JSON: a long chat can hold a large
// trim summary that only getThread needs. `t.*` also breaks when a column is added for another feature.
const THREAD_COLUMNS = `t.id, t.title, t.status, t.model_ref, t.project_id, t.memory_disabled, t.pinned,
  t.knowledge_ids, t.branched_from, t.compare_group_id, t.created_at, t.updated_at`;
const BRANCH_JOIN = `LEFT JOIN threads o ON o.id = t.branched_from AND o.user_id = t.user_id`;
const BRANCH_COLUMNS = "o.title AS branched_title, o.id IS NOT NULL AS branched_exists";
const SELECT_THREADS = `SELECT ${THREAD_COLUMNS}, ${BRANCH_COLUMNS} FROM threads t ${BRANCH_JOIN}`;
const SELECT_THREAD = `SELECT ${THREAD_COLUMNS}, t.compaction_json, t.assistant_json, t.assistant_revision, t.preferred_head, ${BRANCH_COLUMNS} FROM threads t ${BRANCH_JOIN}`;

const parseIds = (value: string | null): string[] => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string").slice(0, 20) : [];
  } catch {
    return [];
  }
};

/** A locked row keeps only the shape the sidebar needs; stale titles/tags/attachments are withheld. */
const toSummary = (r: ThreadRow, tags: string[] = [], state?: { restricted: boolean; locked: boolean }): ThreadSummary => {
  const restricted = state?.restricted ?? false;
  const locked = state?.locked ?? false;
  return {
    id: r.id,
    title: locked ? null : r.title,
    status: r.status,
    modelRef: r.model_ref,
    projectId: r.project_id,
    memoryDisabled: !!r.memory_disabled,
    pinned: !!r.pinned,
    knowledgeIds: locked ? [] : parseIds(r.knowledge_ids),
    tags: locked ? [] : tags,
    branchedFrom: !locked && r.branched_from && r.branched_exists ? { id: r.branched_from, title: r.branched_title } : null,
    sharedKnowledgeRestricted: restricted,
    knowledgeAccess: locked ? "revoked" : "available",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
};

const TAG_CHUNK = 400;

/** Tags for a page of chats, in bounded chunks so a long sidebar stays one query per block. */
export function tagsFor(threadIds: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < threadIds.length; i += TAG_CHUNK) {
    const chunk = threadIds.slice(i, i + TAG_CHUNK);
    if (!chunk.length) continue;
    const rows = db
      .prepare(`SELECT thread_id, tag FROM thread_tags WHERE thread_id IN (${chunk.map(() => "?").join(", ")}) ORDER BY tag`)
      .all(...chunk) as Array<{ thread_id: string; tag: string }>;
    for (const row of rows) {
      const list = out.get(row.thread_id);
      if (list) list.push(row.tag);
      else out.set(row.thread_id, [row.tag]);
    }
  }
  return out;
}

/**
 * `projectId` undefined lists every thread; null lists threads outside any project. `status` undefined lists
 * both. Comparison panes are hidden unless `options.comparisonGroupId` asks for that group.
 */
export function listThreads(
  userId: string,
  projectId?: string | null,
  status?: "regular" | "archived",
  options?: { comparisonGroupId?: string },
): ThreadSummary[] {
  const where = ["t.user_id = ?"];
  const values: string[] = [userId];
  if (options?.comparisonGroupId) where.push("t.compare_group_id = ?"), values.push(options.comparisonGroupId);
  else where.push("t.compare_group_id IS NULL");
  if (projectId === null) where.push("t.project_id IS NULL");
  else if (projectId !== undefined) where.push("t.project_id = ?"), values.push(projectId);
  if (status !== undefined) where.push("t.status = ?"), values.push(status);
  const rows = db.prepare(`${SELECT_THREADS} WHERE ${where.join(" AND ")} ORDER BY t.updated_at DESC`).all(...values) as unknown as ThreadRow[];
  const tags = tagsFor(rows.map((row) => row.id));
  const restricted = restrictedThreadIds(userId);
  const locked = lockedThreadIds(userId);
  return rows.map((row) => toSummary(row, tags.get(row.id) ?? [], { restricted: restricted.has(row.id), locked: locked.has(row.id) }));
}

export function getThread(userId: string, id: string): (ThreadSummary & { compaction: CompactionState | null; compareGroupId: string | null }) | null {
  const row = db.prepare(`${SELECT_THREAD} WHERE t.user_id = ? AND t.id = ?`).get(userId, id) as unknown as
    | (ThreadRow & { compaction_json: string | null })
    | undefined;
  if (!row) return null;
  const restricted = isRestrictedKnowledgeThread(row.id);
  const locked = restricted && !restrictedThreadReadable(userId, row.id);
  const snapshot = assistantSummary(row.assistant_json ?? null);
  return {
    ...toSummary(row, locked ? [] : tagsFor([row.id]).get(row.id) ?? [], { restricted, locked }),
    // A locked chat's compaction summary and import selection are content too; neither leaves the server.
    compaction: !locked && row.compaction_json ? (JSON.parse(row.compaction_json) as CompactionState) : null,
    assistant: snapshot,
    assistantRevision: row.assistant_revision ?? 0,
    preferredHead: locked ? null : row.preferred_head ?? null,
    compareGroupId: row.compare_group_id ?? null,
  };
}

/** Ownership only. History routes do not need the summary, compaction JSON, or the fork join. */
const ownsThread = (userId: string, id: string): boolean =>
  db.prepare("SELECT 1 FROM threads WHERE user_id = ? AND id = ?").get(userId, id) !== undefined;

/** Idempotent: the client may call initialize more than once for the same id. */
export function ensureThread(userId: string, id: string, projectId: string | null = null): ThreadSummary {
  if (isTemporaryThread(id)) throw new HTTPException(400, { message: "Temporary chats cannot be saved" });
  const now = Date.now();
  db.prepare("INSERT OR IGNORE INTO threads (id, user_id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, userId, projectId, now, now);
  const thread = getThread(userId, id);
  // Another user's id: answer exactly as for a missing thread.
  if (!thread) throw new HTTPException(404, { message: "Thread not found" });
  return thread;
}

/**
 * Metadata only. `updated_at` means last message activity (the sidebar groups by it), so renaming,
 * pinning, archiving, tagging, or moving a chat must not bump it. `appendMessage` does.
 * `compareGroupId` is internal: only compare.ts sets it.
 */
export function updateThread(
  userId: string,
  id: string,
  patch: {
    title?: string;
    status?: "regular" | "archived";
    modelRef?: string;
    memoryDisabled?: boolean;
    pinned?: boolean;
    projectId?: string | null;
    knowledgeIds?: string[];
    tags?: string[];
    compareGroupId?: string | null;
  },
) {
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  if (patch.title !== undefined) sets.push("title = ?"), values.push(patch.title);
  if (patch.status !== undefined) sets.push("status = ?"), values.push(patch.status);
  if (patch.modelRef !== undefined) sets.push("model_ref = ?"), values.push(patch.modelRef);
  if (patch.memoryDisabled !== undefined) sets.push("memory_disabled = ?"), values.push(Number(patch.memoryDisabled));
  if (patch.pinned !== undefined) sets.push("pinned = ?"), values.push(Number(patch.pinned));
  if (patch.projectId !== undefined) sets.push("project_id = ?"), values.push(patch.projectId);
  if (patch.knowledgeIds !== undefined) sets.push("knowledge_ids = ?"), values.push(JSON.stringify(patch.knowledgeIds.slice(0, 20)));
  if (patch.compareGroupId !== undefined) sets.push("compare_group_id = ?"), values.push(patch.compareGroupId);
  if (!sets.length && patch.tags === undefined) return;
  tx(() => {
    if (patch.title !== undefined) {
      const identity = db.prepare("SELECT title_bytes FROM conversation_source_ids WHERE thread_id=? AND user_id=?").get(id,userId) as {title_bytes:number}|undefined;
      if (identity) {
        const titleBytes = Buffer.byteLength(patch.title);
        assertStorage(userId, Math.max(0,titleBytes-identity.title_bytes));
        db.prepare("UPDATE conversation_source_ids SET title_bytes=? WHERE thread_id=? AND user_id=?").run(titleBytes,id,userId);
      }
    }
    if (patch.projectId !== undefined) {
      const before = db.prepare("SELECT project_id FROM threads WHERE user_id = ? AND id = ?").get(userId, id) as { project_id: string | null } | undefined;
      // Replayed memory blocks can hold the old project's facts; only global and current-project memory may enter a turn.
      if (before && before.project_id !== patch.projectId) {
        db.prepare("UPDATE turn_context SET memory_enc = NULL WHERE user_id = ? AND thread_id = ?").run(userId, id);
      }
    }
    if (patch.tags !== undefined) {
      const row = db.prepare("SELECT compare_group_id FROM threads WHERE user_id = ? AND id = ?").get(userId, id) as { compare_group_id: string | null } | undefined;
      // A comparison pane is a private working copy; tags belong to real, sidebar-visible chats.
      if (row?.compare_group_id) throw new AppError({ code: "validation", status: 400, message: "A comparison pane cannot be tagged." });
      const tags = normalizeTags(patch.tags);
      db.prepare("DELETE FROM thread_tags WHERE thread_id = ?").run(id);
      const insert = db.prepare("INSERT OR IGNORE INTO thread_tags (thread_id, tag, created_at) VALUES (?, ?, ?)");
      const now = Date.now();
      for (const tag of tags) insert.run(id, tag, now);
    }
    if (sets.length) db.prepare(`UPDATE threads SET ${sets.join(", ")} WHERE user_id = ? AND id = ?`).run(...values, userId, id);
  });
}

export function setCompaction(userId: string, id: string, state: CompactionState | null) {
  db.prepare("UPDATE threads SET compaction_json = ? WHERE user_id = ? AND id = ?").run(
    state ? JSON.stringify(state) : null,
    userId,
    id,
  );
}

export function deleteThread(userId: string, id: string) {
  const row = db.prepare("SELECT compare_group_id FROM threads WHERE user_id = ? AND id = ?").get(userId, id) as { compare_group_id: string | null } | undefined;
  tx(() => {
    deletingThreadVideos(userId, id);
    db.prepare("DELETE FROM threads WHERE user_id = ? AND id = ?").run(userId, id);
  });
  // Pane rows cascade from the thread; the group survives while another pane remains.
  if (row?.compare_group_id) {
    db.prepare(
      `DELETE FROM comparison_groups WHERE id = ? AND user_id = ?
        AND NOT EXISTS (SELECT 1 FROM comparison_panes WHERE group_id = ?)`,
    ).run(row.compare_group_id, userId, row.compare_group_id);
  }
}

interface EditState {
  edited_at: number | null;
  original_enc: string | null;
}

/** The edit columns `listMessages` deliberately leaves out (the encrypted original must never leave the server). */
function editStates(threadId: string): Map<string, EditState> {
  const rows = db.prepare("SELECT id, edited_at, original_enc FROM messages WHERE thread_id = ?").all(threadId) as unknown as Array<EditState & { id: string }>;
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Forks a chat at `messageId`: the new thread gets that message and its ancestors (ids kept, since message
 * keys are per thread) and the source's settings. Compaction carries over only when its boundary is inside
 * the copied branch.
 */
/**
 * `start` and its ancestors, oldest first. Parent ids come from clients, so a cycle stops the walk
 * instead of looping forever on the one event loop every account shares.
 */
export function ancestry<T extends { id: string; parent_id: string | null }>(byId: Map<string, T>, start: T | undefined): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (let row = start; row && !seen.has(row.id); row = row.parent_id ? byId.get(row.parent_id) : undefined) {
    seen.add(row.id);
    out.push(row);
  }
  // Walking ends at the oldest ancestor, so one reverse replaces an unshift on every step.
  return out.reverse();
}

export function branchThread(userId: string, sourceId: string, messageId: string, id: string, modelRef?: string): ThreadSummary {
  const source = getThread(userId, sourceId);
  if (!source) throw new HTTPException(404, { message: "Thread not found" });
  // A fork would carry shared-derived content into a chat with no dependency provenance this cycle.
  assertThreadRedistributable(sourceId);
  const rows = listMessages(userId, sourceId);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const chain = ancestry(byId, byId.get(messageId));
  if (!chain.length) throw new HTTPException(404, { message: "Message not found" });
  const edits = editStates(sourceId);
  const boundaries = [source.compaction?.boundaryMessageId, source.compaction?.trim?.throughMessageId];
  const compaction = source.compaction && chain.some((m) => boundaries.includes(m.id)) ? source.compaction : null;
  const now = Date.now();
  const sourceRow = db.prepare("SELECT assistant_json, imported_assistant_json FROM threads WHERE id = ? AND user_id = ?").get(sourceId, userId) as
    | { assistant_json: string | null; imported_assistant_json: string | null }
    | undefined;
  tx(() => {
    db.prepare(
      `INSERT INTO threads (id, user_id, title, model_ref, project_id, compaction_json, memory_disabled, branched_from, memory_cursor, knowledge_ids, assistant_json, assistant_revision, imported_assistant_json, preferred_head, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      // The copied messages belong to the source chat's memory review; the fork only reviews what follows.
      // A copied assistant snapshot starts at revision 1: the fork owns it and later edits never follow the source.
    ).run(
      id,
      userId,
      source.title,
      modelRef ?? source.modelRef,
      source.projectId,
      compaction ? JSON.stringify(compaction) : null,
      Number(source.memoryDisabled),
      sourceId,
      messageId,
      JSON.stringify(source.knowledgeIds),
      sourceRow?.assistant_json ?? null,
      sourceRow?.assistant_json ? 1 : 0,
      sourceRow?.imported_assistant_json ?? null,
      messageId,
      now,
      now,
    );
    const insert = db.prepare("INSERT INTO messages (id, thread_id, parent_id, format, content, bytes, created_at, edited_at, original_enc, imported) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    // An edited reply keeps its current text, its Edited state, and the encrypted first original, so the fork
    // shows the same text and can still Undo. Both the message and the original are charged to the fork.
    const imported = new Map(
      (db.prepare("SELECT id, imported FROM messages WHERE thread_id = ?").all(sourceId) as Array<{ id: string; imported: number }>).map((row) => [row.id, row.imported]),
    );
    const copies = chain.map((m) => {
      const edit = edits.get(m.id);
      return { m, json: JSON.stringify(m.content), editedAt: edit?.edited_at ?? null, original: edit?.original_enc ?? null };
    });
    assertStorage(userId, copies.reduce((sum, { json, original }) => sum + messageBytes(json) + (original ? Buffer.byteLength(original) : 0), 0));
    // Distinct timestamps keep the copied order, which defines the current branch.
    copies.forEach(({ m, json, editedAt, original }, i) =>
      insert.run(m.id, id, m.parent_id, m.format, json, messageBytes(json), now - chain.length + i, editedAt, original, imported.get(m.id) ?? 0));
    // Draft cards in the copied messages keep working in the fork.
    copyDraftsForBranch(userId, sourceId, id, copies.map(({ json }) => json));
    copyArtifactsForBranch(userId, sourceId, id, chain.map((m) => m.content));
    copyImagesForBranch(userId, sourceId, id, chain.map((m) => m.content));
    // Tags describe what the conversation is about, so the fork starts with them. Editing them in the
    // fork never reaches the source.
    db.prepare("INSERT INTO thread_tags (thread_id, tag, created_at) SELECT ?, tag, ? FROM thread_tags WHERE thread_id = ?").run(id, now, sourceId);
  });
  return getThread(userId, id)!;
}

const ARTIFACT_TOOLS = new Set(["create_artifact", "update_artifact", "create_document", "edit_document", "import_document"]);

/**
 * Copies the artifact versions the copied messages show, up to the newest one they reference, so the
 * fork's cards open and the model can keep editing them. Versions made after the fork point stay behind.
 */
function copyArtifactsForBranch(userId: string, sourceId: string, targetId: string, contents: unknown[]): void {
  const newest = new Map<string, number>();
  for (const content of contents) {
    for (const part of (content as { parts?: unknown[] }).parts ?? []) {
      const p = part as { type?: string; toolName?: string; output?: { id?: unknown; version?: unknown } };
      const name = p.toolName ?? p.type?.replace(/^tool-/, "");
      const out = p.output;
      if (!name || !ARTIFACT_TOOLS.has(name) || typeof out?.id !== "string" || typeof out.version !== "number") continue;
      newest.set(out.id, Math.max(newest.get(out.id) ?? 0, out.version));
    }
  }
  if (!newest.size) return;
  const columns = (db.prepare("PRAGMA table_info(artifacts)").all() as Array<{ name: string }>).map((c) => c.name).filter((n) => n !== "thread_id");
  const list = columns.join(", ");
  const size = db.prepare("SELECT COALESCE(SUM(length(CAST(content AS BLOB)) + size), 0) AS n FROM artifacts WHERE thread_id = ? AND id = ? AND version <= ?");
  const copy = db.prepare(`INSERT INTO artifacts (thread_id, ${list}) SELECT ?, ${list} FROM artifacts WHERE thread_id = ? AND id = ? AND version <= ?`);
  let bytes = 0;
  for (const [artifactId, version] of newest) bytes += (size.get(sourceId, artifactId, version) as { n: number }).n;
  assertStorage(userId, bytes);
  for (const [artifactId, version] of newest) copy.run(targetId, sourceId, artifactId, version);
}

/** Generated/MCP image ids and stored run_code output paths shown by tool results in `contents`. */
export function toolMedia(contents: unknown[]): { images: Set<string>; sandboxPaths: Set<string> } {
  const images = new Set<string>();
  const sandboxPaths = new Set<string>();
  for (const content of contents) {
    for (const part of (content as { parts?: unknown[] }).parts ?? []) {
      const p = part as { type?: string; toolName?: string; state?: string; output?: unknown };
      if (p.state !== "output-available" || !p.output || typeof p.output !== "object") continue;
      const output = p.output as { id?: unknown; url?: unknown; images?: unknown; files?: unknown };
      if (typeof output.id === "string" && typeof output.url === "string" && output.url === `/api/images/${output.id}`) images.add(output.id);
      if (Array.isArray(output.images)) {
        for (const image of output.images as Array<{ id?: unknown }>) if (typeof image?.id === "string") images.add(image.id);
      }
      if (Array.isArray(output.files)) {
        for (const file of output.files as Array<{ path?: unknown; url?: unknown }>) {
          if (typeof file?.path === "string" && typeof file.url === "string" && file.url.includes("/stored?")) sandboxPaths.add(file.path);
        }
      }
    }
  }
  return { images, sandboxPaths };
}

/**
 * A fork references the generated images its copied messages show, so deleting the source chat does not
 * delete them (image_threads), and shares the stored run_code images by media id (no new bytes, no new
 * charge). Non-image run outputs stay with the source chat.
 */
function copyImagesForBranch(userId: string, sourceId: string, targetId: string, contents: unknown[]): void {
  for (const content of contents) {
    if (!content || typeof content !== "object") continue;
    const parts = (content as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) continue;
    for (const raw of parts) {
      if (!raw || typeof raw !== "object") continue;
      const part = raw as { type?: unknown; state?: unknown; output?: {version?:unknown;accepted?:unknown;jobId?:unknown} };
      if (part.type !== "tool-generate_video" || part.state !== "output-available" || part.output?.version !== 1 || part.output.accepted !== true || typeof part.output.jobId !== "string") continue;
      db.prepare(`INSERT OR IGNORE INTO video_threads (video_id,thread_id)
        SELECT v.id,? FROM videos v JOIN video_jobs j ON j.id=v.job_id
        JOIN video_jobs original ON original.id=? AND original.user_id=j.user_id AND original.thread_id IS j.thread_id
          AND original.assistant_message_id=j.assistant_message_id AND original.tool_call_id=j.tool_call_id
        JOIN video_threads refs ON refs.video_id=v.id AND refs.thread_id=?
        WHERE v.user_id=? AND j.state='succeeded'`).run(targetId,part.output.jobId,sourceId,userId);
    }
  }
  const { images, sandboxPaths } = toolMedia(contents);
  const ref = db.prepare(`INSERT OR IGNORE INTO image_threads (image_id, thread_id)
    SELECT id, ? FROM images WHERE id = ? AND user_id = ?`);
  for (const image of images) ref.run(targetId, image, userId);
  const copy = db.prepare(`INSERT OR IGNORE INTO sandbox_files (id, user_id, thread_id, path, mime, data, size, created_at, media_id)
    SELECT ?, user_id, ?, path, mime, x'', size, created_at, media_id FROM sandbox_files
    WHERE user_id = ? AND thread_id = ? AND path = ? AND media_id IS NOT NULL`);
  for (const file of sandboxPaths) copy.run(newId("sbf"), targetId, userId, sourceId, file);
}

export interface MessageRow {
  id: string;
  parent_id: string | null;
  format: string;
  content: unknown;
}

export function listMessages(userId: string, threadId: string): MessageRow[] {
  if (!ownsThread(userId, threadId)) return [];
  // Durable policy also protects raw readers: a locked restricted chat returns no history.
  if (isRestrictedKnowledgeThread(threadId) && !restrictedThreadReadable(userId, threadId)) return [];
  const rows = db
    .prepare("SELECT id, parent_id, format, content FROM messages WHERE thread_id = ? ORDER BY created_at, rowid")
    .all(threadId) as Array<{ id: string; parent_id: string | null; format: string; content: string }>;
  return rows.map((r) => ({ ...r, content: JSON.parse(r.content) }));
}

/**
 * The same list as listMessages, as a JSON array. Stored content is already JSON, so it is spliced in as is:
 * parsing and re-serializing every message (inline attachments can be megabytes) doubled the work and memory.
 */
export function listMessagesJson(userId: string, threadId: string): string {
  if (!ownsThread(userId, threadId)) return "[]";
  if (isRestrictedKnowledgeThread(threadId) && !restrictedThreadReadable(userId, threadId)) return "[]";
  const rows = db
    .prepare("SELECT id, parent_id, format, content, edited_at, imported, original_enc FROM messages WHERE thread_id = ? ORDER BY created_at, rowid")
    .all(threadId) as Array<{ id: string; parent_id: string | null; format: string; content: string; edited_at: number | null; imported: number; original_enc: string | null }>;
  const generations = projectGenerationsForThread(threadId);
  // A receipt projection, the imported flag, and the ever-edited flag (needed to refuse Continue after
  // Undo) are the only server-owned additions; an untouched row keeps its stored JSON spliced as is.
  const items = rows.map((r) => {
    const generation = generations.get(r.id);
    const extra = `${r.edited_at === null ? "" : `,"edited_at":${r.edited_at}`}${r.imported ? ',"imported":true' : ""}`;
    const everEdited = r.original_enc !== null;
    if (!generation && !everEdited) return `{"id":${JSON.stringify(r.id)},"parent_id":${JSON.stringify(r.parent_id)},"format":${JSON.stringify(r.format)},"content":${r.content}${extra}}`;
    const content = r.content as unknown;
    const parsed = overlayGenerationMetadata(threadId, { id: r.id, content: JSON.parse(content as string) as unknown });
    const withEdit = everEdited ? markEverEdited(parsed) : parsed;
    return `{"id":${JSON.stringify(r.id)},"parent_id":${JSON.stringify(r.parent_id)},"format":${JSON.stringify(r.format)},"content":${JSON.stringify(withEdit)}${extra}}`;
  });
  return `[${items.join(",")}]`;
}

/** Marks a reply that was ever edited, even after Undo removed its Edited badge. */
function markEverEdited(content: unknown): unknown {
  const message = content as { metadata?: unknown; custom?: unknown };
  const metadata = typeof message.metadata === "object" && message.metadata !== null ? { ...(message.metadata as Record<string, unknown>) } : {};
  const custom = typeof metadata.custom === "object" && metadata.custom !== null ? { ...(metadata.custom as Record<string, unknown>) } : {};
  custom.everEdited = true;
  metadata.custom = custom;
  return { ...(message as Record<string, unknown>), metadata };
}

export function appendMessage(userId: string, threadId: string, row: MessageRow) {
  return tx(() => {
    ensureThread(userId, threadId);
    const previous = db.prepare("SELECT content, bytes, parent_id, format, edited_at, original_enc, imported FROM messages WHERE thread_id = ? AND id = ?").get(threadId, row.id) as
      | { content: string; bytes: number; parent_id: string | null; format: string; edited_at: number | null; original_enc: string | null; imported: number }
      | undefined;
    // Imported history is immutable through the ordinary append API. Dedicated reply editing keeps
    // server-owned provenance; a runtime replay must not turn historical data into native instructions.
    if (previous?.imported) return { ...row, parent_id: previous.parent_id, format: previous.format, content: JSON.parse(previous.content) as unknown };
    // The stored parent is immutable unless this row is genuinely re-parented, and the stored graph has no
    // cycle, so an unchanged parent needs no walk. A brand-new row still walks from its parent.
    if (row.parent_id !== null && previous?.parent_id !== row.parent_id && createsCycle(threadId, row.id, row.parent_id)) {
      throw new HTTPException(400, { message: "A message cannot be its own ancestor." });
    }
    // Inline images (user attachments, provider image output) become owned references before anything is
    // compared or charged, so history and later requests never carry the original bytes again. An edited reply
    // only maps resent bytes back to its own references: new bytes there are a stale tab's, refused below.
    const edited = !!previous && (previous.edited_at !== null || previous.original_enc !== null);
    const storedContent = stripGeneration(stripImportClaims(row.content));
    const content = normalizeImages(userId, threadId, storedContent, {
      charge: (size) => { assertStorage(userId, size); },
      previous: previous ? JSON.parse(previous.content) : undefined,
      store: !edited,
    });
    const json = JSON.stringify(content);
    const bytes = messageBytes(json);
    // A user edit changes a reply only through the edit route. A tab still holding text from before it (or from
    // before an Undo, when only `original_enc` remains) re-sends old content, which must not silently rewrite it.
    // Compare parsed values too: a client re-encoding the same reply may order keys differently.
    if (previous && edited) {
      let same = previous.content === json;
      if (!same) {
        try {
          same = isDeepStrictEqual(JSON.parse(previous.content), JSON.parse(json));
        } catch {
          same = false;
        }
      }
      if (!same) throw new AppError({ code: "conflict", message: "This reply was edited. Reload the chat to see the current text." });
      // A re-sent identical edited row is not news: keep its stored bytes and do not bump the chat's activity.
      return { ...row, content: JSON.parse(previous.content) as unknown };
    }
    if (previous && previous.content === json && previous.parent_id === row.parent_id && previous.format === row.format) {
      // Assistant turns are persisted step by step, and a reconnecting tab replays what it already sent.
      // normalizeImages above has already charged or mapped any actually new bytes, so an unchanged row can
      // return its stored content without an UPSERT, a search-index write, or a sidebar activity bump.
      return { ...row, content: JSON.parse(previous.content) as unknown };
    }
    if (previous?.content !== json) {
      storeInlineAttachments(db, userId, threadId, content, (size) => { assertStorage(userId, size); });
      assertStorage(userId, bytes - (previous?.bytes ?? 0));
    }
    // Upsert: assistant messages are re-sent when a stream finishes or a tool result lands.
    db.prepare(
      `INSERT INTO messages (id, thread_id, parent_id, format, content, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (thread_id, id) DO UPDATE SET parent_id = excluded.parent_id, format = excluded.format, content = excluded.content, bytes = excluded.bytes`,
    ).run(row.id, threadId, row.parent_id, row.format, json, bytes, Date.now());
    // A new native message means the imported initial selection hint no longer applies.
    db.prepare("UPDATE threads SET updated_at = ?, preferred_head = NULL WHERE id = ?").run(Date.now(), threadId);
    return { ...row, content };
  });
}

/** Client writes cannot mint server-owned imported provenance or inert-history parts. */
function stripImportClaims(content: unknown): unknown {
  if (!content || typeof content !== "object") return content;
  const value = content as Record<string,unknown>;
  const copy = {...value};
  if (Array.isArray(copy.parts)) copy.parts = copy.parts.filter((part: unknown) => {
    const type = part && typeof part === "object" ? (part as {type?:unknown}).type : null;
    return type !== "data-imported-quarantine" && type !== "data-imported-missing-attachment" && type !== "data-imported-tool";
  });
  for (const key of ["metadata","custom"]) {
    if (!copy[key] || typeof copy[key] !== "object") continue;
    const meta = {...copy[key] as Record<string,unknown>}; delete meta.importedTranscript;
    if (meta.custom && typeof meta.custom === "object") { meta.custom = {...meta.custom as Record<string,unknown>}; delete (meta.custom as Record<string,unknown>).importedTranscript; }
    copy[key] = meta;
  }
  return copy;
}

/**
 * A client's reply metadata is never proof of a provider finish reason. Drop any generation object; the
 * history read overlays the stored receipt, so a fabricated `finished`/`length` cannot enable Continue.
 */
function stripGeneration(content: unknown): unknown {
  const message = content as { role?: unknown; metadata?: unknown; custom?: unknown };
  if (!message || message.role !== "assistant") return content;
  const metadata = typeof message.metadata === "object" && message.metadata !== null ? { ...(message.metadata as Record<string, unknown>) } : null;
  const custom = typeof message.custom === "object" && message.custom !== null ? { ...(message.custom as Record<string, unknown>) } : null;
  if (metadata && typeof metadata.custom === "object" && metadata.custom !== null) {
    metadata.custom = { ...(metadata.custom as Record<string, unknown>) };
    delete (metadata.custom as Record<string, unknown>).generation;
  }
  if (metadata) delete metadata.generation;
  if (custom) delete custom.generation;
  return { ...(content as Record<string, unknown>), ...(metadata ? { metadata } : {}), ...(custom ? { custom } : {}) };
}

function createsCycle(threadId: string, id: string, parentId: string): boolean {
  // A direct self-parent is a cycle even before either row exists.
  if (parentId === id) return true;
  // One statement for the whole walk instead of a prepared lookup per ancestor. UNION dedupes, so a
  // pre-existing cycle in the stored graph terminates the recursion too, and the starting row is scoped
  // to this thread, so the walk never crosses into another chat.
  const found = db
    .prepare(
      `WITH RECURSIVE chain(id, parent_id) AS (
         SELECT id, parent_id FROM messages WHERE thread_id = ? AND id = ?
         UNION
         SELECT m.id, m.parent_id FROM messages m JOIN chain c ON m.thread_id = ? AND m.id = c.parent_id
       )
       SELECT 1 AS found FROM chain WHERE id = ? LIMIT 1`,
    )
    .get(threadId, parentId, threadId, id);
  return found !== undefined;
}

/** The branch the user last extended: newest message and its ancestors, oldest first. */
export function currentBranch(userId: string, threadId: string): UIMessage[] {
  const rows = listMessages(userId, threadId);
  const byId = new Map(rows.map((r) => [r.id, r]));
  // An imported archive starts on the leaf it was exported from, until the first new native message.
  const preferred = preferredHead(userId, threadId);
  const head = (preferred ? byId.get(preferred) : undefined) ?? rows.at(-1);
  return ancestry(byId, head).map((row) => ({ id: row.id, ...(row.content as Omit<UIMessage, "id">) }));
}

/** The stored import selection hint, only while that message still exists on this chat. */
export function preferredHead(userId: string, threadId: string): string | null {
  const row = db.prepare("SELECT preferred_head FROM threads WHERE user_id = ? AND id = ?").get(userId, threadId) as { preferred_head: string | null } | undefined;
  if (!row?.preferred_head) return null;
  return db.prepare("SELECT 1 FROM messages WHERE thread_id = ? AND id = ?").get(threadId, row.preferred_head) ? row.preferred_head : null;
}

/** `messageId` and its ancestors, oldest first: the branch the client is showing. */
export function branchMessages(userId: string, threadId: string, messageId: string): UIMessage[] {
  const byId = new Map(listMessages(userId, threadId).map((r) => [r.id, r]));
  return ancestry(byId, byId.get(messageId)).map((row) => ({ id: row.id, ...(row.content as Omit<UIMessage, "id">) }));
}

/** Stored user messages carry attachments as `<attachment name="…">` text parts. Returns the name, or undefined for normal text. */
export function attachmentName(text: string): string | undefined {
  return /^<attachment name="([^"]*)"/.exec(text)?.[1];
}

/** The user's own words on the current branch, without attachment bodies, as the title prompt sees them. */
export function userText(messages: UIMessage[], max = 4000): string {
  return messages
    .filter((m) => m.role === "user")
    .flatMap((m) => m.parts.flatMap((p) => (p.type === "text" && attachmentName(p.text) === undefined ? [p.text] : [])))
    .join("\n\n")
    .slice(0, max);
}
