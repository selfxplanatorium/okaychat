// Extraction failures with fixed, user-safe messages. Anything else a parser throws is logged and replaced
// by a generic message at the boundary.

export type ExtractionErrorCode =
  | "unsupported"
  | "legacy_office"
  | "odf_unsupported"
  | "encrypted"
  | "damaged"
  | "too_large"
  | "not_readable"
  | "timeout";

export type ExtractLimit = "characters" | "pages" | "slides" | "documents";

export class ExtractionError extends Error {
  constructor(readonly code: ExtractionErrorCode, message: string) {
    super(message);
    this.name = "ExtractionError";
  }
}

export const NOT_READABLE = "This file does not contain readable text.";
export const TIMEOUT = "Reading this file took too long. Split it into smaller files.";
export const TOO_LARGE_PART = "A part of this file is too large to read. Split it into smaller files.";

/** A decoded binary usually has NULs or a high replacement-character rate; FTS also stops at a NUL. */
export function assertReadableText(text: string): void {
  const sample = text.slice(0, 20_000);
  if (sample.includes("\u0000") || (sample.match(/�/g)?.length ?? 0) > sample.length * 0.02) {
    throw new ExtractionError("not_readable", NOT_READABLE);
  }
}

/** Appended to a chat attachment that was cut. */
export function truncationMarker(limit: ExtractLimit): string {
  switch (limit) {
    case "characters":
      return "[truncated: the first 400,000 characters were kept]";
    case "pages":
      return "[truncated: only the first 1,000 pages were read]";
    case "slides":
      return "[truncated: only the first 300 slides were read]";
    case "documents":
      return "[truncated: only the first 500 book sections were read]";
  }
}

/** A knowledge source is never indexed partially, so a cut file fails with the limit it hit. */
export function limitMessage(limit: ExtractLimit | undefined): string {
  switch (limit) {
    case "pages":
      return "This PDF has more than 1,000 pages. Split it into smaller files and add them separately.";
    case "slides":
      return "This presentation has more than 300 slides. Split it into smaller files and add them separately.";
    case "documents":
      return "This book has more than 500 sections. Split it into smaller files and add them separately.";
    default:
      return "This file has more than 400,000 characters of text. Split it into smaller files and add them separately.";
  }
}
