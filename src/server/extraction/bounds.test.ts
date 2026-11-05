import assert from "node:assert/strict";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";
import { ExtractionError, extract } from "./index.js";
import { ArchiveTooLargeError } from "./zip.js";

// Bounds, malformed packages, the time budget, and cancellation. Every archive is built locally; the large
// entries are one repeated byte so the ZIP itself stays small while its declared size is real.
// docs/implementation/extraction.md

const OOXML = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";

const xml = (source: string) => strToU8(source);
const textBytes = (text: string) => strToU8(text);

/** A highly compressible buffer; fflate's declared originalSize is what the archive bounds measure. */
function compressible(size: number): Uint8Array {
  return new Uint8Array(size).fill(0x61);
}

function zipStoredMimetype(mimetype: string, files: Record<string, Uint8Array>): Uint8Array {
  return zipSync({ mimetype: [strToU8(mimetype), { level: 0 }], ...files });
}

const PPTX_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`;

const PPTX_PRESENTATION = `<?xml version="1.0" encoding="UTF-8"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${OOXML}">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst>
</p:presentation>`;

const PPTX_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="${PKG_REL}">
  <Relationship Id="rId1" Type="${OOXML}/slide" Target="slides/slide1.xml"/>
  <Relationship Id="rId2" Type="${OOXML}/slide" Target="slides/slide2.xml"/>
</Relationships>`;

const slideXml = (text: string) => `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`;

function pptxWithSlide(slide: Uint8Array): Uint8Array {
  return zipSync({
    "[Content_Types].xml": xml(PPTX_TYPES),
    "ppt/presentation.xml": xml(PPTX_PRESENTATION),
    "ppt/_rels/presentation.xml.rels": xml(PPTX_RELS),
    "ppt/slides/slide1.xml": slide,
    "ppt/slides/slide2.xml": xml(slideXml("Slide Two Token")),
  });
}

/** A two-slide deck: enough parts for the budget to be checked between slides. */
function pptx(): Uint8Array {
  return pptxWithSlide(xml(slideXml("Slide One Token")));
}

