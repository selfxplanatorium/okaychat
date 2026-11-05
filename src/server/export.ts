import type { UIMessage } from "ai";
import { Hono } from "hono";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AppEnv } from "./auth.js";
import { BrowserJobError } from "./browser.js";
import { htmlToPdf, rendererAvailable } from "./documents/render.js";
import { AppError, errorJson, redactSecrets } from "./errors.js";
import { serviceUnavailable } from "./services.js";
import { attachmentName, currentBranch, getThread, isTemporaryThread } from "./threads.js";
import { assertThreadRedistributable } from "./knowledge/thread-policy.js";
import { db } from "./db.js";
import { refUploadId } from "./media/refs.js";
import { sniffRaster } from "./media/sniff.js";
import { getMedia, mediaPath } from "./media/store.js";
import { renderVariant, variantFile, type ImageSource } from "./media/variants.js";
import { imagePath } from "./tools/image.js";
import { assertFeature } from "./permissions/guard.js";
import { reserveOperation } from "./permissions/limits.js";

/** An image the conversation showed: an attached image, or a generated/MCP image card. */
export interface ExportImage {
  name: string;
  upload?: string;
  image?: string;
  inline?: string;
}

const EXPORT_IMAGE = "okaychat-export:";

function messageImages(message: UIMessage): ExportImage[] {
  const out: ExportImage[] = [];
  for (const raw of message.parts) {
    const part = raw as { type: string; url?: string; mediaType?: string; filename?: string; state?: string; output?: unknown; toolName?: string };
    if (part.type === "file" && part.mediaType?.startsWith("image/") && typeof part.url === "string") {
      const upload = refUploadId(part.url);
      if (upload) out.push({ name: part.filename || "image", upload });
      else if (part.url.startsWith("data:image/")) out.push({ name: part.filename || "image", inline: part.url });
    } else if ((part.type.startsWith("tool-") || part.type === "dynamic-tool") && part.state === "output-available" && part.output && typeof part.output === "object") {
      const output = part.output as { id?: unknown; url?: unknown; images?: unknown };
      const name = part.toolName ?? part.type.replace(/^tool-/, "");
      if (name === "generate_image" && typeof output.id === "string") out.push({ name: "Generated image", image: output.id });
      else if (Array.isArray(output.images)) {
        for (const image of output.images as Array<{ id?: unknown }>) if (typeof image?.id === "string") out.push({ name: "Tool image", image: image.id });
      }
    }
  }
  return out;
}

/**
 * Only what a reader of the conversation saw: text, attachment names, and images. Reasoning, tools, and data
 * parts stay out. With `images`, each image becomes a placeholder the PDF export fills; without, a name line.
 */
export function threadMarkdown(title: string | null, messages: UIMessage[], images?: ExportImage[]): string {
  const sections = [`# ${title?.trim() || "Chat"}`];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const body: string[] = [];
    const attachments = new Set<string>();
    const shown = messageImages(message);
    for (const part of message.parts) {
      if (part.type === "file") {
        if (part.filename && !part.mediaType.startsWith("image/")) attachments.add(part.filename);
      } else if (part.type === "text") {
        const name = attachmentName(part.text);
        if (name !== undefined) {
          if (!shown.some((image) => image.name === name)) attachments.add(name);
        } else if (part.text.trim()) body.push(part.text.trim());
      }
    }
    const pictures = shown.map((image) => {
      const label = image.name.replace(/[[\]\\]/g, "");
      if (!images) return `_Image: ${label}_`;
      images.push(image);
      return `![${label}](${EXPORT_IMAGE}${images.length - 1})`;
    });
    if (!body.length && !attachments.size && !pictures.length) continue;
    sections.push(`## ${message.role === "user" ? "You" : "Assistant"}`, ...[...attachments].map((name) => `_Attachment: ${name}_`), ...pictures, ...body);
  }
  return `${sections.join("\n\n")}\n`;
}

const MAX_EXPORT_IMAGES = 40;
const MAX_EXPORT_IMAGE_BYTES = 30 * 1024 * 1024;

/**
 * Bounded data URLs of this account's own images at the `large` preview size. The PDF render is offline,
 * so the worker gets the bytes in the document; nothing is fetched and no remote URL is ever followed.
 */
export async function exportImageData(userId: string, images: ExportImage[]): Promise<Array<string | null>> {
  let budget = MAX_EXPORT_IMAGE_BYTES;
  const out: Array<string | null> = [];
  for (const [index, image] of images.entries()) {
    let data: Buffer | null = null;
    let mime = "image/webp";
    try {
      if (index >= MAX_EXPORT_IMAGES) throw new Error("limit");
      let source: ImageSource | null = null;
      if (image.upload) {
        const row = db.prepare("SELECT media_id FROM uploads WHERE id = ? AND user_id = ?").get(image.upload, userId) as { media_id: string | null } | undefined;
        const media = row?.media_id ? getMedia(row.media_id) : undefined;
        if (media && media.user_id === userId) source = { namespace: userId, key: media.id, file: mediaPath(media), mime: media.mime, size: media.size, etag: media.sha256 };
      } else if (image.image) {
        const row = db.prepare("SELECT id, mime, size FROM images WHERE id = ? AND user_id = ?").get(image.image, userId) as { id: string; mime: string; size: number } | undefined;
        if (row) source = { namespace: userId, key: row.id, file: imagePath(userId, row.id), mime: row.mime, size: row.size, etag: row.id };
      }
      if (source) {
        const chosen = await variantFile(source, "large");
        data = await readFile(chosen.file);
        if (chosen.original) mime = source.mime;
      } else if (image.inline) {
        const original = Buffer.from(image.inline.slice(image.inline.indexOf(",") + 1), "base64");
        if (sniffRaster(original)) {
          const preview = await renderVariant(original, "large", original.byteLength);
          data = preview?.data ?? original;
          if (!preview) mime = sniffRaster(original)!;
        }
      }
    } catch {
      data = null;
    }
    if (!data || data.byteLength > budget) {
      out.push(null);
      continue;
    }
    budget -= data.byteLength;
    out.push(`data:${mime};base64,${data.toString("base64")}`);
  }
  return out;
}

