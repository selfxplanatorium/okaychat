import ExcelJS from "exceljs";
import { assertZipBounds } from "./zip-bounds.js";
import FormulaParser from "fast-formula-parser";
import { Criteria } from "fast-formula-parser/formulas/helpers.js";
import { Infix } from "fast-formula-parser/formulas/operators.js";
import SSF from "fast-formula-parser/ssf/ssf.js";
import type { SheetPreview, SheetPreviewCell } from "../../shared/types.js";
import { workbookSpec, xlsxOp, type CellStyle, type CellValue, type WorkbookSpec, type XlsxOp } from "./schemas.js";

export { workbookSpec, xlsxOp, type WorkbookSpec, type XlsxOp };

// Workbooks are read and written with exceljs. Formulas are evaluated here and stored with their result,
// so previews and viewers that do not recalculate still show numbers. Excel recalculates on open anyway.


const argb = (hex: string) => {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h.slice(0, 6);
  return `FF${full.toUpperCase()}`;
};

function applyStyle(cell: ExcelJS.Cell, s: CellStyle) {
  if (s.bold !== undefined || s.italic !== undefined || s.underline !== undefined || s.color || s.size) {
    cell.font = {
      ...cell.font,
      ...(s.bold !== undefined && { bold: s.bold }),
      ...(s.italic !== undefined && { italic: s.italic }),
      ...(s.underline !== undefined && { underline: s.underline }),
      ...(s.color && { color: { argb: argb(s.color) } }),
      ...(s.size && { size: s.size }),
    };
  }
  if (s.fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(s.fill) } };
  if (s.numFmt) cell.numFmt = s.numFmt;
  if (s.align || s.wrap !== undefined) {
    cell.alignment = { ...cell.alignment, ...(s.align && { horizontal: s.align }), ...(s.wrap !== undefined && { wrapText: s.wrap }), vertical: "top" };
  }
  if (s.border) {
    const thin = { style: "thin" as const, color: { argb: "FFBFBFBF" } };
    cell.border = { top: thin, left: thin, bottom: thin, right: thin };
  }
}

function setCell(cell: ExcelJS.Cell, input: CellValue) {
  const { v, ...style } = input !== null && typeof input === "object" ? input : { v: input };
  if (v !== undefined) {
    if (typeof v === "string" && v.startsWith("=") && v.length > 1) cell.value = { formula: v.slice(1) } as ExcelJS.CellFormulaValue;
    else cell.value = v;
  }
  applyStyle(cell, style);
}

function sheetOf(wb: ExcelJS.Workbook, name?: string): ExcelJS.Worksheet {
  const ws = name ? wb.getWorksheet(name) : wb.worksheets[0];
  if (!ws) throw new Error(`No sheet named "${name}". Sheets: ${wb.worksheets.map((w) => w.name).join(", ")}`);
  return ws;
}

/** Calls `fn` for each cell address in a range like `A1:C3` (or a single cell). */
function eachInRange(ws: ExcelJS.Worksheet, range: string, fn: (cell: ExcelJS.Cell) => void) {
  const [a, b = a] = range.split(":");
  const from = ws.getCell(a!);
  const to = ws.getCell(b!);
  for (let r = Math.min(+from.row, +to.row); r <= Math.max(+from.row, +to.row); r++) {
    for (let c = Math.min(+from.col, +to.col); c <= Math.max(+from.col, +to.col); c++) fn(ws.getCell(r, c));
  }
}

// --- Formulas ---------------------------------------------------------------------------------------------

const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const toSerial = (d: Date) => (d.getTime() - EXCEL_EPOCH) / 86_400_000;

const { FormulaHelpers: H, Types } = FormulaParser;
const flat = (args: unknown[]) => {
  const out: unknown[] = [];
  H.flattenParams(args, null, true, (item) => out.push(item));
  return out;
};
const grid = (arg: unknown): unknown[] => H.accept(arg, Types.ARRAY, undefined, false, true).flat();

