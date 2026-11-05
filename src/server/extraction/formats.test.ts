import assert from "node:assert/strict";
import { test } from "node:test";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { strToU8, zipSync } from "fflate";
import { createDocx, createXlsx } from "../documents/lazy.js";
import { capText, extract, ExtractionError, PDF_NO_TEXT_LAYER } from "./index.js";
import type { ExtractionErrorCode } from "./errors.js";

// Every fixture is built in this file: fflate for ZIP containers, pdf-lib for PDFs, and the application's own
// docx/xlsx writers. Nothing is fetched and nothing is checked in. docs/implementation/extraction.md

const OOXML = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";

const xml = (source: string) => strToU8(source);

async function expectExtractionError(run: Promise<unknown>, code: ExtractionErrorCode, message?: string) {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof ExtractionError, `expected ExtractionError, got ${String(error)}`);
    assert.equal(error.code, code);
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  });
}

// --- PPTX / PPSX ---------------------------------------------------------------------------------------

const contentTypes = (main: string) => `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="${main}"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/notesSlides/notesSlide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>
</Types>`;

const PRESENTATION = `<?xml version="1.0" encoding="UTF-8"?>
<p:presentation xmlns:p="${P}" xmlns:r="${OOXML}">
  <p:sldIdLst>
    <p:sldId id="256" r:id="rId2"/>
    <p:sldId id="257" r:id="rId1"/>
  </p:sldIdLst>
</p:presentation>`;

const PRESENTATION_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="${PKG_REL}">
  <Relationship Id="rId1" Type="${OOXML}/slide" Target="slides/slide1.xml"/>
  <Relationship Id="rId2" Type="${OOXML}/slide" Target="slides/slide2.xml"/>
</Relationships>`;

const slide = (text: string, extra = "") => `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="${P}" xmlns:a="${A}">
  <p:cSld><p:spTree><p:sp><p:txBody>
    <a:p><a:r><a:t>${text}</a:t></a:r>${extra}</a:p>
  </p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`;

const SLIDE_ONE = slide("Slide One Token");
const SLIDE_TWO = slide("Slide Two Token", "<a:br/><a:r><a:t>Second line</a:t></a:r>");

const SLIDE_ONE_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="${PKG_REL}">
  <Relationship Id="rId1" Type="${OOXML}/notesSlide" Target="../notesSlides/notesSlide1.xml"/>
</Relationships>`;

const NOTES_ONE = `<?xml version="1.0" encoding="UTF-8"?>
<p:notes xmlns:p="${P}" xmlns:a="${A}">
  <p:cSld><p:spTree><p:sp><p:txBody>
    <a:p><a:r><a:t>Note from slide one</a:t></a:r></a:p>
  </p:txBody></p:sp></p:spTree></p:cSld>
</p:notes>`;

function pptxBytes(main = "application/vnd.openxmlformats-officedocument.presentationml.main+xml"): Uint8Array {
  return zipSync({
    "[Content_Types].xml": xml(contentTypes(main)),
    "ppt/presentation.xml": xml(PRESENTATION),
    "ppt/_rels/presentation.xml.rels": xml(PRESENTATION_RELS),
    "ppt/slides/slide1.xml": xml(SLIDE_ONE),
    "ppt/slides/slide2.xml": xml(SLIDE_TWO),
    "ppt/slides/_rels/slide1.xml.rels": xml(SLIDE_ONE_RELS),
    "ppt/notesSlides/notesSlide1.xml": xml(NOTES_ONE),
  });
}

test("PPTX: reads slides in presentation order and includes speaker notes", async () => {
  const progress: number[] = [];
  const result = await extract("deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", pptxBytes(), {
    onProgress: (fraction) => progress.push(fraction),
  });
  assert.equal(result.format, "pptx");
  // slide 2 is first in sldIdLst, so it becomes reading position 1.
  assert.equal(
    result.text,
    "## Slide 1\n\nSlide Two Token\nSecond line\n\n## Slide 2\n\nSlide One Token\n\n### Notes\nNote from slide one",
  );
  assert.ok(result.text.startsWith("## Slide 1\n\nSlide Two Token"), "the first heading belongs to slide2 content");
  assert.ok(!result.text.includes("## Slide 1\n\nSlide One Token"));
  assert.ok(progress.length >= 2);
  assert.equal(progress[0], 0);
  assert.equal(progress.at(-1), 1);
  for (let i = 1; i < progress.length; i++) assert.ok(progress[i]! >= progress[i - 1]!, "progress never decreases");
});

