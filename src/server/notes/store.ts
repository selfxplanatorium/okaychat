import { canonicalJson } from "../../shared/permissions.js";
import {
  MAX_NOTES,
  checkNoteWrite,
  isSafeId,
  noteBytes,
  noteExcerpt,
  type Note,
  type NoteFromSource,
  type NoteOrigin,
  type NotePage,
  type NoteSummary,
  type NoteTagCount,
  type NoteWrite,
} from "../../shared/notes.js";
import { newId, sha256 } from "../crypto.js";
import { db, tx } from "../db.js";
import { AppError } from "../errors.js";
import { assertFeature } from "../permissions/guard.js";
import { getProject } from "../projects.js";
import { assertStorage } from "../quota.js";
import { threadBusy } from "../thread-runs.js";
import { isRestrictedKnowledgeThread } from "../knowledge/thread-policy.js";
import { ftsMatchQuery, ftsTokens } from "../text-search.js";

/**
 * Notes storage. Every entry point rechecks the account feature, and every mutation validates before it
 * opens one synchronous transaction: links, ownership, revision, quota, and the account count all resolve
 * inside the same transaction as the write. See docs/implementation/notes.md.
 */

interface Row {
  id: string;
  title: string;
  body: string;
  favorite: number;
  pinned: number;
  project_id: string | null;
  source_kind: "message" | "artifact" | null;
  source_thread_id: string | null;
  source_item_id: string | null;
  source_version: number | null;
  revision: number;
  created_at: number;
  updated_at: number;
}

const COLUMNS =
  "id, title, body, favorite, pinned, project_id, source_kind, source_thread_id, source_item_id, source_version, revision, created_at, updated_at";

const STALE = "This note changed in another tab or window. Reload it before saving.";
const NOT_FOUND = "Note not found";

const invalid = (message: string, details?: Record<string, unknown>) => new AppError({ code: "validation", message, details });
const conflict = (message: string, details?: Record<string, unknown>) => new AppError({ code: "conflict", message, details });
const notFound = () => new AppError({ code: "not_found", message: NOT_FOUND });

function originOf(row: Row): NoteOrigin | null {
  if (row.source_kind === "message" && row.source_thread_id && row.source_item_id) {
    return { kind: "message", threadId: row.source_thread_id, messageId: row.source_item_id };
  }
  if (row.source_kind === "artifact" && row.source_thread_id && row.source_item_id && row.source_version !== null) {
    return { kind: "artifact", threadId: row.source_thread_id, artifactId: row.source_item_id, version: row.source_version };
  }
  return null;
}

/** A live owned-row lookup; a stale pointer is reported, never treated as access. */
function sourceAvailable(userId: string, origin: NoteOrigin | null): boolean {
  if (!origin) return false;
  if (origin.kind === "message") {
    return (
      db
        .prepare(
          `SELECT 1 FROM messages m JOIN threads t ON t.id = m.thread_id
           WHERE t.user_id = ? AND m.thread_id = ? AND m.id = ?`,
        )
        .get(userId, origin.threadId, origin.messageId) !== undefined
    );
  }
  return (
    db
      .prepare(
        `SELECT 1 FROM artifacts a JOIN threads t ON t.id = a.thread_id
         WHERE t.user_id = ? AND a.thread_id = ? AND a.id = ? AND a.version = ?`,
      )
      .get(userId, origin.threadId, origin.artifactId, origin.version) !== undefined
  );
}

function tagsOf(noteId: string): string[] {
  return (db.prepare("SELECT tag FROM note_tags WHERE note_id = ? ORDER BY tag").all(noteId) as Array<{ tag: string }>).map((row) => row.tag);
}

function toNote(row: Row, userId: string): Note {
  const origin = originOf(row);
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    favorite: row.favorite === 1,
    pinned: row.pinned === 1,
    tags: tagsOf(row.id),
    projectId: row.project_id,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    source: origin,
    sourceAvailable: sourceAvailable(userId, origin),
  };
}