function matches(values: unknown[], criteria: unknown): boolean[] {
  const c = Criteria.parse(H.accept(criteria));
  return values.map((v) => (c.op === "wc" ? c.match === c.value.test(v) : Infix.compareOp(v, c.op, c.value, false, false)));
}

/** Rows that meet every (range, criteria) pair, as a mask. */
function ifsMask(pairs: unknown[]): boolean[] {
  let mask: boolean[] | null = null;
  for (let i = 0; i < pairs.length; i += 2) {
    const m = matches(grid(pairs[i]), pairs[i + 1]);
    mask = mask ? mask.map((x, j) => x && !!m[j]) : m;
  }
  return mask ?? [];
}

// Common functions fast-formula-parser does not implement.
const EXTRA_FUNCTIONS: Record<string, (...args: any[]) => unknown> = {
  MAX: (...a) => {
    const nums = flat(a).filter((x) => typeof x === "number") as number[];
    return nums.length ? Math.max(...nums) : 0;
  },
  MIN: (...a) => {
    const nums = flat(a).filter((x) => typeof x === "number") as number[];
    return nums.length ? Math.min(...nums) : 0;
  },
  MEDIAN: (...a) => {
    const nums = (flat(a).filter((x) => typeof x === "number") as number[]).sort((x, y) => x - y);
    if (!nums.length) throw FormulaParser.FormulaError.NA;
    const mid = nums.length >> 1;
    return nums.length % 2 ? nums[mid] : (nums[mid - 1]! + nums[mid]!) / 2;
  },
  COUNTA: (...a) => flat(a).filter((x) => x !== null && x !== undefined && x !== "").length,
  COUNTBLANK: (r) => grid(r).filter((x) => x === null || x === undefined || x === "").length,
  COUNTIF: (r, c) => matches(grid(r), c).filter(Boolean).length,
  SUMIFS: (sum, ...pairs) => {
    const mask = ifsMask(pairs);
    return grid(sum).reduce<number>((acc, v, i) => (mask[i] && typeof v === "number" ? acc + v : acc), 0);
  },
  COUNTIFS: (...pairs) => ifsMask(pairs).filter(Boolean).length,
  AVERAGEIFS: (avg, ...pairs) => {
    const mask = ifsMask(pairs);
    const nums = grid(avg).filter((v, i) => mask[i] && typeof v === "number") as number[];
    if (!nums.length) throw FormulaParser.FormulaError.DIV0;
    return nums.reduce((x, y) => x + y, 0) / nums.length;
  },
  XLOOKUP: (key, lookup, ret, notFound) => {
    const k = H.accept(key);
    const i = grid(lookup).findIndex((v) => v === k || (typeof v === "string" && typeof k === "string" && v.toLowerCase() === k.toLowerCase()));
    if (i === -1) {
      if (notFound !== undefined) return H.accept(notFound);
      throw FormulaParser.FormulaError.NA;
    }
    return grid(ret)[i];
  },
};
function plainValue(cell: ExcelJS.Cell): unknown {
  const v = cell.value;
  if (v instanceof Date) return toSerial(v);
  if (v && typeof v === "object") {
    if ("result" in v) return v.result instanceof Date ? toSerial(v.result) : ((v.result as unknown) ?? null);
    if ("richText" in v) return v.richText.map((t) => t.text).join("");
    if ("text" in v) return v.text;
    if ("error" in v) return null;
    return null;
  }
  return v ?? null;
}

