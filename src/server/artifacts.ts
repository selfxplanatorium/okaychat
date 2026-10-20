import { tool, type ToolSet } from "ai";
import { Hono } from "hono";
import { z } from "zod";
import type { ArtifactKind, ArtifactToolResult, ArtifactVersion, DocumentArtifactKind, SheetPreview, TextArtifactKind } from "../shared/types.js";
import { DOCUMENT_KINDS } from "../shared/types.js";
import type { AppEnv } from "./auth.js";
import { db } from "./db.js";
import { createDocx, docxOp, editDocx, readDocxText } from "./documents/docx.js";
import { editPdf, pdfOp, readPdf } from "./documents/pdf.js";
import { htmlToPdf, pageFurniture, printDocument, rendererAvailable } from "./documents/render.js";
import { createXlsx, editXlsx, previewXlsx, readXlsx, workbookSpec, xlsxOp } from "./documents/xlsx.js";
import { getThread } from "./threads.js";

// Artifacts are versioned per thread. The model addresses them by a short id it picks, so it can edit
// them in later turns without the content being repeated in the conversation.
//
// Text artifacts keep their content in `content`. Document artifacts (pdf, docx, xlsx) keep the source
// that built them in `content` and the built file in `data`; an edit rebuilds the file from the source.
// A document imported from an upload has no source and is edited in place with per-format operations.

const TEXT_KINDS = ["html", "react", "svg", "markdown", "code"] as const satisfies readonly TextArtifactKind[];

export const ARTIFACT_INSTRUCTIONS = `# Artifacts
Use create_artifact for substantial, self-contained content the user will view, reuse, or iterate on: web pages, apps, components, diagrams, documents, reports, scripts over ~20 lines. Do not use it for short answers, explanations, or small snippets.
- Kinds: html (complete page, inline CSS/JS, CDN scripts allowed), react (one file, default-export a component; import from npm packages by name, Tailwind classes work), svg, markdown, code (set language).
- To change an artifact, call update_artifact with its id. Prefer small exact edits; send full content only for rewrites.

# Documents
Use create_document for files the user downloads and opens outside the app: PDF, Word (docx), and Excel (xlsx).
- pdf and docx: write HTML and CSS, not a script. Headings, paragraphs, lists, tables, images as data URIs, page breaks, colours, and \`@page { size; margin }\` work. \`<header>\` and \`<footer>\` repeat on every page; write {page} and {pages} where the page number belongs. The same HTML builds both formats, so prefer it over the other source styles.
- xlsx: pass a JSON workbook (see the tool's schema): sheets, rows, and cells. A cell string starting with \`=\` is a formula; the stored file includes its computed value.
- To change a document, call edit_document with the same kind of source you created it with. Prefer \`edits\` (exact find/replace) over resending the whole source.
- A file the user attached carries a \`file_id\` in its <attachment> header. Call import_document with it, then read_document, then edit with that format's \`ops\` (docx paragraphs, xlsx cells/rows/sheets, pdf pages/forms). Those edit the file in place.
- read_document before editing a file whose structure you do not know. Do not repeat a document's HTML or JSON in your reply.
- Documents show in the side panel with the source alongside. Summarize what you made or changed.`;

interface Row {
  id: string;
  version: number;
  title: string;
  kind: ArtifactKind;
  language: string | null;
  content: string;
  size: number;
  created_at: number;
}

const COLUMNS = "id, version, title, kind, language, content, size, created_at";

const toVersion = (r: Row): ArtifactVersion => ({
  id: r.id,
  version: r.version,
  title: r.title,
  kind: r.kind,
  language: r.language,
  content: r.content,
  size: r.size,
  createdAt: r.created_at,
});

