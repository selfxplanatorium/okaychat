import { sniffRaster } from "../media/sniff.js";
import { ExtractionError } from "./errors.js";
import { MAX_METADATA_BYTES } from "./limits.js";
import { readZipEntry, zipEntryNames } from "./zip.js";

// Content decides the parser; the file name and declared type only break ties for text. Users rename files and
// browsers send empty types, so a supported document is read under any name and an unknown binary fails visibly
// instead of being decoded as text. docs/implementation/extraction.md

export type DetectedFormat = "pdf" | "docx" | "xlsx" | "pptx" | "odt" | "epub" | "html" | "text" | "image";

const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const SNIFF_BYTES = 8 * 1024;

const startsWith = (data: Uint8Array, bytes: readonly number[]) => bytes.every((byte, i) => data[i] === byte);
const ascii = (data: Uint8Array, start: number, end: number) => Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("latin1", start, end);

/** No NUL in the first 8 KiB. */
export function looksText(data: Uint8Array): boolean {
  return !data.subarray(0, SNIFF_BYTES).includes(0);
}

function isZip(data: Uint8Array): boolean {
  return data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && ((data[2] === 3 && data[3] === 4) || (data[2] === 5 && data[3] === 6) || (data[2] === 7 && data[3] === 8));
}

/** Image signatures OCR can read beyond the chat rasters: BMP, TIFF, and HEIF brands. */
function imageMagic(data: Uint8Array): boolean {
  if (sniffRaster(data)) return true;
  // "BM" alone starts plenty of text ("BMW", "BMI"); a real header also has its four reserved bytes at zero.
  if (data.length >= 26 && data[0] === 0x42 && data[1] === 0x4d && data[6] === 0 && data[7] === 0 && data[8] === 0 && data[9] === 0) return true;
  if (startsWith(data, [0x49, 0x49, 0x2a, 0x00]) || startsWith(data, [0x4d, 0x4d, 0x00, 0x2a])) return true;
  return data.length >= 12 && ascii(data, 4, 8) === "ftyp" && /^(heic|heix|hevc|hevx|mif1|msf1)$/.test(ascii(data, 8, 12));
}

const RASTER_NAME = /\.(png|jpe?g|gif|webp|avif|bmp|tiff?|heic|heif)$/i;

function classifyZip(data: Uint8Array): DetectedFormat {
  const names = new Set(zipEntryNames(data));
  const mimetype = names.has("mimetype") ? new TextDecoder().decode(readZipEntry(data, "mimetype", 256) ?? new Uint8Array()).trim() : "";
  if (mimetype === "application/epub+zip") return "epub";
  if (mimetype === "application/vnd.oasis.opendocument.text") return "odt";
  if (mimetype === "application/vnd.oasis.opendocument.spreadsheet" || mimetype === "application/vnd.oasis.opendocument.presentation") {
    throw new ExtractionError("odf_unsupported", "Only OpenDocument text (.odt) is supported. Save spreadsheets as .xlsx and presentations as .pptx.");
  }
  const types = names.has("[Content_Types].xml") ? readZipEntry(data, "[Content_Types].xml", MAX_METADATA_BYTES) : undefined;
  if (types) {
    // Each ContentType value on its own, so one pattern cannot match across two declarations.
    const values = [...new TextDecoder().decode(types).matchAll(/ContentType\s*=\s*"([^"]*)"/gi)].map((match) => match[1]!.toLowerCase());
    if (values.some((value) => /wordprocessingml\.[^"]*main\+xml$/.test(value))) return "docx";
    if (values.some((value) => /spreadsheetml\.[^"]*main\+xml$/.test(value))) return "xlsx";
    if (values.some((value) => /presentationml\.[^"]*main\+xml$/.test(value))) return "pptx";
  }
  // Macro-enabled and template variants declare vendor types; their main part names are fixed.
  if (names.has("word/document.xml")) return "docx";
  if (names.has("xl/workbook.xml")) return "xlsx";
  if (names.has("ppt/presentation.xml")) return "pptx";
  throw new ExtractionError("unsupported", "This ZIP file is not a supported document. Add the original PDF, Office, OpenDocument, or EPUB file.");
}

/** Synchronous; inflates at most a few small metadata entries. Throws `ExtractionError` for refused formats. */
export function detectFormat(name: string, mime: string, data: Uint8Array): DetectedFormat {
  const type = mime.split(";")[0]!.trim().toLowerCase();
  if (startsWith(data, OLE)) {
    throw new ExtractionError("legacy_office", "This is a legacy Office file (.doc, .xls, or .ppt). Save it as .docx, .xlsx, or .pptx and add it again.");
  }
  if (data.length >= 5 && ascii(data, 0, 5) === "%PDF-") return "pdf";
  if (isZip(data)) return classifyZip(data);
  const text = looksText(data);
  const head = text ? new TextDecoder("utf-8", { fatal: false }).decode(data.subarray(0, 512)).replace(/^﻿/, "").trimStart().toLowerCase() : "";
  if (head.startsWith("{\\rtf")) throw new ExtractionError("unsupported", "RTF files are not supported. Save the document as .docx and add it again.");
  if (text && (type === "text/html" || type === "application/xhtml+xml" || /\.(html?|xhtml)$/i.test(name) || head.startsWith("<!doctype html") || head.startsWith("<html"))) {
    return "html";
  }
  if (imageMagic(data)) return "image";
  // A text file named like an image is text; an image name only identifies bytes that are not text.
  if (!text && ((type.startsWith("image/") && type !== "image/svg+xml") || RASTER_NAME.test(name))) return "image";
  if (type === "image/svg+xml" || /\.svg$/i.test(name)) {
    throw new ExtractionError("unsupported", "SVG images are not supported by text extraction. Export a PNG or JPEG.");
  }
  if (!text) throw new ExtractionError("unsupported", "This file is not a supported document or readable text.");
  return "text";
}
