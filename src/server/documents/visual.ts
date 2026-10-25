import type { ArtifactKind, SheetPreview, SheetPreviewCell } from "../../shared/types.js";
import { frameDocument } from "../../shared/artifact-frame.js";
import { BrowserJobError } from "../browser.js";
import { rendererAvailable, screenshotHtml, screenshotPage } from "./render.js";
import { previewXlsx } from "./lazy.js";

// The model's visual self-check. Every artifact is rendered by the browser worker in a fresh Chromium context:
// offline for documents, sheets, and SVG; HTML and React previews may also load from the public CDNs artifact
// pages already use. See docs/implementation/documents.md and docs/implementation/browser-worker.md.

/** How much of a tall page or sheet a single shot shows. Keeps image tokens reasonable. */
const MAX_HEIGHT = 1800;
const XLSX_ROWS = 60;
const XLSX_COLS = 20;

export interface VisualRequest {
  kind: ArtifactKind;
  /** HTML source for pdf/docx, or the artifact content for html/react/svg. */
  content: string;
  /** Built bytes for pdf/docx/xlsx. */
  data?: Uint8Array | null;
  page?: number;
  sheet?: string;
}
export interface VisualShot {
  png: Uint8Array;
  width: number;
  height: number;
  label: string;
  errors: string[];
}

/** Thrown when a visual check cannot be produced; the message is written for the model to act on. */
export class VisualError extends Error {}

const NEEDS_CHROMIUM = "Visual checks need the browser worker, which this server does not have (OKAYCHAT_BROWSER_URL).";

function assertAvailable() {
  if (!rendererAvailable()) throw new VisualError(NEEDS_CHROMIUM);
}

function documentData(request: VisualRequest, what: string): Uint8Array {
  if (!request.data) throw new VisualError(`There is no built ${what} for this artifact yet.`);
  return request.data;
}

/** Screenshot one visual artifact: a page, a sheet, or the whole page for web content. */
export async function screenshotArtifact(request: VisualRequest): Promise<VisualShot> {
  assertAvailable();
  try {
    return await screenshotKind(request);
  } catch (error) {
    // The worker's own refusals (a page out of range, a file that does not parse) are for the model to act on.
    if (error instanceof BrowserJobError && error.forModel) throw new VisualError(error.message);
    throw error;
  }
}

async function screenshotKind(request: VisualRequest): Promise<VisualShot> {
  switch (request.kind) {
    case "html":
    case "react":
    case "svg":
      return screenshotFrame(request);
    case "pdf":
      return screenshotPdf(request);
    case "docx":
      return screenshotDocx(request);
    case "xlsx":
      return screenshotXlsx(request);
    default:
      throw new VisualError(`\`${request.kind}\` artifacts have no visual layout. Use read_artifact for their text.`);
  }
}

async function screenshotFrame(request: VisualRequest): Promise<VisualShot> {
  const html = frameDocument(request.kind, request.content);
  if (!html) throw new VisualError("This artifact has no preview.");
  // A fragment without a doctype would render in quirks mode, which changes layout and measurements.
  const documentHtml = /<html[\s>]/i.test(html) ? html : `<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`;
  const result = await screenshotHtml(documentHtml, {
    width: 1000,
    maxHeight: MAX_HEIGHT,
    network: request.kind === "svg" ? "offline" : "cdn",
  });
  return {
    png: result.png,
    width: result.width,
    height: result.height,
    label: "the visible page",
    errors: result.errors,
  };
}

async function screenshotPdf(request: VisualRequest): Promise<VisualShot> {
  return screenshotPage("pdf", documentData(request, "PDF"), request.page ?? 1);
}

async function screenshotDocx(request: VisualRequest): Promise<VisualShot> {
  return screenshotPage("docx", documentData(request, "Word file"), request.page ?? 1);
}

const columnName = (n: number): string => (n <= 0 ? "" : columnName(Math.floor((n - 1) / 26)) + String.fromCharCode(65 + ((n - 1) % 26)));

function cellStyle(cell: SheetPreviewCell): string {
  const css = [
    cell.color && `color:${cell.color}`,
    cell.bg && `background:${cell.bg}`,
    cell.b && "font-weight:600",
    cell.i && "font-style:italic",
    cell.u && "text-decoration:underline",
    cell.align && `text-align:${cell.align}`,
    cell.size && `font-size:${cell.size}pt`,
    cell.wrap ? "white-space:pre-wrap" : "white-space:nowrap",
  ];
  return css.filter(Boolean).join(";");
}

function sheetHtml(sheet: SheetPreview): string {
  const rows = sheet.rows.slice(0, XLSX_ROWS);
  const cols = sheet.columns.slice(0, XLSX_COLS);
  const merges = sheet.merges;
  const body = rows
    .map((row, r) => {
      const cells = row.cells.slice(0, XLSX_COLS).map((cell, c) => {
        if (cell === null) return "";
        const merge = merges.find((m) => m.top === r + 1 && m.left === c + 1);
        const span = merge
          ? ` colspan="${merge.right - merge.left + 1}" rowspan="${merge.bottom - merge.top + 1}"`
          : "";
        return `<td${span} style="${cellStyle(cell)}">${escapeText(cell.t)}</td>`;
      });
      return `<tr><th class="head">${r + 1}</th>${cells.join("")}</tr>`;
    })
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
  html,body{margin:0;background:#f4f4f5;font:11px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1a1a1a}
  #sheet{display:inline-block;background:#fff;padding:16px;min-height:80px}
  table{border-collapse:collapse;table-layout:fixed}
  td,th{border:1px solid #d4d7dd;padding:3px 5px;vertical-align:top;overflow:hidden;max-width:320px}
  th.head{background:#f0f2f5;color:#666;font-weight:500;text-align:center;min-width:34px;position:relative}
  thead th{background:#f0f2f5;color:#666;font-weight:500;text-align:center}
</style></head><body><div id="sheet"><table>
<colgroup><col style="width:38px">${cols.map((width) => `<col style="width:${Math.min(Math.max(width, 6), 60) * 7 + 10}px">`).join("")}</colgroup>
<thead><tr><th class="head"></th>${cols.map((_, i) => `<th>${columnName(i + 1)}</th>`).join("")}</tr></thead>
<tbody>${body}</tbody>
</table></div></body></html>`;
}

const escapeText = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function screenshotXlsx(request: VisualRequest): Promise<VisualShot> {
  const data = documentData(request, "spreadsheet");
  const sheets = await previewXlsx(data);
  const wanted = request.sheet?.trim().toLowerCase();
  const sheet = wanted ? sheets.find((s) => s.name.toLowerCase() === wanted) : sheets[0];
  if (!sheet) throw new VisualError(wanted ? `There is no sheet named "${request.sheet}". Sheets: ${sheets.map((s) => s.name).join(", ")}` : "This workbook has no sheets.");
  const result = await screenshotHtml(sheetHtml(sheet), { width: 1100, maxHeight: MAX_HEIGHT, contentSelector: "#sheet" });
  const note = sheet.rows.length > XLSX_ROWS || sheet.columns.length > XLSX_COLS;
  return {
    png: result.png,
    width: result.width,
    height: result.height,
    label: `sheet "${sheet.name}"${note ? ` (first ${XLSX_ROWS} rows and ${XLSX_COLS} columns)` : ""}`,
    errors: result.errors,
  };
}