function toSummary(row: Row, userId: string): NoteSummary {
  const { body, ...rest } = toNote(row, userId);
  return { ...rest, excerpt: noteExcerpt(body) };
}

function ownedRow(userId: string, id: string): Row {
  const row = db.prepare(`SELECT ${COLUMNS} FROM notes WHERE id = ? AND user_id = ?`).get(id, userId) as Row | undefined;
  if (!row) throw notFound();
  return row;
}

function assertProject(userId: string, projectId: string | null): void {
  if (projectId !== null && !getProject(userId, projectId)) {
    throw new AppError({ code: "not_found", message: "Project not found" });
  }
}

function writeTags(noteId: string, tags: readonly string[]): void {
  db.prepare("DELETE FROM note_tags WHERE note_id = ?").run(noteId);
  const insert = db.prepare("INSERT INTO note_tags (note_id, tag) VALUES (?, ?)");
  for (const tag of tags) insert.run(noteId, tag);
}

const writeHash = (write: NoteWrite): string => sha256(canonicalJson({ op: "create", ...write }));

const sourceHash = (input: NoteFromSource): string =>
  sha256(
    canonicalJson({
      op: "source",
      source: input.source,
      titlePresent: input.title !== undefined,
      title: input.title ?? null,
      projectPresent: input.projectId !== undefined,
      projectId: input.projectId ?? null,
    }),
  );

function retried(userId: string, requestId: string, hash: string): Note | null {
  const row = db.prepare(`SELECT ${COLUMNS}, create_hash FROM notes WHERE user_id = ? AND create_key = ?`).get(userId, requestId) as
    | (Row & { create_hash: string })
    | undefined;
  if (!row) return null;
  if (row.create_hash !== hash) throw conflict("This request id was already used for a different note.", { reason: "request_reused" });
  return toNote(row, userId);
}

function checkCount(userId: string): void {
  const count = (db.prepare("SELECT COUNT(*) AS n FROM notes WHERE user_id = ?").get(userId) as { n: number }).n;
  if (count >= MAX_NOTES) throw conflict(`You can keep up to ${MAX_NOTES} notes. Delete a note to create another.`, { reason: "limit", limit: MAX_NOTES });
}

/** Cursor binds the normalized filter; edits between pages may move rows, so the client dedupes. */
export interface NoteCursor {
  v: 1;
  pinned: 0 | 1;
  updatedAt: number;
  id: string;
  filterHash: string;
}

export interface NoteListQuery {
  q: string;
  favorite: boolean | null;
  pinned: boolean | null;
  /** `undefined` lists every project, `null` only unlinked notes. */
  projectId: string | null | undefined;
  tags: string[];
  tagMatch: "any" | "all";
  limit: number;
  cursor?: string;
}

export function noteFilterHash(query: NoteListQuery): string {
  return sha256(
    canonicalJson({
      q: query.q,
      favorite: query.favorite,
      pinned: query.pinned,
      projectId: query.projectId === undefined ? "all" : query.projectId,
      tags: [...query.tags].sort(),
      tagMatch: query.tagMatch,
    }),
  );
}

