import { canonicalJson } from "../../shared/permissions.js";
import { isSafeId } from "../../shared/notes.js";
import {
  CALENDAR_PAGE_MAX,
  MAX_EVENTS,
  checkCalendarEventWrite,
  eventBytes,
  reminderSignature,
  type CalendarEvent,
  type CalendarEventSummary,
  type CalendarEventWrite,
  type CalendarPage,
} from "../../shared/calendar.js";
import { newId, sha256 } from "../crypto.js";
import { db, tx } from "../db.js";
import { AppError } from "../errors.js";
import { assertFeature } from "../permissions/guard.js";
import { getProject } from "../projects.js";
import { assertStorage } from "../quota.js";
import { getThread, isTemporaryThread } from "../threads.js";
import { ftsMatchQuery, ftsTokens } from "../text-search.js";

/**
 * Calendar storage and the reminder ledger. One synchronous transaction covers validation, link
 * ownership, revision, quota, the event write, and its reminder rows. See docs/implementation/calendar.md.
 */

interface Row {
  id: string;
  title: string;
  description: string;
  location: string;
  url: string;
  all_day: number;
  time_zone: string;
  start_at: number | null;
  end_at: number | null;
  start_date: string | null;
  end_date: string | null;
  effective_start_at: number;
  effective_end_at: number;
  reminder_offsets_json: string;
  reminder_revision: number;
  thread_id: string | null;
  project_id: string | null;
  revision: number;
  created_at: number;
  updated_at: number;
}

const COLUMNS = `id, title, description, location, url, all_day, time_zone, start_at, end_at, start_date, end_date,
  effective_start_at, effective_end_at, reminder_offsets_json, reminder_revision, thread_id, project_id,
  revision, created_at, updated_at`;

const STALE = "This event changed in another tab or window. Reload it before saving.";
const NOT_FOUND = "Event not found";

const invalid = (message: string, details?: Record<string, unknown>) => new AppError({ code: "validation", message, details });
const conflict = (message: string, details?: Record<string, unknown>) => new AppError({ code: "conflict", message, details });
const notFound = () => new AppError({ code: "not_found", message: NOT_FOUND });

const offsetsOf = (row: Row): number[] => {
  try {
    const parsed = JSON.parse(row.reminder_offsets_json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is number => typeof value === "number") : [];
  } catch {
    return [];
  }
};

function writeOf(row: Row): CalendarEventWrite {
  const common = {
    title: row.title,
    description: row.description,
    location: row.location,
    url: row.url,
    reminderOffsets: offsetsOf(row),
    threadId: row.thread_id,
    projectId: row.project_id,
  };
  return row.all_day === 1
    ? { ...common, allDay: true, timeZone: row.time_zone, startAt: null, endAt: null, startDate: row.start_date ?? "", endDate: row.end_date ?? "" }
    : { ...common, allDay: false, timeZone: row.time_zone, startAt: row.start_at ?? 0, endAt: row.end_at ?? 0, startDate: null, endDate: null };
}

function toEvent(row: Row): CalendarEvent {
  return {
    ...writeOf(row),
    id: row.id,
    revision: row.revision,
    reminderRevision: row.reminder_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    effectiveStartAt: row.effective_start_at,
    effectiveEndAt: row.effective_end_at,
  };
}

function toSummary(row: Row): CalendarEventSummary {
  const event = toEvent(row);
  return {
    id: event.id,
    title: event.title,
    allDay: event.allDay,
    timeZone: event.timeZone,
    startAt: event.startAt,
    endAt: event.endAt,
    startDate: event.startDate,
    endDate: event.endDate,
    reminderOffsets: event.reminderOffsets,
    threadId: event.threadId,
    projectId: event.projectId,
    revision: event.revision,
    reminderRevision: event.reminderRevision,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
    effectiveStartAt: event.effectiveStartAt,
    effectiveEndAt: event.effectiveEndAt,
  };
}

function ownedRow(userId: string, id: string): Row {
  const row = db.prepare(`SELECT ${COLUMNS} FROM calendar_events WHERE id = ? AND user_id = ?`).get(id, userId) as Row | undefined;
  if (!row) throw notFound();
  return row;
}

