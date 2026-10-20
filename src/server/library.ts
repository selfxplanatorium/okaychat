import { rm, stat } from "node:fs/promises";
import { Hono } from "hono";
import type { ArtifactKind, LibraryItem, LibraryKind, LibraryPage, LibrarySort } from "../shared/types.js";
import type { AppEnv } from "./auth.js";
import { db } from "./db.js";
import { imagePath } from "./tools/image.js";

// One listing for everything the agent received or produced for the current user: uploads (a 7-day
// import cache, see files.ts), generated images, and the latest version of each artifact. Artifacts
// carry no user_id, so they are reached through their thread; uploads carry no thread, so the chat is
// recovered from the <attachment> headers stored in message text. run_code files live only in the
// sandbox container and are not catalogued here. Artifacts are not deletable from the library: they
// belong to the chat history, and deleting a version would break the messages that reference it.

const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

/** Library kind for an upload, from its stored mime, falling back to the filename. */
const UPLOAD_KIND = `CASE
  WHEN u.mime LIKE 'image/%' OR lower(u.name) LIKE '%.png' OR lower(u.name) LIKE '%.jpg' OR lower(u.name) LIKE '%.jpeg'
    OR lower(u.name) LIKE '%.gif' OR lower(u.name) LIKE '%.webp' OR lower(u.name) LIKE '%.avif' OR lower(u.name) LIKE '%.svg' THEN 'image'
  WHEN u.mime = 'application/pdf' OR lower(u.name) LIKE '%.pdf' THEN 'pdf'
  WHEN u.mime LIKE '%officedocument.wordprocessingml%' OR lower(u.name) LIKE '%.docx' THEN 'document'
  WHEN u.mime LIKE '%officedocument.spreadsheetml%' OR lower(u.name) LIKE '%.xlsx' OR lower(u.name) LIKE '%.xlsm' THEN 'spreadsheet'
  ELSE 'other' END`;

const ARTIFACT_KIND = `CASE WHEN a.kind = 'pdf' THEN 'pdf' WHEN a.kind = 'docx' THEN 'document' WHEN a.kind = 'xlsx' THEN 'spreadsheet' ELSE 'code' END`;

const ARTIFACT_MIME = `CASE a.kind WHEN 'pdf' THEN 'application/pdf'
  WHEN 'docx' THEN 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  WHEN 'xlsx' THEN 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  WHEN 'html' THEN 'text/html' WHEN 'svg' THEN 'image/svg+xml' WHEN 'markdown' THEN 'text/markdown'
  ELSE 'text/plain' END`;

// The most recent chat whose message mentions this upload's id. Content is stored JSON-escaped, so
// matching the bare id (globally unique) is more reliable than the file_id="..." header text.
const UPLOAD_THREAD = `(SELECT m.thread_id FROM messages m JOIN threads mt ON mt.id = m.thread_id
  WHERE mt.user_id = u.user_id AND m.content LIKE '%' || u.id || '%'
  ORDER BY m.created_at DESC LIMIT 1)`;

interface RawRow {
  key: string;
  name: string;
  kind: LibraryKind;
  mime: string;
  size: number;
  created_at: number;
  source: "uploaded" | "generated";
  threadId: string | null;
  threadTitle: string | null;
  projectId: string | null;
}

const SOURCES = `
  SELECT 'image:' || i.id AS key, i.prompt AS name, 'image' AS kind, 'image/png' AS mime, 0 AS size, i.created_at,
         'generated' AS source, i.thread_id AS threadId, t.title AS threadTitle, t.project_id AS projectId
  FROM images i LEFT JOIN threads t ON t.id = i.thread_id
  WHERE i.user_id = @userId
  UNION ALL
  SELECT 'upload:' || u.id AS key, u.name AS name, ${UPLOAD_KIND} AS kind, u.mime AS mime, length(u.data) AS size, u.created_at,
         'uploaded' AS source, ut.id AS threadId, ut.title AS threadTitle, ut.project_id AS projectId
  FROM uploads u LEFT JOIN threads ut ON ut.id = ${UPLOAD_THREAD}
  WHERE u.user_id = @userId
  UNION ALL
  -- The latest version of each artifact (SQLite picks the bare columns from the MAX row).
  SELECT 'artifact:' || a.thread_id || '/' || a.id AS key, a.title AS name, ${ARTIFACT_KIND} AS kind, ${ARTIFACT_MIME} AS mime,
         CASE WHEN a.size > 0 THEN a.size ELSE length(a.content) END AS size, a.created_at,
         'generated' AS source, t.id AS threadId, t.title AS threadTitle, t.project_id AS projectId
  FROM artifacts a JOIN threads t ON t.id = a.thread_id
  WHERE t.user_id = @userId
  GROUP BY a.thread_id, a.id`;