export function latestArtifact(threadId: string, id: string): ArtifactVersion | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM artifacts WHERE thread_id = ? AND id = ? ORDER BY version DESC LIMIT 1`).get(threadId, id) as Row | undefined;
  return row ? toVersion(row) : null;
}

export function artifactVersions(threadId: string, id: string): ArtifactVersion[] {
  const rows = db.prepare(`SELECT ${COLUMNS} FROM artifacts WHERE thread_id = ? AND id = ? ORDER BY version`).all(threadId, id) as unknown as Row[];
  return rows.map(toVersion);
}

/** Bytes of one version, or the latest when `version` is omitted. */
export function artifactData(threadId: string, id: string, version?: number): Uint8Array | null {
  const row = (
    version === undefined
      ? db.prepare("SELECT data FROM artifacts WHERE thread_id = ? AND id = ? ORDER BY version DESC LIMIT 1").get(threadId, id)
      : db.prepare("SELECT data FROM artifacts WHERE thread_id = ? AND id = ? AND version = ?").get(threadId, id, version)
  ) as { data?: Uint8Array | null } | undefined;
  return row?.data ? new Uint8Array(row.data) : null;
}

function saveVersion(
  threadId: string,
  a: Omit<ArtifactVersion, "version" | "createdAt" | "size"> & { data?: Uint8Array },
): ArtifactToolResult {
  const prev = latestArtifact(threadId, a.id);
  const version = (prev?.version ?? 0) + 1;
  db.prepare("INSERT INTO artifacts (thread_id, id, version, title, kind, language, content, data, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    threadId,
    a.id,
    version,
    a.title,
    a.kind,
    a.language,
    a.content,
    a.data ? Buffer.from(a.data) : null,
    a.data?.byteLength ?? 0,
    Date.now(),
  );
  return { id: a.id, version, title: a.title, kind: a.kind, size: a.data?.byteLength ?? 0 };
}

/** Applies exact find/replace edits. Each `old` must match once, so an edit never lands in the wrong place. */
export function applyEdits(content: string, edits: Array<{ old: string; new: string }>): string {
  let out = content;
  for (const [i, edit] of edits.entries()) {
    const first = out.indexOf(edit.old);
    if (!edit.old || first === -1) throw new Error(`Edit ${i + 1}: \`old\` text not found. Call read_artifact or read_document to get the current content.`);
    if (out.indexOf(edit.old, first + 1) !== -1) throw new Error(`Edit ${i + 1}: \`old\` text matches more than once. Include more surrounding text.`);
    out = out.slice(0, first) + edit.new + out.slice(first + edit.old.length);
  }
  return out;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "artifact";

export const DOCUMENT_MIME: Record<DocumentArtifactKind, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
const EXT: Record<DocumentArtifactKind, string> = { pdf: "pdf", docx: "docx", xlsx: "xlsx" };

/** A download-safe filename for a document title. */
export function documentFilename(title: string, kind: DocumentArtifactKind): string {
  return `${slug(title)}.${EXT[kind]}`;
}

function workbookFrom(source: string) {
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch {
    throw new Error("The xlsx source must be JSON with a `sheets` array. See the create_document schema.");
  }
  const parsed = workbookSpec.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`The workbook is invalid${issue ? ` at ${issue.path.join(".")}: ${issue.message}` : "."}`);
  }
  return parsed.data;
}

/** Builds the bytes for a document from its source text. */
async function buildDocument(kind: DocumentArtifactKind, source: string, title: string): Promise<Uint8Array> {
  if (kind === "pdf") {
    if (!rendererAvailable()) {
      throw new Error(
        "PDF rendering is unavailable because Chromium is not installed on this server. Create the document as docx or xlsx, or set OKAYCHAT_CHROMIUM_PATH.",
      );
    }
    const { body, headerTemplate, footerTemplate } = pageFurniture(source);
    return htmlToPdf(printDocument(body), { headerTemplate, footerTemplate });
  }
  return kind === "docx" ? createDocx(source, title) : createXlsx(workbookFrom(source));
}

