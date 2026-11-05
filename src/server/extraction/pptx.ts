import { ExtractionError } from "./errors.js";
import type { ExtractContext, PartResult } from "./index.js";
import { MAX_SELECTED_BYTES, MAX_SLIDES, MAX_XML_PART_BYTES } from "./limits.js";
import { A, attr, children, elements, isElement, P, parseXml, R, relationships, relsPath, resolvePart, type XmlDocument, type XmlElement, type XmlNode } from "./xml.js";
import { assertZipBounds, inflateSelected } from "./zip.js";

// PPTX/PPSX: DrawingML paragraph text of each slide in presentation order, then its speaker notes. Charts,
// SmartArt, alt text, and embedded objects are not read (docs/implementation/extraction.md).

const DAMAGED = "Could not open this presentation. It may be damaged.";
const PRESENTATION = "ppt/presentation.xml";
const PARTS = /^ppt\/(?:_rels\/presentation\.xml\.rels|(?:slides|notesSlides)\/(?:_rels\/)?[^/]+\.xml(?:\.rels)?)$/;
/** Placeholders that repeat layout chrome (slide number, date, footer, the notes page's slide image). */
const CHROME = new Set(["sldNum", "dt", "ftr", "hdr", "sldImg"]);

function placeholderType(paragraph: XmlElement): string | undefined {
  for (let node: XmlNode | null = paragraph.parentNode; node; node = node.parentNode) {
    if (isElement(node) && node.namespaceURI === P && node.localName === "sp") {
      const ph = elements(node, P, "ph")[0];
      return ph ? (attr(ph, null, "type") ?? "body") : undefined;
    }
  }
  return undefined;
}

function runText(node: XmlNode, out: string[]) {
  for (const child of children(node)) {
    if (!isElement(child)) continue;
    if (child.namespaceURI === A && child.localName === "t") out.push(child.textContent ?? "");
    else if (child.namespaceURI === A && child.localName === "br") out.push("\n");
    else if (child.namespaceURI === A && child.localName === "tab") out.push("\t");
    else runText(child, out);
  }
}

function paragraphs(doc: XmlDocument): string {
  const lines: string[] = [];
  for (const paragraph of elements(doc, A, "p")) {
    const type = placeholderType(paragraph);
    if (type && CHROME.has(type)) continue;
    const out: string[] = [];
    runText(paragraph, out);
    const line = out.join("").trim();
    if (line) lines.push(line);
  }
  return lines.join("\n");
}

export async function extractPptx(data: Uint8Array, ctx: ExtractContext): Promise<PartResult> {
  assertZipBounds(data);
  const parts = inflateSelected(data, (name) => name === PRESENTATION || PARTS.test(name), MAX_XML_PART_BYTES, MAX_SELECTED_BYTES);
  const presentation = parts.get(PRESENTATION);
  if (!presentation) throw new ExtractionError("damaged", DAMAGED);
  const rels = new Map(relationships(parts.get(relsPath(PRESENTATION)), DAMAGED).map((rel) => [rel.id, rel]));
  const order: string[] = [];
  for (const sldId of elements(parseXml(presentation, DAMAGED), P, "sldId")) {
    const rel = rels.get(attr(sldId, R, "id") ?? "");
    const target = rel && !rel.external ? resolvePart(PRESENTATION, rel.target) : undefined;
    if (target && parts.has(target) && !order.includes(target)) order.push(target);
  }
  const total = Math.min(order.length, MAX_SLIDES);
  const out: string[] = [];
  for (let i = 0; i < total; i++) {
    ctx.check();
    const slide = order[i]!;
    const body = paragraphs(parseXml(parts.get(slide)!, DAMAGED));
    const notesRel = relationships(parts.get(relsPath(slide)), DAMAGED).find((rel) => !rel.external && rel.type.endsWith("/notesSlide"));
    const notesPart = notesRel ? resolvePart(slide, notesRel.target) : undefined;
    const notesXml = notesPart ? parts.get(notesPart) : undefined;
    const notes = notesXml ? paragraphs(parseXml(notesXml, DAMAGED)) : "";
    if (body || notes) out.push([`## Slide ${i + 1}`, body, notes ? `### Notes\n${notes}` : ""].filter(Boolean).join("\n\n"));
    ctx.progress(i + 1, total);
  }
  const text = out.join("\n\n");
  return order.length > MAX_SLIDES ? { text, limit: "slides" } : { text };
}
