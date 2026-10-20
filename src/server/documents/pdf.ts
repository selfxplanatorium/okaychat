import { PDFCheckBox, PDFDocument, PDFDropdown, PDFOptionList, PDFRadioGroup, PDFTextField, StandardFonts, degrees, rgb } from "@cantoo/pdf-lib";
import { extractText, getDocumentProxy } from "unpdf";
import { z } from "zod";

// PDFs are made by rendering HTML in Chromium (see render.ts). Existing PDFs are changed structurally
// with pdf-lib: pages, rotation, stamps, form fields, metadata. Rewriting a PDF's body text is not
// something any library does reliably, so the tool tells the model to rebuild such a document from HTML.

export const pdfOp = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("rotate_pages"),
    pages: z.string().default("all").describe("`all`, `2`, `1-3`, or `1,3,5`"),
    angle: z.union([z.literal(90), z.literal(180), z.literal(270)]).describe("Added to the current rotation"),
  }),
  z.object({ op: z.literal("delete_pages"), pages: z.string().describe("`2`, `1-3`, or `1,3,5`. At least one page must remain") }),
  z.object({
    op: z.literal("move_page"),
    from: z.number().int().min(1),
    to: z.number().int().min(1).describe("Position the page takes after removal, 1-based"),
  }),
  z.object({
    op: z.literal("add_text"),
    page: z.number().int().min(1).describe("1-based page number"),
    x: z.number().describe("Points from the left edge"),
    y: z.number().describe("Points from the top edge"),
    text: z.string(),
    size: z.number().min(4).max(144).default(12),
    color: z.string().default("#000000").describe("Hex color"),
  }),
  z.object({ op: z.literal("fill_form"), fields: z.record(z.string(), z.union([z.string(), z.boolean()])) }),
  z.object({
    op: z.literal("set_metadata"),
    title: z.string().optional(),
    author: z.string().optional(),
    subject: z.string().optional(),
    keywords: z.array(z.string()).optional(),
  }),
]);
export type PdfOp = z.infer<typeof pdfOp>;

function pageNumbers(spec: string, total: number): number[] {
  if (/^\s*all\s*$/i.test(spec)) return Array.from({ length: total }, (_, i) => i + 1);
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const range = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(part);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      for (let n = Math.min(from, to); n <= Math.max(from, to); n++) if (n >= 1 && n <= total) out.add(n);
      continue;
    }
    const single = Number(part.trim());
    if (Number.isInteger(single) && single >= 1 && single <= total) out.add(single);
  }
  if (!out.size) throw new Error(`No pages matched "${spec}". The document has ${total} pages.`);
  return [...out].sort((a, b) => a - b);
}

const hexColor = (value: string) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  if (!m) throw new Error(`"${value}" is not a hex color like #1f4e79.`);
  const n = Number.parseInt(m[1]!, 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

/** Text and form fields for the model. */
export async function readPdf(data: Uint8Array): Promise<string> {
  // pdf.js takes ownership of the buffer it is given, so hand it a copy and keep `data` for pdf-lib.
  const proxy = await getDocumentProxy(Uint8Array.from(data));
  const { totalPages, text } = await extractText(proxy, { mergePages: false });
  const pages = (text as string[]).map((page, i) => `--- page ${i + 1} ---\n${page.trim()}`).join("\n\n");
  const doc = await PDFDocument.load(data, { ignoreEncryption: true });
  const form = doc.getForm();
  const fields = form.getFields().map((field) => {
    const name = field.getName();
    if (field instanceof PDFTextField) return `- ${name} (text) = ${JSON.stringify(field.getText() ?? "")}`;
    if (field instanceof PDFCheckBox) return `- ${name} (checkbox) = ${field.isChecked()}`;
    if (field instanceof PDFRadioGroup) return `- ${name} (radio) = ${JSON.stringify(field.getSelected() ?? null)}`;
    if (field instanceof PDFDropdown || field instanceof PDFOptionList) return `- ${name} (choice) = ${JSON.stringify(field.getSelected())}`;
    return `- ${name} (${field.constructor.name})`;
  });
  return [
    `Pages: ${totalPages}`,
    pages || "[This PDF has no text layer. It is probably scanned images.]",
    fields.length ? `\nForm fields:\n${fields.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function editPdf(data: Uint8Array, ops: PdfOp[]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(data, { ignoreEncryption: true, updateMetadata: false });
  for (const [i, op] of ops.entries()) {
    try {
      const pages = doc.getPages();
      switch (op.op) {
        case "rotate_pages":
          for (const n of pageNumbers(op.pages, pages.length)) {
            const page = pages[n - 1]!;
            page.setRotation(degrees((page.getRotation().angle + op.angle) % 360));
          }
          break;
        case "delete_pages": {
          const remove = pageNumbers(op.pages, pages.length);
          if (remove.length >= pages.length) throw new Error("A PDF needs at least one page.");
          // Removing by index shifts later indices, so go from the back.
          for (const n of remove.sort((a, b) => b - a)) doc.removePage(n - 1);
          break;
        }
        case "move_page": {
          if (op.from > pages.length || op.to > pages.length) throw new Error(`The document has ${pages.length} pages.`);
          const [page] = doc.getPages().splice(op.from - 1, 1);
          doc.getPages().splice(op.to - 1, 0, page!);
          break;
        }
        case "add_text": {
          const page = pages[op.page - 1];
          if (!page) throw new Error(`There is no page ${op.page}.`);
          const font = await doc.embedFont(StandardFonts.Helvetica);
          const { height } = page.getSize();
          page.drawText(op.text, { x: op.x, y: height - op.y - op.size, size: op.size, font, color: hexColor(op.color) });
          break;
        }
        case "fill_form": {
          const form = doc.getForm();
          for (const [name, value] of Object.entries(op.fields)) {
            const field = form.getFieldMaybe(name);
            if (!field) throw new Error(`There is no form field named "${name}".`);
            if (field instanceof PDFTextField) field.setText(String(value));
            else if (field instanceof PDFCheckBox) value === true || value === "true" ? field.check() : field.uncheck();
            else if (field instanceof PDFRadioGroup) field.select(String(value));
            else if (field instanceof PDFDropdown || field instanceof PDFOptionList) field.select(String(value));
            else throw new Error(`Field "${name}" is a ${field.constructor.name}, which cannot be filled.`);
          }
          break;
        }
        case "set_metadata":
          if (op.title !== undefined) doc.setTitle(op.title);
          if (op.author !== undefined) doc.setAuthor(op.author);
          if (op.subject !== undefined) doc.setSubject(op.subject);
          if (op.keywords !== undefined) doc.setKeywords(op.keywords);
          break;
      }
    } catch (error) {
      throw new Error(`Operation ${i + 1} (${op.op}): ${(error as Error).message}`);
    }
  }
  return doc.save();
}