function documentOf(threadId: string, id: string) {
  const artifact = latestArtifact(threadId, id);
  if (!artifact) throw new Error(`No artifact with id \`${id}\` in this chat.`);
  if (!DOCUMENT_KINDS.includes(artifact.kind as DocumentArtifactKind)) throw new Error(`\`${id}\` is a ${artifact.kind} artifact, not a document.`);
  const data = artifactData(threadId, id);
  if (!data) throw new Error(`\`${id}\` has no file yet.`);
  return { artifact, data, kind: artifact.kind as DocumentArtifactKind };
}

/** Saves a document artifact, giving it a non-clashing id when one is already taken. */
function createDocument(threadId: string, input: { id: string; title: string; kind: DocumentArtifactKind; source: string; data: Uint8Array }) {
  let key = slug(input.id);
  for (let n = 2; latestArtifact(threadId, key); n++) key = `${slug(input.id)}-${n}`;
  const title = input.title.trim() || "Document";
  return saveVersion(threadId, { id: key, title, kind: input.kind, language: null, content: input.source, data: input.data });
}

function uploadedBytes(userId: string, ref: { fileId?: string; name?: string }): { name: string; mime: string; data: Uint8Array } {
  const row = (
    ref.fileId
      ? db.prepare("SELECT name, mime, data FROM uploads WHERE id = ? AND user_id = ?").get(ref.fileId, userId)
      : db.prepare("SELECT name, mime, data FROM uploads WHERE user_id = ? AND name = ? ORDER BY created_at DESC LIMIT 1").get(userId, ref.name ?? "")
  ) as { name: string; mime: string; data: Uint8Array } | undefined;
  if (!row) throw new Error("That attached file is no longer available. Ask the user to attach it again.");
  return { name: row.name, mime: row.mime, data: new Uint8Array(row.data) };
}

function kindOfUpload(name: string): DocumentArtifactKind | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".xlsx") || lower.endsWith(".xlsm")) return "xlsx";
  return null;
}

