import { rm } from "node:fs/promises";
import { zipSync, strToU8 } from "fflate";
import { Hono } from "hono";
import type { ArtifactKind, LibraryItem, LibraryKind, LibraryPage, LibrarySort } from "../shared/types.js";
import type { AppEnv } from "./auth.js";
import { db } from "./db.js";
import { previewXlsx } from "./documents/xlsx.js";
import { getSkill, deleteSkill } from "./skills.js";
import { imagePath } from "./tools/image.js";

// Stored attachments and outputs belong to the account. Sandbox workspaces are disposable.
// Artifact ownership is always resolved through the owning thread.

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
  artifactKind: ArtifactKind | null;
}

const SOURCES = `
  SELECT 'image:' || i.id AS key, i.prompt AS name, 'image' AS kind, i.mime AS mime, i.size AS size, i.created_at,
         'generated' AS source, i.thread_id AS threadId, t.title AS threadTitle, t.project_id AS projectId, NULL AS artifactKind
  FROM images i LEFT JOIN threads t ON t.id = i.thread_id AND t.user_id = i.user_id
  WHERE i.user_id = @userId
  UNION ALL
  SELECT 'upload:' || u.id AS key, u.name AS name, ${UPLOAD_KIND} AS kind, u.mime AS mime, length(u.data) AS size, u.created_at,
         'uploaded' AS source, ut.id AS threadId, ut.title AS threadTitle, coalesce(ut.project_id, (SELECT pf.project_id FROM project_files pf JOIN projects p ON p.id = pf.project_id
           WHERE pf.upload_id = u.id AND p.user_id = u.user_id LIMIT 1)) AS projectId, NULL AS artifactKind
  FROM uploads u LEFT JOIN threads ut ON ut.id = coalesce(u.thread_id, ${UPLOAD_THREAD}) AND ut.user_id = u.user_id
  WHERE u.user_id = @userId
  UNION ALL
  -- Select by version explicitly; bare columns in GROUP BY pick arbitrary versions.
  SELECT 'artifact:' || a.thread_id || '/' || a.id AS key, a.title AS name, ${ARTIFACT_KIND} AS kind, ${ARTIFACT_MIME} AS mime,
         length(CAST(a.content AS BLOB)) + a.size AS size, a.created_at,
         'generated' AS source, t.id AS threadId, t.title AS threadTitle, t.project_id AS projectId, a.kind AS artifactKind
  FROM artifacts a JOIN threads t ON t.id = a.thread_id
  WHERE t.user_id = @userId
    AND a.version = (SELECT max(v.version) FROM artifacts v WHERE v.thread_id = a.thread_id AND v.id = a.id)
  UNION ALL
  SELECT 'sandbox:' || s.id AS key, s.path AS name,
         ${UPLOAD_KIND.replaceAll("u.mime", "s.mime").replaceAll("u.name", "s.path")} AS kind, s.mime AS mime,
         length(s.data) AS size, s.created_at, 'generated' AS source,
         t.id AS threadId, t.title AS threadTitle, t.project_id AS projectId, NULL AS artifactKind
  FROM sandbox_files s JOIN threads t ON t.id = s.thread_id AND t.user_id = s.user_id
  WHERE s.user_id = @userId
  UNION ALL
  SELECT 'skill:' || sk.id AS key, sk.name || '.zip' AS name, 'other' AS kind, 'application/zip' AS mime,
         length(CAST(sk.name || sk.description || sk.body AS BLOB)) +
           coalesce((SELECT sum(length(CAST(f.name || f.content AS BLOB))) FROM skill_files f WHERE f.skill_id = sk.id), 0) AS size,
         sk.updated_at AS created_at, CASE sk.origin WHEN 'conversation' THEN 'generated' ELSE 'uploaded' END AS source,
         NULL AS threadId, NULL AS threadTitle, NULL AS projectId, NULL AS artifactKind
  FROM skills sk WHERE sk.user_id = @userId`;

interface Cursor {
  v: number | string;
  key: string;
}

