import { DOMParser, XMLSerializer, type Document as XmlDocument, type Element as XmlElement, type Node as XmlNode } from "@xmldom/xmldom";
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IParagraphPropertiesOptions,
  type ParagraphChild,
} from "docx";
import { unzipSync, zipSync } from "fflate";
import { assertZipBounds } from "./zip-bounds.js";
import { parseHTML } from "linkedom";
import { docxOp, type DocxOp } from "./schemas.js";

export { docxOp, type DocxOp };

// DOCX has two paths:
//  - Create: a restricted HTML subset becomes a real Word document through the `docx` package.
//  - Edit: an existing document is edited in place through word/document.xml, so its styles,
//    numbering, images, headers and fields survive. Paragraphs are addressed by the index
//    `readDocx` prints, and a replacement can span the multiple runs Word splits text into.
// See docs/implementation/documents.md.

const MAX_IMAGE_PX = 600;

// --- HTML to DOCX --------------------------------------------------------------------------------------

/** Declarations from the CSS rules that matter for Word, plus the @page setup. */
interface Rule {
  tag?: string;
  classes: string[];
  decls: Record<string, string>;
  specificity: number;
  order: number;
}

interface PageSetup {
  format: "A4" | "Letter";
  landscape: boolean;
  margin: { top: number; right: number; bottom: number; left: number };
}

const css = (element: Element | null | undefined) => {
  const style = element?.getAttribute?.("style") ?? "";
  const decls: Record<string, string> = {};
  for (const part of style.split(";")) {
    const at = part.indexOf(":");
    if (at === -1) continue;
    const name = part.slice(0, at).trim().toLowerCase();
    const value = part.slice(at + 1).trim();
    if (name && value) decls[name] = value;
  }
  return decls;
};

function parseCss(text: string): { rules: Rule[]; page: Record<string, string> } {
  const rules: Rule[] = [];
  const page: Record<string, string> = {};
  const source = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const pageMatch = /@page[^{]*{([^}]*)}/i.exec(source);
  if (pageMatch) {
    for (const part of pageMatch[1]!.split(";")) {
      const at = part.indexOf(":");
      if (at > 0) page[part.slice(0, at).trim().toLowerCase()] = part.slice(at + 1).trim();
    }
  }
  for (const match of source.replace(/@page[^{]*{[^}]*}/gi, "").matchAll(/([^{}@]+){([^}]*)}/g)) {
    const decls: Record<string, string> = {};
    for (const part of match[2]!.split(";")) {
      const at = part.indexOf(":");
      if (at === -1) continue;
      const name = part.slice(0, at).trim().toLowerCase();
      if (name.startsWith("--")) continue;
      const value = part.slice(at + 1).trim();
      if (name && value) decls[name] = value;
    }
    for (const selector of match[1]!.split(",")) {
      const simple = /^\s*([a-z][a-z0-9]*)?((?:[.#][\w-]+)*)\s*$/i.exec(selector);
      if (!simple) continue;
      const tag = simple[1]?.toLowerCase();
      const classes = (simple[2] ?? "").match(/\.[\w-]+/g)?.map((c) => c.slice(1)) ?? [];
      if (!tag && !classes.length) continue;
      rules.push({ tag, classes, decls, specificity: classes.length * 10 + (tag ? 1 : 0), order: rules.length });
    }
  }
  return { rules, page };
}

function matches(element: Element, rule: Rule): boolean {
  if (rule.tag && element.tagName.toLowerCase() !== rule.tag) return false;
  if (!rule.classes.length) return true;
  const own = `${element.getAttribute("class") ?? ""}`.split(/\s+/);
  return rule.classes.every((c) => own.includes(c));
}

/** Declaration from matching rules (weakest first) then the inline style. */
function stylesOf(element: Element, rules: Rule[]): Record<string, string> {
  if (/^(head|body|html|style|script)$/i.test(element.tagName)) return css(element);
  const matched = rules.filter((r) => matches(element, r)).sort((a, b) => a.specificity - b.specificity || a.order - b.order);
  return Object.assign({}, ...matched.map((r) => r.decls), css(element));
}

const pt = (raw: string | undefined): number | undefined => {
  if (!raw) return undefined;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return undefined;
  if (/pt$/.test(raw)) return n;
  if (/px$/.test(raw)) return n * 0.75;
  if (/mm$/.test(raw)) return (n * 72) / 25.4;
  if (/cm$/.test(raw)) return (n * 720) / 25.4;
  if (/in$/.test(raw)) return n * 72;
  return n;
};
const twips = (raw: string | undefined): number | undefined => {
  if (!raw) return undefined;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return undefined;
  if (/mm$/.test(raw)) return Math.round((n * 1440) / 25.4);
  if (/cm$/.test(raw)) return Math.round((n * 14400) / 25.4);
  if (/in$/.test(raw)) return Math.round(n * 1440);
  if (/pt$/.test(raw)) return Math.round(n * 20);
  return Math.round(n * 15); // px
};

const hex = (raw: string | undefined): string | undefined => {
  if (!raw) return undefined;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw.trim());
  if (!m) return undefined;
  const v = m[1]!;
  return (v.length === 3 ? [...v].map((c) => c + c).join("") : v).toUpperCase();
};

const HEADING: Record<string, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  h1: HeadingLevel.HEADING_1,
  h2: HeadingLevel.HEADING_2,
  h3: HeadingLevel.HEADING_3,
  h4: HeadingLevel.HEADING_4,
  h5: HeadingLevel.HEADING_5,
  h6: HeadingLevel.HEADING_6,
};

