import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  MAX_NOTE_BODY_CHARS,
  MAX_NOTE_TITLE_CHARS,
  NOTES_CREATE_LIMIT,
  NOTES_PAGE_DEFAULT,
  NOTES_PAGE_MAX,
  NOTES_SMALL_LIMIT,
  NOTES_SOURCE_LIMIT,
  checkNoteSearch,
  isRequestId,
  isSafeId,
  parseBooleanFilter,
  parseTagFilterValues,
  type NoteTagMatch,
} from "../../shared/notes.js";
import type { AppEnv } from "../auth.js";
import { AppError, errorJson } from "../errors.js";
import { requireFeature } from "../permissions/guard.js";
import { getProject } from "../projects.js";
import {
  createNote,
  createNoteFromSource,
  deleteNote,
  getNote,
  listNotes,
  noteTagCounts,
  updateNote,
  type NoteListQuery,
} from "./store.js";

// Private account text: never cached by a shared cache, and every route (including tags, source copy,
// and delete) passes the account feature guard before doing anything.
const privateHeaders = { "Cache-Control": "private, no-store" };

const invalid = (message: string, details?: Record<string, unknown>) => new AppError({ code: "validation", message, details });

const noteWrite = z
  .object({
    title: z.string().max(MAX_NOTE_TITLE_CHARS * 2),
    body: z.string().max(MAX_NOTE_BODY_CHARS * 2),
    favorite: z.boolean(),
    pinned: z.boolean(),
    tags: z.array(z.string().max(200)).max(10),
    projectId: z.string().max(120).nullable(),
  })
  .strict();

const noteCreate = noteWrite.extend({ requestId: z.string().max(64) }).strict();
const noteUpdate = noteWrite.extend({ revision: z.number().int().positive() }).strict();
const noteDelete = z.object({ revision: z.number().int().positive() }).strict();

const sourceOrigin = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("message"), threadId: z.string().max(120), messageId: z.string().max(120) }).strict(),
  z
    .object({ kind: z.literal("artifact"), threadId: z.string().max(120), artifactId: z.string().max(120), version: z.number().int().positive() })
    .strict(),
]);

const noteFromSource = z
  .object({
    requestId: z.string().max(64),
    source: sourceOrigin,
    title: z.string().max(MAX_NOTE_TITLE_CHARS * 2).optional(),
    projectId: z.string().max(120).nullable().optional(),
  })
  .strict();

const firstIssue = (error: z.ZodError) => error.issues[0]?.message ?? "Invalid note";
const tooLarge = (c: Context) => errorJson(c, new AppError({ code: "validation", status: 413, message: "The note is too large." }));

const NOTE_QUERY_NAMES = new Set(["q", "favorite", "pinned", "projectId", "tag", "tagMatch", "limit", "cursor"]);

function scalar(queries: Record<string, string[]>, name: string): string | undefined {
  const values = queries[name];
  if (!values) return undefined;
  if (values.length !== 1) throw invalid(`Invalid ${name}`);
  return values[0];
}

function parseListQuery(c: Context, userId: string): NoteListQuery {
  const queries = c.req.queries();
  for (const name of Object.keys(queries)) if (!NOTE_QUERY_NAMES.has(name)) throw invalid(`Unknown query ${name}`);
  const search = checkNoteSearch(scalar(queries, "q"));
  if (!search.ok) throw invalid("Invalid search");
  const favorite = parseBooleanFilter(scalar(queries, "favorite"));
  const pinned = parseBooleanFilter(scalar(queries, "pinned"));
  if (!favorite.ok || !pinned.ok) throw invalid("Invalid filter");
  const rawProject = scalar(queries, "projectId");
  let projectId: string | null | undefined;
  if (rawProject === undefined) projectId = undefined;
  else if (rawProject === "none") projectId = null;
  else {
    if (!isSafeId(rawProject)) throw invalid("Invalid project");
    if (!getProject(userId, rawProject)) throw new AppError({ code: "not_found", message: "Project not found" });
    projectId = rawProject;
  }
  const tags = parseTagFilterValues(queries.tag ?? []);
  if (!tags.ok) throw invalid("Invalid tag filter");
  const rawMatch = scalar(queries, "tagMatch");
  if (rawMatch !== undefined && rawMatch !== "any" && rawMatch !== "all") throw invalid("Invalid tag match");
  const tagMatch: NoteTagMatch = rawMatch === "all" ? "all" : "any";
  const rawLimit = scalar(queries, "limit");
  const limit = rawLimit === undefined ? NOTES_PAGE_DEFAULT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > NOTES_PAGE_MAX || (rawLimit !== undefined && String(limit) !== rawLimit)) {
    throw invalid("Invalid limit");
  }
  const cursor = scalar(queries, "cursor");
  return { q: search.value, favorite: favorite.value, pinned: pinned.value, projectId, tags: tags.tags, tagMatch, limit, ...(cursor ? { cursor } : {}) };
}

const idOf = (c: Context): string => {
  const id = c.req.param("id") ?? "";
  if (!isSafeId(id)) throw new AppError({ code: "not_found", message: "Note not found" });
  return id;
};

export const notesRoutes = new Hono<AppEnv>()
  .use(async (c, next) => {
    // Before the guard and the handler, so even a denial or a validation error is private.
    c.header("Cache-Control", "private, no-store");
    await next();
  })
  .use("*", requireFeature("notes"))
  .get("/", (c) => c.json(listNotes(c.get("user").id, parseListQuery(c, c.get("user").id)), 200, privateHeaders))
  .get("/tags", (c) => c.json({ tags: noteTagCounts(c.get("user").id) }, 200, privateHeaders))
  .post("/", bodyLimit({ maxSize: NOTES_CREATE_LIMIT, onError: tooLarge }), async (c) => {
    const parsed = noteCreate.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw invalid(firstIssue(parsed.error));
    if (!isRequestId(parsed.data.requestId)) throw invalid("Invalid request id");
    const { requestId, ...write } = parsed.data;
    const result = createNote(c.get("user").id, requestId, write);
    return c.json({ note: result.note }, result.created ? 201 : 200, privateHeaders);
  })
  .post("/from-source", bodyLimit({ maxSize: NOTES_SOURCE_LIMIT, onError: tooLarge }), async (c) => {
    const parsed = noteFromSource.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw invalid(firstIssue(parsed.error));
    if (!isRequestId(parsed.data.requestId)) throw invalid("Invalid request id");
    const result = createNoteFromSource(c.get("user").id, parsed.data);
    return c.json({ note: result.note }, result.created ? 201 : 200, privateHeaders);
  })
  .get("/:id", (c) => c.json({ note: getNote(c.get("user").id, idOf(c)) }, 200, privateHeaders))
  .put("/:id", bodyLimit({ maxSize: NOTES_CREATE_LIMIT, onError: tooLarge }), async (c) => {
    const parsed = noteUpdate.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw invalid(firstIssue(parsed.error));
    const { revision, ...write } = parsed.data;
    return c.json({ note: updateNote(c.get("user").id, idOf(c), revision, write) }, 200, privateHeaders);
  })
  .delete("/:id", bodyLimit({ maxSize: NOTES_SMALL_LIMIT, onError: tooLarge }), async (c) => {
    const parsed = noteDelete.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw invalid(firstIssue(parsed.error));
    deleteNote(c.get("user").id, idOf(c), parsed.data.revision);
    return c.json({ ok: true }, 200, privateHeaders);
  });
