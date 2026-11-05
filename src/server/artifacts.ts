import { tool, type ToolSet } from "ai";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ArtifactKind, ArtifactToolResult, ArtifactVersion, DocumentArtifactKind, SheetPreview, TextArtifactKind } from "../shared/types.js";
import { DOCUMENT_KINDS } from "../shared/types.js";
import type { AppEnv } from "./auth.js";
import { readSandboxFile, readUpload } from "./media/store.js";
import { db } from "./db.js";
import { createDocx, createXlsx, editDocx, editPdf, editXlsx, previewXlsx, readDocxText, readPdf, readXlsx } from "./documents/lazy.js";
import { htmlToPdf, pageFurniture, printDocument, rendererAvailable } from "./documents/render.js";
import { screenshotArtifact, type VisualShot } from "./documents/visual.js";
import { docxOp, pdfOp, workbookSpec, xlsxOp } from "./documents/schemas.js";
import { scanForInjection, wrapUntrusted } from "./prompt-injection.js";
import { assertStorage } from "./quota.js";
import { serviceUnavailable } from "./services.js";
import { convertToPdf } from "./tools/sandbox.js";
import { MAX_SHOTS_PER_TURN } from "./tools/screenshots.js";
import { getThread } from "./threads.js";
import { assertFeature } from "./permissions/guard.js";
import { reserveOperation } from "./permissions/limits.js";

// Artifacts are versioned per thread. The model addresses them by a short id it picks, so it can edit
// them in later turns without the content being repeated in the conversation.
//
// Text artifacts keep their content in `content`. Document artifacts (pdf, docx, xlsx) keep the source
// that built them in `content` and the built file in `data`; an edit rebuilds the file from the source.
// A document imported from an upload has no source and is edited in place with per-format operations.

const TEXT_KINDS = ["html", "react", "svg", "markdown", "code"] as const satisfies readonly TextArtifactKind[];

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
  turn: Set<string>,
): ArtifactToolResult {
  const prev = latestArtifact(threadId, a.id);
  // One version per artifact per turn: edits within a turn replace that turn's version, so the
  // version list follows the user's requests instead of the agent's drafts.
  const replace = prev !== null && turn.has(a.id);
  const version = replace ? prev.version : (prev?.version ?? 0) + 1;
  const bytes = (a.data?.byteLength ?? 0) + Buffer.byteLength(a.content, "utf8");
  const freed = replace ? prev.size + Buffer.byteLength(prev.content, "utf8") : 0;
  // A new version keeps its bytes next to the old ones; a replaced draft charges only its growth.
  // The owner comes from the thread; the tools run for its user, including server-side schedule runs.
  const owner = db.prepare("SELECT user_id FROM threads WHERE id = ?").get(threadId) as { user_id: string } | undefined;
  if (owner) assertStorage(owner.user_id, bytes - freed);
  db.prepare("INSERT OR REPLACE INTO artifacts (thread_id, id, version, title, kind, language, content, data, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
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
  // Only a saved version belongs to this turn; a rejected first save must not claim the previous one.
  turn.add(a.id);
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
async function buildDocument(kind: DocumentArtifactKind, source: string, title: string, signal?: AbortSignal): Promise<Uint8Array> {
  let data: Uint8Array;
  if (kind === "pdf") {
    // The browser worker renders the PDF; Word and Excel are built in-process and keep working without it.
    if (!rendererAvailable()) throw serviceUnavailable("browser");
    const { body, headerTemplate, footerTemplate } = pageFurniture(source);
    data = await htmlToPdf(printDocument(body), { headerTemplate, footerTemplate }, signal);
  } else data = kind === "docx" ? await createDocx(source, title) : await createXlsx(workbookFrom(source));
  // A stopped reply must not save a version that finished rendering after Stop.
  signal?.throwIfAborted();
  return data;
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
function createDocument(threadId: string, turn: Set<string>, input: { id: string; title: string; kind: DocumentArtifactKind; source: string; data: Uint8Array }) {
  let key = slug(input.id);
  for (let n = 2; latestArtifact(threadId, key); n++) key = `${slug(input.id)}-${n}`;
  const title = input.title.trim() || "Document";
  return saveVersion(threadId, { id: key, title, kind: input.kind, language: null, content: input.source, data: input.data }, turn);
}

/**
 * The bytes behind an import: an attachment (uploads) or a saved run_code output (sandbox_files), both only
 * the caller's own, the same rule run_code's input_files applies. A name only ever matches attachments.
 */
function sourceBytes(userId: string, ref: { fileId?: string; name?: string }): { name: string; data: Uint8Array } {
  const byName = ref.fileId ? undefined : (db.prepare("SELECT id FROM uploads WHERE user_id = ? AND name = ? ORDER BY created_at DESC LIMIT 1").get(userId, ref.name ?? "") as { id: string } | undefined)?.id;
  const id = ref.fileId ?? byName;
  const row = id ? (readUpload(userId, id) ?? readSandboxFile(userId, id)) : undefined;
  if (!row) {
    throw new Error(
      ref.fileId?.startsWith("sbf_")
        ? "That sandbox output is no longer saved. Run the code again and import the new fileId."
        : "That attached file is no longer available. Ask the user to attach it again.",
    );
  }
  return { name: row.name.split("/").pop() || row.name, data: new Uint8Array(row.data) };
}

function kindOfUpload(name: string): DocumentArtifactKind | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".xlsx") || lower.endsWith(".xlsm")) return "xlsx";
  return null;
}