const HEADING_SIZE: Record<string, number> = { h1: 24, h2: 20, h3: 16, h4: 14, h5: 12, h6: 11 };
const BLOCK_TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "table", "blockquote", "pre", "hr",
  "div", "section", "article", "main", "figure", "figcaption", "img", "header", "footer",
]);

function fontName(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const value = raw.toLowerCase();
  if (/mono|consol|courier/.test(value)) return "Courier New";
  if (/serif/.test(value)) return "Times New Roman";
  if (/sans|arial|helvet|calibri|system/.test(value)) return "Calibri";
  return raw.split(",")[0]!.replace(/["']/g, "").trim();
}

function alignment(raw: string | undefined) {
  switch (raw) {
    case "center":
      return AlignmentType.CENTER;
    case "right":
    case "end":
      return AlignmentType.RIGHT;
    case "justify":
      return AlignmentType.JUSTIFIED;
    default:
      return undefined;
  }
}

function parsePageSetup(page: Record<string, string>): PageSetup {
  const raw = (page.size ?? "A4").toLowerCase();
  const margin = { top: 1134, right: 1134, bottom: 1134, left: 1134 };
  // CSS shorthand: one value applies to all sides, two to vertical/horizontal, four clockwise from top.
  const sides = (page.margin ?? "")
    .trim()
    .split(/\s+/)
    .map((part) => twips(part))
    .filter((value): value is number => !!value);
  if (sides.length === 1) Object.assign(margin, { top: sides[0]!, right: sides[0]!, bottom: sides[0]!, left: sides[0]! });
  else if (sides.length === 2) Object.assign(margin, { top: sides[0]!, right: sides[1]!, bottom: sides[0]!, left: sides[1]! });
  else if (sides.length >= 4) Object.assign(margin, { top: sides[0]!, right: sides[1]!, bottom: sides[2]!, left: sides[3]! });
  return { format: /letter|legal/.test(raw) ? "Letter" : "A4", landscape: /landscape/.test(raw), margin };
}

interface InlineStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
  size?: number;
  font?: string;
  background?: string;
}

function inlineStyleOf(element: Element, inherited: InlineStyle, rules: Rule[]): InlineStyle {
  const s = stylesOf(element, rules);
  return {
    bold: inherited.bold || /bold|[6-9]00/.test(s["font-weight"] ?? ""),
    italic: inherited.italic || /italic|oblique/.test(s["font-style"] ?? ""),
    underline: inherited.underline || /underline/.test(s["text-decoration"] ?? ""),
    strike: inherited.strike || /line-through/.test(s["text-decoration"] ?? ""),
    color: hex(s.color) ?? inherited.color,
    size: pt(s["font-size"]) ?? inherited.size,
    font: fontName(s["font-family"]) ?? inherited.font,
    background: hex(s["background-color"]) ?? inherited.background,
  };
}

function imageOf(src: string): ImageRun | null {
  const match = /^data:image\/(png|jpe?g|gif|bmp);base64,(.+)$/i.exec(src);
  if (!match) return null;
  const type = match[1]!.toLowerCase().replace("jpeg", "jpg") as "png" | "jpg" | "gif" | "bmp";
  const data = Buffer.from(match[2]!, "base64");
  const natural = imageSize(data, type);
  const width = Math.min(natural?.width ?? 480, MAX_IMAGE_PX);
  const height = Math.round((natural?.height ?? 360) * (width / (natural?.width ?? 640)));
  return new ImageRun({ type, data, transformation: { width, height } });
}

/** Pixel size from the PNG, GIF, or JPEG header, so images keep their aspect ratio. */
function imageSize(data: Buffer, type: string): { width: number; height: number } | null {
  if (type === "png" && data.length > 24) return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (type === "gif" && data.length > 10) return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  if (type === "jpg") {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) break;
      const marker = data[offset + 1]!;
      const length = data.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xc3) return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
      offset += 2 + length;
    }
  }
  return null;
}