test("PPSX: a slideshow content type is read as a presentation", async () => {
  const result = await extract("show.ppsx", "", pptxBytes("application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml"));
  assert.equal(result.format, "pptx");
  assert.match(result.text, /Slide Two Token/);
  assert.match(result.text, /Note from slide one/);
});

// --- EPUB ----------------------------------------------------------------------------------------------

const EPUB_CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const EPUB_OPF = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <manifest>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch2"/>
    <itemref idref="ch1"/>
  </spine>
</package>`;

const chapter = (title: string, body: string) => `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>${title}</title></head>
  <body><h1>${title}</h1><p>${body}</p></body>
</html>`;

function epubBytes(files: Record<string, Uint8Array> = {}): Uint8Array {
  return zipSync({
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": xml(EPUB_CONTAINER),
    "OEBPS/content.opf": xml(EPUB_OPF),
    "OEBPS/chapter1.xhtml": xml(chapter("Chapter One", "Alpha content")),
    "OEBPS/chapter2.xhtml": xml(chapter("Chapter Two", "Beta content")),
    ...files,
  });
}

test("EPUB: follows the spine reading order", async () => {
  const result = await extract("book.epub", "application/epub+zip", epubBytes());
  assert.equal(result.format, "epub");
  assert.ok(result.text.indexOf("# Chapter Two") >= 0);
  assert.ok(result.text.indexOf("# Chapter One") > result.text.indexOf("# Chapter Two"));
  assert.equal(result.text, "# Chapter Two\n\nBeta content\n\n# Chapter One\n\nAlpha content");
});

test("EPUB: a non-font encryption algorithm is refused", async () => {
  const encryption = `<?xml version="1.0"?>
<encryption xmlns="http://www.w3.org/2001/04/xmlenc#">
  <EncryptedData><EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes256-cbc"/></EncryptedData>
</encryption>`;
  await expectExtractionError(
    extract("locked.epub", "application/epub+zip", epubBytes({ "META-INF/encryption.xml": xml(encryption) })),
    "encrypted",
    "This EPUB is encrypted and cannot be read.",
  );
});

// --- HTML ----------------------------------------------------------------------------------------------

const HTML_PAGE = `<!doctype html>
<html>
  <head><style>.StyleToken { color: red; }</style></head>
  <body>
    <h1>Field Guide</h1>
    <p>Quasar paragraph.</p>
    <ul><li>Alpha item</li><li>Beta item</li></ul>
    <table><tr><td>CellAlpha</td><td>CellBeta</td></tr></table>
    <p>Read the <a href="https://secret.example/private">Visible Link</a>.</p>
    <img src="picture.png" alt="Alt Words">
    <script>ScriptToken()</script>
  </body>