/** Presentations have no artifact kind of their own; they are imported as the PDF LibreOffice makes of them. */
const PRESENTATION = /\.(pptx|ppt|pps|ppsx|odp)$/i;

export interface ArtifactToolOptions {
  /** Per-turn screenshots, keyed by tool call id, injected into the next model step by chat.ts. */
  shots?: Map<string, VisualShot>;
  /** Only vision models get view_artifact. */
  canViewImages?: boolean;
  /** Artifact ids already saved in this turn by an earlier request (browser-tool continuations). */
  savedThisTurn?: Iterable<string>;
  /** Screenshots an earlier request of this turn already took; they count toward the per-reply limit. */
  shotsThisTurn?: number;
  /**
   * The browser worker is down, so the visual check cannot run in this turn. The tool is omitted (with the
   * reason stored on the reply) instead of failing after the model calls it.
   */
  browserDown?: boolean;
}

const SAVING_TOOLS = new Set(["create_artifact", "update_artifact", "create_document", "edit_document", "import_document"]);

/** Artifact ids saved since the last user message, so a continuation request keeps editing the same version. */
export function artifactsInCurrentTurn(messages: Array<{ role: string; parts: unknown[] }>): Set<string> {
  let ids = new Set<string>();
  for (const message of messages) {
    if (message.role === "user") ids = new Set();
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (!part || typeof part !== "object") continue;
      const p = part as { type?: string; output?: unknown };
      const name = p.type?.startsWith("tool-") ? p.type.slice(5) : undefined;
      const id = p.output && typeof p.output === "object" ? (p.output as { id?: unknown }).id : undefined;
      if (name && SAVING_TOOLS.has(name) && typeof id === "string") ids.add(id);
    }
  }
  return ids;
}

/** view_artifact results since the latest user message, for the per-reply screenshot limit across continuations. */
export function screenshotsInCurrentTurn(messages: Array<{ role: string; parts: unknown[] }>): number {
  let count = 0;
  for (const message of messages) {
    if (message.role === "user") count = 0;
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      const p = part as { type?: string; state?: string } | null;
      if (p?.type === "tool-view_artifact" && p.state === "output-available") count++;
    }
  }
  return count;
}

