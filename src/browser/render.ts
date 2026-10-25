import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { FRAME_NETWORK_HOSTS } from "../shared/artifact-frame.js";
import { config } from "./config.js";
import { localEgressProxy } from "./egress-proxy.js";

// Chromium renders PDFs and screenshots for the app's documents and the model's visual check. It starts on the
// first job, jobs share one process with a fresh context each, and it closes after a short idle period. See
// docs/implementation/browser-worker.md.
//
// Two network modes, chosen per job:
// - offline (PDFs, Office and PDF previews, SVG, sheets): the page sees only the document and the files the job
//   staged; every other request is aborted.
// - cdn (HTML and React previews): additionally the artifact CDNs, reached only through the egress proxy.

const IDLE_MS = 60_000;
const CLOSE_GRACE_MS = 5_000;
const DOC_ORIGIN = "http://document.local";

let browser: Browser | null = null;
let launching: Promise<Browser> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
/** Jobs currently holding a slot, and jobs waiting for one. */
let running = 0;
const waiting: Array<() => void> = [];

const require = createRequire(import.meta.url);
let playwright: typeof import("playwright-core") | undefined;
const chromium = () => (playwright ??= require("playwright-core") as typeof import("playwright-core")).chromium;

export class JobError extends Error {
  constructor(
    message: string,
    readonly status = 422,
  ) {
    super(message);
  }
}

export function executablePath(): string | undefined {
  if (config.chromiumPath) return config.chromiumPath;
  try {
    const bundled = chromium().executablePath();
    return existsSync(bundled) ? bundled : undefined;
  } catch {
    return undefined;
  }
}

async function launch(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  if (launching) return launching;
  const executable = executablePath();
  if (!executable) throw new JobError("Chromium is not installed in the browser worker.", 503);
  clearIdle();
  const proxy = config.egressProxy || (await localEgressProxy());
  launching = chromium()
    .launch({
      headless: true,
      executablePath: executable,
      // CDN requests leave only through the egress proxy. Offline jobs abort every request before it gets there.
      proxy: { server: proxy, bypass: "<-loopback>" },
      // --no-sandbox: Chromium's sandbox needs user namespaces, which the container's seccomp and AppArmor
      // profiles do not grant. Compensating controls: its own uid, no capabilities, no secrets in reach, and a
      // firewall that lets it reach only the egress proxy. See docs/implementation/browser-worker.md.
      args: [
        "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-first-run", "--disable-extensions",
        // Route handlers never see DNS prefetch, preconnect, or WebTransport, which could carry data out in a
        // hostname. Only the artifact CDNs and the proxy's own address resolve; the document origin is served by
        // the route handler.
        `--host-resolver-rules=MAP * ~NOTFOUND, ${[...FRAME_NETWORK_HOSTS, new URL(proxy).hostname].map((host) => `EXCLUDE ${host}`).join(", ")}`,
        "--dns-prefetch-disable",
      ],
    })
    .then((b) => {
      browser = b;
      b.on("disconnected", () => {
        if (browser === b) browser = null;
      });
      return b;
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
    if (b) void b.close().catch(() => {});
  }, IDLE_MS);
  idleTimer.unref();
}

async function acquire(signal?: AbortSignal) {
  if (running >= config.maxJobs) {
    await new Promise<void>((resolve, reject) => {
      const turn = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", leave);
        resolve();
      };
      const leave = () => {
        clearTimeout(timer);
        const i = waiting.indexOf(turn);
        if (i >= 0) waiting.splice(i, 1);
        reject(signal?.aborted ? new JobError("Cancelled.", 499) : new JobError("The browser worker is busy; try again.", 503));
      };
      const timer = setTimeout(leave, config.queueMs);
      signal?.addEventListener("abort", leave, { once: true });
      waiting.push(turn);
    });
  }
  running++;
  clearIdle();
}

function release() {
  running--;
  const next = waiting.shift();
  if (next) next();
  else scheduleIdle();
}

