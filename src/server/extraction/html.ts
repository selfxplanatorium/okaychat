import type TurndownService from "turndown";

// HTML files and EPUB chapters to Markdown. Nothing is fetched: links keep only their text, images only their
// alt text. linkedom and turndown load on first use.

let converter: Promise<TurndownService> | undefined;
function turndownService() {
  converter ??= import("turndown").then(({ default: Turndown }) => {
    const turndown = new Turndown({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
    turndown.remove(["script", "style", "noscript", "iframe", "svg", "form"] as never);
    turndown.addRule("linkText", { filter: "a", replacement: (content) => content });
    turndown.addRule("imageAlt", {
      filter: "img",
      replacement: (_content, node) => (node as HTMLElement).getAttribute("alt")?.trim() ?? "",
    });
    return turndown;
  });
  return converter;
}

export interface HtmlText {
  /** Markdown of the body, without the title. */
  text: string;
  title: string;
}

export const hasHeading = (markdown: string) => /^#{1,6} \S/m.test(markdown);

/**
 * Markup per turndown call. Turndown appends each child's output to its parent's and then reads the end of that
 * string, which flattens it, so one element with many children costs time quadratic in its output (a 1.6 MB file
 * took 20 s). Larger elements are split into batches of their children, each wrapped in the element's ancestors.
 */
const BATCH_CHARS = 64 * 1024;
/** Deeper large elements are converted whole; turndown then fails on its own recursion instead of ours. */
const MAX_SPLIT_DEPTH = 64;

const ELEMENT = 1;
const TEXT = 3;
const escapeText = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Approximate serialized size of every element and text node, computed once without recursion. */
function markupSizes(root: Node): Map<Node, number> {
  const sizes = new Map<Node, number>();
  const stack: { node: Node; visited: boolean }[] = [{ node: root, visited: false }];
  while (stack.length) {
    const top = stack.pop()!;
    const { node } = top;
    if (node.nodeType === TEXT) {
      sizes.set(node, node.nodeValue?.length ?? 0);
    } else if (node.nodeType === ELEMENT && !top.visited) {
      stack.push({ node, visited: true });
      for (const child of Array.from(node.childNodes)) stack.push({ node: child, visited: false });
    } else if (node.nodeType === ELEMENT) {
      const el = node as Element;
      let size = el.localName.length * 2 + 5;
      for (const attribute of Array.from(el.attributes)) size += attribute.name.length + attribute.value.length + 4;
      for (const child of Array.from(node.childNodes)) size += sizes.get(child) ?? 0;
      sizes.set(node, size);
    }
  }
  return sizes;
}

/** Lazily, so conversion that stops at the character cap also stops serializing. */
function* htmlBatches(root: Element): Generator<string> {
  const sizes = markupSizes(root);
  function* visit(node: Element, wrap: (inner: string, offset: number) => string, depth: number): Generator<string> {
    let batch = "";
    // List items before the current batch, so a split ordered list keeps counting.
    let items = 0;
    let batchStart = 0;
    for (const child of Array.from(node.childNodes)) {
      const isItem = child.nodeType === ELEMENT && (child as Element).localName === "li";
      if (child.nodeType === ELEMENT && (sizes.get(child) ?? 0) > BATCH_CHARS && child.childNodes.length && depth < MAX_SPLIT_DEPTH) {
        if (batch) yield wrap(batch, batchStart);
        batch = "";
        const el = child as Element;
        const close = `</${el.localName}>`;
        const start = Number(el.getAttribute("start")) || 1;
        const open = (offset: number) => {
          const shell = el.cloneNode(false) as Element;
          if (el.localName === "ol" && offset) shell.setAttribute("start", String(start + offset));
          const html = shell.outerHTML;
          return html.endsWith(close) ? html.slice(0, -close.length) : html;
        };
        const offset = items;
        yield* visit(el, (inner, inside) => wrap(open(inside) + inner + close, offset), depth + 1);
        if (isItem) items++;
        batchStart = items;
        continue;
      }
      const html = child.nodeType === ELEMENT ? (child as Element).outerHTML : child.nodeType === TEXT ? escapeText(child.nodeValue ?? "") : "";
      if (batch && batch.length + html.length > BATCH_CHARS) {
        yield wrap(batch, batchStart);
        batch = "";
        batchStart = items;
      }
      batch += html;
      if (isItem) items++;
    }
    if (batch) yield wrap(batch, batchStart);
  }
  yield* visit(root, (inner) => inner, 0);
}

export interface HtmlOptions {
  /** Called before each batch: the extraction time budget and abort. */
  check?: () => void;
  /** Conversion stops once the text is longer than this; the caller's cap then marks it truncated. */
  maxChars?: number;
}

export async function htmlToText(html: string, options: HtmlOptions = {}): Promise<HtmlText> {
  const [{ parseHTML }, turndown] = await Promise.all([import("linkedom"), turndownService()]);
  // linkedom only builds a body for a whole document; a fragment would put everything outside it.
  const { document } = parseHTML(/<html[\s>]/i.test(html) ? html : `<!doctype html><html><head></head><body>${html}</body></html>`);
  for (const node of document.querySelectorAll("script,style,noscript,iframe,svg,form")) node.remove();
  const title = document.querySelector("title")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  const root = document.body ?? document.documentElement;
  const parts: string[] = [];
  let length = 0;
  for (const batch of root ? htmlBatches(root as unknown as Element) : []) {
    if (length > (options.maxChars ?? Infinity)) break;
    options.check?.();
    const part = turndown.turndown(batch);
    if (!part) continue;
    parts.push(part);
    length += part.length + 2;
  }
  const markdown = parts.join("\n\n");
  return { text: markdown.replace(/\n{3,}/g, "\n\n").trim(), title };
}
