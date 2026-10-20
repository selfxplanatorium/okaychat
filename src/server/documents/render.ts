import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";

// Chromium renders PDFs from HTML. It is never started at boot: the first job launches it, jobs share
// one process, and it closes after a short idle period so an unused server holds no browser memory.
// See docs/research/documents.md.

const IDLE_MS = 60_000;
const JOB_TIMEOUT_MS = 25_000;
const MAX_JOBS = 2;

let browser: Browser | null = null;
let launching: Promise<Browser> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
/** Jobs currently holding a slot, and jobs waiting for one. */
let running = 0;
const waiting: Array<() => void> = [];

function executablePath(): string | undefined {
  const configured = process.env.OKAYCHAT_CHROMIUM_PATH;
  if (configured) return configured;
  try {
    const path = chromium.executablePath();
    return existsSync(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

export function rendererAvailable(): boolean {
  return !!executablePath();
}

async function launch(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  if (launching) return launching;
  const path = executablePath();
  if (!path) {
    throw new Error(
      "Chromium is not installed, so PDF rendering is unavailable. Set OKAYCHAT_CHROMIUM_PATH, or install Playwright's Chromium (see docs/research/documents.md).",
    );
  }
  clearIdle();
  launching = chromium
    .launch({
      headless: true,
      executablePath: path,
      // --no-sandbox is required when the container runs as root. The pages themselves are isolated:
      // every request except the injected document is aborted below.
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-first-run", "--disable-extensions"],
    })
    .then((b) => {
      browser = b;
      b.on("disconnected", () => {
        if (browser === b) browser = null;
        launching = null;
      });
      return b;
    })
    .catch((error) => {
      launching = null;
      browser = null;
      throw error;
    })
    .finally(() => {
      launching = null;
    });
  return launching;
}

function clearIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

function scheduleIdle() {
  clearIdle();
  if (running > 0) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    const b = browser;
    browser = null;
    launching = null;
    if (b) void b.close().catch(() => {});
  }, IDLE_MS);
  // An idle browser must not keep the process alive.
  idleTimer.unref();
}

async function acquire() {
  if (running >= MAX_JOBS) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  clearIdle();
}

function release() {
  running--;
  const next = waiting.shift();
  if (next) next();
  else scheduleIdle();
}

/** Closes Chromium now. Used by tests and on shutdown. */
export async function closeRenderer() {
  clearIdle();
  const b = browser;
  browser = null;
  launching = null;
  if (b) await b.close().catch(() => {});
}

/**
 * Serves one HTML document to a fresh browser context and hands the page to `fn`. Every request other
 * than the document itself is aborted, so model-written HTML cannot reach the network, the LAN, cloud
 * metadata endpoints, or `file://`. Images must be data URIs; fonts come from the system.
 */
async function withPage<T>(html: string, fn: (page: Page) => Promise<T>): Promise<T> {
  const b = await launch();
  const job = (async () => {
    const context = await b.newContext({ javaScriptEnabled: true, bypassCSP: false, offline: false });
    try {
      await context.route("**/*", (route) => {
        const url = route.request().url();
        if (url === "http://document.local/") return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html });
        return route.abort("blockedbyclient");
      });
      const page = await context.newPage();
      await page.goto("http://document.local/", { waitUntil: "load", timeout: JOB_TIMEOUT_MS });
      // Fonts and layout settle together; two frames is enough and avoids waiting on network idleness.
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      return await fn(page);
    } finally {
      // Also runs when the timeout below wins the race while the page is still working.
      await context.close().catch(() => {});
    }
  })();
  const timer = new Promise<never>((_, reject) => {
    const t = setTimeout(() => reject(new Error("Rendering the document timed out.")), JOB_TIMEOUT_MS);
    t.unref();
    job.then(
      () => clearTimeout(t),
      () => clearTimeout(t),
    );
  });
  try {
    return await Promise.race([job, timer]);
  } finally {
    // A late rejection from a timed-out job must not surface as unhandled.
    job.catch(() => {});
  }
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

export interface PdfOptions {
  /** Page size such as `A4`, `Letter`, or `{ width, height }` in CSS pixels. */
  format?: string;
  landscape?: boolean;
  /** CSS pixels, or Playwright's `{ top, right, bottom, left }`. */
  margin?: { top?: string; right?: string; bottom?: string; left?: string };
  printBackground?: boolean;
  /** Chrome page-furniture templates. Use `.pageNumber` / `.totalPages` spans for live page numbers. */
  headerTemplate?: string;
  footerTemplate?: string;
}

/** Turns HTML into a vector PDF with selectable text. */
export async function htmlToPdf(html: string, options: PdfOptions = {}): Promise<Uint8Array> {
  await acquire();
  try {
    const pdf = await withPage(html, (page) =>
      page.pdf({
        format: options.format ?? "A4",
        landscape: options.landscape ?? false,
        margin: options.margin ?? { top: "18mm", right: "18mm", bottom: "18mm", left: "18mm" },
        printBackground: options.printBackground ?? true,
        displayHeaderFooter: !!options.headerTemplate || !!options.footerTemplate,
        headerTemplate: options.headerTemplate,
        footerTemplate: options.footerTemplate,
        preferCSSPageSize: true,
      }),
    );
    return new Uint8Array(pdf);
  } finally {
    release();
  }
}