/** Both links are owned; a foreign or missing id is the same 404. */
function assertLinks(userId: string, write: CalendarEventWrite): void {
  if (write.projectId !== null && !getProject(userId, write.projectId)) {
    throw new AppError({ code: "not_found", message: "Project not found" });
  }
  if (write.threadId !== null) {
    const thread = getThread(userId, write.threadId);
    if (!thread || isTemporaryThread(write.threadId) || thread.compareGroupId) {
      throw new AppError({ code: "not_found", message: "Chat not found" });
    }
  }
}

function checkCount(userId: string): void {
  const count = (db.prepare("SELECT COUNT(*) AS n FROM calendar_events WHERE user_id = ?").get(userId) as { n: number }).n;
  if (count >= MAX_EVENTS) throw conflict(`You can keep up to ${MAX_EVENTS} events. Delete an event to create another.`, { reason: "limit", limit: MAX_EVENTS });
}

const createHash = (write: CalendarEventWrite): string => sha256(canonicalJson({ op: "create", ...write }));

function retried(userId: string, requestId: string, hash: string): CalendarEvent | null {
  const row = db.prepare(`SELECT ${COLUMNS}, create_hash FROM calendar_events WHERE user_id = ? AND create_key = ?`).get(userId, requestId) as
    | (Row & { create_hash: string })
    | undefined;
  if (!row) return null;
  if (row.create_hash !== hash) throw conflict("This request id was already used for a different event.", { reason: "request_reused" });
  return toEvent(row);
}

/**
 * Admits each offset once. A reminder whose instant already passed, or whose event already ended, is
 * inserted suppressed: creating an old event must never deliver a backlog.
 */
function insertReminders(eventId: string, revision: number, effectiveStartAt: number, effectiveEndAt: number, offsets: readonly number[], now: number): void {
  const insert = db.prepare(
    "INSERT INTO calendar_reminders (event_id, reminder_revision, offset_minutes, due_at, state, processed_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const offset of offsets) {
    const dueAt = effectiveStartAt - offset * 60_000;
    const suppressed = dueAt < now || effectiveEndAt <= now;
    insert.run(eventId, revision, offset, dueAt, suppressed ? "suppressed" : "pending", suppressed ? now : null);
  }
}