/** Replaces image placeholders that could not be embedded with a name line. */
function fillImages(markdown: string, images: ExportImage[], data: Array<string | null>): string {
  return markdown.replace(/!\[([^\]]*)\]\(okaychat-export:(\d+)\)/g, (match, label: string, index: string) =>
    data[Number(index)] && images[Number(index)] ? match : `_Image: ${label}_`);
}

const PRINT_STYLE = `@page{size:A4;margin:18mm}
body{font-family:system-ui,-apple-system,"Segoe UI","Liberation Sans",Arial,sans-serif;font-size:10.5pt;line-height:1.55;color:#1a1a1a;margin:0;overflow-wrap:anywhere}
h1{font-size:20pt;margin:0 0 14pt}h2{font-size:12pt;margin:20pt 0 6pt;padding-top:8pt;border-top:1px solid #d8dce2;color:#555}
h3,h4{font-size:11.5pt;margin:12pt 0 6pt}p{margin:0 0 8pt}ul,ol{margin:0 0 8pt;padding-left:18pt}li{margin:0 0 3pt}
table{border-collapse:collapse;margin:8pt 0}th,td{border:1px solid #c9ced6;padding:4pt 7pt;text-align:left;vertical-align:top}th{background:#eef1f5}
code,pre{font-family:ui-monospace,"Liberation Mono",monospace;font-size:9pt}:not(pre)>code{background:#f0f2f5;padding:0 3pt;border-radius:3pt}
pre{background:#f5f6f8;padding:8pt;border-radius:4pt;white-space:pre-wrap;break-inside:avoid-page}
blockquote{margin:8pt 0;padding:2pt 12pt;border-left:3px solid #c9ced6;color:#555}img{max-width:100%}hr{border:0;border-top:1px solid #d8dce2}`;

/**
 * react-markdown escapes raw HTML by default, so message text cannot inject markup into the print page.
 * Only the export's own image placeholders become data URLs; every other URL keeps the default filter.
 */
export function markdownHtml(markdown: string, title: string, images: Array<string | null> = []): string {
  const urlTransform = (url: string) => {
    if (url.startsWith(EXPORT_IMAGE)) return images[Number(url.slice(EXPORT_IMAGE.length))] ?? "";
    return defaultUrlTransform(url);
  };
  const body = renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm], urlTransform }, markdown));
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
  assertThreadRedistributable(threadId);
  const title = thread.title?.trim() || "Chat";
  const branch = currentBranch(userId, threadId);
  const headers = { "Cache-Control": "private, no-store" };
  if (format === "markdown") {
    const markdown = threadMarkdown(thread.title, branch);
    return c.body(markdown, 200, { ...headers, "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": disposition(title, "md") });
  }
  // PDF needs the browser worker. Markdown export never does, so this is the only affected format.
  // Exporting your own data stays available; rendering a PDF through the worker is an artifact action.
  assertFeature(userId, "artifacts");
  if (!rendererAvailable()) return errorJson(c, serviceUnavailable("browser"));
  const lease = reserveOperation({ userId }, "browser.render");
  try {
    // Copy into a plain ArrayBuffer view; Hono's body type rejects ArrayBufferLike.
    const images: ExportImage[] = [];
    const markdown = threadMarkdown(thread.title, branch, images);
    const data = await exportImageData(userId, images);
    const pdf = new Uint8Array(await htmlToPdf(markdownHtml(fillImages(markdown, images, data), title, data)));
    return c.body(pdf, 200, { ...headers, "Content-Type": "application/pdf", "Content-Disposition": disposition(title, "pdf") });
  } catch (error) {
    if (error instanceof AppError) return errorJson(c, error);
    // The worker answered and refused the render (for example a 422). That is not an outage, and its text stays here.
    if (error instanceof BrowserJobError) {
      console.error("[export] worker refused pdf:", redactSecrets(error.message).slice(0, 500));
      // browser.ts words a missed deadline this way; a slow render is a timeout, not a bad request.
      if (/did not answer in time/.test(error.message)) return errorJson(c, new AppError({ code: "timeout" }));
      return errorJson(c, new AppError({ code: "validation", message: "The browser worker could not render this chat as a PDF." }));
    }
    console.error("[export]", redactSecrets(String((error as Error)?.message ?? error)).slice(0, 500));
    // A failed render is still this server's rendering service failing, never a raw worker message.
    return errorJson(c, serviceUnavailable("browser"));
  } finally {
    lease.release();
  }
});