/** Every process below this one whose command line names Chromium. */
function chromiumDescendants(): number[] {
  const parents = new Map<number, number>();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      parents.set(Number(entry), Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]));
    } catch {
      // Gone already.
    }
  }
  const mine = new Set([process.pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [pid, parent] of parents) {
      if (!mine.has(pid) && mine.has(parent)) {
        mine.add(pid);
        grew = true;
      }
    }
  }
  mine.delete(process.pid);
  return [...mine].filter((pid) => {
    try {
      return /chrom|headless/i.test(readFileSync(`/proc/${pid}/cmdline`, "utf8"));
    } catch {
      return false;
    }
  });
}

/** Last resort for a wedged browser: forget it and kill its processes, so the next job launches a new one. */
export async function killBrowser(b: Browser | null = browser) {
  if (browser === b) browser = null;
  await Promise.race([b?.close().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 2_000).unref())]);
  for (const pid of chromiumDescendants()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Exited between the scan and the kill.
    }
  }
}

/** Closes Chromium now. Used by tests and on shutdown. */
export async function closeRenderer() {
  clearIdle();
  const b = browser;
  browser = null;
  if (b) await b.close().catch(() => {});
}

export const renderStats = () => ({ running, waiting: waiting.length, browser: !!browser?.isConnected() });

/** One file served to the rendered page, on the fake document origin. */
export interface RenderResource {
  contentType: string;
  bytes?: Uint8Array;
  file?: string;
}

export interface RenderOptions {
  width?: number;
  height?: number;
  /** offline: only the document and staged files. cdn: also the artifact CDNs, through the egress proxy. */
  network?: "offline" | "cdn";
  /** Exact paths (for example `/file.pdf`) served from the document origin. */
  resources?: Record<string, RenderResource>;
  /** Path prefixes mapped to directories, for library assets such as pdf.js. */
  roots?: Record<string, string>;
  /** JS expression that must turn truthy before the page is considered ready. */
  waitFor?: string;
  waitTimeoutMs?: number;
}

export interface PageSession {
  page: Page;
  errors: string[];
}

const CONTENT_TYPES: Record<string, string> = {
  ".mjs": "text/javascript",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".bcmap": "application/octet-stream",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".pfb": "application/octet-stream",
  ".wasm": "application/wasm",
};

async function serveRoot(prefix: string, directory: string, pathname: string) {
  const relative = decodeURIComponent(pathname.slice(prefix.length));
  const file = path.resolve(directory, relative);
  // Never let a crafted path climb out of the directory we chose to expose.
  if (!file.startsWith(path.resolve(directory) + path.sep)) return null;
  try {
    return { bytes: new Uint8Array(await readFile(file)), contentType: CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream" };
  } catch {
    return null;
  }
}

/** Reported to the model, so a page that misses an asset says which one and why. */
function blockedNote(url: URL, network: "offline" | "cdn") {
  const where = url.origin === DOC_ORIGIN ? url.pathname : url.href.slice(0, 200);
  return network === "cdn"
    ? `Blocked request to ${where}: previews can load only from ${FRAME_NETWORK_HOSTS.join(", ")}.`
    : `Blocked request to ${where}: this render is offline; only the document itself and its staged files are available.`;
}

async function prepare(context: BrowserContext, html: string, options: RenderOptions, errors: string[]) {
  const network = options.network ?? "offline";
  const note = (message: string) => {
    if (errors.length < 20 && !errors.includes(message)) errors.push(message);
  };
  // context.route only sees HTTP. Without this, page script could open a WebSocket to any host.
  await context.routeWebSocket(() => true, (ws) => {
    note(`Blocked WebSocket to ${ws.url().slice(0, 200)}.`);
    void ws.close({ code: 1008, reason: "blocked" });
  });
  // WebRTC sends STUN over UDP, which no route handler sees. Headless Chromium ignores the policy flag,
  // so the APIs are removed from every frame before page script runs. The worker's firewall drops UDP too.
  await context.addInitScript(() => {
    for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCSessionDescription", "RTCIceCandidate", "WebTransport"]) {
      Object.defineProperty(window, name, { value: undefined, configurable: false, writable: false });
    }
  });
  await context.route("**/*", async (route) => {
    const parsed = new URL(route.request().url());
    if (parsed.origin !== DOC_ORIGIN) {
      if (network === "cdn" && parsed.protocol === "https:" && FRAME_NETWORK_HOSTS.includes(parsed.hostname)) return route.continue();
      note(blockedNote(parsed, network));
      return route.abort("blockedbyclient");
    }
    if (parsed.pathname === "/") {
      return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html });
    }
    const resource = options.resources?.[parsed.pathname];
    if (resource) {
      const bytes = resource.bytes ?? (resource.file ? new Uint8Array(await readFile(resource.file)) : undefined);
      return bytes ? route.fulfill({ status: 200, contentType: resource.contentType, body: Buffer.from(bytes) }) : route.abort("failed");
    }
    for (const [prefix, directory] of Object.entries(options.roots ?? {})) {
      if (!parsed.pathname.startsWith(prefix)) continue;
      const served = await serveRoot(prefix, directory, parsed.pathname);
      if (served) return route.fulfill({ status: 200, contentType: served.contentType, body: Buffer.from(served.bytes) });
    }
    note(blockedNote(parsed, network));
    return route.abort("blockedbyclient");
  });
}

