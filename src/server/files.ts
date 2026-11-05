import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { assertZipBounds } from "./documents/zip-bounds.js";
import { extractText, getDocumentProxy } from "unpdf";
import type { AppEnv } from "./auth.js";
import { newId } from "./crypto.js";
import { db } from "./db.js";
import { readXlsx } from "./documents/lazy.js";
import { AppError, errorJson, redactSecrets } from "./errors.js";
import { assertStorage, QuotaError } from "./quota.js";
import { getMedia, mediaPath, putMedia, releaseMedia } from "./media/store.js";
import { sniffRaster } from "./media/sniff.js";
import { serveImage } from "./media/variants.js";

export const MAX_BYTES = 25 * 1024 * 1024;
// Keep huge documents from blowing the context window in one attachment.
export const MAX_CHARS = 400_000;

export async function extract(name: string, type: string, data: Uint8Array): Promise<{ text: string; pages?: number }> {
  const lower = name.toLowerCase();
  if (type === "application/pdf" || lower.endsWith(".pdf")) {
    // pdf.js detaches the buffer it is given; a copy keeps the caller's bytes for storeUpload.
    const pdf = await getDocumentProxy(Uint8Array.from(data));
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    const body = (text as string[]).map((page, i) => `--- page ${i + 1} ---\n${page.trim()}`).join("\n\n");
    if (!body.replace(/--- page \d+ ---/g, "").trim()) {
      return { text: "[This PDF has no text layer. It is probably scanned images. Ask the user for a text version or screenshots.]", pages: totalPages };
    }
    return { text: body, pages: totalPages };
  }
  if (lower.endsWith(".docx") || type.includes("officedocument.wordprocessingml")) {
    assertZipBounds(data);
    const { default: mammoth } = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(data) });
    return { text: value };
  }
  if (lower.endsWith(".xlsx") || lower.endsWith(".xlsm") || type.includes("officedocument.spreadsheetml")) {
    return { text: await readXlsx(data) };
  }
  // Everything else we accept is text of some kind.
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(data) };
}

/** The declared type is untrusted: an "image" that is not a raster we can sniff is stored as opaque bytes. */
function storedMime(name: string, mime: string): string {
  if (/^image\/svg\+xml$/i.test(mime) || /\.svg$/i.test(name)) return "image/svg+xml";
  return mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif|bmp|heic|tiff?)$/i.test(name) ? "application/octet-stream" : mime;
}

/**
 * Attachments belong to the account until explicitly deleted, independent of chat/sandbox lifetime. Raster
 * images go to the file-backed media store (deduplicated per account, charged once); everything else stays a
 * SQLite BLOB.
 */
export function storeUpload(userId: string, name: string, mime: string, data: Uint8Array, threadId: string | null = null): string {
  if (data.byteLength > MAX_BYTES) throw new Error("File is larger than 25 MB");
  const id = newId("upl");
  if (sniffRaster(data)) {
    const { media } = putMedia(userId, data, (bytes) => assertStorage(userId, bytes));
    db.prepare("INSERT INTO uploads (id, user_id, thread_id, name, mime, data, media_id, created_at) VALUES (?, ?, ?, ?, ?, x'', ?, ?)")
      .run(id, userId, threadId, name, media.mime, media.id, Date.now());
    return id;
  }
  assertStorage(userId, data.byteLength);
  db.prepare("INSERT INTO uploads (id, user_id, thread_id, name, mime, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    id,
    userId,
    threadId,
    name,
    storedMime(name, mime),
    Buffer.from(data),
    Date.now(),
  );
  return id;
}

/** Deletes an upload row and, when no other row shares its bytes, the media original and its variants. */
export function deleteUpload(userId: string, id: string): boolean {
  const row = db.prepare("SELECT media_id FROM uploads WHERE id = ? AND user_id = ?").get(id, userId) as { media_id: string | null } | undefined;
  if (!row) return false;
  db.prepare("DELETE FROM uploads WHERE id = ? AND user_id = ?").run(id, userId);
  releaseMedia(row.media_id);
  return true;
}

