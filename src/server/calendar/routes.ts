import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  CALENDAR_PAGE_MAX,
  CALENDAR_SMALL_LIMIT,
  CALENDAR_WRITE_LIMIT,
  RESOLVE_RATE_PER_MINUTE,
  checkRange,
} from "../../shared/calendar.js";
import { canonicalZone, parseLocalDateTime, resolveLocalCandidates } from "../../shared/calendar-time.js";
import { checkNoteSearch, isSafeId } from "../../shared/notes.js";
import type { AppEnv } from "../auth.js";
import { AppError, errorJson } from "../errors.js";
import { admitPersonalSearch } from "../personal-search-rate.js";
import { requireFeature } from "../permissions/guard.js";
import { getProject } from "../projects.js";
import { getThread } from "../threads.js";
import { createEvent, deleteEvent, getEvent, listEvents, updateEvent, type CalendarListQuery } from "./store.js";

const privateHeaders = { "Cache-Control": "private, no-store" };
const invalid = (message: string, details?: Record<string, unknown>) => new AppError({ code: "validation", message, details });
const tooLarge = (c: Context) => errorJson(c, new AppError({ code: "validation", status: 413, message: "The event is too large." }));

const eventWrite = z
  .object({
    allDay: z.boolean(),
    timeZone: z.string().max(100),
    startAt: z.number().int().nullable(),
    endAt: z.number().int().nullable(),
    startDate: z.string().max(10).nullable(),
    endDate: z.string().max(10).nullable(),
    title: z.string().max(400),
    description: z.string().max(40_000),
    location: z.string().max(1_000),
    url: z.string().max(3_000),
    reminderOffsets: z.array(z.number().int()).max(5),
    threadId: z.string().max(120).nullable(),
    projectId: z.string().max(120).nullable(),
  })
  .strict();
const eventCreate = eventWrite.extend({ requestId: z.string().max(64) }).strict();
const eventUpdate = eventWrite.extend({ revision: z.number().int().positive() }).strict();
const eventDelete = z.object({ revision: z.number().int().positive() }).strict();
const resolveInput = z
  .object({ timeZone: z.string().max(100), startLocal: z.string().max(32), endLocal: z.string().max(32) })
  .strict();

const firstIssue = (error: z.ZodError) => error.issues[0]?.message ?? "Invalid event";

const EVENT_QUERY_NAMES = new Set(["from", "to", "limit", "cursor", "q", "projectId", "threadId"]);

function scalar(queries: Record<string, string[]>, name: string): string | undefined {
  const values = queries[name];
  if (!values) return undefined;
  if (values.length !== 1) throw invalid(`Invalid ${name}`);
  return values[0];
}

function parseListQuery(c: Context, userId: string): CalendarListQuery {
  const queries = c.req.queries();
  for (const name of Object.keys(queries)) if (!EVENT_QUERY_NAMES.has(name)) throw invalid(`Unknown query ${name}`);
  const rawFrom = scalar(queries, "from");
  const rawTo = scalar(queries, "to");
  if (rawFrom === undefined || rawTo === undefined || !/^\d{1,15}$/.test(rawFrom) || !/^\d{1,15}$/.test(rawTo)) {
    throw invalid("Invalid range");
  }
  const range = checkRange(Number(rawFrom), Number(rawTo));
  if (!range.ok) throw invalid("Choose a range of at most 93 days.");
  const search = checkNoteSearch(scalar(queries, "q"));
  if (!search.ok) throw invalid("Invalid search");
  const rawProject = scalar(queries, "projectId");
  let projectId: string | null | undefined;
  if (rawProject === undefined) projectId = undefined;
  else if (rawProject === "none") projectId = null;
  else {
    if (!isSafeId(rawProject) || !getProject(userId, rawProject)) throw new AppError({ code: "not_found", message: "Project not found" });
    projectId = rawProject;
  }
  const rawThread = scalar(queries, "threadId");
  let threadId: string | null | undefined;
  if (rawThread === undefined) threadId = undefined;
  else if (rawThread === "none") threadId = null;
  else {
    if (!isSafeId(rawThread) || !getThread(userId, rawThread)) throw new AppError({ code: "not_found", message: "Chat not found" });
    threadId = rawThread;
  }
  const rawLimit = scalar(queries, "limit");
  if (rawLimit === undefined) throw invalid("Invalid limit");
  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > CALENDAR_PAGE_MAX || String(limit) !== rawLimit) throw invalid("Invalid limit");
  const cursor = scalar(queries, "cursor");
  return { from: range.from, to: range.to, q: search.value, projectId, threadId, limit, ...(cursor ? { cursor } : {}) };
}