/**
 * Serves one HTML document to a fresh browser context and hands the page to `fn`. A job that runs past the
 * timeout, or whose caller goes away, has its context closed at once; if Chromium does not let go within a few
 * seconds, the browser is killed. The slot is released only after that cleanup, so a hung page cannot leave
 * more jobs running than the limit.
 */
export async function withBrowserPage<T>(html: string, options: RenderOptions, fn: (session: PageSession) => Promise<T>, signal?: AbortSignal): Promise<T> {
  await acquire(signal);
  try {
    signal?.throwIfAborted();
    const b = await launch();
    const context = await b.newContext({
      javaScriptEnabled: true,
      bypassCSP: false,
      // A service worker's requests skip context.route.
      serviceWorkers: "block",
      acceptDownloads: false,
      viewport: { width: options.width ?? 1000, height: options.height ?? 800 },
    });
    let stopped: JobError | null = null;
    let onStop!: (error: JobError) => void;
    const stop = new Promise<never>((_, reject) => (onStop = reject));
    stop.catch(() => {});
    const halt = (error: JobError) => {
      if (stopped) return;
      stopped = error;
      onStop(error);
    };
    const timer = setTimeout(() => halt(new JobError("Rendering the page timed out.", 504)), config.jobTimeoutMs);
    const abort = () => halt(new JobError("Cancelled.", 499));
    signal?.addEventListener("abort", abort, { once: true });
    const errors: string[] = [];
    const job = (async () => {
      await prepare(context, html, options, errors);
      const page = await context.newPage();
      page.on("pageerror", (error) => {
        if (errors.length < 20) errors.push(error.message);
      });
      page.on("console", (message) => {
        // Chromium logs every aborted request again; the blocked-request note already says which and why.
        if (message.type() === "error" && errors.length < 20 && !message.text().includes("net::ERR_BLOCKED_BY_CLIENT")) errors.push(message.text());
      });
      await page.goto(`${DOC_ORIGIN}/`, { waitUntil: "load", timeout: config.jobTimeoutMs });
      if (options.network === "cdn") {
        // React artifacts import from CDNs after load. Give the chain a moment to settle.
        await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      }
      if (options.waitFor) {
        await page.waitForFunction(options.waitFor, undefined, { timeout: options.waitTimeoutMs ?? 15_000 }).catch(() => {
          errors.push("The page did not finish rendering in time.");
        });
      }
      // Fonts and layout settle together; two frames is enough and avoids waiting on network idleness.
      await page
        .evaluate(async () => {
          await (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready;
          await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        })
        .catch(() => {});
      return await fn({ page, errors });
    })();
    job.catch(() => {});
    try {
      return await Promise.race([job, stop]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      // Closing the context ends the page's work. A browser that does not close it in time is wedged.
      const closed = await Promise.race([
        context.close().then(() => true, () => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), CLOSE_GRACE_MS).unref()),
      ]);
      if (!closed) await killBrowser(b);
      // The job settles once its context is gone; wait for it so nothing still touches the page.
      await Promise.race([job.then(() => {}, () => {}), new Promise((resolve) => setTimeout(resolve, CLOSE_GRACE_MS).unref())]);
    }
  } finally {
    release();
  }
}