/** Evaluates every formula and stores its result. Unsupported functions keep the previous result. */
export function recalculate(wb: ExcelJS.Workbook) {
  const done = new Set<string>();
  const visiting = new Set<string>();
  const key = (ws: ExcelJS.Worksheet, r: number, c: number) => `${ws.id}:${r}:${c}`;

  const valueAt = (ws: ExcelJS.Worksheet, r: number, c: number): unknown => {
    const cell = ws.getCell(r, c);
    if (cell.type === ExcelJS.ValueType.Formula) evaluate(ws, cell);
    return plainValue(cell);
  };

  const parser = new FormulaParser({
    functions: EXTRA_FUNCTIONS,
    onCell: ({ sheet, row, col }) => {
      const ws = (sheet && wb.getWorksheet(sheet)) || current;
      return valueAt(ws, row, col);
    },
    onRange: ({ sheet, from, to }) => {
      const ws = (sheet && wb.getWorksheet(sheet)) || current;
      const out: unknown[][] = [];
      for (let r = from.row; r <= Math.min(to.row, ws.rowCount); r++) {
        const row: unknown[] = [];
        for (let c = from.col; c <= Math.min(to.col, ws.columnCount); c++) row.push(valueAt(ws, r, c));
        out.push(row);
      }
      return out;
    },
  });

  let current: ExcelJS.Worksheet = wb.worksheets[0]!;
  function evaluate(ws: ExcelJS.Worksheet, cell: ExcelJS.Cell) {
    const k = key(ws, +cell.row, +cell.col);
    if (done.has(k) || visiting.has(k)) return;
    visiting.add(k);
    const outer = current;
    current = ws;
    try {
      const formula = cell.formula;
      if (!formula) return;
      let result = parser.parse(formula, { sheet: ws.name, row: +cell.row, col: +cell.col });
      if (Array.isArray(result)) result = result.flat()[0];
      if (result !== null && typeof result === "object") return; // A FormulaError: keep whatever was there.
      const value = cell.value as ExcelJS.CellFormulaValue | ExcelJS.CellSharedFormulaValue;
      cell.value = { ...value, result: result as ExcelJS.CellFormulaValue["result"] };
    } catch {
      // Unsupported function or bad reference. Excel computes it on open.
    } finally {
      current = outer;
      visiting.delete(k);
      done.add(k);
    }
  }

  for (const ws of wb.worksheets) {
    ws.eachRow({ includeEmpty: false }, (row) =>
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (cell.type === ExcelJS.ValueType.Formula) evaluate(ws, cell);
      }),
    );
  }
  wb.calcProperties = { ...wb.calcProperties, fullCalcOnLoad: true };
}

// --- Create, load, save -----------------------------------------------------------------------------------

export async function loadXlsx(data: Uint8Array): Promise<ExcelJS.Workbook> {
  assertZipBounds(data);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(data) as unknown as ArrayBuffer);
  return wb;
}

export async function saveXlsx(wb: ExcelJS.Workbook): Promise<Uint8Array> {
  recalculate(wb);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

export async function createXlsx(spec: WorkbookSpec): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "okaychat";
  for (const s of spec.sheets) {
    const ws = wb.addWorksheet(s.name.slice(0, 31));
    s.rows.forEach((row, r) => row.forEach((value, c) => setCell(ws.getCell(r + 1, c + 1), value)));
    s.columns?.forEach((width, i) => (ws.getColumn(i + 1).width = width));
    if (!s.columns) autoWidth(ws);
    if (s.header && s.rows[0]) {
      ws.getRow(1).eachCell((cell) => applyStyle(cell, { bold: true, fill: "#e8edf3", border: true }));
    }
    const freeze = s.freeze ?? (s.header ? "A2" : undefined);
    if (freeze) freezeAt(ws, freeze);
    s.merges?.forEach((m) => ws.mergeCells(m));
    if (s.autoFilter) ws.autoFilter = s.autoFilter;
  }
  return saveXlsx(wb);
}

function autoWidth(ws: ExcelJS.Worksheet) {
  ws.columns.forEach((col) => {
    let max = 8;
    col.eachCell?.({ includeEmpty: false }, (cell) => {
      const text = displayText(cell);
      max = Math.max(max, ...text.split("\n").map((l) => l.length + 2));
    });
    col.width = Math.min(max, 60);
  });
}

