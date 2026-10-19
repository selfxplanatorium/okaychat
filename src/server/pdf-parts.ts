import type { UIMessage } from "ai";
import type { ModelInfo } from "../shared/types.js";
import { extract } from "./files.js";

// PDFs arrive as file parts. Models that read PDFs get them as-is; for the rest the server swaps in the
// extracted text, so a thread keeps working after switching to a model without PDF input.

const cache = new Map<string, string>();
const CACHE_SIZE = 50;

async function pdfText(key: string, name: string, dataUrl: string): Promise<string> {
  const hit = cache.get(key);
  if (hit) return hit;
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const { text, pages } = await extract(name, "application/pdf", new Uint8Array(Buffer.from(base64, "base64")));
  const wrapped = `<attachment name="${name.replaceAll('"', "'")}"${pages ? ` pages="${pages}"` : ""}>\n${text}\n</attachment>`;
  cache.set(key, wrapped);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return wrapped;
}

export async function adaptPdfParts(messages: UIMessage[], model: ModelInfo): Promise<UIMessage[]> {
  if (model.inputModalities.includes("pdf")) return messages;
  return Promise.all(
    messages.map(async (m) => {
      if (!m.parts.some((p) => p.type === "file" && p.mediaType === "application/pdf")) return m;
      const parts = await Promise.all(
        m.parts.map(async (p, i) =>
          p.type === "file" && p.mediaType === "application/pdf" && p.url.startsWith("data:")
            ? { type: "text" as const, text: await pdfText(`${m.id}:${i}`, p.filename ?? "document.pdf", p.url).catch((e: Error) => `[Could not read ${p.filename}: ${e.message}]`) }
            : p,
        ),
      );
      return { ...m, parts };
    }),
  );
}