export const fileRoutes = new Hono<AppEnv>()
  // Library download/preview of a stored attachment. Inline only for the browser's own safe viewers
  // (images, PDF); anything else downloads, so a model-crafted HTML file cannot script on our origin.
  .get("/uploads/:id/file", async (c) => {
    const userId = c.get("user").id;
    const row = db
      .prepare("SELECT name, mime, data, media_id FROM uploads WHERE id = ? AND user_id = ?")
      .get(c.req.param("id"), userId) as { name: string; mime: string; data: Uint8Array; media_id: string | null } | undefined;
    if (!row) return c.json({ error: "Not found" }, 404);
    const disposition = (inline: boolean) => `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(row.name)}`;
    if (row.media_id) {
      const media = getMedia(row.media_id);
      if (!media || media.user_id !== userId) return c.json({ error: "Not found" }, 404);
      // Validated against the owner above; the digest never changes for one media id.
      return serveImage(c, { namespace: userId, key: media.id, file: mediaPath(media), mime: media.mime, size: media.size, etag: media.sha256.slice(0, 32) }, {
        headers: { "Content-Disposition": disposition(true), "Content-Security-Policy": "default-src 'none'; sandbox" },
      });
    }
    const mime = row.mime || "application/octet-stream";
    const inline = /^image\/(png|jpeg|gif|webp|avif)$/.test(mime) || mime === "application/pdf";
    return new Response(new Uint8Array(row.data) as unknown as BodyInit, {
      headers: {
        "Content-Type": mime,
        "Content-Disposition": disposition(inline),
        // Inline images and PDFs render in the browser's own viewers; the rest downloads and gets no script.
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  })
  // PDFs that a model reads natively never go through extraction. This keeps their bytes for
  // import_document without paying for text extraction the caller will not use.
  .post("/files/store", bodyLimit({ maxSize: MAX_BYTES + 64 * 1024 }), async (c) => {
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return errorJson(c, new AppError({ code: "validation", message: "No file was uploaded." }));
    if (file.size > MAX_BYTES) return errorJson(c, new AppError({ code: "validation", message: "File is larger than 25 MB", status: 413 }));
    if (c.req.query("temporary") === "1") return c.json({ fileId: null });
    try {
      const userId = c.get("user").id;
      const fileId = storeUpload(userId, file.name, file.type, new Uint8Array(await file.arrayBuffer()));
      // The client references stored images by id; it needs the sniffed type, not the browser's guess.
      const stored = db.prepare("SELECT u.mime, m.width, m.height FROM uploads u LEFT JOIN media m ON m.id = u.media_id WHERE u.id = ?").get(fileId) as { mime: string; width: number | null; height: number | null };
      return c.json({ fileId, mime: stored.mime, ...(stored.width && stored.height ? { width: stored.width, height: stored.height } : {}) });
    } catch (error) {
      if (error instanceof QuotaError || error instanceof AppError) return errorJson(c, error);
      throw error;
    }
  })
  .post("/files/extract", bodyLimit({ maxSize: MAX_BYTES + 64 * 1024 }), async (c) => {
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return errorJson(c, new AppError({ code: "validation", message: "No file was uploaded." }));
  if (file.size > MAX_BYTES) return errorJson(c, new AppError({ code: "validation", message: "File is larger than 25 MB", status: 413 }));
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    const { text, pages } = await extract(file.name, file.type, bytes);
    const fileId = c.req.query("temporary") !== "1" ? storeUpload(c.get("user").id, file.name, file.type, bytes) : undefined;
    const truncated = text.length > MAX_CHARS;
    return c.json({
      text: truncated ? `${text.slice(0, MAX_CHARS)}\n\n[truncated: ${text.length - MAX_CHARS} more characters]` : text,
      pages,
      fileId,
      truncated,
    });
  } catch (error) {
    if (error instanceof QuotaError) return errorJson(c, error);
    // Parser messages can include paths and internal detail. Keep them in the log, show a plain row error.
    console.error("[files] extract failed", redactSecrets(String((error as Error)?.message ?? error)).slice(0, 500));
    return errorJson(c, new AppError({
      code: "validation",
      status: 422,
      message: `Could not read ${file.name.slice(0, 200)}. It may be damaged or use an unsupported format.`,
      details: { name: file.name, message: (error as Error)?.message },
      cause: error,
    }));
  }
});
