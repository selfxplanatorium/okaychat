import { isDeepStrictEqual } from "node:util";
import type { UIMessage } from "ai";
import { HTTPException } from "hono/http-exception";
import type { CompactionState, ThreadSummary } from "../shared/types.js";
import { assertStorage, messageBytes } from "./quota.js";
import { storeInlineAttachments } from "./attachment-storage.js";
import { db, tx } from "./db.js";
import { copyDraftsForBranch } from "./email/drafts.js";
import { AppError } from "./errors.js";

/** Temporary conversations exist only in browser memory; their ids must never become stored threads. */
export const isTemporaryThread = (id: string): boolean => id.startsWith("tmp_");

interface ThreadRow {
  id: string;
  title: string | null;
  status: "regular" | "archived";
  model_ref: string | null;
  project_id: string | null;
  compaction_json: string | null;
  memory_disabled: number;
  pinned: number;
  knowledge_ids: string | null;
  branched_from: string | null;
  /** Joined from the source thread; null once it is deleted. */
  branched_title: string | null;
  branched_exists: number | null;
  created_at: number;
  updated_at: number;
}

const SELECT_THREADS = `SELECT t.*, o.title AS branched_title, o.id IS NOT NULL AS branched_exists FROM threads t
  LEFT JOIN threads o ON o.id = t.branched_from AND o.user_id = t.user_id`;

const parseIds = (value: string | null): string[] => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string").slice(0, 20) : [];
  } catch {
    return [];
  }
};

