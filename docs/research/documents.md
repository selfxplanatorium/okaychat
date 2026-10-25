# Documents: PDF, DOCX, XLSX

Status: built 2026-10-20.

## What the model gets

| Tool | Purpose |
| --- | --- |
| `create_document` | Build a PDF, Word, or Excel file from a text source. The source is stored with the artifact and rebuilds the file on later edits. |
| `edit_document` | Either change the source (`edits` / `content`) and rebuild, or edit the binary in place (`docx_ops`, `xlsx_ops`, `pdf_ops`). |
| `read_document` | Text view: PDF pages and form fields, Word paragraphs with styles, spreadsheet cells and formulas. |
| `import_document` | Copy an attachment's original bytes (from `/api/files/extract`) into a document artifact. |
| `view_artifact` | Render the current version and return a screenshot to the model. One page or sheet per call, vision models only. |

Attachment bytes land in the `uploads` table (seven-day retention) before the model asks for them:
`/api/files/extract` stores docx/xlsx and large PDFs, and `/api/files/store` stores a PDF that a model
reads natively. `import_document` resolves the newest upload by `file_id`, or by filename for models
that only received extracted text. Temporary chats never store uploads.

Documents are artifacts with `kind` `pdf`, `docx`, or `xlsx`. `artifacts.content` holds the source —
HTML for PDF/DOCX, workbook JSON for XLSX — and `artifacts.data` holds the built file. The versions API
returns metadata (`size`) without the bytes; the web panel fetches
`/api/threads/:id/artifacts/:id/file` and, for spreadsheets, `/preview`.

## Formats

### PDF

HTML and CSS are rendered to a vector PDF by Chromium in the browser worker (`docs/research/browser-worker.md`), offline. `PRINT_DEFAULTS` in
`documents/render.ts` gives plain HTML a readable document look; anything the model writes later in the
document overrides it. `@page` sets size and margins. A top-level `<header>` and `<footer>` are removed
from the flow and passed to Chrome as page templates, so they repeat on every page and `{page}` /
`{pages}` become live counters. Chrome prints templates in its own context: they cannot use document CSS,
and they get a small fixed style.

Existing PDFs are changed structurally with `@cantoo/pdf-lib`: rotate, delete, move pages, stamp text,
fill form fields, set metadata. Body text is not rewritten — no library does that reliably — so the tool
describes the document and the model rebuilds it from HTML when the content itself must change.

### DOCX

Creation converts a restricted HTML subset with the `docx` package (plain text with blank lines
becomes paragraphs, so prose does not collapse into one block): headings, paragraphs, bold/italic/
underline/strike, links, inline code, `pre`, lists (nested), tables, images as data URIs, blockquote,
`hr`, page breaks, colours, backgrounds, alignment, font families and sizes, `@page` size/orientation/
margins, and header/footer furniture with page numbers.

Editing works on `word/document.xml` directly, unzipped with `fflate` and parsed with `@xmldom/xmldom`,
so styles, numbering, images, fields, headers and footers survive. Paragraphs are addressed by the index
`read_document` prints. `replace_text` concatenates a paragraph's runs first, so a match can span the
split runs Word creates for bold or spell-check boundaries; the replacement lands in the first affected
run. `insert_paragraph` clones the referenced paragraph to copy its formatting.

### XLSX

`exceljs` reads and writes workbooks, preserving styles and formulas. Creating takes a JSON workbook
spec (`sheets[].rows[][]`), where a string starting with `=` is a formula and a cell object can carry
style fields such as `bold`, `fill`, `numFmt`, `align`, `wrap`, and `border`.

`fast-formula-parser` evaluates formulas so the stored file contains a cached result; Excel and
LibreOffice recalculate on open anyway. Common functions the parser lacks are added in `xlsx.ts`
(`MAX`, `MIN`, `MEDIAN`, `COUNTA`, `COUNT*`, `SUMIFS`, `AVERAGEIFS`, `XLOOKUP`). A formula the evaluator
cannot handle keeps whatever result it had and still opens correctly.

`exceljs` does not move formula references when rows or columns are inserted or deleted, so
`shiftReferences()` rewrites A1 references (with sheet qualifiers, inside strings excluded) before
each splice.

`previewXlsx` produces the `SheetPreview` JSON the web grid renders. Values are formatted with `ssf`
(the same number-format engine pdfmake used), so a `#,##0.00` cell reads `1,234.50`.

## Editing semantics

A created document has a source. `edit_document` with `edits` or `content` changes the source and
rebuilds the file — cheap for the model and always consistent. Using `ops` on a created document edits
the binary and clears the stored source, because a later rebuild would undo those operations.

An imported document has no source. It is only editable through `ops`. `read_document` first is the
reliable path: paragraph indices for DOCX, sheet/cell addresses for XLSX, page numbers and field names
for PDF.

## Visual self-check

`view_artifact(id, page?, sheet?)` gives the model its own eyes. It renders the current version in the
browser worker's Chromium and returns a PNG:

- HTML, React, and SVG: the artifact document from `src/shared/artifact-frame.ts`, so the screenshot is
  the same DOM the panel shows. HTML and React still need the public CDNs (Babel, esm.sh, Tailwind); only those
  hosts are allowed, through the worker's egress proxy, and everything else is aborted. SVG renders offline. Tall pages are clipped to 1800 CSS pixels.
