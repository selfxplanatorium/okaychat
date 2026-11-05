import { detectFormat, type DetectedFormat } from "./detect.js";
import { extractDocx } from "./docx.js";
import { extractEpub } from "./epub.js";
import { ExtractionError, NOT_READABLE, TIMEOUT, type ExtractLimit } from "./errors.js";
import { hasHeading, htmlToText } from "./html.js";
import { EXTRACT_BUDGET_MS, MAX_EXTRACTED_CHARS } from "./limits.js";
import { extractOdt } from "./odt.js";
import { extractPdf } from "./pdf.js";
import { extractPptx } from "./pptx.js";
import { decodeUtf8, extractPlainText } from "./text.js";
import { extractXlsx } from "./xlsx.js";

// The one extraction path for chat attachments, knowledge sources, and project files: content-based detection,
// bounded parsers, a time budget checked between parts, abort, progress, and one character cap.
// docs/implementation/extraction.md

export type ExtractFormat = DetectedFormat;
export type { ExtractLimit } from "./errors.js";
export { ExtractionError, limitMessage, truncationMarker } from "./errors.js";
export { PDF_NO_TEXT_LAYER } from "./pdf.js";

export interface ExtractOptions {
  signal?: AbortSignal;
  /** Defaults to MAX_EXTRACTED_CHARS. The result never carries more than this many UTF-16 code units. */
  maxChars?: number;
  /** 0..1, monotonic, called at most once per part and throttled by the caller. */
  onProgress?: (fraction: number) => void;
  /** Test-only: replaces EXTRACT_BUDGET_MS. */
  budgetMs?: number;
}

export interface ExtractResult {
  text: string;
  pages?: number;
  format: ExtractFormat;
  /** The format needs OCR: a raster/HEIF image, or a PDF with no text layer. `text` is empty (image) or the sentinel (PDF). */
  needsOcr?: "image" | "pdf";
  truncated?: boolean;
  limit?: ExtractLimit;
}

/** What one format extractor returns before the shared cap. */
export interface PartResult {
  text: string;
  pages?: number;
  needsOcr?: "image" | "pdf";
  /** A part limit (pages, slides, documents) the extractor stopped at. */
  limit?: ExtractLimit;
}

export interface ExtractContext {
  signal?: AbortSignal;
  /** Throws on abort or when the time budget is spent. Called before each page, slide, or chapter. */
  check(): void;
  progress(done: number, total: number): void;
}

/** Keeps at most `max` code units without splitting a surrogate pair. */
export function capText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return { text: text.slice(0, end), truncated: true };
}

async function extractHtml(data: Uint8Array): Promise<PartResult> {
  const { text, title } = await htmlToText(decodeUtf8(data));
  return { text: title && !hasHeading(text) ? (text ? `# ${title}\n\n${text}` : `# ${title}`) : text };
}

export async function extract(name: string, type: string, data: Uint8Array, options: ExtractOptions = {}): Promise<ExtractResult> {
  const { signal } = options;
  signal?.throwIfAborted();
  const maxChars = options.maxChars ?? MAX_EXTRACTED_CHARS;
  const deadline = Date.now() + (options.budgetMs ?? EXTRACT_BUDGET_MS);
  let reported = -1;
  const report = (fraction: number) => {
    const value = Math.min(1, Math.max(0, fraction));
    if (value <= reported) return;
    reported = value;
    options.onProgress?.(value);
  };
  const ctx: ExtractContext = {
    signal,
    check() {
      signal?.throwIfAborted();
      if (Date.now() >= deadline) throw new ExtractionError("timeout", TIMEOUT);
    },
    progress: (done, total) => report(total > 0 ? done / total : 1),
  };
  const format = detectFormat(name, type, data);
  report(0);
  ctx.check();
  let part: PartResult;
  switch (format) {
    case "pdf":
      part = await extractPdf(data, ctx);
      break;
    case "docx":
      part = await extractDocx(data);
      break;
    case "xlsx":
      part = await extractXlsx(data);
      break;
    case "pptx":
      part = await extractPptx(data, ctx);
      break;
    case "epub":
      part = await extractEpub(data, ctx);
      break;
    case "odt":
      part = await extractOdt(data);
      break;
    case "html":
      part = await extractHtml(data);
      break;
    case "image":
      part = { text: "", needsOcr: "image" };
      break;
    case "text":
      part = { text: extractPlainText(data) };
      break;
  }
  signal?.throwIfAborted();
  if (part.text.includes("\u0000")) throw new ExtractionError("not_readable", NOT_READABLE);
  const capped = capText(part.text, maxChars);
  // The first limit reached wins: a part limit already describes why the text is incomplete.
  const limit = part.limit ?? (capped.truncated ? "characters" : undefined);
  report(1);
  return {
    text: capped.text,
    format,
    ...(part.pages !== undefined ? { pages: part.pages } : {}),
    ...(part.needsOcr ? { needsOcr: part.needsOcr } : {}),
    ...(limit ? { truncated: true, limit } : {}),
  };
}