</html>`;

test("HTML: keeps readable text, link text, and image alt text, but not scripts or URLs", async () => {
  const result = await extract("guide.html", "text/html", strToU8(HTML_PAGE));
  assert.equal(result.format, "html");
  assert.match(result.text, /^# Field Guide$/m);
  assert.match(result.text, /Quasar paragraph\./);
  assert.match(result.text, /Alpha item/);
  assert.match(result.text, /Beta item/);
  assert.match(result.text, /CellAlpha/);
  assert.match(result.text, /CellBeta/);
  assert.match(result.text, /Visible Link/);
  assert.match(result.text, /Alt Words/);
  assert.ok(!result.text.includes("secret.example"));
  assert.ok(!result.text.includes("ScriptToken"));
  assert.ok(!result.text.includes("StyleToken"));
});

test("HTML: a document title becomes a heading when the body has none", async () => {
  const withTitle = `<!doctype html><html><head><title>Quasar Title</title></head><body><p>Body only.</p></body></html>`;
  const titled = await extract("page.html", "", strToU8(withTitle));
  assert.equal(titled.format, "html");
  assert.ok(titled.text.startsWith("# Quasar Title"));
  assert.match(titled.text, /Body only\./);

  const withoutTitle = `<!doctype html><html><body><p>Body only.</p></body></html>`;
  const untitled = await extract("page.html", "", strToU8(withoutTitle));
  assert.equal(untitled.text, "Body only.");
});

test("HTML: a fragment without an html element keeps its text", async () => {
  const result = await extract("snippet.html", "text/html", strToU8("<h2>Quasar Fragment</h2><p>Fragment body.</p><script>ScriptToken()</script>"));
  assert.equal(result.format, "html");
  assert.match(result.text, /^## Quasar Fragment$/m);
  assert.match(result.text, /Fragment body\./);
  assert.ok(!result.text.includes("ScriptToken"));
});

test("HTML: an ordered list split into batches keeps counting from its start", async () => {
  const items = Array.from({ length: 6_000 }, (_, i) => `<li>Item ${i + 1} padding padding</li>`).join("");
  const result = await extract("list.html", "text/html", strToU8(`<html><body><div><ol start="5">${items}</ol><p>After list.</p></div></body></html>`));
  const numbers = result.text.split("\n").filter((line) => /^\d+\. /.test(line)).map((line) => Number.parseInt(line, 10));
  assert.equal(numbers.length, 6_000);
  assert.ok(numbers.every((value, i) => value === 5 + i));
  assert.match(result.text, /After list\.$/);
});

// --- ODT -----------------------------------------------------------------------------------------------

const ODT_CONTENT = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
  office:version="1.3">
  <office:body>
    <office:text>
      <text:h text:outline-level="1">Document Title</text:h>
      <text:h text:outline-level="2">Section Head</text:h>
      <text:p>Plain paragraph.</text:p>
      <text:list>
        <text:list-item><text:p>First item</text:p></text:list-item>
        <text:list-item><text:p>Second item</text:p></text:list-item>
      </text:list>
      <table:table>
        <table:table-row>
          <table:table-cell><text:p>Name</text:p></table:table-cell>
          <table:table-cell><text:p>Score</text:p></table:table-cell>
        </table:table-row>
        <table:table-row>
          <table:table-cell><text:p>Ada</text:p></table:table-cell>
          <table:table-cell><text:p>42</text:p></table:table-cell>
        </table:table-row>
      </table:table>
      <text:p>Spaced<text:s text:c="3"/>out and<text:line-break/>wrapped.</text:p>
    </office:text>
  </office:body>
</office:document-content>`;

function odtBytes(content = ODT_CONTENT): Uint8Array {
  return zipSync({
    mimetype: [strToU8("application/vnd.oasis.opendocument.text"), { level: 0 }],
    "content.xml": xml(content),
  });
}

test("ODT: walks headings, paragraphs, lists, tables, spaces, and line breaks", async () => {
  const result = await extract("doc.odt", "application/vnd.oasis.opendocument.text", odtBytes());
  assert.equal(result.format, "odt");
  assert.equal(
    result.text,
    "# Document Title\n\n## Section Head\n\nPlain paragraph.\n\n- First item\n- Second item\n\nName | Score\nAda | 42\n\nSpaced   out and\nwrapped.",
  );
});

// --- DOCX / XLSX ---------------------------------------------------------------------------------------

test("DOCX: extracts the document text through the shared creators", async () => {
  const data = await createDocx("<h1>Quasar Heading</h1><p>Quasar body text.</p>", "Quasar Report");
  const result = await extract("report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", data);
  assert.equal(result.format, "docx");
  assert.match(result.text, /Quasar Heading/);
  assert.match(result.text, /Quasar body text\./);
});

test("XLSX: extracts the workbook text through the shared creators", async () => {
  const data = await createXlsx({ sheets: [{ name: "Costs", header: true, rows: [["Item", "Cost"], ["Quasar Hosting", 120]] }] });
  const result = await extract("costs.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", data);
  assert.equal(result.format, "xlsx");
  assert.match(result.text, /Quasar Hosting/);
  assert.match(result.text, /120/);
});

// --- Plain text ----------------------------------------------------------------------------------------

const textBytes = (text: string) => strToU8(text);

