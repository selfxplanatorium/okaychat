import { browserConfigured, browserJob } from "../browser.js";

// Scrapling, web_fetch's fallback for blocked or JavaScript-heavy pages, runs in the browser worker
// (src/browser/scrapling.ts), where its connections can only leave through the egress proxy. See
// docs/research/scrapling.md and docs/research/browser-worker.md.

/** Fetch a page Node's fetch could not read: TLS-impersonated HTTP first, then a stealth browser if installed. */
export async function scraplingFetch(url: string, signal?: AbortSignal): Promise<{ title: string; content: string } | null> {
  if (!browserConfigured()) return null;
  try {
    const page = await browserJob<{ title: string | null; content?: string }>("/v1/fetch", { url }, 180_000, signal);
    return page.title !== null && page.content ? { title: page.title, content: page.content } : null;
  } catch {
    return null;
  }
}
