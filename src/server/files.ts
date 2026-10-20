import { Hono } from "hono";
import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";
import type { AppEnv } from "./auth.js";
import { newId } from "./crypto.js";
import { db } from "./db.js";
import { readXlsx } from "./documents/xlsx.js";
import { sandboxConfigured } from "./tools/sandbox.js";

export const MAX_BYTES = 25 * 1024 * 1024;
// Keep huge documents from blowing the context window in one attachment.
const MAX_CHARS = 400_000;

/** Attachments a tool can use later: the document tools import these, and run_code can copy any of them. */
function importable(name: string): boolean {
  return sandboxConfigured() || /\.(pdf|docx|xlsx|xlsm)$/i.test(name);
}

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
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(data) });
    return { text: value };
  }
  if (lower.endsWith(".xlsx") || lower.endsWith(".xlsm") || type.includes("officedocument.spreadsheetml")) {
    return { text: await readXlsx(data) };
  }
  // Everything else we accept is text of some kind.
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(data) };
}

/** Stores the bytes so `import_document` can copy them into an artifact. Older uploads are dropped. */
function storeUpload(userId: string, name: string, mime: string, data: Uint8Array): string {
  db.prepare("DELETE FROM uploads WHERE created_at < ?").run(Date.now() - 7 * 86_400_000);
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
  // PDFs that a model reads natively never go through extraction. This keeps their bytes for
  // import_document without paying for text extraction the caller will not use.
  .post("/files/store", async (c) => {
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return c.json({ error: "No file" }, 400);
    if (file.size > MAX_BYTES) return c.json({ error: "File is larger than 25 MB" }, 413);
    if (c.req.query("temporary") === "1" || !importable(file.name)) return c.json({ fileId: null });
    return c.json({ fileId: storeUpload(c.get("user").id, file.name, file.type, new Uint8Array(await file.arrayBuffer())) });
  })
  .post("/files/extract", async (c) => {
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "No file" }, 400);
  if (file.size > MAX_BYTES) return c.json({ error: "File is larger than 25 MB" }, 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    const { text, pages } = await extract(file.name, file.type, bytes);
    const fileId = c.req.query("temporary") !== "1" && importable(file.name) ? storeUpload(c.get("user").id, file.name, file.type, bytes) : undefined;
    const truncated = text.length > MAX_CHARS;
    return c.json({
      text: truncated ? `${text.slice(0, MAX_CHARS)}\n\n[truncated: ${text.length - MAX_CHARS} more characters]` : text,
      pages,
      fileId,
      truncated,
    });
  } catch (error) {
    return c.json({ error: `Could not read ${file.name}: ${(error as Error).message}` }, 422);
  }
});
