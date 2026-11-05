import { ExtractionError } from "./errors.js";
import type { PartResult } from "./index.js";
import { MAX_METADATA_BYTES, MAX_SELECTED_BYTES, MAX_XML_PART_BYTES } from "./limits.js";
import { attr, children, elements, isElement, isText, ODF_MANIFEST, ODF_OFFICE, ODF_TABLE, ODF_TEXT, parseXml, type XmlElement, type XmlNode } from "./xml.js";
import { assertZipBounds, inflateSelected } from "./zip.js";

// ODT: walks office:text into Markdown-like text: headings, paragraphs, lists, and table rows. Comments are
// skipped; footnotes stay inline where they are cited.

const DAMAGED = "Could not open this OpenDocument file. It may be damaged.";

const is = (node: XmlNode, ns: string, local: string): node is XmlElement => isElement(node) && node.namespaceURI === ns && node.localName === local;

/** Paragraph content. ODF collapses white space; spaces, tabs, and breaks are explicit elements. */
function inline(node: XmlNode): string {
  let out = "";
  for (const child of children(node)) {
    if (isText(child)) out += (child.nodeValue ?? "").replace(/[ \t\r\n]+/g, " ");
    else if (!isElement(child)) continue;
    else if (is(child, ODF_TEXT, "s")) out += " ".repeat(Math.max(1, Math.min(1000, Number(attr(child, ODF_TEXT, "c") ?? 1) || 1)));
    else if (is(child, ODF_TEXT, "tab")) out += "\t";
    else if (is(child, ODF_TEXT, "line-break")) out += "\n";
    else if (is(child, ODF_OFFICE, "annotation") || is(child, ODF_OFFICE, "annotation-end")) continue;
    else out += inline(child);
  }
  return out;
}

function listItems(list: XmlElement, depth: number, out: string[]) {
  for (const item of children(list)) {
    if (!is(item, ODF_TEXT, "list-item") && !is(item, ODF_TEXT, "list-header")) continue;
    const parts: string[] = [];
    const nested: XmlElement[] = [];
    for (const child of children(item)) {
      if (is(child, ODF_TEXT, "list")) nested.push(child);
      else if (isElement(child)) parts.push(inline(child).trim());
    }
    const line = parts.filter(Boolean).join(" ");
    if (line) out.push(`${"  ".repeat(depth)}- ${line}\n`);
    for (const list of nested) listItems(list, depth + 1, out);
  }
}

function block(node: XmlNode, out: string[]) {
  for (const child of children(node)) {
    if (!isElement(child)) continue;
    if (is(child, ODF_TEXT, "h")) {
      const level = Math.max(1, Math.min(6, Number(attr(child, ODF_TEXT, "outline-level") ?? 1) || 1));
      const text = inline(child).trim();
      if (text) out.push(`${"#".repeat(level)} ${text}\n\n`);
    } else if (is(child, ODF_TEXT, "p")) {
      const text = inline(child).trim();
      if (text) out.push(`${text}\n\n`);
    } else if (is(child, ODF_TEXT, "list")) {
      listItems(child, 0, out);
      out.push("\n");
    } else if (is(child, ODF_TABLE, "table")) {
      for (const row of elements(child, ODF_TABLE, "table-row")) {
        const cells = children(row)
          .filter((cell): cell is XmlElement => is(cell, ODF_TABLE, "table-cell") || is(cell, ODF_TABLE, "covered-table-cell"))
          .map((cell) => children(cell).map((part) => inline(part).trim()).filter(Boolean).join(" "));
        if (cells.some(Boolean)) out.push(`${cells.join(" | ")}\n`);
      }
      out.push("\n");
    } else if (is(child, ODF_OFFICE, "annotation") || is(child, ODF_TEXT, "tracked-changes")) {
      continue;
    } else {
      block(child, out);
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
  block(body, out);
  return { text: out.join("").replace(/\n{3,}/g, "\n\n").trim() };
}
