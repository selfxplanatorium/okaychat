# Document extraction and knowledge OCR

One extraction path, `extract(name, type, data, options)` in `src/server/extraction/index.ts`, serves chat
attachments (`POST /files/extract`), project files, knowledge uploads, and knowledge URL PDFs. `files.ts`
re-exports `extract` and `MAX_CHARS`. Knowledge ingestion adds OCR for images and scanned PDFs through the code
sandbox (`src/server/ocr.ts`). Separate from `read_document` and artifact editing (`documents.md`).

## Formats

| Format | Result |
| --- | --- |
| PDF with a text layer | Text with `--- page N ---` markers, first 1,000 pages |
| PDF without a text layer | The sentinel below with `needsOcr: "pdf"`; knowledge OCRs it, chat keeps the sentinel |
| DOCX | mammoth raw text |
| XLSX / XLSM | exceljs cell tables (`documents/xlsx.ts` `readXlsx`) |
| PPTX / PPSX (and macro/template variants) | `## Slide n` per slide in presentation order, DrawingML paragraph text, `### Notes` with speaker notes; slide number, date, footer, header, and the notes page's slide image placeholders are skipped |
| EPUB (non-DRM) | Spine XHTML in reading order (including `linear="no"`), each chapter through `htmlToText`, `## <title>` when a chapter has a title and no heading |
| HTML / HTM / XHTML file | Markdown via linkedom + turndown: no script/style/noscript/iframe/svg/form, links keep only their text, images only their alt, `# <title>` when there is no heading. A fragment without `<html>` is wrapped in a document first. Chat still attaches `.html` as code |
| ODT | `office:text` walk: `#` headings by outline level, paragraphs, `- ` list items (nested indented), table cells joined by a pipe, `text:s`/tab/line-break, footnotes inline, comments skipped |
| Raster/HEIF images | `needsOcr: "image"`, empty text. Chat: 422 pointing to the vision path or knowledge |
| Text, CSV, JSON, Markdown, code | UTF-8, BOM stripped, binary check |
| Legacy `.doc/.xls/.ppt` (OLE), ODS/ODP, RTF, SVG, unknown ZIP, unknown binary | `ExtractionError` with an actionable message, never decoded as text |

Audio/video in knowledge, URL-served Office/EPUB/ODT files, chart/SmartArt/alt text, NCX/nav-only EPUB content,
and AVIF OCR are not read (deferrals below).

## Detection

`detect.ts` is content-first and synchronous; the name and declared type only break ties for text:

1. OLE magic → `legacy_office`. 2. `%PDF-` → pdf. 3. ZIP magic → container: `mimetype` (EPUB, ODT; ODS/ODP →
`odf_unsupported`), then each `ContentType` value in `[Content_Types].xml` (word/spreadsheet/presentation
`…main+xml`), then the fixed main part names (`word/document.xml`, `xl/workbook.xml`, `ppt/presentation.xml`) for
macro and template variants; anything else is an unsupported ZIP. 4. `{\rtf` → unsupported. 5. HTML by type,
extension, or a leading `<!doctype html`/`<html`, only for bytes without a NUL in the first 8 KiB. 6. Image magic
(chat rasters, BMP with its reserved header bytes at zero so text starting with "BM" stays text, TIFF, HEIF brands), or an image type/name on bytes that are not text: a `.png` holding text is
text. 7. SVG → unsupported. 8. A NUL in the first 8 KiB → unsupported. 9. Text.

A supported document is read under any name; the stored name never changes and no mismatch is recorded.
Detection reads at most the `mimetype` entry (256 B) and `[Content_Types].xml` (1 MiB), and refuses a directory
over 10,000 entries.

## Bounds

`limits.ts`: 400,000 UTF-16 code units (cut only outside a surrogate pair), 1,000 PDF pages, 300 slides, 500 EPUB
documents, 32 MiB per selected ZIP entry and 64 MiB for all selected entries (on top of
`documents/zip-bounds.ts`: 200 MiB expanded, 10,000 entries, checked once by every ZIP extractor), a 20 s budget
checked before each page/slide/chapter (it does not preempt one synchronous parse; the size caps bound that),
25 MiB OCR input, 120 s runner OCR time with a 150 s app deadline. fflate inflates each selected entry into a
buffer of its declared size, so an understated header cannot grow memory past the declared caps; a stored entry is
copied at its compressed size instead, so the per-entry and total caps count the larger of the two (overlapping
directory entries could otherwise each copy the whole file). Each XML part parsed into an xmldom tree may hold at
most 300,000 `<` and `=` (tags and attributes, about 1–2 KB of memory each), checked before parsing. ODT `text:s`
adds at most 400,000 spaces per document. HTML is converted in batches of about 64 KiB of markup, each wrapped in
its ancestors (a split `<ol>` keeps its numbering through `start`), because turndown's output join is quadratic in
one element's size; conversion checks the budget before each batch and stops once the text passes the character
cap. Parsing one 25 MiB HTML file still takes several seconds. The first limit
reached sets `truncated` and `limit` (`characters`, `pages`, `slides`, `documents`). `/files/extract` appends a
fixed marker (`[truncated: the first 400,000 characters were kept]` and the page/slide/section variants); a
knowledge source or URL refuses a truncated extraction instead of indexing part of a file.

Progress is `done/total` per part, monotonic, `0` first and `1` last. An abort signal is checked between parts.

## Errors

