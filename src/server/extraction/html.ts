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

export async function htmlToText(html: string): Promise<HtmlText> {
  const [{ parseHTML }, turndown] = await Promise.all([import("linkedom"), turndownService()]);
  const { document } = parseHTML(html);
  for (const node of document.querySelectorAll("script,style,noscript,iframe,svg,form")) node.remove();
  const title = document.querySelector("title")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  const root = document.body ?? document.documentElement;
  const markdown = root ? turndown.turndown(root.innerHTML ?? "") : "";
  return { text: markdown.replace(/\n{3,}/g, "\n\n").trim(), title };
}