export function encodeNoteCursor(cursor: NoteCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeNoteCursor(value: string): NoteCursor {
  if (value.length > 1024) throw invalid("Invalid cursor");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw invalid("Invalid cursor");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid("Invalid cursor");
  const cursor = parsed as Record<string, unknown>;
  if (
    cursor.v !== 1 ||
    (cursor.pinned !== 0 && cursor.pinned !== 1) ||
    typeof cursor.updatedAt !== "number" ||
    !Number.isSafeInteger(cursor.updatedAt) ||
    cursor.updatedAt < 0 ||
    !isSafeId(cursor.id) ||
    typeof cursor.filterHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(cursor.filterHash) ||
    Object.keys(cursor).length !== 5
  ) {
    throw invalid("Invalid cursor");
  }
  return {
    v: 1,
    pinned: cursor.pinned,
    updatedAt: cursor.updatedAt,
    id: cursor.id,
    filterHash: cursor.filterHash,
  };
}

export function listNotes(userId: string, query: NoteListQuery): NotePage {
  assertFeature(userId, "notes");
  if (query.projectId !== undefined && query.projectId !== null && !getProject(userId, query.projectId)) {
    throw new AppError({ code: "not_found", message: "Project not found" });
  }
  const filterHash = noteFilterHash(query);
  const cursor = query.cursor ? decodeNoteCursor(query.cursor) : null;
  if (cursor && cursor.filterHash !== filterHash) throw invalid("Invalid cursor");
  const where: string[] = ["n.user_id = ?"];
  const values: Array<string | number> = [userId];
  if (query.favorite !== null) {
    where.push("n.favorite = ?");
    values.push(query.favorite ? 1 : 0);
  }
  if (query.pinned !== null) {
    where.push("n.pinned = ?");
    values.push(query.pinned ? 1 : 0);
  }
  if (query.projectId !== undefined) {
    if (query.projectId === null) where.push("n.project_id IS NULL");
    else {
      where.push("n.project_id = ?");
      values.push(query.projectId);
    }
  }
  if (query.tags.length) {
    const placeholders = query.tags.map(() => "?").join(", ");
    if (query.tagMatch === "all") {
      where.push(
        `(SELECT COUNT(DISTINCT nt.tag) FROM note_tags nt WHERE nt.note_id = n.id AND nt.tag IN (${placeholders})) = ?`,
      );
      values.push(...query.tags, query.tags.length);
    } else {
      where.push(`EXISTS (SELECT 1 FROM note_tags nt WHERE nt.note_id = n.id AND nt.tag IN (${placeholders}))`);
      values.push(...query.tags);
    }
  }
  const tokens = ftsTokens(query.q);
  if (query.q.trim() && !tokens.length) return { items: [], nextCursor: null };
  if (tokens.length) {
    where.push("n.search_id IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?)");
    values.push(ftsMatchQuery(tokens));
  }
  if (cursor) {
    where.push("(n.pinned < ? OR (n.pinned = ? AND (n.updated_at < ? OR (n.updated_at = ? AND n.id < ?))))");
    values.push(cursor.pinned, cursor.pinned, cursor.updatedAt, cursor.updatedAt, cursor.id);
  }
  const limit = query.limit;
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM notes n WHERE ${where.join(" AND ")} ORDER BY n.pinned DESC, n.updated_at DESC, n.id DESC LIMIT ?`)
    .all(...values, limit + 1) as unknown as Row[];
  const page = rows.slice(0, limit);
  const items = page.map((row) => toSummary(row, userId));
  const last = page.at(-1);
  const nextCursor =
    rows.length > limit && last
      ? encodeNoteCursor({
          v: 1,
          pinned: last.pinned === 1 ? 1 : 0,
          updatedAt: last.updated_at,
          id: last.id,
          filterHash,
        })
      : null;
  return { items, nextCursor };
}

export function noteTagCounts(userId: string): NoteTagCount[] {
  assertFeature(userId, "notes");
  return db
    .prepare(
      `SELECT nt.tag AS tag, COUNT(*) AS count FROM note_tags nt JOIN notes n ON n.id = nt.note_id
       WHERE n.user_id = ? GROUP BY nt.tag ORDER BY count DESC, nt.tag ASC`,
    )
    .all(userId) as unknown as NoteTagCount[];
}

export function getNote(userId: string, id: string): Note {
  assertFeature(userId, "notes");
  return toNote(ownedRow(userId, id), userId);
}

export function createNote(userId: string, requestId: string, write: NoteWrite): { note: Note; created: boolean } {
  assertFeature(userId, "notes");
  const checked = checkNoteWrite(write);
  if (!checked.ok) throw invalid("Invalid note", { problem: checked.problem });
  const value = checked.value;
  const hash = writeHash(value);
  return tx(() => {
    const existing = retried(userId, requestId, hash);
    if (existing) return { note: existing, created: false };
    assertProject(userId, value.projectId);
    checkCount(userId);
    assertStorage(userId, noteBytes(value));
    const now = Date.now();
    const id = newId("note");
    db.prepare(
      `INSERT INTO notes (id, user_id, title, body, favorite, pinned, project_id, create_key, create_hash, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(id, userId, value.title, value.body, value.favorite ? 1 : 0, value.pinned ? 1 : 0, value.projectId, requestId, hash, now, now);
    writeTags(id, value.tags);
    return { note: toNote(ownedRow(userId, id), userId), created: true };
  });
}