function freezeAt(ws: ExcelJS.Worksheet, address: string | null) {
  if (!address) {
    ws.views = [];
    return;
  }
  const cell = ws.getCell(address);
  ws.views = [{ state: "frozen", xSplit: +cell.col - 1, ySplit: +cell.row - 1 }];
}

// --- Formula reference shifting for row/column inserts ----------------------------------------------------

const colNum = (letters: string) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const colName = (n: number): string => (n <= 0 ? "" : colName(Math.floor((n - 1) / 26)) + String.fromCharCode(65 + ((n - 1) % 26)));

/**
 * Moves A1 references in formulas on `target` when rows or columns are inserted (count > 0) or deleted
 * (count < 0) at `at`. exceljs does not do this, so formulas would otherwise point at the wrong cells.
 */
function shiftReferences(wb: ExcelJS.Workbook, target: ExcelJS.Worksheet, axis: "row" | "col", at: number, count: number) {
  const ref = /('(?:[^']|'')+'|[A-Za-z_][\w.]*)?(!)?(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\w(])/g;
  const shift = (formula: string, home: ExcelJS.Worksheet) =>
    formula
      .split(/("(?:[^"]|"")*")/)
      .map((chunk, i) =>
        i % 2
          ? chunk
          : chunk.replace(ref, (m, sheet: string | undefined, bang, d1, col: string, d2, row: string) => {
              if (sheet && !bang) return m;
              const sheetName = sheet?.replace(/^'|'$/g, "").replaceAll("''", "'");
              if ((sheetName ?? home.name) !== target.name) return m;
              let r = +row;
              let c = colNum(col);
              if (axis === "row" && r >= at) r = count > 0 ? r + count : r < at - count ? at : r + count;
              if (axis === "col" && c >= at) c = count > 0 ? c + count : c < at - count ? at : c + count;
              return `${sheet ? `${sheet}!` : ""}${d1}${colName(c)}${d2}${r}`;
            }),
      )
      .join("");
  for (const ws of wb.worksheets) {
    ws.eachRow({ includeEmpty: false }, (row) =>
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value as ExcelJS.CellFormulaValue | null;
        if (cell.type === ExcelJS.ValueType.Formula && v && "formula" in v && v.formula) cell.value = { ...v, formula: shift(v.formula, ws) };
      }),
    );
  }
}

// --- Edit operations --------------------------------------------------------------------------------------


export async function editXlsx(data: Uint8Array, ops: XlsxOp[]): Promise<Uint8Array> {
  const wb = await loadXlsx(data);
  for (const [i, op] of ops.entries()) {
    try {
      applyOp(wb, op);
    } catch (error) {
      throw new Error(`Operation ${i + 1} (${op.op}): ${(error as Error).message}`);
    }
  }
  return saveXlsx(wb);
}

function writeGrid(ws: ExcelJS.Worksheet, row: number, col: number, values: CellValue[][]) {
  values.forEach((r, dr) => r.forEach((v, dc) => setCell(ws.getCell(row + dr, col + dc), v)));
}

