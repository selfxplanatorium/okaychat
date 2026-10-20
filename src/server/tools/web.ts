import { Readability } from "@mozilla/readability";
import { tool, type ToolSet } from "ai";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { extractText, getDocumentProxy } from "unpdf";
import { z } from "zod";
import { DEFAULT_USER_SETTINGS } from "../../shared/types.js";
import { scraplingFetch } from "./scrapling.js";
import { SearchBudget } from "./search-budget.js";

// Free web access with no keys: SearXNG sidecar when configured, Brave's public HTML results otherwise.
// DuckDuckGo's HTML endpoints answer 202 (bot wall) from many servers and Bing serves junk to scrapers,
// so neither is used. See docs/research/web-search.md.

const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const SEARXNG_URL = process.env.OKAYCHAT_SEARXNG_URL?.replace(/\/$/, "");
const MAX_BYTES = 5 * 1024 * 1024;
const PAGE_CHARS = 40_000;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function searxng(query: string, limit: number): Promise<SearchResult[]> {
  const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json&safesearch=1`;
  const res = await fetch(url, { signal: AbortSignal.timeout(12_000), headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`SearXNG ${res.status}`);
  const body = (await res.json()) as { results?: Array<{ title: string; url: string; content?: string }> };
  return (body.results ?? []).slice(0, limit).map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? "" }));
}

async function brave(query: string, limit: number): Promise<SearchResult[]> {
  const res = await fetch(`https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`, {
    headers: { "User-Agent": BROWSER_UA, Accept: "text/html", "Accept-Language": "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`Brave ${res.status}`);
  const { document } = parseHTML(await res.text());
  const out: SearchResult[] = [];
  for (const node of document.querySelectorAll('[data-type="web"]')) {
    const link = node.querySelector("a[href^='http']");
    const url = link?.getAttribute("href");
    const title = node.querySelector(".title, .search-snippet-title")?.textContent?.trim();
    if (!url || !title || url.includes("search.brave.com")) continue;
    const snippet = node.querySelector(".snippet-description, .generic-snippet, .content")?.textContent?.trim() ?? "";
    out.push({ title, url, snippet: snippet.replace(/\s+/g, " ") });
    if (out.length >= limit) break;
  }
  return out;
}

async function duckduckgoLite(query: string, limit: number): Promise<SearchResult[]> {
  const res = await fetch("https://lite.duckduckgo.com/lite/", {
    method: "POST",
    headers: { "User-Agent": BROWSER_UA, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ q: query }),
    signal: AbortSignal.timeout(12_000),
  });
  // 202 is DuckDuckGo's bot wall.
  if (res.status !== 200) throw new Error(`DuckDuckGo ${res.status}`);
  const { document } = parseHTML(await res.text());
  const links = [...document.querySelectorAll("a.result-link")];
  const snippets = [...document.querySelectorAll(".result-snippet")];
  return links.slice(0, limit).map((a, i) => ({
    title: a.textContent?.trim() ?? "",
    url: decodeDuckUrl(a.getAttribute("href") ?? ""),
    snippet: snippets[i]?.textContent?.trim() ?? "",
  }));
}

function decodeDuckUrl(href: string): string {
  const match = href.match(/[?&]uddg=([^&]+)/);
  return match ? decodeURIComponent(match[1]!) : href.startsWith("//") ? `https:${href}` : href;
}

export async function webSearch(query: string, limit = 8): Promise<{ engine: string; results: SearchResult[] }> {
  const errors: string[] = [];
  if (SEARXNG_URL) {
    try {
      const results = await searxng(query, limit);
      if (results.length) return { engine: "searxng", results };
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  for (const [engine, run] of [["brave", brave], ["duckduckgo", duckduckgoLite]] as const) {
    try {
      const results = await run(query, limit);
      if (results.length) return { engine, results };
      errors.push(`${engine}: no results`);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  throw new Error(`Search failed: ${errors.join("; ")}`);
}

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
turndown.remove(["script", "style", "noscript", "iframe", "svg", "form"] as never);

function htmlToMarkdown(html: string, url: string): { title: string; markdown: string } {
  const { document } = parseHTML(html);
  // Readability needs a base URL to resolve relative links.
  const base = document.createElement("base");
  base.setAttribute("href", url);
  document.head?.appendChild(base);
  const article = new Readability(document as never, { charThreshold: 200 }).parse();
  const title = article?.title || document.querySelector("title")?.textContent || url;
  const markdown = article?.content ? turndown.turndown(article.content) : turndown.turndown(document.body?.innerHTML ?? "");
  return { title: title.trim(), markdown: markdown.replace(/\n{3,}/g, "\n\n").trim() };
}

/** Pages behind bot walls or rendered by JS come back blocked or nearly empty; Scrapling handles those. */
function looksBlocked(status: number, text: string) {
  return (
    [401, 403, 429, 503].includes(status) ||
    /cf-browser-verification|challenge-platform|Just a moment\.\.\.|Enable JavaScript and cookies|captcha/i.test(text.slice(0, 20_000))
  );
}

export async function webFetch(url: string): Promise<{ title: string; content: string; via: string }> {
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("Only http and https URLs are allowed");
  let res: Response | null = null;
  let error: string | null = null;
  // A thin result (JS shell or a genuinely short page) is kept in case Scrapling cannot do better.
  let thin: { title: string; content: string } | null = null;
  try {
    res = await fetch(parsed, {
      headers: { "User-Agent": BROWSER_UA, Accept: "text/html,application/xhtml+xml,application/pdf,text/plain,*/*", "Accept-Language": "en-US,en;q=0.9" },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    error = (e as Error).message;
  }

  if (res) {
    const type = res.headers.get("content-type") ?? "";
    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > MAX_BYTES) throw new Error(`Page is larger than ${MAX_BYTES / 1024 / 1024} MB`);
    if (type.includes("application/pdf")) {
      const pdf = await getDocumentProxy(new Uint8Array(await res.arrayBuffer()));
      const { text } = await extractText(pdf, { mergePages: true });
      return { title: parsed.pathname.split("/").pop() || url, content: text as string, via: "fetch" };
    }
    const body = await res.text();
    if (!looksBlocked(res.status, body)) {
      if (type.includes("html") || body.trimStart().startsWith("<")) {
        const { title, markdown } = htmlToMarkdown(body, res.url || url);
        if (markdown.length > 200) return { title, content: markdown, via: "fetch" };
        if (res.ok && markdown) thin = { title, content: markdown };
      } else if (res.ok) {
        return { title: url, content: body, via: "fetch" };
      }
    }
    error = `HTTP ${res.status}`;
  }

  const scraped = await scraplingFetch(url);
  if (scraped) return { ...scraped, via: "scrapling" };
  if (thin) return { ...thin, via: "fetch" };
  throw new Error(`Could not read ${url} (${error ?? "empty page"})`);
}

/** Built-in tools every chat gets when the model supports tool calls. */
export function webTools(opts: { searchBudget?: SearchBudget } = {}): ToolSet {
  const searchBudget = opts.searchBudget ?? new SearchBudget(DEFAULT_USER_SETTINGS.maxSearches);
  return {
    web_search: tool({
      description:
        `Search the web. Returns titles, URLs, and snippets. Use targeted queries for facts that need verification; stop once you have enough evidence. At most ${searchBudget.limit} search queries are allowed for the entire reply, shared with sub-agents. Follow up with web_fetch to read a result; reading pages does not count toward this limit.`,
      inputSchema: z.object({
        query: z.string().min(1).describe("Search query, as you would type it into a search engine"),
        limit: z.number().int().min(1).max(20).optional().describe("Max results, default 8"),
      }),
      execute: async ({ query, limit }) => {
        if (!searchBudget.reserve()) {
          throw new Error(`The web search limit (${searchBudget.limit} queries per reply) has been reached. Answer using the evidence already collected; you may still read known URLs with web_fetch.`);
        }
        return webSearch(query, limit ?? 8);
      },
    }),
    web_fetch: tool({
      description:
        "Read a web page or PDF by URL and return its main content as Markdown. Long pages are paged: pass `page` to continue. Handles pages that block bots or need JavaScript.",
      inputSchema: z.object({
        url: z.string().url(),
        page: z.number().int().min(1).optional().describe("1-based page of the content, default 1"),
      }),
      execute: async ({ url, page = 1 }) => {
        const { title, content, via } = await webFetch(url);
        const pages = Math.max(1, Math.ceil(content.length / PAGE_CHARS));
        const slice = content.slice((page - 1) * PAGE_CHARS, page * PAGE_CHARS);
        return { title, url, page, pages, via, content: slice };
      },
    }),
  };
}