const idOf = (c: Context): string => {
  const id = c.req.param("id") ?? "";
  if (!isSafeId(id)) throw new AppError({ code: "not_found", message: "Event not found" });
  return id;
};

// Resolve is a cheap but deliberately bounded scan. A small in-process window is enough: it is not an
// LLM bucket, and it exists so a looping editor cannot pin the process.
interface Window {
  start: number;
  count: number;
}
const windows = new Map<string, Window>();
const WINDOW_MS = 60_000;
const WINDOW_LIMIT = 10_000;

function admitResolve(userId: string, now: number): { ok: true } | { ok: false; retryAfterMs: number } {
  let window = windows.get(userId);
  if (!window || now - window.start >= WINDOW_MS) {
    if (!window && windows.size >= WINDOW_LIMIT) {
      for (const [key, value] of windows) if (now - value.start >= WINDOW_MS) windows.delete(key);
      if (windows.size >= WINDOW_LIMIT) return { ok: false, retryAfterMs: WINDOW_MS };
    }
    window = { start: now, count: 0 };
    windows.set(userId, window);
  }
  if (window.count >= RESOLVE_RATE_PER_MINUTE) {
    return { ok: false, retryAfterMs: Math.max(1_000, WINDOW_MS - (now - window.start)) };
  }
  window.count++;
  return { ok: true };
}

export const calendarRoutes = new Hono<AppEnv>()
  .use(async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    await next();
  })
  .use("*", requireFeature("calendar"))
  .get("/events", (c) => {
    const userId = c.get("user").id;
    if (c.req.query("q")) {
      const admission = admitPersonalSearch(userId);
      if (!admission.ok) throw new AppError({ code: "rate_limited", message: "Too many searches. Wait a moment.", retryAfterMs: admission.retryAfterMs });
    }
    return c.json(listEvents(userId, parseListQuery(c, userId)), 200, privateHeaders);
  })
  .post("/events", bodyLimit({ maxSize: CALENDAR_WRITE_LIMIT, onError: tooLarge }), async (c) => {
    const parsed = eventCreate.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw invalid(firstIssue(parsed.error));
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.data.requestId)) {
      throw invalid("Invalid request id");
    }
    const { requestId, ...write } = parsed.data;
    const result = createEvent(c.get("user").id, requestId, write);
    return c.json({ event: result.event }, result.created ? 201 : 200, privateHeaders);
  })
  .post("/resolve-time", bodyLimit({ maxSize: CALENDAR_SMALL_LIMIT, onError: tooLarge }), async (c) => {
    const parsed = resolveInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw invalid(firstIssue(parsed.error));
    const zone = canonicalZone(parsed.data.timeZone);
    if (!zone) throw invalid("Choose a recognized time zone.", { problem: "invalidZone" });
    const start = parseLocalDateTime(parsed.data.startLocal);
    const end = parseLocalDateTime(parsed.data.endLocal);
    if (!start || !end) throw invalid("Invalid local time.");
    const now = Date.now();
    const admission = admitResolve(c.get("user").id, now);
    if (!admission.ok) {
      throw new AppError({ code: "rate_limited", message: "Too many time checks. Wait a moment.", retryAfterMs: admission.retryAfterMs });
    }
    return c.json(
      { startCandidates: resolveLocalCandidates(zone, start), endCandidates: resolveLocalCandidates(zone, end) },
      200,
      privateHeaders,
    );
  })
  .get("/events/:id", (c) => c.json({ event: getEvent(c.get("user").id, idOf(c)) }, 200, privateHeaders))
  .put("/events/:id", bodyLimit({ maxSize: CALENDAR_WRITE_LIMIT, onError: tooLarge }), async (c) => {
    const parsed = eventUpdate.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw invalid(firstIssue(parsed.error));
    const { revision, ...write } = parsed.data;
    return c.json({ event: updateEvent(c.get("user").id, idOf(c), revision, write) }, 200, privateHeaders);
  })
  .delete("/events/:id", bodyLimit({ maxSize: CALENDAR_SMALL_LIMIT, onError: tooLarge }), async (c) => {
    const parsed = eventDelete.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw invalid(firstIssue(parsed.error));
    deleteEvent(c.get("user").id, idOf(c), parsed.data.revision);
    return c.json({ ok: true }, 200, privateHeaders);
  });