export function createEvent(userId: string, requestId: string, value: unknown): { event: CalendarEvent; created: boolean } {
  assertFeature(userId, "calendar");
  const checked = checkCalendarEventWrite(value);
  if (!checked.ok) throw invalid("Invalid event", { problem: checked.problem });
  const { write, effectiveStartAt, effectiveEndAt } = checked.value;
  const hash = createHash(write);
  return tx(() => {
    const existing = retried(userId, requestId, hash);
    if (existing) return { event: existing, created: false };
    assertLinks(userId, write);
    checkCount(userId);
    assertStorage(userId, eventBytes(write));
    const now = Date.now();
    const id = newId("evt");
    db.prepare(
      `INSERT INTO calendar_events (id, user_id, title, description, location, url, all_day, time_zone, start_at, end_at, start_date, end_date,
         effective_start_at, effective_end_at, reminder_offsets_json, reminder_revision, thread_id, project_id, create_key, create_hash, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      id,
      userId,
      write.title,
      write.description,
      write.location,
      write.url,
      write.allDay ? 1 : 0,
      write.timeZone,
      write.startAt,
      write.endAt,
      write.startDate,
      write.endDate,
      effectiveStartAt,
      effectiveEndAt,
      JSON.stringify(write.reminderOffsets),
      write.threadId,
      write.projectId,
      requestId,
      hash,
      now,
      now,
    );
    insertReminders(id, 1, effectiveStartAt, effectiveEndAt, write.reminderOffsets, now);
    return { event: toEvent(ownedRow(userId, id)), created: true };
  });
}

function sameWrite(row: Row, write: CalendarEventWrite, effectiveStartAt: number, effectiveEndAt: number): boolean {
  return (
    canonicalJson(writeOf(row)) === canonicalJson(write) &&
    row.effective_start_at === effectiveStartAt &&
    row.effective_end_at === effectiveEndAt
  );
}

export function updateEvent(userId: string, id: string, revision: number, value: unknown): CalendarEvent {
  assertFeature(userId, "calendar");
  const checked = checkCalendarEventWrite(value);
  if (!checked.ok) throw invalid("Invalid event", { problem: checked.problem });
  const { write, effectiveStartAt, effectiveEndAt } = checked.value;
  return tx(() => {
    const row = ownedRow(userId, id);
    if (row.revision !== revision) throw conflict(STALE, { reason: "stale", currentRevision: row.revision });
    assertLinks(userId, write);
    if (sameWrite(row, write, effectiveStartAt, effectiveEndAt)) return toEvent(row);
    assertStorage(userId, eventBytes(write) - eventBytes(writeOf(row)));
    const now = Date.now();
    const previous = toEvent(row);
    const nextSignature = reminderSignature({
      effectiveStartAt,
      timeZone: write.timeZone,
      allDay: write.allDay,
      startDate: write.startDate,
      reminderOffsets: write.reminderOffsets,
    });
    const rebuild = reminderSignature(previous) !== nextSignature;
    const reminderRevision = rebuild ? row.reminder_revision + 1 : row.reminder_revision;
    const result = db
      .prepare(
        `UPDATE calendar_events SET title = ?, description = ?, location = ?, url = ?, all_day = ?, time_zone = ?, start_at = ?, end_at = ?,
           start_date = ?, end_date = ?, effective_start_at = ?, effective_end_at = ?, reminder_offsets_json = ?, reminder_revision = ?,
           thread_id = ?, project_id = ?, revision = revision + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND revision = ?`,
      )
      .run(
        write.title,
        write.description,
        write.location,
        write.url,
        write.allDay ? 1 : 0,
        write.timeZone,
        write.startAt,
        write.endAt,
        write.startDate,
        write.endDate,
        effectiveStartAt,
        effectiveEndAt,
        JSON.stringify(write.reminderOffsets),
        reminderRevision,
        write.threadId,
        write.projectId,
        now,
        id,
        userId,
        revision,
      );
    if (Number(result.changes) === 0) throw conflict(STALE, { reason: "stale" });
    if (rebuild) {
      // The schedule identity changed: old reminders and their notices can never fire again.
      db.prepare("DELETE FROM calendar_reminders WHERE event_id = ?").run(id);
      db.prepare("DELETE FROM notifications WHERE calendar_event_id = ?").run(id);
      insertReminders(id, reminderRevision, effectiveStartAt, effectiveEndAt, write.reminderOffsets, now);
    }
    return toEvent(ownedRow(userId, id));
  });
}

export function deleteEvent(userId: string, id: string, revision: number): void {
  assertFeature(userId, "calendar");
  tx(() => {
    const row = ownedRow(userId, id);
    if (row.revision !== revision) throw conflict(STALE, { reason: "stale", currentRevision: row.revision });
    // Ledger rows and notices cascade from the event.
    db.prepare("DELETE FROM calendar_events WHERE id = ? AND user_id = ? AND revision = ?").run(id, userId, revision);
  });
}

export function getEvent(userId: string, id: string): CalendarEvent {
  assertFeature(userId, "calendar");
  return toEvent(ownedRow(userId, id));
}

export interface CalendarListQuery {
  from: number;
  to: number;
  q: string;
  projectId: string | null | undefined;
  threadId: string | null | undefined;
  limit: number;
  cursor?: string;
}

interface CalendarCursor {
  v: 1;
  startAt: number;
  id: string;
  filterHash: string;
}

function filterHash(query: CalendarListQuery): string {
  return sha256(
    canonicalJson({
      from: query.from,
      to: query.to,
      q: query.q,
      projectId: query.projectId === undefined ? "all" : query.projectId,
      threadId: query.threadId === undefined ? "all" : query.threadId,
    }),
  );
}

function encodeCursor(cursor: CalendarCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCalendarCursor(value: string): CalendarCursor {
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
    typeof cursor.startAt !== "number" ||
    !Number.isSafeInteger(cursor.startAt) ||
    cursor.startAt < 0 ||
    !isSafeId(cursor.id) ||
    typeof cursor.filterHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(cursor.filterHash) ||
    Object.keys(cursor).length !== 4
  ) {
    throw invalid("Invalid cursor");
  }
  return { v: 1, startAt: cursor.startAt, id: cursor.id, filterHash: cursor.filterHash };
}

export function listEvents(userId: string, query: CalendarListQuery): CalendarPage {
  assertFeature(userId, "calendar");
  if (query.projectId !== undefined && query.projectId !== null && !getProject(userId, query.projectId)) {
    throw new AppError({ code: "not_found", message: "Project not found" });
  }
  if (query.threadId !== undefined && query.threadId !== null) {
    if (!getThread(userId, query.threadId)) throw new AppError({ code: "not_found", message: "Chat not found" });
  }
  const hash = filterHash(query);
  const cursor = query.cursor ? decodeCalendarCursor(query.cursor) : null;
  if (cursor && cursor.filterHash !== hash) throw invalid("Invalid cursor");
  const where: string[] = ["e.user_id = ?", "e.effective_start_at < ?", "e.effective_end_at > ?"];
  const values: Array<string | number> = [userId, query.to, query.from];
  if (query.projectId !== undefined) {
    if (query.projectId === null) where.push("e.project_id IS NULL");
    else {
      where.push("e.project_id = ?");
      values.push(query.projectId);
    }
  }
  if (query.threadId !== undefined) {
    if (query.threadId === null) where.push("e.thread_id IS NULL");
    else {
      where.push("e.thread_id = ?");
      values.push(query.threadId);
    }
  }
  const tokens = ftsTokens(query.q);
  if (query.q.trim() && !tokens.length) return { items: [], nextCursor: null };
  if (tokens.length) {
    where.push("e.search_id IN (SELECT rowid FROM calendar_events_fts WHERE calendar_events_fts MATCH ?)");
    values.push(ftsMatchQuery(tokens));
  }
  if (cursor) {
    where.push("(e.effective_start_at > ? OR (e.effective_start_at = ? AND e.id > ?))");
    values.push(cursor.startAt, cursor.startAt, cursor.id);
  }
  const limit = Math.min(CALENDAR_PAGE_MAX, Math.max(1, query.limit));
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM calendar_events e WHERE ${where.join(" AND ")} ORDER BY e.effective_start_at ASC, e.id ASC LIMIT ?`)
    .all(...values, limit + 1) as unknown as Row[];
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(toSummary),
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({ v: 1, startAt: last.effective_start_at, id: last.id, filterHash: hash })
        : null,
  };
}


/** The reminder ledger row plus the event it belongs to, for the ticker. */
export interface DueReminder {
  event: CalendarEvent;
  userId: string;
  reminderRevision: number;
  offsetMinutes: number;
  dueAt: number;
}

export function dueReminders(now: number, limit: number): DueReminder[] {
  const rows = db
    .prepare(
      `SELECT r.event_id AS event_id, r.reminder_revision AS reminder_revision, r.offset_minutes AS offset_minutes,
         r.due_at AS due_at, e.user_id AS user_id
       FROM calendar_reminders r JOIN calendar_events e ON e.id = r.event_id
       WHERE r.state = 'pending' AND r.due_at <= ?
       ORDER BY r.due_at ASC, r.event_id ASC, r.offset_minutes ASC LIMIT ?`,
    )
    .all(now, limit) as Array<{ event_id: string; reminder_revision: number; offset_minutes: number; due_at: number; user_id: string }>;
  return rows.map((row) => ({
    event: toEvent(db.prepare(`SELECT ${COLUMNS} FROM calendar_events WHERE id = ?`).get(row.event_id) as unknown as Row),
    userId: row.user_id,
    reminderRevision: row.reminder_revision,
    offsetMinutes: row.offset_minutes,
    dueAt: row.due_at,
  }));
}