export interface ScreenshotOptions extends RenderOptions {
  /** Stop capturing after this many CSS pixels of page height. */
  maxHeight?: number;
  /** Measure and crop to this element instead of the body. */
  contentSelector?: string;
}

export interface ScreenshotResult {
  png: Uint8Array;
  width: number;
  height: number;
  errors: string[];
}

/** A full-page PNG of an HTML document, clipped to keep the image a reasonable size for a model. */
export async function screenshotHtml(html: string, options: ScreenshotOptions = {}, signal?: AbortSignal): Promise<ScreenshotResult> {
  return withBrowserPage(html, options, async ({ page, errors }) => {
    const viewportWidth = options.width ?? 1000;
    const content = await page.evaluate((selector) => {
      const target = selector ? document.querySelector(selector) : null;
      if (target) {
        const rect = target.getBoundingClientRect();
        return { right: rect.right, bottom: rect.bottom };
      }
      let right = 0;
      let bottom = 0;
      for (const element of document.body.querySelectorAll("*")) {
        const rect = element.getBoundingClientRect();
        if (rect.width || rect.height) {
          right = Math.max(right, rect.right);
          bottom = Math.max(bottom, rect.bottom);
        }
        if (right > 5000 || bottom > 20000) break;
      }
      const body = document.body.getBoundingClientRect();
      return { right: Math.max(right, body.right), bottom: Math.max(bottom, body.bottom) };
    }, options.contentSelector ?? null);
    // Crop to the content, so a small card or table does not spend tokens on empty canvas.
    const width = Math.max(120, Math.min(viewportWidth, Math.ceil(content.right) + 1));
    const height = Math.max(1, Math.ceil(Math.min(content.bottom, options.maxHeight ?? 1800)) + 1);
    const png = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width, height } });
    return { png: new Uint8Array(png), width, height, errors };
  }, signal);
}

export interface PdfOptions {
  /** Page size such as `A4`, `Letter`. */
  format?: string;
  landscape?: boolean;
  margin?: { top?: string; right?: string; bottom?: string; left?: string };
  printBackground?: boolean;
  /** Chrome page-furniture templates. Use `.pageNumber` / `.totalPages` spans for live page numbers. */
  headerTemplate?: string;
  footerTemplate?: string;
}

/** Turns HTML into a vector PDF with selectable text. Always offline. */
export async function htmlToPdf(html: string, options: PdfOptions = {}, signal?: AbortSignal): Promise<Uint8Array> {
  return withBrowserPage(html, { network: "offline" }, async ({ page }) => {
    const pdf = await page.pdf({
      format: options.format ?? "A4",
      landscape: options.landscape ?? false,
      margin: options.margin ?? { top: "18mm", right: "18mm", bottom: "18mm", left: "18mm" },
      printBackground: options.printBackground ?? true,
      displayHeaderFooter: !!options.headerTemplate || !!options.footerTemplate,
      headerTemplate: options.headerTemplate,
      footerTemplate: options.footerTemplate,
      preferCSSPageSize: true,
    });
    return new Uint8Array(pdf);
  }, signal);
}
