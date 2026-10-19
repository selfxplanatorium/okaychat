import type { CompactionState, ThreadSummary } from "../shared/types.js";
import { db } from "./db.js";

interface ThreadRow {
  id: string;
  title: string | null;
  status: "regular" | "archived";
  model_ref: string | null;
  project_id: string | null;
  compaction_json: string | null;
  created_at: number;
  updated_at: number;
}

const toSummary = (r: ThreadRow): ThreadSummary => ({
  id: r.id,
  title: r.title,
  status: r.status,
  modelRef: r.model_ref,
  projectId: r.project_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** `projectId` undefined lists every thread; null lists threads outside any project. */
export function listThreads(userId: string, projectId?: string | null): ThreadSummary[] {
  const rows = (
    projectId === undefined
      ? db.prepare("SELECT * FROM threads WHERE user_id = ? ORDER BY updated_at DESC LIMIT 500").all(userId)
      : projectId === null
        ? db.prepare("SELECT * FROM threads WHERE user_id = ? AND project_id IS NULL ORDER BY updated_at DESC LIMIT 500").all(userId)
        : db.prepare("SELECT * FROM threads WHERE user_id = ? AND project_id = ? ORDER BY updated_at DESC LIMIT 500").all(userId, projectId)
  ) as unknown as ThreadRow[];
  return rows.map(toSummary);
}

export function getThread(userId: string, id: string): (ThreadSummary & { compaction: CompactionState | null }) | null {
  const row = db.prepare("SELECT * FROM threads WHERE user_id = ? AND id = ?").get(userId, id) as ThreadRow | undefined;
  if (!row) return null;
  return { ...toSummary(row), compaction: row.compaction_json ? (JSON.parse(row.compaction_json) as CompactionState) : null };
}

/** Idempotent: the client may call initialize more than once for the same id. */
export function ensureThread(userId: string, id: string, projectId: string | null = null): ThreadSummary {
  const now = Date.now();
  db.prepare("INSERT OR IGNORE INTO threads (id, user_id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, userId, projectId, now, now);
  const thread = getThread(userId, id);
  if (!thread) throw new Error("Thread belongs to another user");
  return thread;
}

export function updateThread(userId: string, id: string, patch: { title?: string; status?: "regular" | "archived"; modelRef?: string }) {
  const sets: string[] = [];
  const values: Array<string | number> = [];
  if (patch.title !== undefined) sets.push("title = ?"), values.push(patch.title);
  if (patch.status !== undefined) sets.push("status = ?"), values.push(patch.status);
  if (patch.modelRef !== undefined) sets.push("model_ref = ?"), values.push(patch.modelRef);
  sets.push("updated_at = ?");
  values.push(Date.now());
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

export function appendMessage(userId: string, threadId: string, row: MessageRow) {
  ensureThread(userId, threadId);
  // Upsert: assistant messages are re-sent when a stream finishes or a tool result lands.
  db.prepare(
    `INSERT INTO messages (id, thread_id, parent_id, format, content, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (thread_id, id) DO UPDATE SET parent_id = excluded.parent_id, format = excluded.format, content = excluded.content`,
  ).run(row.id, threadId, row.parent_id, row.format, JSON.stringify(row.content), Date.now());
  db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(Date.now(), threadId);
}
