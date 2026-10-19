import { Hono } from "hono";
import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";
import type { AppEnv } from "./auth.js";

const MAX_BYTES = 25 * 1024 * 1024;
// Keep huge documents from blowing the context window in one attachment.
const MAX_CHARS = 400_000;

async function extract(name: string, type: string, data: Uint8Array): Promise<{ text: string; pages?: number }> {
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
  // Everything else we accept is text of some kind.
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(data) };
}

export const fileRoutes = new Hono<AppEnv>().post("/files/extract", async (c) => {
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "No file" }, 400);
  if (file.size > MAX_BYTES) return c.json({ error: "File is larger than 25 MB" }, 413);
  try {
    const { text, pages } = await extract(file.name, file.type, new Uint8Array(await file.arrayBuffer()));
    const truncated = text.length > MAX_CHARS;
    return c.json({ text: truncated ? `${text.slice(0, MAX_CHARS)}\n\n[truncated: ${text.length - MAX_CHARS} more characters]` : text, pages, truncated });
  } catch (error) {
    return c.json({ error: `Could not read ${file.name}: ${(error as Error).message}` }, 422);
  }
});
