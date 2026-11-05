import { ExtractionError } from "./errors.js";
import type { PartResult } from "./index.js";
import { MAX_EXTRACTED_CHARS, MAX_METADATA_BYTES, MAX_SELECTED_BYTES, MAX_XML_PART_BYTES } from "./limits.js";
import { attr, children, elements, isElement, isText, ODF_MANIFEST, ODF_OFFICE, ODF_TABLE, ODF_TEXT, parseXml, type XmlElement, type XmlNode } from "./xml.js";
import { assertZipBounds, inflateSelected } from "./zip.js";

// ODT: walks office:text into Markdown-like text: headings, paragraphs, lists, and table rows. Comments are
// skipped; footnotes stay inline where they are cited.

const DAMAGED = "Could not open this OpenDocument file. It may be damaged.";

const is = (node: XmlNode, ns: string, local: string): node is XmlElement => isElement(node) && node.namespaceURI === ns && node.localName === local;

/** Spaces `text:s` may still add. A 22-byte element asks for up to 1,000, so without a document budget a few MB
 * of XML would expand into more text than a string can hold. */
interface Budget {
  spaces: number;
}

/** Paragraph content. ODF collapses white space; spaces, tabs, and breaks are explicit elements. */
function inline(node: XmlNode, budget: Budget): string {
  let out = "";
  for (const child of children(node)) {
    if (isText(child)) out += (child.nodeValue ?? "").replace(/[ \t\r\n]+/g, " ");
    else if (!isElement(child)) continue;
    else if (is(child, ODF_TEXT, "s")) {
      const count = Math.max(1, Math.min(1000, budget.spaces, Number(attr(child, ODF_TEXT, "c") ?? 1) || 1));
      budget.spaces = Math.max(0, budget.spaces - count);
      out += " ".repeat(count);
    }
    else if (is(child, ODF_TEXT, "tab")) out += "\t";
    else if (is(child, ODF_TEXT, "line-break")) out += "\n";
    else if (is(child, ODF_OFFICE, "annotation") || is(child, ODF_OFFICE, "annotation-end")) continue;
    else out += inline(child, budget);
  }
  return out;
}

function listItems(list: XmlElement, depth: number, out: string[], budget: Budget) {
  for (const item of children(list)) {
    if (!is(item, ODF_TEXT, "list-item") && !is(item, ODF_TEXT, "list-header")) continue;
    const parts: string[] = [];
    const nested: XmlElement[] = [];
    for (const child of children(item)) {
      if (is(child, ODF_TEXT, "list")) nested.push(child);
      else if (isElement(child)) parts.push(inline(child, budget).trim());
    }
    const line = parts.filter(Boolean).join(" ");
    if (line) out.push(`${"  ".repeat(depth)}- ${line}\n`);
    for (const list of nested) listItems(list, depth + 1, out, budget);
  }
}

function block(node: XmlNode, out: string[], budget: Budget) {
  for (const child of children(node)) {
    if (!isElement(child)) continue;
    if (is(child, ODF_TEXT, "h")) {
      const level = Math.max(1, Math.min(6, Number(attr(child, ODF_TEXT, "outline-level") ?? 1) || 1));
      const text = inline(child, budget).trim();
      if (text) out.push(`${"#".repeat(level)} ${text}\n\n`);
    } else if (is(child, ODF_TEXT, "p")) {
      const text = inline(child, budget).trim();
      if (text) out.push(`${text}\n\n`);
    } else if (is(child, ODF_TEXT, "list")) {
      listItems(child, 0, out, budget);
      out.push("\n");
    } else if (is(child, ODF_TABLE, "table")) {
      for (const row of elements(child, ODF_TABLE, "table-row")) {
        const cells = children(row)
          .filter((cell): cell is XmlElement => is(cell, ODF_TABLE, "table-cell") || is(cell, ODF_TABLE, "covered-table-cell"))
          .map((cell) => children(cell).map((part) => inline(part, budget).trim()).filter(Boolean).join(" "));
        if (cells.some(Boolean)) out.push(`${cells.join(" | ")}\n`);
      }
      out.push("\n");
    } else if (is(child, ODF_OFFICE, "annotation") || is(child, ODF_TEXT, "tracked-changes")) {
      continue;
    } else {
      block(child, out, budget);
    }
  }
}

export async function extractOdt(data: Uint8Array): Promise<PartResult> {
  assertZipBounds(data);
  const parts = inflateSelected(data, (name) => name === "content.xml" || name === "META-INF/manifest.xml", MAX_XML_PART_BYTES, MAX_SELECTED_BYTES);
  const manifest = parts.get("META-INF/manifest.xml");
  if (manifest && manifest.byteLength <= MAX_METADATA_BYTES && elements(parseXml(manifest, DAMAGED), ODF_MANIFEST, "encryption-data").length) {
    throw new ExtractionError("encrypted", "This OpenDocument file is password-protected. Save it without a password and add it again.");
  }
  const content = parts.get("content.xml");
  if (!content) throw new ExtractionError("damaged", DAMAGED);
  const body = elements(parseXml(content, DAMAGED), ODF_OFFICE, "text")[0];
  if (!body) throw new ExtractionError("damaged", DAMAGED);
  const out: string[] = [];
  block(body, out, { spaces: MAX_EXTRACTED_CHARS });
  return { text: out.join("").replace(/\n{3,}/g, "\n\n").trim() };
}
