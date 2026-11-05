import path from "node:path";
import { DOMParser, type Document as XmlDocument, type Element as XmlElement, type Node as XmlNode } from "@xmldom/xmldom";
import { ExtractionError, TOO_LARGE_PART } from "./errors.js";
import { MAX_XML_MARKUP } from "./limits.js";

export const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
export const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
export const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
export const ODF_TEXT = "urn:oasis:names:tc:opendocument:xmlns:text:1.0";
export const ODF_TABLE = "urn:oasis:names:tc:opendocument:xmlns:table:1.0";
export const ODF_OFFICE = "urn:oasis:names:tc:opendocument:xmlns:office:1.0";
export const ODF_MANIFEST = "urn:oasis:names:tc:opendocument:xmlns:manifest:1.0";
export const OPF = "http://www.idpf.org/2007/opf";
export const CONTAINER = "urn:oasis:names:tc:opendocument:xmlns:container";

export type { XmlDocument, XmlElement, XmlNode };

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_NODE = 4;

/** Tags and attributes, each a DOM node: every `<` and `=`. Text containing `=` only counts a little high. */
function markupCount(bytes: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < bytes.length && count <= MAX_XML_MARKUP; i++) if (bytes[i] === 0x3c || bytes[i] === 0x3d) count++;
  return count;
}

/**
 * Parses one package part. Fatal parser errors and `parsererror` documents are `damaged` with the caller's message;
 * a part with more than MAX_XML_MARKUP tags and attributes is `too_large` before any node is built.
 */
export function parseXml(bytes: Uint8Array, damaged: string): XmlDocument {
  if (markupCount(bytes) > MAX_XML_MARKUP) throw new ExtractionError("too_large", TOO_LARGE_PART);
  let doc: XmlDocument;
  try {
    doc = new DOMParser({ onError: () => {} }).parseFromString(new TextDecoder("utf-8", { fatal: false }).decode(bytes), "text/xml");
  } catch {
    throw new ExtractionError("damaged", damaged);
  }
  if (!doc.documentElement || doc.getElementsByTagName("parsererror").length) throw new ExtractionError("damaged", damaged);
  return doc;
}

export const isElement = (node: XmlNode): node is XmlElement => node.nodeType === ELEMENT_NODE;
export const isText = (node: XmlNode) => node.nodeType === TEXT_NODE || node.nodeType === CDATA_NODE;

/** Descendants in document order with one namespace and local name. */
export function elements(root: XmlDocument | XmlElement, ns: string, local: string): XmlElement[] {
  return Array.from(root.getElementsByTagNameNS(ns, local));
}

export function children(node: XmlNode): XmlNode[] {
  return Array.from(node.childNodes);
}

/** A namespaced attribute, or a plain one when `ns` is null. Missing is undefined, never "". */
export function attr(el: XmlElement, ns: string | null, local: string): string | undefined {
  const value = ns ? el.getAttributeNS(ns, local) : el.getAttribute(local);
  return value ? value : undefined;
}

/**
 * Resolves a package-relative reference from the part at `base`. A leading `/` is the package root (OPC);
 * schemes, backslashes, and anything that escapes the root are refused. Returns a POSIX path without a leading `/`.
 */
export function resolvePart(base: string, target: string): string | undefined {
  const clean = target.replace(/[#?].*$/s, "");
  if (!clean || clean.includes("\\") || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith("//")) return undefined;
  const joined = clean.startsWith("/") ? clean.slice(1) : path.posix.join(path.posix.dirname(base), clean);
  const normalized = path.posix.normalize(joined);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) return undefined;
  return normalized;
}

/** OPC: the relationships part of `part` (`dir/_rels/name.rels`). */
export const relsPath = (part: string) => path.posix.join(path.posix.dirname(part), "_rels", `${path.posix.basename(part)}.rels`);

export interface Relationship {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

export function relationships(bytes: Uint8Array | undefined, damaged: string): Relationship[] {
  if (!bytes) return [];
  return elements(parseXml(bytes, damaged), PKG_REL, "Relationship").map((el) => ({
    id: attr(el, null, "Id") ?? "",
    type: attr(el, null, "Type") ?? "",
    target: attr(el, null, "Target") ?? "",
    external: attr(el, null, "TargetMode") === "External",
  }));
}