export function artifactTools(threadId: string, userId: string, visual: ArtifactToolOptions = {}): ToolSet {
  const shots = visual.shots;
  // Calls rendering now, plus screenshots from earlier requests of this turn.
  const shotsPending = { value: visual.shotsThisTurn ?? 0 };
  // Artifact ids saved in this turn. A tool set lives for one request; continuations pass the earlier ids.
  const turn = new Set<string>(visual.savedThisTurn);
  // A retried import of the same bytes under the same id returns the first copy instead of storing another.
  // The key holds a content hash because a run_code output keeps its fileId when a later run rewrites it.
  // Versions are overwritten within a turn, so a cached import also remembers the bytes it saved.
  const imported = new Map<string, { result: ArtifactToolResult; saved: string }>();
  const digest = (data: Uint8Array | null) => (data ? createHash("sha256").update(data).digest("hex") : "");
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
        assertFeature(userId, "artifacts");
        let key = slug(id);
        // Creating an id that exists would silently overwrite it, so give the new artifact its own id.
        for (let n = 2; latestArtifact(threadId, key); n++) key = `${slug(id)}-${n}`;
        return saveVersion(threadId, { id: key, title, kind, language: language ?? null, content }, turn);
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
        assertFeature(userId, "artifacts");
        const prev = latestArtifact(threadId, id);
        if (!prev) throw new Error(`No artifact with id \`${id}\` in this chat.`);
        if (prev.size) throw new Error(`\`${id}\` is a document. Use edit_document.`);
        if (content === undefined && !edits?.length && !title) throw new Error("Pass `edits` or `content`.");
        const next = content ?? (edits?.length ? applyEdits(prev.content, edits) : prev.content);
        return saveVersion(threadId, { ...prev, title: title ?? prev.title, content: next }, turn);
      },
    }),
    read_artifact: tool({
      description: "Read the current content of an artifact. Use when you no longer have it in context, or an edit failed.",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        const a = latestArtifact(threadId, id);
        if (!a) throw new Error(`No artifact with id \`${id}\` in this chat.`);
        if (a.size) throw new Error(`\`${id}\` is a document. Use read_document.`);
        const injection = scanForInjection(`${a.title ?? ""}\n${a.content}`);
        return { id: a.id, version: a.version, title: a.title, kind: a.kind, language: a.language, content: a.content, ...(injection.flagged ? { injection } : {}) };
      },
      // Keep every field the model needs for paging and versioned edits inside the data envelope.
      toModelOutput: ({ output }) => ({
        type: "text",
        value: wrapUntrusted(
          JSON.stringify({ id: output.id, version: output.version, title: output.title, kind: output.kind, language: output.language, content: output.content }),
          { kind: "artifact", name: output.title },
        ).text,
      }),
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
      execute: async ({ id, title, kind, content }, { abortSignal }) => {
        assertFeature(userId, "artifacts");
        // PDF is built by the browser worker; Word and Excel are built in-process.
        const lease = kind === "pdf" ? reserveOperation({ userId }, "browser.render") : null;
        try {
          const data = await buildDocument(kind, content, title, abortSignal);
          return createDocument(threadId, turn, { id, title, kind, source: content, data });
        } finally {
          lease?.release();
        }
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
      execute: async ({ id, title, edits, content, docx_ops, xlsx_ops, pdf_ops }, { abortSignal }) => {
        assertFeature(userId, "artifacts");
        const prev = latestArtifact(threadId, id);
        if (!prev) throw new Error(`No artifact with id \`${id}\` in this chat.`);
        const kind = prev.kind;
        if (!DOCUMENT_KINDS.includes(kind as DocumentArtifactKind)) throw new Error(`\`${id}\` is a text artifact. Use update_artifact.`);
        const docKind = kind as DocumentArtifactKind;
        const ops = docKind === "docx" ? docx_ops : docKind === "xlsx" ? xlsx_ops : pdf_ops;
        const changedSource = content ?? (edits?.length ? applyEdits(prev.content, edits) : undefined);

        if (changedSource !== undefined) {
          const lease = docKind === "pdf" ? reserveOperation({ userId }, "browser.render") : null;
          try {
            const data = await buildDocument(docKind, changedSource, title ?? prev.title, abortSignal);
            return saveVersion(threadId, { ...prev, title: title ?? prev.title, content: changedSource, data }, turn);
          } finally {
            lease?.release();
          }
        }
        if (!ops?.length) throw new Error("Pass `edits`, `content`, or the format's `ops`.");
        const old = artifactData(threadId, id);
        if (!old) throw new Error(`\`${id}\` has no file yet.`);
        const data =
          docKind === "docx" ? await editDocx(old, ops as z.infer<typeof docxOp>[]) : docKind === "xlsx" ? await editXlsx(old, ops as z.infer<typeof xlsxOp>[]) : await editPdf(old, ops as z.infer<typeof pdfOp>[]);
        // The binary has moved past the source, so keeping the source would let a later rebuild undo the ops.
        return saveVersion(threadId, { ...prev, title: title ?? prev.title, content: "", data }, turn);
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
        const text = kind === "docx" ? await readDocxText(data) : kind === "xlsx" ? await readXlsx(data, range) : await readPdf(data);
        const injection = scanForInjection(`${artifact.title}\n${text}`);
        return { id, version: artifact.version, kind, text, ...(injection.flagged ? { injection } : {}) };
      },
      // Keep id/version/kind/paging fields in the envelope; the model needs them for edits and re-reads.
      toModelOutput: ({ output }) => ({
        type: "text",
        value: wrapUntrusted(
          JSON.stringify({ id: output.id, version: output.version, kind: output.kind, text: output.text }),
          { kind: "artifact", name: `document ${output.id}` },
        ).text,
      }),
    }),
    ...(visual.canViewImages && shots && !visual.browserDown && rendererAvailable()
      ? {
          view_artifact: tool({
            description:
              "Render the current version of an artifact and see a screenshot of it. Use for layout checks on PDF, Word, spreadsheet, HTML, React, or SVG artifacts. One page or sheet per call.",
            inputSchema: z.object({
              id: z.string(),
              page: z.number().int().min(1).optional().describe("PDF or Word page number. Default 1."),
              sheet: z.string().optional().describe("Spreadsheet sheet name. Default the first sheet."),
            }),
            execute: async ({ id, page, sheet }, { toolCallId }) => {
              assertFeature(userId, "artifacts");
              // Reserve before rendering, so parallel calls cannot all pass the limit.
              if (shots.size + shotsPending.value >= MAX_SHOTS_PER_TURN) {
                throw new Error(`This reply has used its ${MAX_SHOTS_PER_TURN} screenshots. Finish from what you have already seen, or ask the user to check the artifact.`);
              }
              const artifact = latestArtifact(threadId, id);
              if (!artifact) throw new Error(`No artifact with id \`${id}\` in this chat.`);
              const data = artifact.size ? artifactData(threadId, id) : null;
              shotsPending.value++;
              const lease = reserveOperation({ userId }, "browser.render");
              let shot: VisualShot;
              try {
                shot = await screenshotArtifact({ kind: artifact.kind, content: artifact.content, data, page, sheet });
              } finally {
                shotsPending.value--;
                lease.release();
              }
              shots.set(toolCallId, shot);
              return {
                id,
                version: artifact.version,
                kind: artifact.kind,
                capture: shot.label,
                width: shot.width,
                height: shot.height,
                ...(shot.errors.length ? { pageErrors: shot.errors.slice(0, 5) } : {}),
                note: "The screenshot is attached to your next step. It is not repeated in later turns.",
              };
            },
          }),
        }
      : {}),
    import_document: tool({
      description:
        "Copy a file into this chat as an editable document artifact: an attachment (its file_id, or its filename when the header has none) or a run_code output (its fileId). PDF, DOCX, and XLSX keep their format; PPTX, PPT, and ODP presentations are converted to PDF. Importing a new file under an existing document's id saves a new version of it. Then view_artifact can show it.",
      inputSchema: z.object({
        file_id: z.string().optional().describe("The attachment's file_id, or a run_code output's fileId"),
        name: z.string().optional().describe("The attachment's filename, used when there is no file_id"),
        id: z.string().describe("Short kebab-case id for the artifact"),
        title: z.string().describe("Human-readable title; also the download filename"),
      }),
      execute: async ({ file_id, name, id, title }, { abortSignal }) => {
        assertFeature(userId, "artifacts");
        if (!file_id && !name) throw new Error("Pass the attachment's file_id or name.");
        const source = sourceBytes(userId, { fileId: file_id, name });
        const key = `${file_id ?? `name:${name}`}\u0000${slug(id)}\u0000${createHash("sha256").update(source.data).digest("hex")}`;
        const previous = imported.get(key);
        if (previous && latestArtifact(threadId, previous.result.id)?.version === previous.result.version && digest(artifactData(threadId, previous.result.id)) === previous.saved) {
          return previous.result;
        }
        let kind = kindOfUpload(source.name);
        let data = source.data;
        if (!kind && PRESENTATION.test(source.name)) {
          data = await convertToPdf(userId, threadId, source.name, source.data, abortSignal);
          kind = "pdf";
        }
        if (!kind) throw new Error(`Files can be imported as pdf, docx, or xlsx, and presentations as pdf. \`${source.name}\` is none of those.`);
        // Importing again under an existing document's id (a fixed file) adds a version instead of a second card.
        const existing = latestArtifact(threadId, slug(id));
        const result =
          existing?.kind === kind
            ? saveVersion(threadId, { id: existing.id, title: title.trim() || existing.title, kind, language: null, content: "", data }, turn)
            : createDocument(threadId, turn, { id, title, kind, source: "", data });
        imported.set(key, { result, saved: digest(data) });
        return result;
      },
    }),
  };
}

const fileHeaders = (filename: string, mime: string) => ({
  "Content-Type": mime,
  "Content-Disposition": `inline; filename="${filename}"`,
  // A version's bytes change while its turn keeps editing it, and the URL carries only the version number.
  "Cache-Control": "private, no-cache",
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