function runsOf(node: Node, inherited: InlineStyle, rules: Rule[]): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  for (const child of [...node.childNodes]) {
    if (child.nodeType === 3) {
      const text = (child.nodeValue ?? "").replace(/\s+/g, " ");
      if (!text) continue;
      out.push(
        new TextRun({
          text,
          bold: inherited.bold,
          italics: inherited.italic,
          underline: inherited.underline ? {} : undefined,
          strike: inherited.strike,
          color: inherited.color,
          size: inherited.size ? Math.round(inherited.size * 2) : undefined,
          font: inherited.font,
          shading: inherited.background ? { type: ShadingType.CLEAR, fill: inherited.background, color: "auto" } : undefined,
        }),
      );
      continue;
    }
    if (child.nodeType !== 1) continue;
    const element = child as Element;
    const tag = element.tagName.toLowerCase();
    if (tag === "br") {
      out.push(new TextRun({ text: "", break: 1 }));
      continue;
    }
    if (tag === "img") {
      const image = imageOf(element.getAttribute("src") ?? "");
      if (image) out.push(image);
      continue;
    }
    const style = inlineStyleOf(element, inherited, rules);
    // No browser cascade supplies the default look of semantic tags here.
    if (tag === "strong" || tag === "b") style.bold = true;
    if (tag === "em" || tag === "i") style.italic = true;
    if (tag === "u" || tag === "ins") style.underline = true;
    if (tag === "s" || tag === "del" || tag === "strike") style.strike = true;
    if (tag === "code" || tag === "kbd" || tag === "samp") style.font = "Courier New";
    if (tag === "a") {
      const href = element.getAttribute("href") ?? "";
      if (/^(https?:|mailto:|tel:|#)/i.test(href)) {
        const children = runsOf(element, { ...style, underline: true, color: style.color ?? "1155CC" }, rules) as TextRun[];
        if (children.length) {
          out.push(new ExternalHyperlink({ link: href, children }));
          continue;
        }
      }
    }
    out.push(...runsOf(element, style, rules));
  }
  return out;
}

function paragraphProps(element: Element, inherited: InlineStyle, rules: Rule[]): IParagraphPropertiesOptions {
  const tag = element.tagName.toLowerCase();
  const s = stylesOf(element, rules);
  const style = inlineStyleOf(element, inherited, rules);
  const heading = HEADING[tag];
  return {
    heading,
    alignment: alignment(s["text-align"]),
    spacing: {
      before: twips(s["margin-top"]) ?? (heading ? 240 : 0),
      after: twips(s["margin-bottom"]) ?? (heading ? 120 : 0),
    },
    indent: twips(s["margin-left"]) ? { left: twips(s["margin-left"])! } : undefined,
    pageBreakBefore: /page|always/.test(`${s["break-before"] ?? ""} ${s["page-break-before"] ?? ""}`) || undefined,
    shading: style.background ? { type: ShadingType.CLEAR, fill: style.background, color: "auto" } : undefined,
  };
}

function paragraphOf(element: Element, inherited: InlineStyle, rules: Rule[]): Paragraph {
  const tag = element.tagName.toLowerCase();
  const style = inlineStyleOf(element, inherited, rules);
  const size = style.size ?? HEADING_SIZE[tag];
  const runs = runsOf(element, { ...style, size }, rules);
  return new Paragraph({
    ...paragraphProps(element, inherited, rules),
    children: runs.length ? runs : [new TextRun({ text: "", size: size ? Math.round(size * 2) : undefined })],
  });
}

