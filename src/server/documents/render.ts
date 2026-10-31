import type { PdfJobOptions, RenderResult } from "../../browser/api.js";
import { browserConfigured, browserJob, browserToken } from "../browser.js";

// PDFs and screenshots are rendered by the browser worker (src/browser/), a separate container with Chromium and
// no app data or secrets. This module holds the print helpers and the calls into it. See
// docs/implementation/browser-worker.md.

/** How long the app waits for one job: the worker's own timeout plus time queued for a slot. */
const JOB_WAIT_MS = 90_000;

export function rendererAvailable(): boolean {
  return browserConfigured();
}

/** At boot: create the worker token so the worker can start accepting jobs. Never waits for the worker. */
export function probeRenderer() {
  if (!browserConfigured()) return;
  browserToken();
}

export interface ScreenshotOptions {
  width?: number;
  /** Stop capturing after this many CSS pixels of page height. */
  maxHeight?: number;
  /** Measure and crop to this element instead of the body. */
  contentSelector?: string;
  /** cdn lets HTML and React previews load from the artifact CDNs (through the worker's egress proxy). */
  network?: "offline" | "cdn";
}

export interface ScreenshotResult {
  png: Uint8Array;
  width: number;
  height: number;
  errors: string[];
}

const bytes = (value: string) => new Uint8Array(Buffer.from(value, "base64"));

/** A full-page PNG of an HTML document, clipped to keep the image a reasonable size for a model. */
export async function screenshotHtml(html: string, options: ScreenshotOptions = {}, signal?: AbortSignal): Promise<ScreenshotResult> {
  const result = await browserJob<Extract<RenderResult, { png: string }>>(
    "/v1/render",
    { kind: "screenshot", html, network: options.network ?? "offline", width: options.width, maxHeight: options.maxHeight, contentSelector: options.contentSelector },
    JOB_WAIT_MS,
    signal,
  );
  return { png: bytes(result.png), width: result.width, height: result.height, errors: result.errors };
}

/** One page of a built PDF or Word file, rendered offline in the worker. */
export async function screenshotPage(kind: "pdf" | "docx", file: Uint8Array, page: number, signal?: AbortSignal): Promise<ScreenshotResult & { label: string }> {
  const result = await browserJob<Extract<RenderResult, { png: string }>>(
    "/v1/render",
    { kind: kind === "pdf" ? "pdf-page" : "docx-page", file: Buffer.from(file).toString("base64"), page },
    JOB_WAIT_MS,
    signal,
  );
  return { png: bytes(result.png), width: result.width, height: result.height, label: result.label ?? `page ${page}`, errors: result.errors };
}

// Print defaults keep a document readable when the model writes only body markup. Later rules win, so
// anything the model sets explicitly overrides these.
export const PRINT_DEFAULTS = `@page{size:A4;margin:18mm}
body{font-family:"Liberation Sans",Arial,Helvetica,sans-serif;font-size:11pt;line-height:1.5;color:#1a1a1a;margin:0}
h1{font-size:22pt;margin:0 0 12pt}h2{font-size:16pt;margin:18pt 0 8pt}h3{font-size:13pt;margin:14pt 0 6pt}
p{margin:0 0 8pt}ul,ol{margin:0 0 8pt;padding-left:18pt}li{margin:0 0 3pt}
table{border-collapse:collapse;width:100%;margin:8pt 0}th,td{border:1px solid #c9ced6;padding:5pt 7pt;text-align:left;vertical-align:top}
th{background:#eef1f5;font-weight:600}blockquote{margin:8pt 0;padding:2pt 12pt;border-left:3px solid #c9ced6;color:#555}
code,pre{font-family:"Liberation Mono",ui-monospace,monospace;font-size:9.5pt}pre{background:#f5f6f8;padding:8pt;white-space:pre-wrap}
hr{border:0;border-top:1px solid #c9ced6;margin:14pt 0}img{max-width:100%}
header{font-size:9pt;color:#666}footer{font-size:9pt;color:#666}`;

/**
 * Chrome prints running furniture from its own templates, not from the document body. Pull <header> and
 * <footer> out of the HTML, turn {page}/{pages} into Chrome's live page counters, and let page.pdf repeat
 * them on every page.
 */
export function pageFurniture(html: string): { body: string; headerTemplate?: string; footerTemplate?: string } {
  const take = (tag: string) => {
    const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(html);
    return match?.[1];
  };
  const header = take("header");
  const footer = take("footer");
  const body = html.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "").replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "");
  const template = (content: string) =>
    `<div style="width:100%;padding:0 18mm;font-size:9px;color:#666;text-align:center">${content
      .replaceAll("{page}", '<span class="pageNumber"></span>')
      .replaceAll("{pages}", '<span class="totalPages"></span>')}</div>`;
  return { body, headerTemplate: header ? template(header) : undefined, footerTemplate: footer ? template(footer) : undefined };
}

export function printDocument(html: string): string {
  const style = `<style>${PRINT_DEFAULTS}</style>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + style);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${style}</head>`);
  return `<!doctype html><html><head><meta charset="utf-8">${style}</head><body>${html}</body></html>`;
}

export type PdfOptions = PdfJobOptions;

/** Turns HTML into a vector PDF with selectable text. The worker renders it offline. */
export async function htmlToPdf(html: string, options: PdfOptions = {}, signal?: AbortSignal): Promise<Uint8Array> {
  const result = await browserJob<Extract<RenderResult, { pdf: string }>>("/v1/render", { kind: "pdf", html, pdf: options }, JOB_WAIT_MS, signal);
  return bytes(result.pdf);
}
