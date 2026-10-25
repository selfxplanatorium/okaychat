import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createDocx, editDocx, readDocxText } from "./docx.js";
import { editPdf, readPdf } from "./pdf.js";
import { startTestWorker } from "../../browser/test-worker.js";
import { htmlToPdf, pageFurniture, printDocument } from "./render.js";
import { createXlsx, editXlsx, previewXlsx, readXlsx, loadXlsx } from "./xlsx.js";

// PDFs come from the browser worker; this one runs in the test process. Closing it also closes Chromium.
const worker = await startTestWorker();
after(worker.close);

const text = new TextDecoder();

test("xlsx: formulas are evaluated and stored, and cells read back with their value", async () => {
  const data = await createXlsx({
    sheets: [
      {
        name: "Costs",
        header: true,
        rows: [
          ["Item", "Cost"],
          ["Hosting", 120],
          ["Support", 80],
          ["Total", "=SUM(B2:B3)"],
          ["Double", "=B4*2"],
        ],
      },
    ],
  });
  assert.ok(data.byteLength > 1000);
  const view = await readXlsx(data);
  assert.match(view, /Hosting/);
  assert.match(view, /=SUM\(B2:B3\) → 200/);
  assert.match(view, /=B4\*2 → 400/);
  const preview = await previewXlsx(data);
  assert.equal(preview.length, 1);
  assert.equal(preview[0]!.rows[3]!.cells[1]!.t, "200");
});

test("xlsx: formatting, row insertion, and reference shifting survive a round trip", async () => {
  const created = await createXlsx({
    sheets: [{ name: "S", rows: [[1], [2], ["=A2*2"]] }],
  });
  const edited = await editXlsx(created, [
    { op: "format", range: "A1", style: { bold: true, fill: "#ffdd00" } },
    { op: "insert_rows", at: 2 },
    { op: "set_cells", start: "A2", values: [["inserted"]] },
  ]);
  const wb = await loadXlsx(edited);
  const ws = wb.getWorksheet("S")!;
  assert.equal(ws.getCell("A4").formula, "A3*2");
  assert.equal(ws.getCell("A1").font?.bold, true);
  const view = await readXlsx(edited);
  assert.match(view, /inserted/);
  assert.match(view, /=A3\*2 → 4/);
});

test("docx: a fragment that starts with <style> keeps its CSS out of the text", async () => {
  const data = await createDocx('<style>h1{color:#b00020}</style><h1>Title</h1><p>Body</p>', "Doc");
  const view = readDocxText(data);
  assert.match(view, /\[Heading1\] Title/);
  assert.match(view, /\[Normal\] Body/);
  assert.doesNotMatch(view, /color:#b00020/);
});

const REPORT = `<!doctype html><html><head><style>
  @page { size: Letter landscape; margin: 20mm }
  .note { color: #b00020; font-weight: bold }
</style></head><body>
  <header>Report · page {page} of {pages}</header>
  <h1>Quarterly Report</h1>
  <p>Hello <strong>bold</strong> and <em>italic</em> text.</p>
  <p class="note">A styled paragraph.</p>
  <ul><li>One</li><li>Two</li></ul>
  <table><tr><th>Name</th><th>Qty</th></tr><tr><td>Hosting</td><td>120</td></tr></table>
  <footer>Internal</footer>
</body></html>`;

test("docx: plain text becomes paragraphs instead of one block", async () => {
  const data = await createDocx("First paragraph.\n\nSecond paragraph.\nStill second.", "Notes");
  const view = readDocxText(data);
  assert.match(view, /1\. \[Normal\] First paragraph\./);
  assert.match(view, /2\. \[Normal\] Second paragraph\./);
});

test("docx: HTML becomes a Word document with headings, lists, tables and page setup", async () => {
  const data = await createDocx(REPORT, "Report");
  assert.equal(text.decode(data.slice(0, 2)), "PK");
  const view = readDocxText(data);
  assert.match(view, /\[Heading1\] Quarterly Report/);
  assert.match(view, /Hello bold and italic text\./);
  assert.match(view, /\[ListParagraph\] One/);
  assert.match(view, /Hosting/);
});

test("docx: replace_text spans split runs and keeps paragraph indices stable", async () => {
  const data = await createDocx(REPORT, "Report");
  const edited = editDocx(data, [{ op: "replace_text", find: "bold and italic", replace: "BOLD and italic", paragraph: 2 }]);
  const view = readDocxText(edited);
  assert.match(view, /Hello BOLD and italic text\./);
  assert.doesNotMatch(view, /bold and italic text/);
});

test("docx: insert, restyle and delete paragraphs", async () => {
  const data = await createDocx("<h2>Title</h2><p>First</p><p>Second</p>", "Doc");
  const edited = editDocx(data, [
    { op: "insert_paragraph", after: 2, text: "Inserted", style: "Heading3" },
    { op: "set_style", paragraph: 1, style: "Heading1" },
    { op: "set_text", paragraph: 4, text: "Replaced" },
  ]);
  const view = readDocxText(edited);
  assert.match(view, /1\. \[Heading1\] Title/);
  assert.match(view, /3\. \[Heading3\] Inserted/);
  assert.match(view, /4\. \[Normal\] Replaced/);
  assert.doesNotMatch(view, /Second/);
});

test("docx: a missing find target reports the paragraph", async () => {
  const data = await createDocx("<p>Hello</p>");
  assert.throws(() => editDocx(data, [{ op: "replace_text", find: "missing", replace: "x" }]), /not found/);
});

test("pdf: HTML renders to a text PDF and ops change it", { skip: !worker.available && "Chromium is not installed" }, async () => {
  const html = "<header>Invoice · page {page} of {pages}</header><h1>Invoice</h1><p>Total: €120</p><div style='break-before:page'>Page two</div>";
  const furniture = pageFurniture(html);
  const pdf = await htmlToPdf(printDocument(furniture.body), { headerTemplate: furniture.headerTemplate, footerTemplate: furniture.footerTemplate });
  assert.equal(text.decode(pdf.slice(0, 5)), "%PDF-");
  const view = await readPdf(pdf);
  assert.match(view, /Pages: 2/);
  assert.match(view, /Invoice/);
  assert.match(view, /Page two/);
  assert.match(view, /Invoice · page 1 of 2/);
  assert.match(view, /Invoice · page 2 of 2/);

  const edited = await editPdf(pdf, [
    { op: "add_text", page: 1, x: 60, y: 60, text: "PAID", size: 18, color: "#1a7f37" },
    { op: "set_metadata", title: "Invoice 1", author: "okaychat" },
  ]);
  assert.match(await readPdf(edited), /PAID/);
  await assert.rejects(editPdf(edited, [{ op: "delete_pages", pages: "1-2" }]), /at least one page|Operation 1/);
});