/** Collects inline children into an anonymous paragraph. */
function flush(inline: Node[], inherited: InlineStyle, rules: Rule[], out: Paragraph[]) {
  if (!inline.length) return;
  const holder = inline[0]!.ownerDocument!.createElement("p");
  for (const node of inline) holder.appendChild(node.cloneNode(true));
  if ((holder.textContent ?? "").trim()) out.push(paragraphOf(holder, inherited, rules));
  inline.length = 0;
}

function blocksOf(parent: Element, inherited: InlineStyle, rules: Rule[], list?: { level: number }): Paragraph[] {
  const out: Paragraph[] = [];
  const inline: Node[] = [];
  for (const node of [...parent.childNodes]) {
    if (node.nodeType === 3) {
      inline.push(node);
      continue;
    }
    if (node.nodeType !== 1) continue;
    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    if (!BLOCK_TAGS.has(tag)) {
      inline.push(element);
      continue;
    }
    if (tag === "div" || tag === "section" || tag === "article" || tag === "main" || tag === "figure" || tag === "figcaption" || tag === "header" || tag === "footer") {
      flush(inline, inherited, rules, out);
      const s = stylesOf(element, rules);
      if (/page|always/.test(`${s["break-before"] ?? ""} ${s["page-break-before"] ?? ""}`) && out.length) {
        // A break of its own; replacing the last block would delete the content before the break.
        out.push(new Paragraph({ children: [], pageBreakBefore: true }));
      }
      out.push(...blocksOf(element, inherited, rules, list));
      continue;
    }
    flush(inline, inherited, rules, out);
    if (tag === "hr") {
      out.push(
        new Paragraph({
          children: [],
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "BFBFBF", space: 1 } },
          spacing: { before: 120, after: 120 },
        }),
      );
      continue;
    }
    if (tag === "img") {
      const image = imageOf(element.getAttribute("src") ?? "");
      if (image) out.push(new Paragraph({ children: [image], alignment: AlignmentType.CENTER }));
      continue;
    }
    if (tag === "ul" || tag === "ol") {
      const level = list?.level ?? 0;
      const ordered = tag === "ol";
      for (const child of [...element.children]) {
        if (child.tagName.toLowerCase() !== "li") continue;
        const nested = [...child.children].filter((c) => ["ul", "ol"].includes(c.tagName.toLowerCase()));
        const holder = element.ownerDocument.createElement("p");
        for (const part of [...child.childNodes]) if (!nested.includes(part as Element)) holder.appendChild(part.cloneNode(true));
        const runs = runsOf(holder, inherited, rules);
        out.push(
          new Paragraph({
            ...paragraphProps(holder, inherited, rules),
            children: runs.length ? runs : [new TextRun({ text: "" })],
            ...(ordered ? { numbering: { reference: "ordered", level } } : { bullet: { level } }),
          }),
        );
        for (const sub of nested) out.push(...blocksOf(sub, inherited, rules, { level: level + 1 }));
      }
      continue;
    }
    if (tag === "table") {
      const rows: TableRow[] = [];
      for (const tr of [...element.querySelectorAll("tr")]) {
        const cells: TableCell[] = [];
        let header = false;
        for (const cell of [...tr.children]) {
          const cellTag = cell.tagName.toLowerCase();
          if (cellTag !== "td" && cellTag !== "th") continue;
          header ||= cellTag === "th";
          const children = blocksOf(cell as Element, { ...inherited, bold: inherited.bold || cellTag === "th" }, rules);
          cells.push(
            new TableCell({
              children: children.length ? children : [new Paragraph({ children: [] })],
              shading: cellTag === "th" ? { type: ShadingType.CLEAR, fill: "E8EDF3", color: "auto" } : undefined,
              margins: { top: 60, bottom: 60, left: 100, right: 100 },
            }),
          );
        }
        if (cells.length) rows.push(new TableRow({ children: cells, tableHeader: header }));
      }
      if (rows.length) out.push(tableOf(rows));
      continue;
    }
    if (tag === "blockquote") {
      for (const paragraph of blocksOf(element, { ...inherited, italic: true, color: inherited.color ?? "555555" }, rules)) out.push(paragraph);
      continue;
    }
    if (tag === "pre") {
      const text = element.textContent ?? "";
      out.push(
        new Paragraph({
          children: text.split("\n").flatMap((line, i) => [
            ...(i ? [new TextRun({ text: "", break: 1 })] : []),
            new TextRun({ text: line, font: "Courier New", size: 18 }),
          ]),
          shading: { type: ShadingType.CLEAR, fill: "F4F4F4", color: "auto" },
          spacing: { before: 120, after: 120 },
        }),
      );
      continue;
    }
    out.push(paragraphOf(element, inherited, rules));
  }
  flush(inline, inherited, rules, out);
  return out;
}

