import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { ModelMessage } from "ai";
import { injectScreenshots, MAX_SHOTS_PER_TURN } from "../tools/screenshots.js";
import type { VisualShot } from "./visual.js";
import { createDocx } from "./docx.js";
import { startTestWorker } from "../../browser/test-worker.js";
import { htmlToPdf } from "./render.js";
import { VisualError, screenshotArtifact } from "./visual.js";
import { createXlsx } from "./xlsx.js";

// Screenshots come from the browser worker; this one runs in the test process. Closing it also closes Chromium.
const worker = await startTestWorker();
after(worker.close);

const PNG = [137, 80, 78, 71];
const isPng = (bytes: Uint8Array) => PNG.every((value, i) => bytes[i] === value);

const shot: VisualShot = { png: new Uint8Array([1, 2, 3]), width: 10, height: 20, label: "page 1", errors: [] };

const toolResult = (toolCallId: string, toolName = "view_artifact"): ModelMessage => ({
  role: "tool",
  content: [{ type: "tool-result", toolCallId, toolName, output: { type: "text", value: "captured" } }],
});

test("screenshots are injected once, as a user message, and never repeated", () => {
  const messages: ModelMessage[] = [
    { role: "user", content: [{ type: "text", text: "make a report" }] },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "view_artifact", input: { id: "report" } }] },
    toolResult("c1"),
  ];
  const shots = new Map([["c1", shot]]);
  const injected = new Set<string>();

  const first = injectScreenshots(messages, shots, injected);
  assert.equal(first.length, messages.length + 1);
  const last = first.at(-1)!;
  assert.equal(last.role, "user");
  if (last.role !== "user") return;
  assert.equal(last.content[0]!.type, "text");
  const image = last.content[1]!;
  assert.equal(image.type, "file");
  if (image.type === "file" && image.data.type === "data") assert.deepEqual([...(image.data.data as Uint8Array)], [1, 2, 3]);

  // The next prepareStep sees the image already in the messages and must not add it again.
  assert.equal(injectScreenshots(first, shots, injected).length, first.length);
});

test("screenshots from earlier turns and unrelated tool results are left alone", () => {
  const messages: ModelMessage[] = [
    { role: "user", content: [{ type: "text", text: "next turn" }] },
    toolResult("old-call"),
    toolResult("other", "read_document"),
  ];
  const shots = new Map<string, VisualShot>([["other", shot]]);
  assert.equal(injectScreenshots(messages, shots, new Set()).length, messages.length);
});

test("the per-reply screenshot budget is small enough to bound image tokens", () => {
  assert.ok(MAX_SHOTS_PER_TURN >= 3 && MAX_SHOTS_PER_TURN <= 10);
});

test("visual checks render web, PDF, Word, and spreadsheet artifacts", { skip: !worker.available && "Chromium is not installed" }, async () => {
  const html = await screenshotArtifact({ kind: "html", title: "Page", content: "<style>body{padding:24px}</style><h1>Hello</h1><p>World</p>" });
  assert.ok(isPng(html.png));
  assert.ok(html.width > 100 && html.height > 40 && html.height < 1800);

  const svg = await screenshotArtifact({ kind: "svg", title: "Logo", content: "<svg width='120' height='60'><rect width='120' height='60' fill='#62691b'/></svg>" });
  assert.ok(isPng(svg.png));

  const pdf = await htmlToPdf("<h1>Invoice</h1><div style='break-before:page'>Second</div>");
  const page2 = await screenshotArtifact({ kind: "pdf", title: "Invoice", content: "", data: pdf, page: 2 });
  assert.ok(isPng(page2.png));
  assert.match(page2.label, /page 2 of 2/);
  await assert.rejects(screenshotArtifact({ kind: "pdf", title: "Invoice", content: "", data: pdf, page: 3 }), /has 2 pages/);

  const docx = await createDocx("<h1>Report</h1><p>Hello <strong>World</strong>.</p>");
  const word = await screenshotArtifact({ kind: "docx", title: "Report", content: "", data: docx });
  assert.ok(isPng(word.png));
  assert.match(word.label, /page 1/);

  const xlsx = await createXlsx({ sheets: [{ name: "Costs", header: true, rows: [["Item", "Cost"], ["Hosting", 120]] }] });
  const sheet = await screenshotArtifact({ kind: "xlsx", title: "Costs", content: "", data: xlsx });
  assert.ok(isPng(sheet.png));
  assert.match(sheet.label, /Costs/);
  await assert.rejects(screenshotArtifact({ kind: "xlsx", title: "Costs", content: "", data: xlsx, sheet: "Nope" }), /no sheet named/);
});

test("text artifacts and missing files report what the model should do instead", async () => {
  await assert.rejects(screenshotArtifact({ kind: "markdown", title: "Notes", content: "# Hi" }), /no visual layout/);
  await assert.rejects(screenshotArtifact({ kind: "pdf", title: "Missing", content: "" }), VisualError);
});
