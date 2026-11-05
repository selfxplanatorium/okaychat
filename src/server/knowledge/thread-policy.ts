import { AppError } from "../errors.js";
import { afterCommit, db, tx } from "../db.js";
import { threadBusy } from "../thread-runs.js";
import { readableCollectionRow, readableCollectionsForChat } from "./access.js";
import { removeArchiveStagingForUser } from "../archive-jobs.js";
import { featureAllowed } from "../permissions/guard.js";
import { registerKnowledgeOperation } from "./revocation.js";

// A chat that has ever attached another account's collection keeps durable dependencies. They survive
// detaching, archiving, and a model change, and they are never pruned: deleting the collection leaves a
// tombstone that keeps the chat locked. The whole chat is withheld while any dependency is unreadable,
// because generated answers, edits, summaries, and tool results cannot be attributed to one collection.

/** Operational metadata only: no name, URL, owner identity, passage, or query is stored here. */
export const MAX_LIFETIME_DEPENDENCIES = 20;

export function dependencyRows(threadId: string): Array<{ collection_id: string; created_at: number }> {
  return db.prepare("SELECT collection_id, created_at FROM knowledge_thread_dependencies WHERE thread_id = ? ORDER BY created_at, collection_id").all(threadId) as Array<{ collection_id: string; created_at: number }>;
}

/** Independent of the current attachment list: detaching does not turn a restricted chat back into one. */
export function isRestrictedKnowledgeThread(threadId: string): boolean {
  return !!db.prepare("SELECT 1 FROM knowledge_thread_dependencies WHERE thread_id = ? LIMIT 1").get(threadId);
}

/** The account owns this thread (live row). Does not imply the content is readable. */
export function ownsThreadRow(userId: string, threadId: string): boolean {
  return !!db.prepare("SELECT 1 FROM threads WHERE user_id = ? AND id = ?").get(userId, threadId);
}

/**
 * Every dependency must still resolve through the live predicate, and the reader's own knowledge feature
 * must be allowed. A missing collection denies; a re-created one with the same id does not grant anything
 * unless the audience now includes the reader, which is the same check as a fresh read.
 */
export function restrictedThreadReadable(userId: string, threadId: string): boolean {
  if (!ownsThreadRow(userId, threadId)) return false;
  const dependencies = dependencyRows(threadId);
  if (!dependencies.length) return true;
  if (!featureAllowed(userId, "knowledge")) return false;
  return dependencies.every((dependency) => !!readableCollectionRow(userId, dependency.collection_id));
}

export type KnowledgeThreadAccess = "available" | "revoked";

/** `null` means the thread is missing or foreign, which callers must answer as 404, not as a locked chat. */
export function threadKnowledgeAccess(userId: string, threadId: string): KnowledgeThreadAccess | null {
  if (!ownsThreadRow(userId, threadId)) return null;
  return restrictedThreadReadable(userId, threadId) ? "available" : "revoked";
}

export function knowledgeAccessRevoked(): AppError {
  return new AppError({
    code: "forbidden",
    message: "Shared knowledge used by this chat is unavailable.",
    hint: "Ask the collection owner for access, or start a new chat.",
    details: { reason: "knowledge_access_revoked" },
  });
}

export function distributionRestricted(): AppError {
  return new AppError({
    code: "conflict",
    message: "This action is unavailable for a chat that uses shared knowledge.",
    hint: "Start a new chat to share, export, schedule, or copy this answer.",
    details: { reason: "shared_knowledge_restricted" },
  });
}

/** Content of a locked restricted chat is never returned, including tool records, edits, and summaries. */
export function assertThreadContentReadable(userId: string, threadId: string): void {
  const access = threadKnowledgeAccess(userId, threadId);
  // A missing or foreign thread answers as not found; only an owned locked one admits it is locked.
  if (access === null) throw new AppError({ code: "not_found", message: "Thread not found" });
  if (access === "revoked") throw knowledgeAccessRevoked();
}

/**
 * A caller's signal combined with a live dependency lease for a restricted chat. Utility calls (titles,
 * translations) must abort when a dependency becomes unreadable, not only at their own admission check.
 */
export function restrictedThreadSignal(userId: string, threadId: string, signal?: AbortSignal): { signal: AbortSignal | undefined; release: () => void } {
  if (!isRestrictedKnowledgeThread(threadId)) return { signal, release: () => {} };
  const controller = new AbortController();
  const release = registerKnowledgeOperation(controller, () => threadKnowledgeAccess(userId, threadId) === "available");
  return { signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, release };
}