interface Cursor {
  v: number | string;
  key: string;
}

/** Keyset condition per sort: rows strictly after the cursor in the sort's direction. */
const CURSOR_WHERE: Record<LibrarySort, [string, string]> = {
  newest: ["created_at < @v", "(created_at = @v AND key < @key)"],
  oldest: ["created_at > @v", "(created_at = @v AND key > @key)"],
  name: ["name > @v COLLATE NOCASE", "(name = @v AND key > @key)"],
  size: ["size < @v", "(size = @v AND key > @key)"],
};

const ORDER_BY: Record<LibrarySort, string> = {
  newest: "created_at DESC, key DESC",
  oldest: "created_at ASC, key ASC",
  name: "name COLLATE NOCASE ASC, key ASC",
  size: "size DESC, key ASC",
};

const cursorValue = (sort: LibrarySort, row: RawRow): number | string =>
  sort === "name" ? row.name : sort === "size" ? row.size : row.created_at;

const encodeCursor = (sort: LibrarySort, row: RawRow): string =>
  Buffer.from(JSON.stringify({ v: cursorValue(sort, row), key: row.key } satisfies Cursor), "utf8").toString("base64url");

async function toItems(userId: string, rows: RawRow[]): Promise<LibraryItem[]> {
  const items: LibraryItem[] = [];
  for (const r of rows) {
    const colon = r.key.indexOf(":");
    const prefix = r.key.slice(0, colon);
    const id = r.key.slice(colon + 1);
    const base = {
      id: r.key,
      name: r.name,
      kind: r.kind,
      mime: r.mime || "application/octet-stream",
      size: r.size,
      createdAt: r.created_at,
      source: r.source,
      threadId: r.threadId ?? null,
      threadTitle: r.threadTitle,
      projectId: r.projectId,
      deletable: false,
    };
    if (prefix === "image") {
      // Generated images live on disk and their size was not stored; stat each page's files only.
      const size = (await stat(imagePath(userId, id)).catch(() => null))?.size ?? r.size;
      items.push({ ...base, size, previewUrl: `/api/images/${id}`, downloadUrl: `/api/images/${id}`, deletable: true });
    } else if (prefix === "upload") {
      const fileUrl = `/api/uploads/${encodeURIComponent(id)}/file`;
      // Only images and PDFs render in the browser's own viewers; docx/xlsx preview client-side anyway.
      const inline = base.mime.startsWith("image/") || base.mime === "application/pdf";
      items.push({ ...base, previewUrl: inline ? fileUrl : null, downloadUrl: fileUrl, deletable: true });
    } else {
      const [thread, artifactId] = id.split("/");
      if (!thread || !artifactId) continue;
      const apiBase = `/api/threads/${encodeURIComponent(thread)}/artifacts/${encodeURIComponent(artifactId)}`;
      const documentKind = r.kind === "pdf" ? "pdf" : r.kind === "document" ? "docx" : r.kind === "spreadsheet" ? "xlsx" : null;
      items.push({
        ...base,
        previewUrl: documentKind === "pdf" ? `${apiBase}/file` : null,
        downloadUrl: documentKind ? `${apiBase}/file` : null,
        artifactId,
        // Everything the SQL did not map to a document kind is a text artifact kind ("code").
        artifactKind: documentKind ?? (r.kind as ArtifactKind),
        deletable: false,
      });
    }
  }
  return items;
}

interface ListOptions {
  kind?: LibraryKind;
  source?: "uploaded" | "generated";
  threadId?: string;
  projectId?: string;
  q?: string;
  from?: number;
  to?: number;
  sort?: LibrarySort;
  cursor?: string;
  limit?: number;
}