interface SourceProjection {
  body: string;
  defaultTitle: string;
  projectId: string | null;
}

function sourceProjection(userId: string, input: NoteFromSource): SourceProjection {
  const { source } = input;
  // A chat using shared knowledge cannot be copied into another workspace.
  if (isRestrictedKnowledgeThread(source.threadId)) throw conflict("This action is unavailable for a chat that uses shared knowledge.", { reason: "shared_knowledge_restricted" });
  if (source.kind === "message") {
    const row = db
      .prepare(
        `SELECT m.content AS content, t.project_id AS project_id, t.compare_group_id AS compare_group_id, t.status AS status
         FROM messages m JOIN threads t ON t.id = m.thread_id
         WHERE t.user_id = ? AND m.thread_id = ? AND m.id = ?`,
      )
      .get(userId, source.threadId, source.messageId) as
      | { content: string; project_id: string | null; compare_group_id: string | null; status: string }
      | undefined;
    if (!row || source.threadId.startsWith("tmp_") || row.compare_group_id) throw notFound();
    if (threadBusy(source.threadId)) {
      throw conflict("Wait for this chat to finish before copying its text.", { reason: "source_busy" });
    }
    let parsed: { role?: unknown; parts?: unknown };
    try {
      parsed = JSON.parse(row.content) as typeof parsed;
    } catch {
      throw invalid("This message has no copyable text.", { reason: "source_empty" });
    }
    if (parsed.role !== "user" && parsed.role !== "assistant") throw invalid("This message has no copyable text.", { reason: "source_empty" });
    const texts = (Array.isArray(parsed.parts) ? parsed.parts : [])
      .filter((part): part is { type: "text"; text: string } => {
        if (!part || typeof part !== "object") return false;
        const candidate = part as { type?: unknown; text?: unknown };
        return candidate.type === "text" && typeof candidate.text === "string";
      })
      .map((part) => part.text);
    const body = texts.join("\n\n");
    if (!body.trim()) throw invalid("This message has no copyable text.", { reason: "source_empty" });
    return { body, defaultTitle: derivedTitle(body), projectId: row.project_id };
  }

  assertFeature(userId, "artifacts");
  const row = db
    .prepare(
      `SELECT a.title AS title, a.kind AS kind, a.content AS content, t.project_id AS project_id
       FROM artifacts a JOIN threads t ON t.id = a.thread_id
       WHERE t.user_id = ? AND a.thread_id = ? AND a.id = ? AND a.version = ?`,
    )
    .get(userId, source.threadId, source.artifactId, source.version) as
    | { title: string; kind: string; content: string; project_id: string | null }
    | undefined;
  if (!row || source.threadId.startsWith("tmp_")) throw notFound();
  if (row.kind !== "markdown") {
    throw invalid("Only Markdown artifacts can be saved as notes.", { reason: "source_unsupported" });
  }
  return { body: row.content, defaultTitle: derivedTitle(row.title), projectId: row.project_id };
}