// A table is a section child, not a paragraph child; the docx types model the union loosely.
const tableOf = (rows: TableRow[]) =>
  new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" },
      left: { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" },
      right: { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" },
      insideVertical: { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" },
    },
  }) as unknown as Paragraph;

/** Text with `{page}` and `{pages}` replaced by live Word page fields. */
function fieldRuns(text: string, size = 18): TextRun[] {
  return text.split(/(\{page\}|\{pages\})/).filter(Boolean).map((part) =>
    part === "{page}"
      ? new TextRun({ children: [PageNumber.CURRENT], size })
      : part === "{pages}"
        ? new TextRun({ children: [PageNumber.TOTAL_PAGES], size })
        : new TextRun({ text: part, size }),
  );
}

function furniture(root: { querySelector(selector: string): Element | null }, tag: string): Paragraph[] {
  const element = root.querySelector(tag) as Element | null;
  if (!element) return [];
  const text = element.textContent ?? "";
  return [new Paragraph({ children: fieldRuns(text), alignment: AlignmentType.CENTER, spacing: { before: 60, after: 60 } })];
}

/** Builds a Word document from the HTML subset documented in docs/implementation/documents.md. */
export async function createDocx(html: string, title?: string): Promise<Uint8Array> {
  // Plain text (no block markup) still becomes readable paragraphs, so a model that writes prose
  // instead of HTML does not produce one wall of text.
  const fragment = /<(p|h[1-6]|div|ul|ol|table|section|article|header|footer|style|html|body|br)\b/i.test(html)
    ? html
    : html
        .split(/\n{2,}/)
        .filter((block) => block.trim())
        .map((block) => `<p>${block.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>")}</p>`)
        .join("");
  // Accept both a full document and a body fragment. Wrapping a full document would nest its head.
  const source = /<(html|body|head)[\s>]/i.test(fragment) ? fragment : `<!doctype html><html><head></head><body>${fragment}</body></html>`;
  const { document } = parseHTML(source);
  const cssText = [...document.querySelectorAll("style")].map((s) => s.textContent ?? "").join("\n");
  for (const element of [...document.querySelectorAll("style, script")]) element.remove();
  const { rules, page } = parseCss(cssText);
  const setup = parsePageSetup(page);
  const root = (document.querySelector("body") ?? document.documentElement) as Element;
  const body = stylesOf(root, rules);
  const inherited: InlineStyle = {
    font: fontName(body["font-family"]) ?? "Calibri",
    size: pt(body["font-size"]) ?? 11,
    color: hex(body.color),
  };
  // Headers and footers are page furniture, not document body.
  const headers = furniture(document, "header");
  const footers = furniture(document, "footer");
  for (const element of [...document.querySelectorAll("header, footer")]) element.remove();
  const children = blocksOf(root, inherited, rules);
  if (!children.length) children.push(new Paragraph({ children: [] }));

  const a4 = { width: 11906, height: 16838 };
  const letter = { width: 12240, height: 15840 };
  const size = setup.format === "Letter" ? letter : a4;
  const doc = new Document({
    creator: "okaychat",
    title: title ?? "Document",
    styles: {
      default: {
        document: { run: { font: inherited.font, size: Math.round((inherited.size ?? 11) * 2), color: inherited.color } },
      },
    },
    numbering: {
      config: [
        {
          reference: "ordered",
          levels: [
            { level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.START },
            { level: 1, format: LevelFormat.LOWER_LETTER, text: "%2.", alignment: AlignmentType.START },
            { level: 2, format: LevelFormat.LOWER_ROMAN, text: "%3.", alignment: AlignmentType.START },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: setup.landscape ? size.height : size.width, height: setup.landscape ? size.width : size.height },
            margin: setup.margin,
          },
        },
        headers: headers.length ? { default: new Header({ children: headers }) } : undefined,
        footers: footers.length ? { default: new Footer({ children: footers }) } : undefined,
        children,
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}

// --- Reading and editing an existing DOCX --------------------------------------------------------------


const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

interface Part {
  node: XmlElement;
  start: number;
  end: number;
}

function paragraphText(paragraph: XmlElement): { text: string; parts: Part[] } {
  const parts: Part[] = [];
  let text = "";
  const walk = (node: XmlNode) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 1) {
        const element = child as XmlElement;
        const name = element.localName ?? element.nodeName;
        if (name === "t") {
          const value = element.textContent ?? "";
          if (value) {
            parts.push({ node: element, start: text.length, end: text.length + value.length });
            text += value;
          }
          continue;
        }
        if (name === "tab") {
          text += "\t";
          continue;
        }
        if (name === "br" || name === "cr") {
          text += "\n";
          continue;
        }
      }
      walk(child);
    }
  };
  walk(paragraph);
  return { text, parts };
}