function applyOp(wb: ExcelJS.Workbook, op: XlsxOp) {
  switch (op.op) {
    case "set_cells": {
      const ws = sheetOf(wb, op.sheet);
      const start = ws.getCell(op.start);
      writeGrid(ws, +start.row, +start.col, op.values);
      return;
    }
    case "format":
      return eachInRange(sheetOf(wb, op.sheet), op.range, (cell) => applyStyle(cell, op.style));
    case "insert_rows": {
      const ws = sheetOf(wb, op.sheet);
      const count = op.count ?? 1;
      shiftReferences(wb, ws, "row", op.at, count);
      ws.spliceRows(op.at, 0, ...Array.from({ length: count }, () => []));
      if (op.values) writeGrid(ws, op.at, 1, op.values);
      return;
    }
    case "delete_rows": {
      const ws = sheetOf(wb, op.sheet);
      const count = op.count ?? 1;
      ws.spliceRows(op.at, count);
      shiftReferences(wb, ws, "row", op.at, -count);
      return;
    }
    case "insert_columns": {
      const ws = sheetOf(wb, op.sheet);
      const count = op.count ?? 1;
      const at = colNum(op.at.toUpperCase());
      shiftReferences(wb, ws, "col", at, count);
      ws.spliceColumns(at, 0, ...Array.from({ length: count }, () => []));
      return;
    }
    case "delete_columns": {
      const ws = sheetOf(wb, op.sheet);
      const count = op.count ?? 1;
      const at = colNum(op.at.toUpperCase());
      ws.spliceColumns(at, count);
      shiftReferences(wb, ws, "col", at, -count);
      return;
    }
    case "add_sheet": {
      if (wb.getWorksheet(op.name)) throw new Error(`A sheet named "${op.name}" exists`);
      const ws = wb.addWorksheet(op.name.slice(0, 31));
      if (op.rows) {
        writeGrid(ws, 1, 1, op.rows);
        autoWidth(ws);
      }
      return;
    }
    case "rename_sheet":
      sheetOf(wb, op.sheet).name = op.name.slice(0, 31);
      return;
    case "delete_sheet":
      if (wb.worksheets.length === 1) throw new Error("A workbook needs at least one sheet");
      wb.removeWorksheet(sheetOf(wb, op.sheet).id);
      return;
    case "column_widths": {
      const ws = sheetOf(wb, op.sheet);
      for (const [col, width] of Object.entries(op.widths)) ws.getColumn(col.toUpperCase()).width = width;
      return;
    }
    case "merge":
      return sheetOf(wb, op.sheet).mergeCells(op.range);
    case "unmerge":
      return sheetOf(wb, op.sheet).unMergeCells(op.range);
    case "freeze":
      return freezeAt(sheetOf(wb, op.sheet), op.cell);
  }
}

// --- Reading ----------------------------------------------------------------------------------------------

function displayText(cell: ExcelJS.Cell): string {
  const raw = cell.value;
  if (raw === null || raw === undefined) return "";
  const v = plainValue(cell);
  if (v === null || v === undefined) return cell.type === ExcelJS.ValueType.Formula ? "" : String(cell.text ?? "");
  if (typeof v === "number") {
    const fmt = cell.numFmt || (raw instanceof Date || (raw as ExcelJS.CellFormulaValue).result instanceof Date ? "yyyy-mm-dd" : "General");
    try {
      return SSF.format(fmt, v);
    } catch {
      return String(v);
    }
  }
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
}

const MAX_READ_CELLS = 4000;

/** A text view for the model: one Markdown table per sheet, formulas shown with their result. */
export async function readXlsx(data: Uint8Array, range?: string): Promise<string> {
  const wb = await loadXlsx(data);
  const [sheetPart, cellPart] = range?.includes("!") ? range.split("!") : [undefined, range];
  const sheets = sheetPart ? [sheetOf(wb, sheetPart.replace(/^'|'$/g, ""))] : wb.worksheets;
  const out: string[] = [`Sheets: ${wb.worksheets.map((w) => `${w.name} (${w.actualRowCount} rows × ${w.actualColumnCount} cols)`).join(", ")}`];
  let budget = MAX_READ_CELLS;
  for (const ws of sheets) {
    let r1 = 1;
    let c1 = 1;
    let r2 = ws.rowCount;
    let c2 = ws.columnCount;
    if (cellPart) {
      const [a, b = a] = cellPart.split(":");
      const from = ws.getCell(a!);
      const to = ws.getCell(b!);
      [r1, c1, r2, c2] = [+from.row, +from.col, +to.row, +to.col];
    }
    if (r2 < r1 || c2 < c1) {
      out.push(`\n## ${ws.name}\n(empty)`);
      continue;
    }
    const lines = [`\n## ${ws.name}`, `| | ${Array.from({ length: c2 - c1 + 1 }, (_, i) => colName(c1 + i)).join(" | ")} |`, `|---|${"---|".repeat(c2 - c1 + 1)}`];
    let lastRow = r1;
    for (let r = r1; r <= r2 && budget > 0; r++, lastRow = r) {
      const cells: string[] = [];
      for (let c = c1; c <= c2; c++) {
        const cell = ws.getCell(r, c);
        const text = displayText(cell).replaceAll("|", "\\|").replaceAll("\n", " ");
        cells.push(cell.type === ExcelJS.ValueType.Formula ? `=${cell.formula}${text ? ` → ${text}` : ""}` : text);
      }
      budget -= cells.length;
      if (cells.some(Boolean)) lines.push(`| ${r} | ${cells.join(" | ")} |`);
    }
    if (lastRow <= r2) lines.push(`\n[Stopped at row ${lastRow - 1} of ${r2}. Pass range \`${ws.name}!A${lastRow}:${colName(c2)}${r2}\` to read on.]`);
    const merges = (ws.model as { merges?: string[] }).merges;
    if (merges?.length) lines.push(`Merged: ${merges.join(", ")}`);
    out.push(lines.join("\n"));
  }
  return out.join("\n");
}