const toSummary = (r: ThreadRow): ThreadSummary => ({
  id: r.id,
  title: r.title,
  status: r.status,
  modelRef: r.model_ref,
  projectId: r.project_id,
  memoryDisabled: !!r.memory_disabled,
  pinned: !!r.pinned,
  knowledgeIds: parseIds(r.knowledge_ids),
  branchedFrom: r.branched_from && r.branched_exists ? { id: r.branched_from, title: r.branched_title } : null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** `projectId` undefined lists every thread; null lists threads outside any project. `status` undefined lists both. */
export function listThreads(userId: string, projectId?: string | null, status?: "regular" | "archived"): ThreadSummary[] {
  const where = ["t.user_id = ?"];
  const values: string[] = [userId];
  if (projectId === null) where.push("t.project_id IS NULL");
  else if (projectId !== undefined) where.push("t.project_id = ?"), values.push(projectId);
  if (status !== undefined) where.push("t.status = ?"), values.push(status);
  const rows = db.prepare(`${SELECT_THREADS} WHERE ${where.join(" AND ")} ORDER BY t.updated_at DESC LIMIT 500`).all(...values) as unknown as ThreadRow[];
  return rows.map(toSummary);
}

export function getThread(userId: string, id: string): (ThreadSummary & { compaction: CompactionState | null }) | null {
  const row = db.prepare(`${SELECT_THREADS} WHERE t.user_id = ? AND t.id = ?`).get(userId, id) as unknown as ThreadRow | undefined;
  if (!row) return null;
  return { ...toSummary(row), compaction: row.compaction_json ? (JSON.parse(row.compaction_json) as CompactionState) : null };
}

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
 * pinning, archiving, or moving a chat must not bump it. `appendMessage` does.
 */
export function updateThread(
  userId: string,
  id: string,
  patch: { title?: string; status?: "regular" | "archived"; modelRef?: string; memoryDisabled?: boolean; pinned?: boolean; projectId?: string | null; knowledgeIds?: string[] },
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
  if (!sets.length) return;
  db.prepare(`UPDATE threads SET ${sets.join(", ")} WHERE user_id = ? AND id = ?`).run(...values, userId, id);
}

export function setCompaction(userId: string, id: string, state: CompactionState | null) {
  db.prepare("UPDATE threads SET compaction_json = ? WHERE user_id = ? AND id = ?").run(
    state ? JSON.stringify(state) : null,
    userId,
    id,
  );
}

export function deleteThread(userId: string, id: string) {
  db.prepare("DELETE FROM threads WHERE user_id = ? AND id = ?").run(userId, id);
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
export function branchThread(userId: string, sourceId: string, messageId: string, id: string, modelRef?: string): ThreadSummary {
  const source = getThread(userId, sourceId);
  if (!source) throw new HTTPException(404, { message: "Thread not found" });
  const rows = listMessages(userId, sourceId);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const chain: MessageRow[] = [];
  for (let row = byId.get(messageId); row; row = row.parent_id ? byId.get(row.parent_id) : undefined) chain.unshift(row);
  if (!chain.length) throw new HTTPException(404, { message: "Message not found" });
  const edits = editStates(sourceId);
  const boundaries = [source.compaction?.boundaryMessageId, source.compaction?.trim?.throughMessageId];
  const compaction = source.compaction && chain.some((m) => boundaries.includes(m.id)) ? source.compaction : null;
  const now = Date.now();
  tx(() => {
    db.prepare(
      `INSERT INTO threads (id, user_id, title, model_ref, project_id, compaction_json, memory_disabled, branched_from, memory_cursor, knowledge_ids, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      // The copied messages belong to the source chat's memory review; the fork only reviews what follows.
    ).run(id, userId, source.title, modelRef ?? source.modelRef, source.projectId, compaction ? JSON.stringify(compaction) : null, Number(source.memoryDisabled), sourceId, messageId, JSON.stringify(source.knowledgeIds), now, now);
    const insert = db.prepare("INSERT INTO messages (id, thread_id, parent_id, format, content, bytes, created_at, edited_at, original_enc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    // An edited reply keeps its current text, its Edited state, and the encrypted first original, so the fork
    // shows the same text and can still Undo. Both the message and the original are charged to the fork.
    const copies = chain.map((m) => {
      const edit = edits.get(m.id);
      return { m, json: JSON.stringify(m.content), editedAt: edit?.edited_at ?? null, original: edit?.original_enc ?? null };
    });
    assertStorage(userId, copies.reduce((sum, { json, original }) => sum + messageBytes(json) + (original ? Buffer.byteLength(original) : 0), 0));
    // Distinct timestamps keep the copied order, which defines the current branch.
    copies.forEach(({ m, json, editedAt, original }, i) =>
      insert.run(m.id, id, m.parent_id, m.format, json, messageBytes(json), now - chain.length + i, editedAt, original));
    // Draft cards in the copied messages keep working in the fork.
    copyDraftsForBranch(userId, sourceId, id, copies.map(({ json }) => json));
  });
  return getThread(userId, id)!;
}

export interface MessageRow {
  id: string;
  parent_id: string | null;
  format: string;
  content: unknown;
}

export function listMessages(userId: string, threadId: string): MessageRow[] {
  if (!getThread(userId, threadId)) return [];
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
  if (!getThread(userId, threadId)) return "[]";
  const rows = db
    .prepare("SELECT id, parent_id, format, content, edited_at FROM messages WHERE thread_id = ? ORDER BY created_at, rowid")
    .all(threadId) as Array<{ id: string; parent_id: string | null; format: string; content: string; edited_at: number | null }>;
  // `edited_at` appears only on edited replies; the client shows their Edited badge from it.
  const items = rows.map((r) => `{"id":${JSON.stringify(r.id)},"parent_id":${JSON.stringify(r.parent_id)},"format":${JSON.stringify(r.format)},"content":${r.content}${r.edited_at === null ? "" : `,"edited_at":${r.edited_at}`}}`);
  return `[${items.join(",")}]`;
}

export function appendMessage(userId: string, threadId: string, row: MessageRow) {
  tx(() => {
    ensureThread(userId, threadId);
    const previous = db.prepare("SELECT content, bytes, edited_at, original_enc FROM messages WHERE thread_id = ? AND id = ?").get(threadId, row.id) as { content: string; bytes: number; edited_at: number | null; original_enc: string | null } | undefined;
    const json = JSON.stringify(row.content);
    const bytes = messageBytes(json);
    // A user edit changes a reply only through the edit route. A tab still holding text from before it (or from
    // before an Undo, when only `original_enc` remains) re-sends old content, which must not silently rewrite it.
    // Compare parsed values too: a client re-encoding the same reply may order keys differently.
    if (previous && (previous.edited_at !== null || previous.original_enc !== null)) {
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
      return;
    }
    if (previous?.content !== json) {
      storeInlineAttachments(db, userId, threadId, row.content, (size) => { assertStorage(userId, size); });
      assertStorage(userId, bytes - (previous?.bytes ?? 0));
    }
    // Upsert: assistant messages are re-sent when a stream finishes or a tool result lands.
    db.prepare(
      `INSERT INTO messages (id, thread_id, parent_id, format, content, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (thread_id, id) DO UPDATE SET parent_id = excluded.parent_id, format = excluded.format, content = excluded.content, bytes = excluded.bytes`,
    ).run(row.id, threadId, row.parent_id, row.format, json, bytes, Date.now());
    db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(Date.now(), threadId);
  });
}

/** The branch the user last extended: newest message and its ancestors, oldest first. */
export function currentBranch(userId: string, threadId: string): UIMessage[] {
  const rows = listMessages(userId, threadId);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: UIMessage[] = [];
  for (let row = rows.at(-1); row; row = row.parent_id ? byId.get(row.parent_id) : undefined) {
    out.unshift({ id: row.id, ...(row.content as Omit<UIMessage, "id">) });
  }
  return out;
}

/** `messageId` and its ancestors, oldest first: the branch the client is showing. */
export function branchMessages(userId: string, threadId: string, messageId: string): UIMessage[] {
  const byId = new Map(listMessages(userId, threadId).map((r) => [r.id, r]));
  const out: UIMessage[] = [];
  for (let row = byId.get(messageId); row; row = row.parent_id ? byId.get(row.parent_id) : undefined) {
    out.unshift({ id: row.id, ...(row.content as Omit<UIMessage, "id">) });
  }
  return out;
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