export function artifactTools(threadId: string, userId: string): ToolSet {
  return {
    create_artifact: tool({
      description: "Create an artifact shown in a side panel. See the Artifacts section of the system prompt for when to use it.",
      inputSchema: z.object({
        id: z.string().describe("Short kebab-case id, unique in this chat, e.g. `budget-dashboard`"),
        title: z.string().describe("Human-readable title"),
        kind: z.enum(TEXT_KINDS),
        language: z.string().optional().describe("Language for kind `code`, e.g. `python`"),
        content: z.string().describe("Full content"),
      }),
      execute: async ({ id, title, kind, language, content }) => {
        let key = slug(id);
        // Creating an id that exists would silently overwrite it, so give the new artifact its own id.
        for (let n = 2; latestArtifact(threadId, key); n++) key = `${slug(id)}-${n}`;
        return saveVersion(threadId, { id: key, title, kind, language: language ?? null, content });
      },
    }),
    update_artifact: tool({
      description: "Change an existing text artifact. Pass `edits` (exact find/replace pairs) for targeted changes, or `content` to replace it whole.",
      inputSchema: z.object({
        id: z.string(),
        title: z.string().optional(),
        edits: z
          .array(z.object({ old: z.string().describe("Exact text to find, matching once"), new: z.string() }))
          .optional(),
        content: z.string().optional().describe("Full new content. Use instead of edits for rewrites"),
      }),
      execute: async ({ id, title, edits, content }) => {
        const prev = latestArtifact(threadId, id);
        if (!prev) throw new Error(`No artifact with id \`${id}\` in this chat.`);
        if (prev.size) throw new Error(`\`${id}\` is a document. Use edit_document.`);
        if (content === undefined && !edits?.length && !title) throw new Error("Pass `edits` or `content`.");
        const next = content ?? (edits?.length ? applyEdits(prev.content, edits) : prev.content);
        return saveVersion(threadId, { ...prev, title: title ?? prev.title, content: next });
      },
    }),
    read_artifact: tool({
      description: "Read the current content of an artifact. Use when you no longer have it in context, or an edit failed.",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        const a = latestArtifact(threadId, id);
        if (!a) throw new Error(`No artifact with id \`${id}\` in this chat.`);
        if (a.size) throw new Error(`\`${id}\` is a document. Use read_document.`);
        return { id: a.id, version: a.version, title: a.title, kind: a.kind, language: a.language, content: a.content };
      },
    }),

    create_document: tool({
      description:
        "Create a PDF, Word, or Excel file, shown in the side panel and downloadable. The source is kept so later edits rebuild the file.",
      inputSchema: z.object({
        id: z.string().describe("Short kebab-case id, unique in this chat, e.g. `q3-invoice`"),
        title: z.string().describe("Human-readable title; also the download filename"),
        kind: z.enum(["pdf", "docx", "xlsx"]),
        content: z
          .string()
          .describe(
            "For pdf and docx: HTML and CSS. For xlsx: JSON of the form {\"sheets\":[{\"name\":\"Sheet1\",\"header\":true,\"rows\":[[\"Item\",\"Cost\"],[\"Hosting\",{ \"v\": 120, \"numFmt\": \"\\\"€\\\"#,##0.00\" }]]}]}. A string starting with `=` is a formula.",
          ),
      }),
      execute: async ({ id, title, kind, content }) => {
        const data = await buildDocument(kind, content, title);
        return createDocument(threadId, { id, title, kind, source: content, data });
      },
    }),
    edit_document: tool({
      description:
        "Change a document. With `edits` or `content`, the source changes and the file is rebuilt (created documents). With `ops`, the file is edited in place (imported or created files; the stored source is dropped).",
      inputSchema: z.object({
        id: z.string(),
        title: z.string().optional(),
        edits: z
          .array(z.object({ old: z.string().describe("Exact text in the source, matching once"), new: z.string() }))
          .optional()
          .describe("Find/replace in the HTML or workbook JSON"),
        content: z.string().optional().describe("Full new source, replacing what is stored"),
        docx_ops: z.array(docxOp).optional().describe("Word edits: replace_text, set_text, insert_paragraph, delete_paragraph, set_style"),
        xlsx_ops: z.array(xlsxOp).optional().describe("Spreadsheet edits: set_cells, format, rows, columns, sheets"),
        pdf_ops: z.array(pdfOp).optional().describe("PDF edits: rotate_pages, delete_pages, move_page, add_text, fill_form, set_metadata"),
      }),
      execute: async ({ id, title, edits, content, docx_ops, xlsx_ops, pdf_ops }) => {
        const prev = latestArtifact(threadId, id);
        if (!prev) throw new Error(`No artifact with id \`${id}\` in this chat.`);
        const kind = prev.kind;
        if (!DOCUMENT_KINDS.includes(kind as DocumentArtifactKind)) throw new Error(`\`${id}\` is a text artifact. Use update_artifact.`);
        const docKind = kind as DocumentArtifactKind;
        const ops = docKind === "docx" ? docx_ops : docKind === "xlsx" ? xlsx_ops : pdf_ops;
        const changedSource = content ?? (edits?.length ? applyEdits(prev.content, edits) : undefined);

        if (changedSource !== undefined) {
          const data = await buildDocument(docKind, changedSource, title ?? prev.title);
          return saveVersion(threadId, { ...prev, title: title ?? prev.title, content: changedSource, data });
        }
        if (!ops?.length) throw new Error("Pass `edits`, `content`, or the format's `ops`.");
        const old = artifactData(threadId, id);
        if (!old) throw new Error(`\`${id}\` has no file yet.`);
        const data =
          docKind === "docx" ? editDocx(old, ops as z.infer<typeof docxOp>[]) : docKind === "xlsx" ? await editXlsx(old, ops as z.infer<typeof xlsxOp>[]) : await editPdf(old, ops as z.infer<typeof pdfOp>[]);
        // The binary has moved past the source, so keeping the source would let a later rebuild undo the ops.
        return saveVersion(threadId, { ...prev, title: title ?? prev.title, content: "", data });
      },
    }),
    read_document: tool({
      description: "Read a document as text: PDF pages and form fields, Word paragraphs with their styles, or spreadsheet cells with formulas.",
      inputSchema: z.object({
        id: z.string(),
        range: z.string().optional().describe("Spreadsheets only: a range like `Sheet1!A1:F40`"),
      }),
      execute: async ({ id, range }) => {
        const { artifact, data, kind } = documentOf(threadId, id);
        const text = kind === "docx" ? readDocxText(data) : kind === "xlsx" ? await readXlsx(data, range) : await readPdf(data);
        return { id, version: artifact.version, kind, text };
      },
    }),
    import_document: tool({
      description:
        "Copy a file the user attached into this chat as an editable document artifact. Use the attachment's file_id, or its filename when the header has none.",
      inputSchema: z.object({
        file_id: z.string().optional().describe("The attachment's file_id"),
        name: z.string().optional().describe("The attachment's filename, used when there is no file_id"),
        id: z.string().describe("Short kebab-case id for the artifact"),
        title: z.string().describe("Human-readable title; also the download filename"),
      }),
      execute: async ({ file_id, name, id, title }) => {
        if (!file_id && !name) throw new Error("Pass the attachment's file_id or name.");
        const upload = uploadedBytes(userId, { fileId: file_id, name });
        const kind = kindOfUpload(upload.name);
        if (!kind) throw new Error(`Attachments can be imported as pdf, docx, or xlsx. \`${upload.name}\` is none of those.`);
        return createDocument(threadId, { id, title, kind, source: "", data: upload.data });
      },
    }),
  };
}