/** Sharing, export, archives, schedules, comparisons, and copies refuse even while all dependencies resolve. */
export function assertThreadRedistributable(threadId: string): void {
  if (isRestrictedKnowledgeThread(threadId)) throw distributionRestricted();
}

/** Thread ids of this account whose restricted content is currently locked. */
export function lockedThreadIds(userId: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT t.id FROM threads t JOIN knowledge_thread_dependencies d ON d.thread_id = t.id WHERE t.user_id = ?`,
    )
    .all(userId) as Array<{ id: string }>;
  const locked = new Set<string>();
  for (const row of rows) {
    if (!restrictedThreadReadable(userId, row.id)) locked.add(row.id);
  }
  return locked;
}

/** Thread ids with any dependency, readable or not; list projections use this for the restricted badge. */
export function restrictedThreadIds(userId: string): Set<string> {
  const rows = db
    .prepare(`SELECT DISTINCT t.id FROM threads t JOIN knowledge_thread_dependencies d ON d.thread_id = t.id WHERE t.user_id = ?`)
    .all(userId) as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

/**
 * A live/frozen share or an unfinished archive job would copy content out during a first transition. Archive
 * jobs are account-wide and do not store their thread list, so any open job for this account blocks.
 */
function hasRedistributionWork(userId: string, threadId: string): boolean {
  if (db.prepare("SELECT 1 FROM shares WHERE thread_id = ? LIMIT 1").get(threadId)) return true;
  return !!db.prepare("SELECT 1 FROM archive_jobs WHERE user_id = ? AND state IN ('preparing', 'ready', 'committing') LIMIT 1").get(userId);
}

export class KnowledgeAttachError extends Error {
  constructor(readonly reason: "ack_required" | "conflict" | "limit" | "busy" | "invalid") {
    super(reason);
    this.name = "KnowledgeAttachError";
  }
}

export interface AttachmentChange {
  /** Already validated as readable-for-chat by the caller? This function re-validates regardless. */
  knowledgeIds: string[];
  acceptSharedRestrictions: boolean;
  /** A project move being applied in the same request, validated against the destination. */
  projectId?: string | null;
}

/**
 * The only writer of `threads.knowledge_ids` for a chat with knowledge. Ordinary chats keep the existing PATCH
 * path; the first transition to another account's collection requires the acknowledgement, finds no open
 * share/archive work, and installs the durable dependencies, the attachment list, and disabling of automatic
 * memory learning in one transaction. Later detaches only change the attachment list.
 */
export function applyKnowledgeAttachments(userId: string, threadId: string, change: AttachmentChange): "ordinary" | "restricted" {
  const thread = db.prepare("SELECT project_id FROM threads WHERE user_id = ? AND id = ?").get(userId, threadId) as { project_id: string | null } | undefined;
  if (!thread) throw new KnowledgeAttachError("invalid");
  const ids = [...new Set(change.knowledgeIds)].slice(0, 20);
  const rows = readableCollectionsForChat(userId, ids, change.projectId === undefined ? thread.project_id : change.projectId);
  if (rows.length !== ids.length) throw new KnowledgeAttachError("invalid");
  const foreign = rows.filter((row) => row.user_id !== userId).map((row) => row.id);
  const existing = dependencyRows(threadId).map((row) => row.collection_id);
  const existingSet = new Set(existing);
  const fresh = foreign.filter((id) => !existingSet.has(id));
  if (fresh.length) {
    if (!change.acceptSharedRestrictions) throw new KnowledgeAttachError("ack_required");
    if (existing.length + fresh.length > MAX_LIFETIME_DEPENDENCIES) throw new KnowledgeAttachError("limit");
    if (threadBusy(threadId)) throw new KnowledgeAttachError("busy");
    if (hasRedistributionWork(userId, threadId)) throw new KnowledgeAttachError("conflict");
  }
  tx(() => {
    db.prepare("UPDATE threads SET knowledge_ids = ? WHERE user_id = ? AND id = ?").run(JSON.stringify(ids), userId, threadId);
    if (fresh.length) {
      const insert = db.prepare("INSERT OR IGNORE INTO knowledge_thread_dependencies (thread_id, collection_id, created_at) VALUES (?, ?, ?)");
      let stamp = Date.now();
      for (const id of fresh) insert.run(threadId, id, stamp++);
      // Restricted history must never become a source of independently stored memories.
      db.prepare("UPDATE threads SET memory_disabled = 1 WHERE user_id = ? AND id = ?").run(userId, threadId);
    }
  });
  if (fresh.length) {
    // A finished export may still hold a ZIP of this chat; nothing restricted may remain downloadable.
    afterCommit(() => removeArchiveStagingForUser(userId));
  }
  return existing.length + fresh.length > 0 ? "restricted" : "ordinary";
}