test("Text, CSV, JSON, and code files decode as UTF-8", async () => {
  const content = "Héllo 😀\nline two\n";
  for (const [name, mime] of [
    ["notes.txt", "text/plain"],
    ["data.csv", "text/csv"],
    ["data.json", "application/json"],
    ["script.ts", "text/plain"],
  ] as const) {
    const result = await extract(name, mime, textBytes(content));
    assert.equal(result.format, "text", name);
    assert.equal(result.text, content, name);
  }
});

test("Text: a leading BOM is stripped", async () => {
  const result = await extract("bom.txt", "text/plain", textBytes("\uFEFFHello"));
  assert.equal(result.text, "Hello");
});

test("Text: an empty file extracts to an empty string", async () => {
  const result = await extract("empty.txt", "text/plain", new Uint8Array());
  assert.equal(result.text, "");
  assert.equal(result.format, "text");
  assert.equal(result.truncated, undefined);
});

test("Text: 400,001 characters are cut to exactly 400,000", async () => {
  const result = await extract("long.txt", "text/plain", textBytes("a".repeat(400_001)));
  assert.equal(result.text.length, 400_000);
  assert.equal(result.truncated, true);
  assert.equal(result.limit, "characters");
});

test("capText: never splits a surrogate pair", async () => {
  const capped = capText(`${"a".repeat(399_999)}😀`, 400_000);
  assert.equal(capped.text.length, 399_999);
  assert.equal(capped.truncated, true);
  assert.ok(!/[\uD800-\uDBFF]$/.test(capped.text));

  const small = capText("ab😀", 3);
  assert.equal(small.text, "ab");
});

// --- PDF -----------------------------------------------------------------------------------------------

async function pdfWithText(text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage();
  page.drawText(text, { x: 40, y: 700, size: 14, font });
  return new Uint8Array(await doc.save());
}

async function blankPdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage();
  return new Uint8Array(await doc.save());
}

async function longPdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) doc.addPage();
  doc.getPage(0).drawText("First page token", { x: 40, y: 700, size: 14, font });
  return new Uint8Array(await doc.save());
}

test("PDF: keeps page markers and the text layer", async () => {
  const result = await extract("report.pdf", "application/pdf", await pdfWithText("Quasar PDF token"));
  assert.equal(result.format, "pdf");
  assert.equal(result.pages, 1);
  assert.match(result.text, /^--- page 1 ---/);
  assert.match(result.text, /Quasar PDF token/);
});

test("PDF: a blank page reports the no-text-layer sentinel and needs OCR", async () => {
  const result = await extract("scan.pdf", "application/pdf", await blankPdf(1));
  assert.equal(result.format, "pdf");
  assert.equal(result.pages, 1);
  assert.equal(result.needsOcr, "pdf");
  assert.equal(result.text, PDF_NO_TEXT_LAYER);
});

test("PDF: more than 1,000 pages are truncated with the pages limit", async () => {
  const result = await extract("long.pdf", "application/pdf", await longPdf(1_001));
  assert.equal(result.format, "pdf");
  assert.equal(result.pages, 1_001);
  assert.equal(result.truncated, true);
  assert.equal(result.limit, "pages");
  assert.match(result.text, /^--- page 1 ---/);
  assert.match(result.text, /First page token/);
});

// --- Images --------------------------------------------------------------------------------------------

const { default: sharp } = await import("sharp");
const PNG_1X1 = new Uint8Array(await sharp({ create: { width: 1, height: 1, channels: 3, background: "#336699" } }).png().toBuffer());

test("Image: a 1×1 PNG is an image that needs OCR", async () => {
  const result = await extract("pixel.png", "image/png", PNG_1X1);
  assert.equal(result.format, "image");
  assert.equal(result.needsOcr, "image");
  assert.equal(result.text, "");
});

test("Image: BMP, TIFF, and HEIC magic bytes are images", async () => {
  const fixtures: Array<[string, Uint8Array]> = [
    ["bitmap.bmp", new Uint8Array([0x42, 0x4d, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])],
    ["scan.tiff", new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00])],
    ["photo.heic", new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0])],
  ];
  for (const [name, data] of fixtures) {
    const result = await extract(name, "application/octet-stream", data);
    assert.equal(result.format, "image", name);
    assert.equal(result.needsOcr, "image", name);
  }
});