/** Keyset condition per sort: rows strictly after the cursor in the sort's direction. */
const CURSOR_WHERE: Record<LibrarySort, [string, string]> = {
  newest: ["created_at < @v", "(created_at = @v AND key < @key)"],
  oldest: ["created_at > @v", "(created_at = @v AND key > @key)"],
  name: ["name > @v COLLATE NOCASE", "(name = @v COLLATE NOCASE AND key > @key)"],
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
    if (prefix === "skill") {
      const url = `/api/library/skill/${encodeURIComponent(id)}`;
      items.push({ ...base, previewUrl: `${url}/preview`, downloadUrl: `${url}/file`, deletable: true });
    } else if (prefix === "image") {
      items.push({ ...base, previewUrl: `/api/images/${id}`, downloadUrl: `/api/images/${id}`, deletable: true });
    } else if (prefix === "upload" || prefix === "sandbox") {
      const fileUrl = prefix === "upload" ? `/api/uploads/${encodeURIComponent(id)}/file` :
        `/api/sandbox/${encodeURIComponent(r.threadId!)}/stored?path=${encodeURIComponent(r.name)}`;
      // Only images and PDFs render in the browser's own viewers; docx/xlsx preview client-side anyway.
      const inline = base.mime.startsWith("image/") || base.mime === "application/pdf";
      const text = base.mime.startsWith("text/") || /\.(txt|md|csv|json|py|sh|js|ts|html|svg)$/i.test(r.name);
      const previewUrl = inline ? `${fileUrl}${fileUrl.includes("?") ? "&" : "?"}preview=1` :
        r.kind === "spreadsheet" || text ? `/api/library/${prefix}/${encodeURIComponent(id)}/preview` : null;
      items.push({ ...base, previewUrl, downloadUrl: fileUrl, deletable: true });
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
        artifactKind: documentKind ?? r.artifactKind!,
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
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? PAGE_SIZE), 1), MAX_PAGE_SIZE);
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
      `SELECT key, name, kind, mime, size, created_at, source, threadId, threadTitle, projectId, artifactKind FROM (${SOURCES})
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

export async function deleteLibraryItem(userId: string, prefix: "image" | "upload" | "sandbox" | "skill", id: string): Promise<boolean> {
  if (prefix === "image") {
    const row = db.prepare("SELECT id FROM images WHERE id = ? AND user_id = ?").get(id, userId) as { id: string } | undefined;
    if (!row) return false;
    db.prepare("DELETE FROM images WHERE id = ? AND user_id = ?").run(id, userId);
    await rm(imagePath(userId, id), { force: true });
    return true;
  }
  if (prefix === "skill") { deleteSkill(userId, id); return true; }
  if (prefix === "sandbox") {
    return !!db.prepare("DELETE FROM sandbox_files WHERE id = ? AND user_id = ?").run(id, userId).changes;
  }
  const row = db.prepare("SELECT id FROM uploads WHERE id = ? AND user_id = ?").get(id, userId) as { id: string } | undefined;
  if (!row) return false;
  db.prepare("DELETE FROM uploads WHERE id = ? AND user_id = ?").run(id, userId);
  return true;
}

const skillMarkdown = (s: { name: string; description: string; body: string }) =>
  `---\nname: ${s.name}\ndescription: ${JSON.stringify(s.description)}\n---\n\n${s.body}\n`;

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
  .get("/library/skill/:id/file", (c) => {
    const skill = getSkill(c.get("user").id, c.req.param("id"));
    const files = Object.fromEntries(skill.fileContents.map((f) => [f.name, strToU8(f.content)]));
    const data = zipSync({ ...files, "SKILL.md": strToU8(skillMarkdown(skill)) });
    return new Response(data, { headers: {
      "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${skill.name}.zip"`,
      "Content-Security-Policy": "default-src 'none'; sandbox", "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store",
    } });
  })
  .get("/library/:source/:id/preview", async (c) => {
    c.header("Cache-Control", "private, no-store");
    if (c.req.param("source") === "skill") {
      const skill = getSkill(c.get("user").id, c.req.param("id"));
      return c.json({ text: skillMarkdown(skill) + (skill.files.length ? `\nReference files:\n${skill.files.map((f) => f.name).join("\n")}` : "") });
    }
    const table = c.req.param("source") === "upload" ? "uploads" : c.req.param("source") === "sandbox" ? "sandbox_files" : null;
    if (!table) return c.json({ error: "Not found" }, 404);
    const row = db.prepare(`SELECT ${table === "uploads" ? "name" : "path"} AS name, mime, data FROM ${table} WHERE id = ? AND user_id = ?`)
      .get(c.req.param("id"), c.get("user").id) as { name: string; mime: string; data: Uint8Array } | undefined;
    if (!row) return c.json({ error: "Not found" }, 404);
    c.header("Cache-Control", "private, no-store");
    if (/\.(xlsx|xlsm)$/i.test(row.name) || row.mime.includes("officedocument.spreadsheetml")) return c.json(await previewXlsx(row.data));
    // Text is rendered by React, never interpreted as an HTML document. Bound previews separately.
    return c.json({ text: new TextDecoder().decode(row.data.subarray(0, 200_000)), truncated: row.data.length > 200_000 });
  })
  .delete("/library/skill/:id", async (c) => {
    await deleteLibraryItem(c.get("user").id, "skill", c.req.param("id"));
    return c.json({ ok: true });
  })
  .delete("/library/sandbox/:id", async (c) =>
    (await deleteLibraryItem(c.get("user").id, "sandbox", c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404))
  .delete("/library/image/:id", async (c) =>
    (await deleteLibraryItem(c.get("user").id, "image", c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404))
  .delete("/library/upload/:id", async (c) => {
    const ok = await deleteLibraryItem(c.get("user").id, "upload", c.req.param("id"));
    return ok ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404);
  });
