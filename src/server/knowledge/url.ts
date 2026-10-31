import { extract } from "../files.js";
import { KnowledgeInputError } from "./store.js";
import { BlockedAddressError, publicFetch, readCapped } from "../public-fetch.js";
import { htmlToMarkdown } from "../tools/web.js";

// One URL source for a knowledge collection. The original response bytes are kept in `uploads` exactly as
// received, and readable text is extracted separately (HTML via Readability/turndown, PDF via unpdf, text
// decoded as UTF-8). Unlike `web_fetch`, this applies no tool-reply paging and never falls back to the
// browser worker: a knowledge source is a single public page, not a crawl. Extracted text has its own
// documented 400k-character cap; the original bytes stay complete.

/** Original body cap. The upload path accepts 25 MB; a page larger than this is not a document. */
export const MAX_URL_BYTES = 10 * 1024 * 1024;
/** Extracted-text cap. The original bytes stay complete; this bounds chunking and embedding work. */
export const MAX_URL_TEXT = 400_000;
export const URL_TIMEOUT_MS = 20_000;
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

export interface KnowledgeUrlPage {
  /** Page title, or the file name / host when the page has none. */
  title: string;
  /** MIME type the original bytes are stored with. */
  mime: string;
  /** Exact response body, persisted as the source original. */
  bytes: Uint8Array;
  /** Readable text for chunking. */
  text: string;
}

type Transport = typeof fetch;
let urlFetch: Transport = publicFetch;

/** Tests replace the transport; production always uses the pinned public DNS fetch. */
export function setKnowledgeUrlFetchForTests(next: Transport | null) {
  urlFetch = next ?? publicFetch;
}

const deadline = (signal?: AbortSignal) =>
  signal ? AbortSignal.any([AbortSignal.timeout(URL_TIMEOUT_MS), signal]) : AbortSignal.timeout(URL_TIMEOUT_MS);

const fileName = (url: URL) => {
  const last = url.pathname.split("/").filter(Boolean).at(-1);
  if (!last) return url.hostname;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
};

const isPdf = (bytes: Uint8Array) => bytes.length >= 5 && new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";

export async function fetchKnowledgeUrl(raw: string, opts: { signal?: AbortSignal } = {}): Promise<KnowledgeUrlPage> {
  const parsed = new URL(raw);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new KnowledgeInputError("Only http and https URLs are allowed.");
  const signal = deadline(opts.signal);
  let res: Response;
  try {
    res = await urlFetch(parsed, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml,application/pdf,text/plain,text/markdown,application/json,*/*;q=0.5",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal,
    });
  } catch (error) {
    if (error instanceof BlockedAddressError) throw new KnowledgeInputError("This URL must be on the public internet.");
    if (opts.signal?.aborted) throw error;
    // Transport errors are not written for the user; the detail stays out of the stored and displayed message.
    throw new KnowledgeInputError(`Could not read ${parsed.href}.`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new KnowledgeInputError(`The page answered HTTP ${res.status}.`);
  }
  const tooLarge = `That page is larger than ${MAX_URL_BYTES / 1024 / 1024} MB.`;
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_URL_BYTES) {
    await res.body?.cancel().catch(() => {});
    throw new KnowledgeInputError(tooLarge);
  }
  let bytes: Uint8Array;
  try {
    bytes = await readCapped(res, MAX_URL_BYTES, tooLarge);
  } catch (error) {
    if (opts.signal?.aborted || signal.aborted) throw error;
    // readCapped only throws its own size message; anything else is a transport failure.
    throw new KnowledgeInputError((error as Error).message === tooLarge ? tooLarge : "Could not read that page.");
  }
  if (!bytes.length) throw new KnowledgeInputError("That page returned an empty response.");

  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const name = fileName(parsed);

  if (type === "application/pdf" || isPdf(bytes)) {
    const { text } = await extract(name.endsWith(".pdf") ? name : `${name}.pdf`, "application/pdf", new Uint8Array(bytes));
    if (!text.trim() || text.startsWith("[This PDF has no text layer")) {
      throw new KnowledgeInputError("That PDF has no text layer. No OCR is available; add a text version instead.");
    }
    return { title: name, mime: "application/pdf", bytes, text: text.slice(0, MAX_URL_TEXT) };
  }

  const body = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const html = type === "text/html" || type === "application/xhtml+xml" || (!type && body.trimStart().startsWith("<"));
  if (html) {
    const page = await htmlToMarkdown(body, res.url || parsed.href);
    if (!page.markdown.trim()) throw new KnowledgeInputError("That page had no readable text.");
    return { title: (page.title || name).slice(0, 200), mime: type === "application/xhtml+xml" ? "application/xhtml+xml" : "text/html", bytes, text: page.markdown.slice(0, MAX_URL_TEXT) };
  }

  const textMime = type.startsWith("text/") || type === "application/json";
  if (type && !textMime) throw new KnowledgeInputError(`That URL returned ${type}, which is not a readable document. Use a text, HTML, or PDF page.`);
  const text = body.trim();
  if (!text) throw new KnowledgeInputError("That page had no readable text.");
  return { title: name.slice(0, 200), mime: type || "text/plain", bytes, text: text.slice(0, MAX_URL_TEXT) };
}
