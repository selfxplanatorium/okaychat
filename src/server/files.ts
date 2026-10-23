import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import mammoth from "mammoth";
import { assertZipBounds } from "./documents/zip-bounds.js";
import { extractText, getDocumentProxy } from "unpdf";
import type { AppEnv } from "./auth.js";
import { newId } from "./crypto.js";
import { db } from "./db.js";
import { readXlsx } from "./documents/xlsx.js";
import { assertStorage, QuotaError } from "./quota.js";

export const MAX_BYTES = 25 * 1024 * 1024;
// Keep huge documents from blowing the context window in one attachment.
const MAX_CHARS = 400_000;

export async function extract(name: string, type: string, data: Uint8Array): Promise<{ text: string; pages?: number }> {
  const lower = name.toLowerCase();
  if (type === "application/pdf" || lower.endsWith(".pdf")) {
    const pdf = await getDocumentProxy(data);
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    const body = (text as string[]).map((page, i) => `--- page ${i + 1} ---\n${page.trim()}`).join("\n\n");
    if (!body.replace(/--- page \d+ ---/g, "").trim()) {
      return { text: "[This PDF has no text layer. It is probably scanned images. Ask the user for a text version or screenshots.]", pages: totalPages };
    }
    return { text: body, pages: totalPages };
  }
  if (lower.endsWith(".docx") || type.includes("officedocument.wordprocessingml")) {
    assertZipBounds(data);
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(data) });
    return { text: value };
  }
  if (lower.endsWith(".xlsx") || lower.endsWith(".xlsm") || type.includes("officedocument.spreadsheetml")) {
    return { text: await readXlsx(data) };
  }
  // Everything else we accept is text of some kind.
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(data) };
}

/** Attachments belong to the account until explicitly deleted, independent of chat/sandbox lifetime. */
export function storeUpload(userId: string, name: string, mime: string, data: Uint8Array): string {
  if (data.byteLength > MAX_BYTES) throw new Error("File is larger than 25 MB");
  assertStorage(userId, data.byteLength);
  const id = newId("upl");
  db.prepare("INSERT INTO uploads (id, user_id, name, mime, data, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    id,
    userId,
    name,
    mime,
    Buffer.from(data),
    Date.now(),
  );
  return id;
}

export const fileRoutes = new Hono<AppEnv>()
  // Library download/preview of a stored attachment. Inline only for the browser's own safe viewers
  // (images, PDF); anything else downloads, so a model-crafted HTML file cannot script on our origin.
  .get("/uploads/:id/file", (c) => {
    const row = db
      .prepare("SELECT name, mime, data FROM uploads WHERE id = ? AND user_id = ?")
      .get(c.req.param("id"), c.get("user").id) as { name: string; mime: string; data: Uint8Array } | undefined;
    if (!row) return c.json({ error: "Not found" }, 404);
    const mime = row.mime || "application/octet-stream";
    const inline = /^image\/(png|jpeg|gif|webp|avif)$/.test(mime) || mime === "application/pdf";
    return new Response(new Uint8Array(row.data) as unknown as BodyInit, {
      headers: {
        "Content-Type": mime,
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(row.name)}`,
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
    if (!(file instanceof File)) return c.json({ error: "No file" }, 400);
    if (file.size > MAX_BYTES) return c.json({ error: "File is larger than 25 MB" }, 413);
    if (c.req.query("temporary") === "1") return c.json({ fileId: null });
    try {
      return c.json({ fileId: storeUpload(c.get("user").id, file.name, file.type, new Uint8Array(await file.arrayBuffer())) });
    } catch (error) {
      if (error instanceof QuotaError) return c.json({ error: error.message }, 413);
      throw error;
    }
  })
  .post("/files/extract", bodyLimit({ maxSize: MAX_BYTES + 64 * 1024 }), async (c) => {
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "No file" }, 400);
  if (file.size > MAX_BYTES) return c.json({ error: "File is larger than 25 MB" }, 413);
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
    if (error instanceof QuotaError) return c.json({ error: error.message }, 413);
    return c.json({ error: `Could not read ${file.name}: ${(error as Error).message}` }, 422);
  }
});