const EPUB_CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const EPUB_OPF = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <manifest><item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="ch1"/></spine>
</package>`;

const xhtml = (title: string, body: string) => `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body><h1>${title}</h1><p>${body}</p></body></html>`;

function epubBytes(files: Record<string, Uint8Array> = {}): Uint8Array {
  return zipStoredMimetype("application/epub+zip", {
    "META-INF/container.xml": xml(EPUB_CONTAINER),
    "OEBPS/content.opf": xml(EPUB_OPF),
    "OEBPS/chapter1.xhtml": xml(xhtml("Chapter One", "Alpha content")),
    ...files,
  });
}

function odtBytes(files: Record<string, Uint8Array> = {}): Uint8Array {
  return zipStoredMimetype("application/vnd.oasis.opendocument.text", {
    "content.xml": xml(`<?xml version="1.0"?><office:document-content
      xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
      xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
      <office:body><office:text><text:p>ODT body</text:p></office:text></office:body>
    </office:document-content>`),
    ...files,
  });
}

const expectArchiveTooLarge = (run: Promise<unknown>) =>
  assert.rejects(run, (error: unknown) => error instanceof ArchiveTooLargeError);

const expectExtractionError = async (run: Promise<unknown>, code: ExtractionError["code"], message?: string) => {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof ExtractionError, `expected ExtractionError, got ${String(error)}`);
    assert.equal(error.code, code);
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  });
};

const expectAbort = (run: Promise<unknown>) =>
  assert.rejects(run, (error: unknown) => error instanceof Error && error.name === "AbortError");

// --- Archive expansion bounds -------------------------------------------------------------------------

test("PPTX: an entry declaring 210 MiB is refused by the archive bounds", async () => {
  const archive = pptxWithSlide(compressible(210 * 1024 * 1024));
  await expectArchiveTooLarge(extract("bomb.pptx", "", archive));
});

test("EPUB: an entry declaring 210 MiB is refused by the archive bounds", async () => {
  const archive = epubBytes({ "OEBPS/chapter1.xhtml": compressible(210 * 1024 * 1024) });
  await expectArchiveTooLarge(extract("bomb.epub", "application/epub+zip", archive));
});

test("ODT: an entry declaring 210 MiB is refused by the archive bounds", async () => {
  const archive = odtBytes({ "content.xml": compressible(210 * 1024 * 1024) });
  await expectArchiveTooLarge(extract("bomb.odt", "application/vnd.oasis.opendocument.text", archive));
});

test("PPTX: a 70 MiB slide part is too large for the selected-part cap", async () => {
  const archive = pptxWithSlide(compressible(70 * 1024 * 1024));
  await expectExtractionError(
    extract("wide.pptx", "", archive),
    "too_large",
    "A part of this file is too large to read. Split it into smaller files.",
  );
});

/**
 * A stored-only ZIP whose central directory adds `copies` entries that all point at the slide's local header and
 * declare originalSize 1 with the slide's full compressed size. fflate copies a stored entry at its compressed
 * size, so each copy allocates the whole slide.
 */
function overlappingStoredPptx(slide: Uint8Array, copies: number): Uint8Array {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const entry = (name: string, size: number, originalSize: number, at: number) => {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt32LE(size, 20);
    header.writeUInt32LE(originalSize, 24);
    header.writeUInt16LE(Buffer.byteLength(name), 28);
    header.writeUInt32LE(at, 42);
    central.push(header, Buffer.from(name));
  };
  const add = (name: string, data: Uint8Array) => {
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(Buffer.byteLength(name), 26);
    locals.push(header, Buffer.from(name), Buffer.from(data));
    entry(name, data.length, data.length, offset);
    const at = offset;
    offset += 30 + Buffer.byteLength(name) + data.length;
    return at;
  };
  add("[Content_Types].xml", xml(PPTX_TYPES));
  add("ppt/presentation.xml", xml(PPTX_PRESENTATION));
  add("ppt/_rels/presentation.xml.rels", xml(PPTX_RELS));
  const at = add("ppt/slides/slide1.xml", slide);
  for (let i = 0; i < copies; i++) entry(`ppt/slides/copy${i}.xml`, slide.length, 1, at);
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(4 + copies, 8);
  end.writeUInt16LE(4 + copies, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

test("ZIP: overlapping stored entries count at the size fflate copies, not their declared size", async () => {
  // Three 24 MiB copies are 72 MiB, over the 64 MiB selected cap; declared as 1 byte each they used to pass.
  const slide = new Uint8Array(24 * 1024 * 1024).fill(0x20);
  await expectExtractionError(extract("overlap.pptx", "", overlappingStoredPptx(slide, 3)), "too_large");
  // One stored entry over the 32 MiB part cap that declares 1 byte.
  const wide = new Uint8Array(33 * 1024 * 1024).fill(0x20);
  await expectExtractionError(extract("overlap.pptx", "", overlappingStoredPptx(wide, 1)), "too_large");
});

test("PPTX: one shape with 20,000 paragraphs is read in linear time", async () => {
  const paragraphs = "<a:p><a:r><a:t>x</a:t></a:r></a:p>".repeat(20_000);
  const slide = slideXml("Shape Token").replace("<a:p>", `${paragraphs}<a:p>`);
  const started = Date.now();
  const result = await extract("dense.pptx", "", pptxWithSlide(xml(slide)));
  // The placeholder lookup was once quadratic here: about 100 s.
  assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
  assert.match(result.text, /Shape Token/);
});

test("XML: a part with more than 300,000 tags and attributes is too large before parsing", async () => {
  const slide = slideXml("Tiny").replace("<a:p>", `${"<a:p/>".repeat(300_001)}<a:p>`);
  await expectExtractionError(
    extract("nodes.pptx", "", pptxWithSlide(xml(slide))),
    "too_large",
    "A part of this file is too large to read. Split it into smaller files.",
  );
});

test("ODT: text:s spaces are bounded across the whole document", async () => {
  // 100,000 elements asking for 1,000 spaces each would be 100 million characters.
  const spaces = 'x<text:s text:c="1000"/>'.repeat(100_000);
  const archive = odtBytes({
    "content.xml": xml(`<?xml version="1.0"?><office:document-content
      xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
      xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
      <office:body><office:text><text:p>${spaces}end</text:p></office:text></office:body>
    </office:document-content>`),
  });
  const result = await extract("spaces.odt", "", archive, { maxChars: 10_000_000 });
  assert.ok(result.text.length <= 400_000 + 200_000 + 3, `kept ${result.text.length} characters`);
  assert.ok(result.text.endsWith("end"));
});

test("A ZIP with 10,001 entries is refused", async () => {
  const files: Record<string, Uint8Array> = {};
  for (let i = 0; i <= 10_000; i++) files[`part-${i}.txt`] = new Uint8Array();
  const archive = zipSync(files);
  await expectArchiveTooLarge(extract("many.zip", "application/zip", archive));
});

// --- Malformed packages -------------------------------------------------------------------------------

test("PPTX: malformed presentation XML is damaged", async () => {
  const archive = zipSync({
    "[Content_Types].xml": xml(PPTX_TYPES),
    "ppt/presentation.xml": xml("<p:presentation><p:sldIdLst>"),
    "ppt/_rels/presentation.xml.rels": xml(PPTX_RELS),
    "ppt/slides/slide1.xml": xml(slideXml("Slide One Token")),
  });
  await expectExtractionError(extract("broken.pptx", "", archive), "damaged", "Could not open this presentation. It may be damaged.");
});

test("EPUB: a missing container.xml is damaged", async () => {
  const archive = zipStoredMimetype("application/epub+zip", {
    "OEBPS/content.opf": xml(EPUB_OPF),
    "OEBPS/chapter1.xhtml": xml(xhtml("Chapter One", "Alpha content")),
  });
  await expectExtractionError(extract("broken.epub", "application/epub+zip", archive), "damaged", "Could not open this EPUB. It may be damaged.");
});

test("ODT: a missing content.xml is damaged", async () => {
  const archive = zipStoredMimetype("application/vnd.oasis.opendocument.text", {
    "META-INF/manifest.xml": xml("<manifest/>"),
  });
  await expectExtractionError(
    extract("broken.odt", "application/vnd.oasis.opendocument.text", archive),
    "damaged",
    "Could not open this OpenDocument file. It may be damaged.",
  );
});

test("PDF: unparseable bytes are damaged", async () => {
  await expectExtractionError(
    extract("broken.pdf", "application/pdf", textBytes("%PDF-1.4 garbage")),
    "damaged",
    "Could not open this PDF. It may be damaged or password-protected.",
  );
});

test("A corrupt ZIP is damaged", async () => {
  const corrupt = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
  await expectExtractionError(extract("broken.zip", "application/zip", corrupt), "damaged", "This file could not be opened. It may be damaged.");
});

// --- Deadline and cancellation ------------------------------------------------------------------------

test("Deadline: a zero budget times out with the fixed message", async () => {
  await expectExtractionError(
    extract("deck.pptx", "", pptx(), { budgetMs: 0 }),
    "timeout",
    "Reading this file took too long. Split it into smaller files.",
  );
});

test("Abort: an already-aborted signal rejects before parsing", async () => {
  const controller = new AbortController();
  controller.abort();
  await expectAbort(extract("notes.txt", "text/plain", textBytes("Hello"), { signal: controller.signal }));
});

test("Abort: an EPUB aborted from onProgress stops between chapters", async () => {
  const twoChapters = zipStoredMimetype("application/epub+zip", {
    "META-INF/container.xml": xml(EPUB_CONTAINER),
    "OEBPS/content.opf": xml(`<?xml version="1.0"?>
      <package xmlns="http://www.idpf.org/2007/opf" version="2.0">
        <manifest>
          <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
          <item id="ch2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
        </manifest>
        <spine><itemref idref="ch1"/><itemref idref="ch2"/></spine>
      </package>`),
    "OEBPS/chapter1.xhtml": xml(xhtml("Chapter One", "Alpha content")),
    "OEBPS/chapter2.xhtml": xml(xhtml("Chapter Two", "Beta content")),
  });
  const controller = new AbortController();
  const seen: number[] = [];
  const run = extract("book.epub", "application/epub+zip", twoChapters, {
    signal: controller.signal,
    onProgress: (fraction) => {
      seen.push(fraction);
      if (fraction >= 0.5) controller.abort();
    },
  });
  await expectAbort(run);
  assert.ok(seen.includes(0.5), `expected progress to reach the first chapter boundary, saw ${seen.join(", ")}`);
});
