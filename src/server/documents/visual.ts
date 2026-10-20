import { createRequire } from "node:module";
import path from "node:path";
import type { ArtifactKind, SheetPreview, SheetPreviewCell } from "../../shared/types.js";
import { FRAME_NETWORK_HOSTS, frameDocument } from "../../shared/artifact-frame.js";
import { rendererAvailable, screenshotHtml, withBrowserPage } from "./render.js";
import { previewXlsx } from "./xlsx.js";

// The model's visual self-check. Every rendered artifact runs in the same locked-down Chromium the PDF
// writer uses: no network except the public CDNs artifact pages already need, no file access, and a
// fresh context per shot. See docs/research/documents.md.

const require = createRequire(import.meta.url);
const pdfjsRoot = () => path.dirname(require.resolve("pdfjs-dist/package.json"));
const docxPreviewFile = () => require.resolve("docx-preview");
const jszipFile = () => path.join(path.dirname(require.resolve("jszip/package.json")), "dist", "jszip.min.js");

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

const NEEDS_CHROMIUM = "Visual checks need Chromium on this server. Set OKAYCHAT_CHROMIUM_PATH, or build the image with SCRAPLING_BROWSER=true.";

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
    allowHosts: request.kind === "svg" ? undefined : FRAME_NETWORK_HOSTS,
  });
  return {
    png: result.png,
    width: result.width,
    height: result.height,
    label: "the visible page",
    errors: result.errors,
  };
}

function pdfViewer(pageNumber: number): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
  html,body{margin:0;background:#e9e9ec;font:12px system-ui,sans-serif}
  #stage{display:flex;justify-content:center;padding:16px}
  canvas{display:block;background:#fff;box-shadow:0 1px 8px rgba(0,0,0,.18);max-width:100%;height:auto}
</style></head><body><div id="stage"></div>
<script type="module">
try {
  const pdfjs = await import("/pdfjs/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/build/pdf.worker.mjs";
  const doc = await pdfjs.getDocument({
    url: "/file.pdf",
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
  }).promise;
  window.__pages = doc.numPages;
  if (${pageNumber} > doc.numPages) throw new Error("This PDF has " + doc.numPages + " page" + (doc.numPages === 1 ? "" : "s") + ".");
  const page = await doc.getPage(${pageNumber});
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.min(2.5, 1000 / base.width) });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  document.getElementById("stage").append(canvas);
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  window.__ready = true;
} catch (error) {
  window.__error = error?.message ?? String(error);
}
</script></body></html>`;
}

async function screenshotPdf(request: VisualRequest): Promise<VisualShot> {
  const data = documentData(request, "PDF");
  const pageNumber = request.page ?? 1;
  return withBrowserPage(
    pdfViewer(pageNumber),
    {
      width: 1060,
      resources: { "/file.pdf": { contentType: "application/pdf", bytes: data } },
      roots: { "/pdfjs/": pdfjsRoot() },
      waitFor: "window.__ready === true || !!window.__error",
    },
    async ({ page, errors }) => {
      const failure = await page.evaluate(() => (window as unknown as { __error?: string }).__error);
      if (failure) throw new VisualError(capitalize(failure));
      const canvas = page.locator("#stage canvas");
      const box = await canvas.boundingBox();
      const png = await canvas.screenshot({ type: "png" });
      const pages = await page.evaluate(() => (window as unknown as { __pages?: number }).__pages ?? 1);
      return {
        png: new Uint8Array(png),
        width: Math.round(box?.width ?? 1000),
        height: Math.round(box?.height ?? 1400),
        label: `page ${pageNumber} of ${pages}`,
        errors,
      };
    },
  );
}

function docxViewer(): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
  html,body{margin:0;background:#e9e9ec}
  #doc{display:flex;justify-content:center;padding:16px}
</style></head><body><div id="doc"></div>
<script src="/vendor/jszip.min.js"></script>
<script src="/vendor/docx-preview.js"></script>
<script>
(async () => {
  try {
    const buf = await (await fetch("/file.docx")).arrayBuffer();
    await docx.renderAsync(buf, document.getElementById("doc"), null, {
      className: "docx",
      inWrapper: true,
      breakPages: true,
      renderHeaders: true,
      renderFooters: true,
      ignoreWidth: false,
      ignoreHeight: false,
    });
    window.__pages = document.querySelectorAll("#doc .docx-wrapper > section.docx").length;
    window.__ready = true;
  } catch (error) {
    window.__error = error?.message ?? String(error);
  }
})();
</script></body></html>`;
}

async function screenshotDocx(request: VisualRequest): Promise<VisualShot> {
  const data = documentData(request, "Word file");
  const pageNumber = request.page ?? 1;
  return withBrowserPage(
    docxViewer(),
    {
      width: 1000,
      resources: {
        "/file.docx": {
          contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          bytes: data,
        },
        "/vendor/jszip.min.js": { contentType: "text/javascript", file: jszipFile() },
        "/vendor/docx-preview.js": { contentType: "text/javascript", file: docxPreviewFile() },
      },
      waitFor: "window.__ready === true || !!window.__error",
    },
    async ({ page, errors }) => {
      const failure = await page.evaluate(() => (window as unknown as { __error?: string }).__error);
      if (failure) throw new VisualError(capitalize(failure));
      const pages = await page.evaluate(() => (window as unknown as { __pages?: number }).__pages ?? 0);
      if (!pages) throw new VisualError("The Word file rendered no pages.");
      if (pageNumber > pages) throw new VisualError(`This Word file has ${pages} page${pages === 1 ? "" : "s"}.`);
      const section = page.locator("#doc .docx-wrapper > section.docx").nth(pageNumber - 1);
      const box = await section.boundingBox();
      const png = await section.screenshot({ type: "png" });
      return {
        png: new Uint8Array(png),
        width: Math.round(box?.width ?? 816),
        height: Math.round(box?.height ?? 1056),
        label: `page ${pageNumber} of ${pages}`,
        errors,
      };
    },
  );
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

const capitalize = (text: string) => (text ? text[0]!.toUpperCase() + text.slice(1) : text);
