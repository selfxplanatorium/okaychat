import type { UIMessage } from "ai";
import { Hono } from "hono";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AppEnv } from "./auth.js";
import { htmlToPdf } from "./documents/render.js";
import { redactSecrets } from "./errors.js";
import { attachmentName, currentBranch, getThread, isTemporaryThread } from "./threads.js";

/** Only what a reader of the conversation saw: text and attachment names. Reasoning, tools, and data parts stay out. */
export function threadMarkdown(title: string | null, messages: UIMessage[]): string {
  const sections = [`# ${title?.trim() || "Chat"}`];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const body: string[] = [];
    const attachments = new Set<string>();
    for (const part of message.parts) {
      if (part.type === "file") {
        if (part.filename) attachments.add(part.filename);
      } else if (part.type === "text") {
        const name = attachmentName(part.text);
        if (name !== undefined) attachments.add(name);
        else if (part.text.trim()) body.push(part.text.trim());
      }
    }
    if (!body.length && !attachments.size) continue;
    sections.push(`## ${message.role === "user" ? "You" : "Assistant"}`, ...[...attachments].map((name) => `_Attachment: ${name}_`), ...body);
  }
  return `${sections.join("\n\n")}\n`;
}

const PRINT_STYLE = `@page{size:A4;margin:18mm}
body{font-family:system-ui,-apple-system,"Segoe UI","Liberation Sans",Arial,sans-serif;font-size:10.5pt;line-height:1.55;color:#1a1a1a;margin:0;overflow-wrap:anywhere}
h1{font-size:20pt;margin:0 0 14pt}h2{font-size:12pt;margin:20pt 0 6pt;padding-top:8pt;border-top:1px solid #d8dce2;color:#555}
h3,h4{font-size:11.5pt;margin:12pt 0 6pt}p{margin:0 0 8pt}ul,ol{margin:0 0 8pt;padding-left:18pt}li{margin:0 0 3pt}
table{border-collapse:collapse;margin:8pt 0}th,td{border:1px solid #c9ced6;padding:4pt 7pt;text-align:left;vertical-align:top}th{background:#eef1f5}
code,pre{font-family:ui-monospace,"Liberation Mono",monospace;font-size:9pt}:not(pre)>code{background:#f0f2f5;padding:0 3pt;border-radius:3pt}
pre{background:#f5f6f8;padding:8pt;border-radius:4pt;white-space:pre-wrap;break-inside:avoid-page}
blockquote{margin:8pt 0;padding:2pt 12pt;border-left:3px solid #c9ced6;color:#555}img{max-width:100%}hr{border:0;border-top:1px solid #d8dce2}`;

/** react-markdown escapes raw HTML by default, so message text cannot inject markup into the print page. */
export function markdownHtml(markdown: string, title: string): string {
  const body = renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm] }, markdown));
  const escaped = title.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escaped}</title><style>${PRINT_STYLE}</style></head><body>${body}</body></html>`;
}

/** Header-safe ASCII fallback plus an RFC 5987 UTF-8 name, so non-Latin titles survive in modern browsers. */
function disposition(title: string, extension: string): string {
  const base = title.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "chat";
  const ascii = base.normalize("NFKD").replace(/[^\x20-\x7e]/g, "").replace(/[%;]/g, "").trim() || "chat";
  return `attachment; filename="${ascii}.${extension}"; filename*=UTF-8''${encodeURIComponent(`${base}.${extension}`)}`;
}

export const exportRoutes = new Hono<AppEnv>().get("/threads/:id/export", async (c) => {
  const userId = c.get("user").id;
  const threadId = c.req.param("id");
  const format = c.req.query("format");
  if (format !== "markdown" && format !== "pdf") return c.json({ error: "Format must be markdown or pdf" }, 400);
  if (isTemporaryThread(threadId)) return c.json({ error: "Temporary chats are not stored" }, 400);
  const thread = getThread(userId, threadId);
  if (!thread) return c.json({ error: "Thread not found" }, 404);
  const title = thread.title?.trim() || "Chat";
  const markdown = threadMarkdown(thread.title, currentBranch(userId, threadId));
  const headers = { "Cache-Control": "private, no-store" };
  if (format === "markdown") {
    return c.body(markdown, 200, { ...headers, "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": disposition(title, "md") });
  }
  try {
    // Copy into a plain ArrayBuffer view; Hono's body type rejects ArrayBufferLike.
    const pdf = new Uint8Array(await htmlToPdf(markdownHtml(markdown, title)));
    return c.body(pdf, 200, { ...headers, "Content-Type": "application/pdf", "Content-Disposition": disposition(title, "pdf") });
  } catch (error) {
    console.error("[export]", redactSecrets(String((error as Error)?.message ?? error)).slice(0, 500));
    return c.json({ error: "PDF rendering is unavailable on this server" }, 503);
  }
});