/** One page of raw rows plus the cursor for the next one. Cursor is the last row's sort key and unique key. */
function listRows(userId: string, opts: ListOptions): { rows: RawRow[]; nextCursor: string | null } {
  const sort = opts.sort ?? "newest";
  const limit = Math.min(Math.max(opts.limit ?? PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const where = ["1 = 1"];
  const named: Record<string, string | number | null> = { userId };
  if (opts.kind) where.push("kind = @kind"), (named.kind = opts.kind);
  if (opts.source) where.push("source = @source"), (named.source = opts.source);
  if (opts.threadId) where.push("threadId = @threadId"), (named.threadId = opts.threadId);
  if (opts.projectId) where.push("projectId = @projectId"), (named.projectId = opts.projectId);
  if (opts.q) {
    // Percent, underscore, and backslash escaped so a name search matches literally.
    where.push("name LIKE @q ESCAPE '\\'");
    named.q = `%${opts.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  }
  if (opts.from !== undefined) where.push("created_at >= @from"), (named.from = opts.from);
  if (opts.to !== undefined) where.push("created_at <= @to"), (named.to = opts.to);
  if (opts.cursor) {
    let parsed: Cursor;
    try {
      parsed = JSON.parse(Buffer.from(opts.cursor, "base64url").toString()) as Cursor;
      const value = (parsed as Cursor | null)?.v;
      if ((typeof value !== "number" && typeof value !== "string") || typeof parsed.key !== "string") throw new Error("bad cursor");
    } catch {
      // A stale or malformed cursor reads as "no more pages" instead of failing the page.
      return { rows: [], nextCursor: null };
    }
    where.push(`(${CURSOR_WHERE[sort].join(" OR ")})`);
    named.v = parsed.v;
    named.key = parsed.key;
  }

  const rows = db
    .prepare(
      `SELECT key, name, kind, mime, size, created_at, source, threadId, threadTitle, projectId FROM (${SOURCES})
       WHERE ${where.join(" AND ")} ORDER BY ${ORDER_BY[sort]} LIMIT ${limit + 1}`,
    )
    .all(named) as unknown as RawRow[];

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return { rows: page, nextCursor: hasMore && page.length ? encodeCursor(sort, page.at(-1)!) : null };
}

/** The user's library, one page at a time. */
export async function listLibrary(userId: string, opts: ListOptions): Promise<LibraryPage> {
  const { rows, nextCursor } = listRows(userId, opts);
  return { items: await toItems(userId, rows), nextCursor };
}

export async function deleteLibraryItem(userId: string, prefix: "image" | "upload", id: string): Promise<boolean> {
  if (prefix === "image") {
    const row = db.prepare("SELECT id FROM images WHERE id = ? AND user_id = ?").get(id, userId) as { id: string } | undefined;
    if (!row) return false;
    db.prepare("DELETE FROM images WHERE id = ? AND user_id = ?").run(id, userId);
    await rm(imagePath(userId, id), { force: true });
    return true;
  }
  const row = db.prepare("SELECT id FROM uploads WHERE id = ? AND user_id = ?").get(id, userId) as { id: string } | undefined;
  if (!row) return false;
  db.prepare("DELETE FROM uploads WHERE id = ? AND user_id = ?").run(id, userId);
  return true;
}

export const libraryRoutes = new Hono<AppEnv>()
  .get("/library", async (c) => {
    const q = c.req.query();
    const number = (v: string | undefined) => (v && Number.isFinite(Number(v)) ? Number(v) : undefined);
    return c.json(
      await listLibrary(c.get("user").id, {
        kind: (["image", "document", "pdf", "spreadsheet", "code", "other"] as const).includes(q.kind as LibraryKind) ? (q.kind as LibraryKind) : undefined,
        source: q.source === "uploaded" || q.source === "generated" ? q.source : undefined,
        threadId: q.thread || undefined,
        projectId: q.project || undefined,
        q: q.q || undefined,
        from: number(q.from),
        to: number(q.to),
        sort: (["newest", "oldest", "name", "size"] as const).includes(q.sort as LibrarySort) ? (q.sort as LibrarySort) : undefined,
        cursor: q.cursor || undefined,
        limit: number(q.limit),
      }),
    );
  })
  .delete("/library/image/:id", async (c) =>
    (await deleteLibraryItem(c.get("user").id, "image", c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404))
  .delete("/library/upload/:id", async (c) => {
    const ok = await deleteLibraryItem(c.get("user").id, "upload", c.req.param("id"));
    return ok ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404);
  });