// --- Detection wins over the name and MIME ------------------------------------------------------------

test("Detection: a .docx name holding PPTX bytes reads the slides", async () => {
  const result = await extract("renamed.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", pptxBytes());
  assert.equal(result.format, "pptx");
  assert.match(result.text, /Slide Two Token/);
});

test("Detection: a .pdf name holding text is plain text", async () => {
  const result = await extract("renamed.pdf", "application/pdf", textBytes("Just text bytes"));
  assert.equal(result.format, "text");
  assert.equal(result.text, "Just text bytes");
});

test("Detection: a .txt name holding HTML is HTML", async () => {
  const result = await extract("renamed.txt", "text/plain", strToU8("<html><body><h1>Quasar HTML</h1></body></html>"));
  assert.equal(result.format, "html");
  assert.match(result.text, /Quasar HTML/);
});

test("Detection: a .png name holding text is plain text", async () => {
  const result = await extract("renamed.png", "image/png", textBytes("Not an image"));
  assert.equal(result.format, "text");
  assert.equal(result.text, "Not an image");
});

test("Detection: text starting with BM is text, while a bitmap header is an image under any name", async () => {
  const text = await extract("notes.md", "text/markdown", textBytes("BMW quarterly report"));
  assert.equal(text.format, "text");
  assert.equal(text.text, "BMW quarterly report");
  const header = new Uint8Array(26);
  header.set([0x42, 0x4d, 26, 0, 0, 0, 0, 0, 0, 0, 26, 0, 0, 0, 12]);
  const bitmap = await extract("scan.dat", "application/octet-stream", header);
  assert.equal(bitmap.format, "image");
});

test("Detection: OLE magic is a legacy Office file", async () => {
  const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
  await expectExtractionError(
    extract("old.doc", "application/msword", ole),
    "legacy_office",
    "This is a legacy Office file (.doc, .xls, or .ppt). Save it as .docx, .xlsx, or .pptx and add it again.",
  );
});

test("Detection: an unknown ZIP is refused, never decoded", async () => {
  const unknown = zipSync({ "notes.txt": textBytes("inside") });
  await expectExtractionError(
    extract("archive.zip", "application/zip", unknown),
    "unsupported",
    "This ZIP file is not a supported document. Add the original PDF, Office, OpenDocument, or EPUB file.",
  );
});

test("Detection: ODS and ODP containers are explicitly unsupported", async () => {
  for (const mimetype of ["application/vnd.oasis.opendocument.spreadsheet", "application/vnd.oasis.opendocument.presentation"]) {
    const data = zipSync({ mimetype: [strToU8(mimetype), { level: 0 }], "content.xml": textBytes("<x/>") });
    await expectExtractionError(
      extract("sheet.ods", mimetype, data),
      "odf_unsupported",
      "Only OpenDocument text (.odt) is supported. Save spreadsheets as .xlsx and presentations as .pptx.",
    );
  }
});

test("Detection: RTF is unsupported", async () => {
  await expectExtractionError(
    extract("letter.rtf", "application/rtf", textBytes("{\\rtf1 hello}")),
    "unsupported",
    "RTF files are not supported. Save the document as .docx and add it again.",
  );
});

test("Detection: SVG is unsupported", async () => {
  await expectExtractionError(
    extract("icon.svg", "image/svg+xml", textBytes("<svg xmlns=\"http://www.w3.org/2000/svg\"><rect/></svg>")),
    "unsupported",
    "SVG images are not supported by text extraction. Export a PNG or JPEG.",
  );
});

test("Detection: binary garbage with NULs is unsupported", async () => {
  const garbage = new Uint8Array([0x01, 0x00, 0x02, 0x00, 0x03, 0x04, 0x00, 0x05]);
  await expectExtractionError(
    extract("blob.bin", "application/octet-stream", garbage),
    "unsupported",
    "This file is not a supported document or readable text.",
  );
});

test("Detection: text with too many replacement characters is not readable", async () => {
  const broken = new Uint8Array(200).fill(0xff);
  await expectExtractionError(extract("broken.txt", "text/plain", broken), "not_readable", "This file does not contain readable text.");
});
