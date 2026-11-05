import path from "node:path";
import { ExtractionError } from "./errors.js";
import { hasHeading, htmlToText } from "./html.js";
import type { ExtractContext, PartResult } from "./index.js";
import { MAX_EPUB_DOCUMENTS, MAX_METADATA_BYTES, MAX_SELECTED_BYTES, MAX_XML_PART_BYTES } from "./limits.js";
import { attr, CONTAINER, elements, OPF, parseXml } from "./xml.js";
import { assertZipBounds, inflateSelected, readZipEntry, zipEntryNames } from "./zip.js";
import { decodeUtf8 } from "./text.js";

// EPUB: the spine's XHTML documents in reading order (including linear="no"). No network, no NCX/nav, no
// non-spine content.

const DAMAGED = "Could not open this EPUB. It may be damaged.";
/** Font obfuscation (IDPF, Adobe) also lives in encryption.xml and leaves the text readable. */
const FONT_OBFUSCATION = new Set(["http://www.idpf.org/2008/embedding", "http://ns.adobe.com/pdf/enc#RC"]);
const XMLENC = "http://www.w3.org/2001/04/xmlenc#";

function resolveHref(dir: string, href: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(href.replace(/[#?].*$/s, ""));
  } catch {
    return undefined;
  }
  if (!decoded || decoded.includes("\\") || /^[a-z][a-z0-9+.-]*:/i.test(decoded) || decoded.startsWith("/")) return undefined;
  const normalized = path.posix.normalize(path.posix.join(dir, decoded));
  if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) return undefined;
  return normalized;
}

function assertNotEncrypted(data: Uint8Array) {
  const raw = readZipEntry(data, "META-INF/encryption.xml", MAX_METADATA_BYTES);
  if (!raw) return;
  const doc = parseXml(raw, DAMAGED);
  const methods = elements(doc, XMLENC, "EncryptionMethod").map((el) => attr(el, null, "Algorithm") ?? "");
  // Any entry that is not plain font obfuscation means DRM or encrypted content.
  if (!methods.length || methods.some((method) => !FONT_OBFUSCATION.has(method))) {
    throw new ExtractionError("encrypted", "This EPUB is encrypted and cannot be read.");
  }
}

export async function extractEpub(data: Uint8Array, ctx: ExtractContext): Promise<PartResult> {
  assertZipBounds(data);
  const mimetype = decodeUtf8(readZipEntry(data, "mimetype", 256) ?? new Uint8Array()).trim();
  if (mimetype !== "application/epub+zip") throw new ExtractionError("damaged", DAMAGED);
  const names = new Set(zipEntryNames(data));
  if (names.has("META-INF/encryption.xml")) assertNotEncrypted(data);
  const container = readZipEntry(data, "META-INF/container.xml", MAX_METADATA_BYTES);
  if (!container) throw new ExtractionError("damaged", DAMAGED);
  const rootfiles = elements(parseXml(container, DAMAGED), CONTAINER, "rootfile");
  const rootfile = rootfiles.find((el) => attr(el, null, "media-type") === "application/oebps-package+xml") ?? rootfiles[0];
  const opfPath = rootfile ? resolveHref("", attr(rootfile, null, "full-path") ?? "") : undefined;
  const opfBytes = opfPath ? readZipEntry(data, opfPath, MAX_XML_PART_BYTES) : undefined;
  if (!opfPath || !opfBytes) throw new ExtractionError("damaged", DAMAGED);
  const opf = parseXml(opfBytes, DAMAGED);
  const dir = path.posix.dirname(opfPath) === "." ? "" : path.posix.dirname(opfPath);
  const manifest = new Map<string, string>();
  for (const item of elements(opf, OPF, "item")) {
    const type = attr(item, null, "media-type");
    if (type !== "application/xhtml+xml" && type !== "text/html") continue;
    const href = resolveHref(dir, attr(item, null, "href") ?? "");
    const id = attr(item, null, "id");
    if (id && href) manifest.set(id, href);
  }
  const spine: string[] = [];
  for (const ref of elements(opf, OPF, "itemref")) {
    const href = manifest.get(attr(ref, null, "idref") ?? "");
    if (href) spine.push(href);
  }
  const read = spine.slice(0, MAX_EPUB_DOCUMENTS);
  const wanted = new Set(read);
  const parts = inflateSelected(data, (name) => wanted.has(name), MAX_XML_PART_BYTES, MAX_SELECTED_BYTES);
  const out: string[] = [];
  for (let i = 0; i < read.length; i++) {
    ctx.check();
    const bytes = parts.get(read[i]!);
    if (bytes) {
      const chapter = await htmlToText(decodeUtf8(bytes));
      const text = chapter.title && chapter.text && !hasHeading(chapter.text) ? `## ${chapter.title}\n\n${chapter.text}` : chapter.text;
      if (text) out.push(text);
    }
    ctx.progress(i + 1, read.length);
  }
  const text = out.join("\n\n");
  return spine.length > MAX_EPUB_DOCUMENTS ? { text, limit: "documents" } : { text };
}
