// The browser worker's job API, shared by the worker (src/browser/server.ts) and the app's client
// (src/server/browser.ts). Types only: the app imports nothing from the worker at runtime.
//
// POST /v1/render  RenderJob -> RenderResult | { error, model? }
// POST /v1/fetch   { url } -> { title, content } | { title: null }
// GET  /health     -> Health (no token)
// Bytes travel as base64 inside JSON. Every request except /health carries `Authorization: Bearer <token>`.

export interface PdfJobOptions {
  format?: string;
  landscape?: boolean;
  margin?: { top?: string; right?: string; bottom?: string; left?: string };
  printBackground?: boolean;
  headerTemplate?: string;
  footerTemplate?: string;
}

export type RenderJob =
  /** HTML to a vector PDF. Always offline. */
  | { kind: "pdf"; html: string; pdf?: PdfJobOptions }
  /** A cropped PNG of an HTML page. `cdn` also lets the page load from the artifact CDNs. */
  | { kind: "screenshot"; html: string; network: "offline" | "cdn"; width?: number; maxHeight?: number; contentSelector?: string }
  /** One page of a PDF or Word file, rendered offline by pdf.js or docx-preview. */
  | { kind: "pdf-page" | "docx-page"; file: string; page: number };

export type RenderResult = { pdf: string } | { png: string; width: number; height: number; label?: string; errors: string[] };

export interface Health {
  ok: boolean;
  chromium: boolean;
  scrapling: boolean;
  /** True when the container firewall is in place; false in dev, where only application checks apply. */
  egressEnforced: boolean;
  running: number;
  waiting: number;
  /** dispatch role: render slots that can take a job now, out of `slots`. */
  slotsReady?: number;
  slots?: number;
}

/** Largest request body: a 50 MB file as base64 plus the job's fields. */
export const MAX_JOB_BYTES = 72 * 1024 * 1024;
/** Largest PDF a job may return. */
export const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