const styleOf = (paragraph: XmlElement): string => {
  const pPr = [...paragraph.childNodes].find((n) => n.nodeType === 1 && (n as XmlElement).localName === "pPr") as XmlElement | undefined;
  const style = pPr && ([...pPr.childNodes].find((n) => n.nodeType === 1 && (n as XmlElement).localName === "pStyle") as XmlElement | undefined);
  return style?.getAttribute("w:val") ?? style?.getAttributeNS(W, "val") ?? "Normal";
};

function writeText(node: XmlElement, text: string) {
  node.textContent = text;
  if (/^\s|\s$/.test(text)) node.setAttribute("xml:space", "preserve");
  else node.removeAttribute("xml:space");
}

/** Text view for the model: one numbered paragraph per line, with its style. */
export function readDocxText(data: Uint8Array): string {
  assertZipBounds(data);
  const files = unzipSync(data);
  const xml = files["word/document.xml"];
  if (!xml) throw new Error("This file is not a Word document (word/document.xml is missing).");
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(xml), "text/xml");
  const paragraphs = [...doc.getElementsByTagName("w:p")];
  const lines = paragraphs.map((p, i) => {
    const { text } = paragraphText(p);
    const style = styleOf(p);
    return `${i + 1}. [${style}] ${text.replace(/\n/g, "\\n") || "(empty)"}`;
  });
  return `Paragraphs: ${paragraphs.length}\n${lines.join("\n")}`;
}

function occurrences(text: string, find: string): number {
  if (!find) return 0;
  let count = 0;
  for (let at = text.indexOf(find); at !== -1; at = text.indexOf(find, at + find.length)) count++;
  return count;
}

/** Removes every child of a paragraph except its properties and `keep`. */
function dropContentExcept(paragraph: XmlElement, keep: XmlElement | undefined) {
  for (const child of [...paragraph.childNodes]) {
    if (child === keep || (child.nodeType === 1 && (child as XmlElement).localName === "pPr")) continue;
    paragraph.removeChild(child);
  }
}

function replaceInParagraph(paragraph: XmlElement, find: string, replace: string, all: boolean) {
  let { text, parts } = paragraphText(paragraph);
  let from = 0;
  let count = 0;
  for (;;) {
    const at = text.indexOf(find, from);
    if (at === -1) break;
    const end = at + find.length;
    let inserted = false;
    for (const part of parts) {
      if (part.end <= at || part.start >= end) continue;
      const value = part.node.textContent ?? "";
      const localStart = Math.max(at, part.start) - part.start;
      const localEnd = Math.min(end, part.end) - part.start;
      writeText(part.node, value.slice(0, localStart) + (inserted ? "" : replace) + value.slice(localEnd));
      inserted = true;
    }
    count++;
    if (!all) break;
    // Rebuild, because the offsets moved by the length difference.
    const next = paragraphText(paragraph);
    text = next.text;
    parts = next.parts;
    from = at + replace.length;
  }
  return count;
}