const fileHeaders = (filename: string, mime: string) => ({
  "Content-Type": mime,
  "Content-Disposition": `inline; filename="${filename}"`,
  "Cache-Control": "private, max-age=60",
});

export const artifactRoutes = new Hono<AppEnv>()
  .get("/threads/:id/artifacts/:artifactId", (c) => {
    const thread = getThread(c.get("user").id, c.req.param("id"));
    if (!thread) return c.json({ error: "Not found" }, 404);
    const versions = artifactVersions(thread.id, c.req.param("artifactId"));
    return versions.length ? c.json(versions) : c.json({ error: "Not found" }, 404);
  })
  .get("/threads/:id/artifacts/:artifactId/file", (c) => {
    const thread = getThread(c.get("user").id, c.req.param("id"));
    if (!thread) return c.json({ error: "Not found" }, 404);
    const id = c.req.param("artifactId");
    const version = c.req.query("version") ? Number(c.req.query("version")) : undefined;
    const data = artifactData(thread.id, id, version);
    const artifact = latestArtifact(thread.id, id);
    if (!data || !artifact) return c.json({ error: "Not found" }, 404);
    const kind = artifact.kind as DocumentArtifactKind;
    return new Response(data as unknown as BodyInit, { headers: fileHeaders(documentFilename(artifact.title, kind), DOCUMENT_MIME[kind]) });
  })
  .get("/threads/:id/artifacts/:artifactId/preview", async (c) => {
    const thread = getThread(c.get("user").id, c.req.param("id"));
    if (!thread) return c.json({ error: "Not found" }, 404);
    const id = c.req.param("artifactId");
    const version = c.req.query("version") ? Number(c.req.query("version")) : undefined;
    const data = artifactData(thread.id, id, version);
    const artifact = latestArtifact(thread.id, id);
    if (!data || !artifact) return c.json({ error: "Not found" }, 404);
    if (artifact.kind !== "xlsx") return c.json({ error: "Preview is only available for spreadsheets" }, 400);
    return c.json(await previewXlsx(data) satisfies SheetPreview[]);
  });