- PDF: `pdfjs-dist` is served into the page from the worker's `node_modules` and draws the requested page to a
  canvas; the canvas is captured at 1000 px wide. This is exact, including form fields and embedded
  fonts. Pages are addressed with `page`, default 1.
- DOCX: `docx-preview` and `jszip` are served into the page, the file renders into Word-like pages, and
  the requested `section.docx` is captured. This uses docx-preview's layout, which is close to Word but
  not identical.
- XLSX: the same `SheetPreview` JSON the web grid uses becomes a styled table, captured at its content
  size. `sheet` picks a sheet; the first 60 rows and 20 columns are shown.

Screenshots are not placed inside the tool result. OpenAI-compatible chat APIs serialize tool content,
so the result stays text and the image is appended once as a synthetic user message by `prepareStep`
(`src/server/tools/screenshots.ts`). That shape works for every vision provider, and the persisted
history stays text-only, so later turns do not resend images. A reply may spend six screenshots; the
model is told the image follows and that it is not repeated. Page JavaScript errors and console errors
come back in the tool text even for a model that cannot see images.

Non-vision models do not get the tool. Without a browser worker (`OKAYCHAT_BROWSER_URL`), the tool is absent and
the text tools keep working. Blocked requests (a missing image, a non-CDN script) come back in `pageErrors` with
the reason.

Run outputs: `import_document` accepts a run_code output's `fileId`; PPTX/PPT/ODP become PDF through LibreOffice in
the sandbox (`docs/research/code-sandbox.md`), so the same page shots work for slides.

## Chromium lifecycle and isolation

Chromium runs only in the browser worker container (`src/browser/render.ts`); the app calls it through
`documents/render.ts` and `src/server/browser.ts`. Lifecycle, timeouts, the offline/cdn modes, the egress
firewall, and `--no-sandbox` are in `docs/research/browser-worker.md`. In short:

- In the container each render runs in a fresh slot process and Chromium, then exits (two concurrent slots by default).
  The local dev worker shares Chromium across fresh contexts and closes it after 60 s idle.
- Every request except the document and its staged files is aborted (cdn mode adds `FRAME_NETWORK_HOSTS`).
  Model-written HTML cannot reach the LAN, cloud metadata, the app, or `file://`. Images must be data URIs;
  fonts come from the worker's system fonts.
- WebSockets refused, service workers blocked, WebRTC and WebTransport removed, DNS limited to the CDNs.
- A timed-out or abandoned job has its context closed before its slot is released; a wedged browser is killed.
- DOCX and XLSX are measured with `assertZipBounds` (`documents/zip-bounds.ts`) before mammoth, exceljs, or
  fflate opens them: at most 200 MB expanded and 10,000 entries, checked against both the central
  directory and a streaming count, so neither overlapping entries nor understated headers get through.

Without a worker, PDF creation reports that rendering is unavailable while DOCX, XLSX, and all reading/editing
keep working. In dev, `npm run dev` starts a local worker that uses Playwright's browser cache.

## Web previews

Previews run in the user's browser and need nothing extra on the server:

- PDF: the browser's own viewer in an iframe.
- DOCX: `docx-preview`, lazy-loaded, renders pages into a DOM.
- XLSX: a React grid built from `SheetPreview`.

The public share page uses the same component with the public artifact routes.

## Weight

| Package | Purpose |
| --- | --- |
| `playwright-core` | Drives Chromium in the browser worker. 14 MB, no dependencies, downloads nothing. The app no longer loads it. |
| `docx` | Creates Word documents. |
| `exceljs` | Reads and writes workbooks. |
| `@cantoo/pdf-lib` | Maintained `pdf-lib` fork, used for PDF structure and forms. |
| `fflate` | Unzip/rezip DOCX packages without a full zip library. |
| `@xmldom/xmldom` | Serializes OOXML faithfully (namespaces, `xml:space`). |
| `docx-preview` | Browser-side Word rendering, lazy chunk. |
| `fast-formula-parser` | Formula evaluation, small and dependency-free. |
| `pdfjs-dist` | Renders PDF pages to canvases for the visual check; served locally, never bundled into the web app. |

`pdfmake` was evaluated and rejected: it needs its own declarative layout dialect and models write better
HTML/CSS. `pdfjs-dist` was removed after the preview settled on the browser viewer.

## Known gaps

- DOCX created from HTML cannot use arbitrary CSS layout (flex, grid, absolute positioning). Word has no
  CSS model; the converter covers documents, not magazine layouts.
- An imported DOCX's pages are not re-laid-out: inserting a paragraph can push content across a page
  differently than `read_document` suggests, but nothing is lost.
- DOCX screenshots come from docx-preview, not Word, so exotic fields, text boxes, and SmartArt can look
  different from the file the user opens.
- The visual check costs image tokens. It is offered per page/sheet, capped per reply, and never sent
  again in later turns.
- Liberation fonts cover Latin, Greek, and Cyrillic. CJK falls back to whatever the system provides in
  DOCX and PDF output.
- Formula evaluation is approximate for functions outside the supported set; the cached value may be
  missing until Excel recalculates.
