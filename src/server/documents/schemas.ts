import { z } from "zod";

// Tool input schemas for the document engines. They live apart from pdf.ts, xlsx.ts, and docx.ts so that
// building a turn's tool set does not load pdf-lib, exceljs, or docx (see documents/lazy.ts).

// --- PDF ---------------------------------------------------------------------------------------------------

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

// --- XLSX --------------------------------------------------------------------------------------------------

const color = z.string().describe("Hex color, e.g. `#1f4e79`");
export const cellStyle = z.object({
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  color: color.optional(),
  fill: color.optional().describe("Background color"),
  size: z.number().optional().describe("Font size in points"),
  numFmt: z.string().optional().describe("Excel number format, e.g. `#,##0.00`, `0%`, `yyyy-mm-dd`, `\"€\"#,##0`"),
  align: z.enum(["left", "center", "right"]).optional(),
  wrap: z.boolean().optional(),
  border: z.boolean().optional().describe("Thin border on all sides"),
});
export type CellStyle = z.infer<typeof cellStyle>;

export const cellValue = z.union([
  z.string().describe("Text, or a formula starting with `=`"),
  z.number(),
  z.boolean(),
  z.null(),
  cellStyle.extend({ v: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional().describe("Value or `=formula`") }),
]);
export type CellValue = z.infer<typeof cellValue>;

export const workbookSpec = z.object({
  sheets: z
    .array(
      z.object({
        name: z.string(),
        rows: z.array(z.array(cellValue)).describe("Rows of cells, starting at A1"),
        header: z.boolean().optional().describe("Style the first row as a header (bold, shaded, bordered) and freeze it"),
        columns: z.array(z.number()).optional().describe("Column widths in characters, from column A"),
        freeze: z.string().optional().describe("Freeze rows above and columns left of this cell, e.g. `B2`"),
        merges: z.array(z.string()).optional().describe("Ranges to merge, e.g. `A1:D1`"),
        autoFilter: z.string().optional().describe("Range with filter buttons, e.g. `A1:F1`"),
      }),
    )
    .min(1),
});
export type WorkbookSpec = z.infer<typeof workbookSpec>;

const sheetArg = z.string().optional().describe("Sheet name. Defaults to the first sheet");
export const xlsxOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set_cells"), sheet: sheetArg, start: z.string().describe("Top-left cell, e.g. `B3`"), values: z.array(z.array(cellValue)) }),
  z.object({ op: z.literal("format"), sheet: sheetArg, range: z.string().describe("e.g. `A1:F1`"), style: cellStyle }),
  z.object({ op: z.literal("insert_rows"), sheet: sheetArg, at: z.number().int().min(1).describe("Row number the new rows take"), count: z.number().int().min(1).default(1), values: z.array(z.array(cellValue)).optional() }),
  z.object({ op: z.literal("delete_rows"), sheet: sheetArg, at: z.number().int().min(1), count: z.number().int().min(1).default(1) }),
  z.object({ op: z.literal("insert_columns"), sheet: sheetArg, at: z.string().describe("Column letter the new columns take"), count: z.number().int().min(1).default(1) }),
  z.object({ op: z.literal("delete_columns"), sheet: sheetArg, at: z.string(), count: z.number().int().min(1).default(1) }),
  z.object({ op: z.literal("add_sheet"), name: z.string(), rows: z.array(z.array(cellValue)).optional() }),
  z.object({ op: z.literal("rename_sheet"), sheet: z.string(), name: z.string() }),
  z.object({ op: z.literal("delete_sheet"), sheet: z.string() }),
  z.object({ op: z.literal("column_widths"), sheet: sheetArg, widths: z.record(z.string(), z.number()).describe("Column letter to width in characters, e.g. {\"A\": 30}") }),
  z.object({ op: z.literal("merge"), sheet: sheetArg, range: z.string() }),
  z.object({ op: z.literal("unmerge"), sheet: sheetArg, range: z.string() }),
  z.object({ op: z.literal("freeze"), sheet: sheetArg, cell: z.string().nullable().describe("e.g. `A2` freezes row 1. null removes it") }),
]);
export type XlsxOp = z.infer<typeof xlsxOp>;

// --- DOCX --------------------------------------------------------------------------------------------------

export const docxOp = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("replace_text"),
    find: z.string().min(1).describe("Exact text, which may span bold/italic runs"),
    replace: z.string().describe("Replacement text. Use insert_paragraph for new lines"),
    paragraph: z.number().int().min(1).optional().describe("Only this paragraph (1-based, as read_document prints)"),
    all: z.boolean().optional().describe("Replace every match instead of requiring exactly one"),
  }),
  z.object({ op: z.literal("set_text"), paragraph: z.number().int().min(1), text: z.string().describe("Replaces all text, keeping the paragraph's first-run formatting") }),
  z.object({
    op: z.literal("insert_paragraph"),
    after: z.number().int().min(0).describe("Paragraph index to insert after; 0 puts it first"),
    text: z.string(),
    style: z.string().optional().describe("Paragraph style id, e.g. `Heading2`"),
  }),
  z.object({ op: z.literal("delete_paragraph"), paragraph: z.number().int().min(1) }),
  z.object({ op: z.literal("set_style"), paragraph: z.number().int().min(1), style: z.string().describe("Paragraph style id, e.g. `Heading1` or `Normal`") }),
]);
export type DocxOp = z.infer<typeof docxOp>;
