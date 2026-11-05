import { getDocumentProxy } from "unpdf";
import { ExtractionError } from "./errors.js";
import type { ExtractContext, PartResult } from "./index.js";
import { MAX_PDF_PAGES } from "./limits.js";

export const PDF_NO_TEXT_LAYER =
  "[This PDF has no text layer. It is probably scanned images. Add it to a knowledge collection where OCR can read it, or provide a text version.]";
const DAMAGED = "Could not open this PDF. It may be damaged or password-protected.";

interface TextItem {
  str?: string;
  hasEOL?: boolean;
}

export async function extractPdf(data: Uint8Array, ctx: ExtractContext): Promise<PartResult> {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // pdf.js detaches the buffer it is given; a copy keeps the caller's bytes for storeUpload.
    pdf = await getDocumentProxy(Uint8Array.from(data));
  } catch {
    throw new ExtractionError("damaged", DAMAGED);
  }
  try {
    const pages = pdf.numPages;
    const read = Math.min(pages, MAX_PDF_PAGES);
    const texts: string[] = [];
    for (let i = 1; i <= read; i++) {
      ctx.check();
      let content: { items: TextItem[] };
      try {
        content = (await (await pdf.getPage(i)).getTextContent()) as { items: TextItem[] };
      } catch {
        throw new ExtractionError("damaged", DAMAGED);
      }
      // Same join as unpdf's extractText: item strings, with a line break where pdf.js reports one.
      texts.push(content.items.filter((item) => item.str != null).map((item) => item.str + (item.hasEOL ? "\n" : "")).join(""));
      ctx.progress(i, read);
    }
    if (texts.every((page) => !page.trim())) return { text: PDF_NO_TEXT_LAYER, pages, needsOcr: "pdf" };
    const text = texts.map((page, i) => `--- page ${i + 1} ---\n${page.trim()}`).join("\n\n");
    return pages > MAX_PDF_PAGES ? { text, pages, limit: "pages" } : { text, pages };
  } finally {
    await pdf.loadingTask.destroy().catch(() => {});
  }
}