const PREVIEW_ROWS = 500;
const PREVIEW_COLS = 50;

const hexOf = (c: Partial<ExcelJS.Color> | undefined) => (c?.argb && c.argb.length === 8 ? `#${c.argb.slice(2)}` : undefined);

/** What the web grid renders. Theme colors are not resolved; explicit colors are. */
export async function previewXlsx(data: Uint8Array): Promise<SheetPreview[]> {
  const wb = await loadXlsx(data);
  return wb.worksheets.map((ws) => {
    const rowCount = Math.min(ws.rowCount, PREVIEW_ROWS);
    const colCount = Math.min(ws.columnCount, PREVIEW_COLS);
    const rows: SheetPreview["rows"] = [];
    for (let r = 1; r <= rowCount; r++) {
      const row = ws.getRow(r);
      const cells: (SheetPreviewCell | null)[] = [];
      for (let c = 1; c <= colCount; c++) {
        const cell = row.getCell(c);
        if (cell.isMerged && cell.master !== cell) {
          cells.push(null);
          continue;
        }
        const font = cell.font ?? {};
        const fill = cell.fill?.type === "pattern" && cell.fill.pattern === "solid" ? hexOf(cell.fill.fgColor) : undefined;
        const text = displayText(cell);
        const numeric = typeof plainValue(cell) === "number";
        cells.push({
          t: text,
          ...(font.bold && { b: true }),
          ...(font.italic && { i: true }),
          ...(font.underline && { u: true }),
          ...(hexOf(font.color) && { color: hexOf(font.color) }),
          ...(font.size && font.size !== 11 && { size: font.size }),
          ...(fill && { bg: fill }),
          align: (cell.alignment?.horizontal as SheetPreviewCell["align"]) ?? (numeric ? "right" : undefined),
          ...(cell.alignment?.wrapText && { wrap: true }),
          ...(cell.border?.top || cell.border?.bottom ? { border: true } : {}),
        });
      }
      rows.push({ height: row.height || undefined, cells });
    }
    const merges = ((ws.model as { merges?: string[] }).merges ?? []).map((m) => {
      const [a, b = a] = m.split(":");
      const from = ws.getCell(a!);
      const to = ws.getCell(b!);
      return { top: +from.row, left: +from.col, bottom: +to.row, right: +to.col };
    });
    const view = ws.views[0] as { state?: string; xSplit?: number; ySplit?: number } | undefined;
    return {
      name: ws.name,
      columns: Array.from({ length: colCount }, (_, i) => ws.getColumn(i + 1).width ?? 9),
      rows,
      merges,
      frozen: view?.state === "frozen" ? { rows: view.ySplit ?? 0, cols: view.xSplit ?? 0 } : undefined,
      truncated: ws.rowCount > PREVIEW_ROWS || ws.columnCount > PREVIEW_COLS,
    };
  });
}