`ExtractionError(code, message)` with codes `unsupported`, `legacy_office`, `odf_unsupported`, `encrypted`,
`damaged`, `too_large`, `not_readable`, `timeout`. Messages are constants and safe to show; any other parser error
is logged with `redactSecrets` and replaced by a generic message. `/files/extract` maps `ExtractionError` to 422,
`ArchiveTooLargeError`/`HTTPException` to its status, and stores the upload only after a successful extraction.
Project files refuse `needsOcr` and blank text with 422 and store nothing. An EPUB whose `encryption.xml` lists
anything except IDPF/Adobe font obfuscation is `encrypted`; an ODT manifest with `encryption-data` too.

Scanned-PDF sentinel:

```
[This PDF has no text layer. It is probably scanned images. Add it to a knowledge collection where OCR can read it, or provide a text version.]
```

## OCR

`ocrExtract({userId, sourceId, kind, data, signal})` calls the runner's `POST /workspaces/:ws/ocr?job=`
(`code-sandbox.md`) with the raw bytes. The workspace is `sha256("ocr:" + user + ":" + source)`, so sources OCR in
parallel up to the runner's slots; it is deleted after every call, and an abort first sends the job's cancel.
The answer is read with a 4 MiB cap. Errors become `OcrUnavailableError` (sandbox not configured; or
`service_unavailable` from the registry, a transport failure, or a runner 503) or `OcrFailedError` (429 busy, any
other runner refusal; stderr is logged, never shown). OCR is attempted only when `sandboxConfigured()`; it never
consults the account's `code` feature, because no model code runs.

`knowledgeCapabilities()` (`GET /knowledge/capabilities`) returns `not_configured` without probing, else
`ok`/`unavailable` from `serviceStatus("sandbox")` (`up`/`degraded` count as available). The knowledge page shows
a notice for the two unavailable states.

Chat never OCRs: a send must not wait up to two minutes, and vision models read images directly. Chat images stay
on the vision path; a scanned PDF attachment keeps the sentinel.

OCR text is third-party content on the same knowledge text/chunk path as any source, enveloped at delivery; it
adds no prompt ingress.

## Knowledge pipeline

`knowledge/jobs.ts` `extractSource`: stored text is reused with its `extraction` label (pasted text stays null);
otherwise the original is extracted, a truncated result fails with the limit message, and `needsOcr` calls the OCR
seam (`setOcrExtractorForTests`). Messages (tests match `/OCR/`):

- Image, not configured: "This image needs OCR. OCR requires the code sandbox, which this server has not configured. Add a text version, or ask an admin to enable the sandbox."
- Image, unreachable: "This image needs OCR. The code sandbox is not reachable right now. Add a text version, or try again when it is back."
- PDF, not configured: "This PDF has no text layer. Reading it needs OCR, which requires the code sandbox. It is not configured on this server. Add a text version, or ask an admin to enable the sandbox."
- PDF, unreachable: "This PDF has no text layer. Reading it needs OCR, but the code sandbox is not reachable right now. Add a text version, or try again when it is back."
- Engine failure: "OCR could not read this file. Try a clearer image or a text version."; busy: "The code sandbox is busy. Try again in a moment."
- Empty result: "OCR did not find any text in this file."

`setSourceText` writes `text`, `text_bytes`, and `extraction` in the transaction that asserts the quota growth.
`knowledge_sources.extraction` (`text`/`ocr`, nullable) is the one schema change, an appended `ALTER TABLE`.

Reindex and Retry keep stored text and never OCR it again; only a source without text extracts, which is how a
failed OCR source recovers once the sandbox is back. A malformed, encrypted, oversized, zip-bombed, unsupported,
quota-refused, or OCR-failed source keeps its original upload (still charged and visible); deleting the source or
collection releases the upload, an unreferenced media original, text, chunks, and vectors. Cancel aborts
extraction between parts and the OCR request (runner cancel plus workspace delete); the generation guard ignores
late writes. Progress and statuses are in `knowledge.md`.

## At rest

Originals and extracted text stay plaintext in SQLite and the media store, as for every upload. Encrypting only
new knowledge sources would create a second storage format, break preview and reindex, and still not protect a
server that holds `OKAYCHAT_SECRET`.

## Tests

- `extraction/formats.test.ts`: local PPTX/PPSX/EPUB/HTML/ODT/DOCX/XLSX/PDF/text fixtures (fflate, pdf-lib, the
  document creators), detection under wrong names, refused formats, the sentinel, image results, truncation.
- `extraction/bounds.test.ts`: 210 MiB entries, a 70 MiB selected part, overlapping stored entries, a 10,001-entry
  ZIP, a dense slide, the XML markup cap, ODT space expansion, malformed parts, the time budget, and aborts.
- `ocr.test.ts`: not configured, service down, the request/cleanup sequence, abort, 429/422, oversized answers,
  and capabilities.
- `knowledge/knowledge.test.ts`: uploads of each format to `ready`, OCR through a fake extractor, failures that
  keep originals, retry/reindex, quota, capabilities, and `/files/extract` status mapping.
- `sandbox-flow.itest.ts` (real containers, `test/integration/run.sh`): a Pillow PNG and an image-only PDF read
  through `/ocr`, twice for one source.

## Deferrals

- OCR in chat, for images and scanned PDFs.
- OCR languages beyond the image's `eng` and `ita`, a language picker, confidence or word boxes, handwriting,
  layout reconstruction. AVIF OCR (the image's Pillow cannot decode it).
- Image-only decks, chart/SmartArt/diagram/alt text, embedded objects; EPUB DRM, NCX/nav-only content, remote
  resources, `xml:base`, non-spine content.
- Legacy Office, ODP/ODS, RTF, Pages/Keynote/Numbers, `.xls`/`.ods` spreadsheets.
- Audio/video transcription in knowledge; URL-served Office/EPUB/ODT files.
- At-rest encryption of originals or extracted text; a user-facing re-extract action.
