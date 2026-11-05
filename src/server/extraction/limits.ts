// Extraction bounds shared by chat attachments, knowledge sources, and project files.
// docs/implementation/extraction.md

/** UTF-16 code units kept from one file. */
export const MAX_EXTRACTED_CHARS = 400_000;
export const MAX_PDF_PAGES = 1_000;
export const MAX_SLIDES = 300;
export const MAX_EPUB_DOCUMENTS = 500;
/** One selected ZIP entry. The shared 200 MB archive bound alone would allow a single 199 MB XML part. */
export const MAX_XML_PART_BYTES = 32 * 1024 * 1024;
/**
 * Tags and attributes (`<` and `=`) in one XML part parsed into a DOM. xmldom holds 1–2 KB per node, so the byte
 * cap alone would let a 90 KB PPTX build a 3.6 GB tree; this bounds one part to a few hundred MB.
 */
export const MAX_XML_MARKUP = 300_000;
/** All selected ZIP entries of one file together. */
export const MAX_SELECTED_BYTES = 64 * 1024 * 1024;
/** Checked between parts; one synchronous parse is not preempted. */
export const EXTRACT_BUDGET_MS = 20_000;
/** Detection inflates at most this much container metadata. */
export const MAX_METADATA_BYTES = 1024 * 1024;
export const MAX_OCR_BYTES = 25 * 1024 * 1024;
export const MAX_OCR_TEXT_CHARS = MAX_EXTRACTED_CHARS;
/** Runner execution limit; the app's HTTP deadline adds 30 s for transport and the slot wait. */
export const OCR_TIMEOUT_MS = 120_000;