/** First nonempty line without its heading markers, clipped UTF-8 safely. */
function derivedTitle(text: string): string {
  const line = text.split(/\r?\n/).map((value) => value.trim()).find(Boolean) ?? "";
  return clipTitle(line.replace(/^#{1,6}\s+/, "").trim());
}

function clipTitle(value: string): string {
  let out = "";
  let bytes = 0;
  let chars = 0;
  for (const char of value) {
    if (chars >= 200) break;
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > 800) break;
    out += char;
    chars++;
    bytes += size;
  }
  return out;
}

export function createNoteFromSource(userId: string, input: NoteFromSource): { note: Note; created: boolean } {
  assertFeature(userId, "notes");
  if (!isSafeId(input.source.threadId)) throw invalid("Invalid source");
  if (input.source.kind === "message" && !isSafeId(input.source.messageId)) throw invalid("Invalid source");
  if (input.source.kind === "artifact") {
    if (!isSafeId(input.source.artifactId) || !Number.isSafeInteger(input.source.version) || input.source.version < 1) {
      throw invalid("Invalid source version");
    }
  }
  const hash = sourceHash(input);
  return tx(() => {
    const existing = retried(userId, input.requestId, hash);
    if (existing) return { note: existing, created: false };
    const projection = sourceProjection(userId, input);
    const title = input.title !== undefined ? clipTitle(input.title.trim()) : projection.defaultTitle;
    const projectId = input.projectId === undefined ? projection.projectId : input.projectId;
    assertProject(userId, projectId);
    const value: NoteWrite = {
      title,
      body: projection.body,
      favorite: false,
      pinned: false,
      tags: [],
      projectId,
    };
    const checked = checkNoteWrite(value);
    if (!checked.ok) {
      throw invalid("This source cannot be saved as a note.", {
        reason: checked.problem === "bodyTooLong" ? "body_too_long" : "source_invalid",
        field: checked.problem === "bodyTooLong" ? "body" : "source",
      });
    }
    checkCount(userId);
    assertStorage(userId, noteBytes(checked.value));
    const now = Date.now();
    const id = newId("note");
    const origin = input.source;
    db.prepare(
      `INSERT INTO notes (id, user_id, title, body, favorite, pinned, project_id, source_kind, source_thread_id, source_item_id, source_version, create_key, create_hash, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      id,
      userId,
      checked.value.title,
      checked.value.body,
      checked.value.projectId,
      origin.kind,
      origin.threadId,
      origin.kind === "message" ? origin.messageId : origin.artifactId,
      origin.kind === "artifact" ? origin.version : null,
      input.requestId,
      hash,
      now,
      now,
    );
    return { note: toNote(ownedRow(userId, id), userId), created: true };
  });
}

function sameWrite(row: Row, value: NoteWrite): boolean {
  return (
    row.title === value.title &&
    row.body === value.body &&
    row.favorite === (value.favorite ? 1 : 0) &&
    row.pinned === (value.pinned ? 1 : 0) &&
    row.project_id === value.projectId &&
    JSON.stringify(tagsOf(row.id)) === JSON.stringify(value.tags)
  );
}

export function updateNote(userId: string, id: string, revision: number, write: NoteWrite): Note {
  assertFeature(userId, "notes");
  const checked = checkNoteWrite(write);
  if (!checked.ok) throw invalid("Invalid note", { problem: checked.problem });
  const value = checked.value;
  return tx(() => {
    const row = ownedRow(userId, id);
    if (row.revision !== revision) throw conflict(STALE, { reason: "stale", currentRevision: row.revision });
    assertProject(userId, value.projectId);
    if (sameWrite(row, value)) return toNote(row, userId);
    assertStorage(userId, noteBytes(value) - noteBytes({ title: row.title, body: row.body }));
    const now = Date.now();
    const result = db
      .prepare(
        `UPDATE notes SET title = ?, body = ?, favorite = ?, pinned = ?, project_id = ?, revision = revision + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND revision = ?`,
      )
      .run(value.title, value.body, value.favorite ? 1 : 0, value.pinned ? 1 : 0, value.projectId, now, id, userId, revision);
    if (Number(result.changes) === 0) throw conflict(STALE, { reason: "stale" });
    writeTags(id, value.tags);
    return toNote(ownedRow(userId, id), userId);
  });
}

export function deleteNote(userId: string, id: string, revision: number): void {
  assertFeature(userId, "notes");
  tx(() => {
    const row = ownedRow(userId, id);
    if (row.revision !== revision) throw conflict(STALE, { reason: "stale", currentRevision: row.revision });
    // A delete frees bytes, so it works while the account is over its quota.
    db.prepare("DELETE FROM notes WHERE id = ? AND user_id = ? AND revision = ?").run(id, userId, revision);
  });
}