/** Applies paragraph-level edits to an existing document, keeping everything else intact. */
export function editDocx(data: Uint8Array, ops: DocxOp[]): Uint8Array {
  assertZipBounds(data);
  const files = unzipSync(data);
  const raw = files["word/document.xml"];
  if (!raw) throw new Error("This file is not a Word document.");
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(raw), "text/xml");
  const paragraphs = () => [...doc.getElementsByTagName("w:p")];
  const at = (index: number) => {
    const p = paragraphs()[index - 1];
    if (!p) throw new Error(`There is no paragraph ${index}. Read the document again for its paragraph list.`);
    return p;
  };

  for (const [i, op] of ops.entries()) {
    try {
      switch (op.op) {
        case "replace_text": {
          const targets = op.paragraph ? [at(op.paragraph)] : paragraphs();
          if (!op.all) {
            // Count every occurrence first: a second match in the same paragraph is just as ambiguous.
            const matches = targets.reduce((n, paragraph) => n + occurrences(paragraphText(paragraph).text, op.find), 0);
            if (!matches) throw new Error(`"${op.find}" was not found${op.paragraph ? ` in paragraph ${op.paragraph}` : ""}.`);
            if (matches > 1) throw new Error(`"${op.find}" matches ${matches} times. Pass all: true, or target a paragraph.`);
          }
          let total = 0;
          for (const paragraph of targets) total += replaceInParagraph(paragraph, op.find, op.replace, !!op.all);
          if (!total) throw new Error(`"${op.find}" was not found${op.paragraph ? ` in paragraph ${op.paragraph}` : ""}.`);
          break;
        }
        case "set_text": {
          const paragraph = at(op.paragraph);
          const runs = [...paragraph.childNodes].filter((n) => n.nodeType === 1 && (n as XmlElement).localName === "r") as XmlElement[];
          const keep = runs[0];
          if (!keep) {
            dropContentExcept(paragraph, undefined);
            const run = doc.createElementNS(W, "w:r");
            const text = doc.createElementNS(W, "w:t");
            writeText(text, op.text);
            run.appendChild(text);
            paragraph.appendChild(run);
            break;
          }
          // Everything but the paragraph properties and the kept run goes, hyperlinks and other wrappers included.
          dropContentExcept(paragraph, keep);
          const texts = [...keep.childNodes].filter((n) => n.nodeType === 1 && (n as XmlElement).localName === "t") as XmlElement[];
          if (!texts.length) {
            const text = doc.createElementNS(W, "w:t");
            writeText(text, op.text);
            keep.appendChild(text);
          } else {
            writeText(texts[0]!, op.text);
            for (const extra of texts.slice(1)) extra.parentNode?.removeChild(extra);
          }
          break;
        }
        case "insert_paragraph": {
          const list = paragraphs();
          const source = list[Math.max(0, Math.min(op.after, list.length) - 1)];
          if (!source) throw new Error("The document has no paragraphs to copy formatting from.");
          const clone = source.cloneNode(true) as XmlElement;
          // Keep the original run formatting and replace its text.
          const runs = [...clone.childNodes].filter((n) => n.nodeType === 1 && (n as XmlElement).localName === "r") as XmlElement[];
          const keep = runs[0];
          dropContentExcept(clone, keep);
          if (keep) {
            for (const child of [...keep.childNodes]) keep.removeChild(child);
            const text = doc.createElementNS(W, "w:t");
            writeText(text, op.text);
            keep.appendChild(text);
          } else {
            const run = doc.createElementNS(W, "w:r");
            const text = doc.createElementNS(W, "w:t");
            writeText(text, op.text);
            run.appendChild(text);
            clone.appendChild(run);
          }
          if (op.style) setParagraphStyle(doc, clone, op.style);
          const next = list[op.after];
          const parent = next?.parentNode ?? source.parentNode!;
          if (next) parent.insertBefore(clone, next);
          else parent.appendChild(clone);
          break;
        }
        case "delete_paragraph": {
          const paragraph = at(op.paragraph);
          paragraph.parentNode?.removeChild(paragraph);
          break;
        }
        case "set_style":
          setParagraphStyle(doc, at(op.paragraph), op.style);
          break;
      }
    } catch (error) {
      throw new Error(`Operation ${i + 1} (${op.op}): ${(error as Error).message}`);
    }
  }
  files["word/document.xml"] = new TextEncoder().encode(new XMLSerializer().serializeToString(doc));
  return zipSync(files, { level: 6 });
}

function setParagraphStyle(doc: XmlDocument, paragraph: XmlElement, style: string) {
  let pPr = [...paragraph.childNodes].find((n) => n.nodeType === 1 && (n as XmlElement).localName === "pPr") as XmlElement | undefined;
  if (!pPr) {
    pPr = doc.createElementNS(W, "w:pPr");
    paragraph.insertBefore(pPr, paragraph.firstChild);
  }
  let pStyle = [...pPr.childNodes].find((n) => n.nodeType === 1 && (n as XmlElement).localName === "pStyle") as XmlElement | undefined;
  if (!pStyle) {
    pStyle = doc.createElementNS(W, "w:pStyle");
    pPr.insertBefore(pStyle, pPr.firstChild);
  }
  pStyle.setAttributeNS(W, "w:val", style);
}
