import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// End to end against the real sandbox and browser worker containers: run_code outputs are stored, imported as
// artifacts (presentations through LibreOffice), and screenshotted by view_artifact, with quota and ownership
// checks. Not part of `npm test`: test/integration/run.sh starts the containers and sets OKAYCHAT_IT_*.
const sandboxUrl = process.env.OKAYCHAT_IT_SANDBOX_URL;
if (!sandboxUrl) throw new Error("Run through test/integration/run.sh (OKAYCHAT_IT_SANDBOX_URL is not set)");
const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-flow-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "flow-test-secret-only-not-for-production";
process.env.OKAYCHAT_SANDBOX_URL = sandboxUrl;
process.env.OKAYCHAT_SANDBOX_TOKEN = process.env.OKAYCHAT_IT_SANDBOX_TOKEN!;
process.env.OKAYCHAT_BROWSER_URL = process.env.OKAYCHAT_IT_BROWSER_URL!;
process.env.OKAYCHAT_BROWSER_TOKEN_FILE = process.env.OKAYCHAT_IT_BROWSER_TOKEN_FILE!;
const { db } = await import("./db.js");
const { ensureThread } = await import("./threads.js");
const { runCode, SandboxTurn } = await import("./tools/sandbox.js");
const { artifactTools } = await import("./artifacts.js");
const { storageUsed } = await import("./quota.js");
type VisualShot = import("./documents/visual.js").VisualShot;

after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const USER = "usr_flow";
const THREAD = `thr_flow_${Date.now()}`;
for (const id of [USER, "usr_other"]) {
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, `${id}@example.test`, id, "x", "user", Date.now());
}
ensureThread(USER, THREAD);
ensureThread("usr_other", "thr_flow_other");

type Execute = (input: unknown, options: unknown) => Promise<Record<string, unknown>>;
const shots = new Map<string, VisualShot>();
const tools = (userId = USER, threadId = THREAD) => artifactTools(threadId, userId, { shots, canViewImages: true });
const call = (name: string, input: unknown, set = tools()) =>
  (set[name] as unknown as { execute: Execute }).execute(input, { toolCallId: `call_${name}_${Math.random()}`, messages: [], abortSignal: new AbortController().signal });
const isPng = (bytes: Uint8Array) => Buffer.from(bytes.subarray(0, 4)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

const MAKE = String.raw`
import docx, openpyxl, pptx, matplotlib.pyplot as plt
from reportlab.pdfgen import canvas
d = docx.Document(); d.add_heading("Flow report", 1); d.add_paragraph("Made in the sandbox."); d.add_page_break(); d.add_paragraph("Second page"); d.save("report.docx")
wb = openpyxl.Workbook(); ws = wb.active; ws.title = "Costs"; ws.append(["Item", "Cost"]); ws.append(["Hosting", 120]); wb.save("costs.xlsx")
p = pptx.Presentation()
for title in ("Deck title", "Second slide", "Third slide"):
    s = p.slides.add_slide(p.slide_layouts[5]); s.shapes.title.text = title
p.save("deck.pptx")
c = canvas.Canvas("letter.pdf"); c.drawString(72, 720, "Hello from reportlab"); c.showPage(); c.save()
plt.plot([1, 2, 3]); plt.savefig("chart.png")
`;

const outputs: Record<string, string> = {};

test("run_code stores every output in chat storage and charges the quota once", async () => {
  const before = storageUsed(USER);
  const result = await runCode({ userId: USER, threadId: THREAD, language: "python", code: MAKE, timeoutS: 120 });
  assert.equal(result.exitCode, 0, result.stderr);
  const names = result.files.map((f) => f.path).sort();
  assert.deepEqual(names, ["chart.png", "costs.xlsx", "deck.pptx", "letter.pdf", "report.docx"]);
  for (const file of result.files) {
    assert.ok(file.fileId?.startsWith("sbf_") && file.url.includes("/stored?"), JSON.stringify(file));
    outputs[file.path] = file.fileId!;
  }
  const bytes = result.files.reduce((sum, f) => sum + f.size, 0);
  assert.equal(storageUsed(USER) - before, bytes);
  const image = result.files.find((f) => f.path === "chart.png")!;
  assert.equal(image.image, true);
});

test("import_document turns owned sandbox outputs into artifacts, presentations as PDF, and view_artifact sees them", async () => {
  const cases: Array<[string, string, string, string]> = [
    ["report.docx", "report", "docx", "page 1 of 2"],
    ["costs.xlsx", "costs", "xlsx", 'sheet "Costs"'],
    ["letter.pdf", "letter", "pdf", "page 1 of 1"],
    ["deck.pptx", "deck", "pdf", "page 1 of 3"],
  ];
  for (const [file, id, kind, label] of cases) {
    const before = storageUsed(USER);
    const set = tools();
    const imported = await call("import_document", { file_id: outputs[file], id, title: id }, set);
    assert.equal(imported.kind, kind, `${file}: ${JSON.stringify(imported)}`);
    const size = imported.size as number;
    assert.ok(size > 500);
    assert.equal(storageUsed(USER) - before, size, `${file} charged its artifact copy once`);
    // A retry in the same turn returns the same artifact instead of a second copy.
    assert.deepEqual(await call("import_document", { file_id: outputs[file], id, title: id }, set), imported);
    assert.equal(storageUsed(USER) - before, size);
    const shot = await call("view_artifact", { id: imported.id }, set);
    assert.equal(shot.capture, label, `${file}: ${JSON.stringify(shot)}`);
    const png = [...shots.values()].at(-1)!;
    assert.ok(isPng(png.png) && png.width > 100 && png.height > 100, `${file}: ${png.width}x${png.height}`);
  }
  const last = await call("view_artifact", { id: "deck", page: 3 });
  assert.equal(last.capture, "page 3 of 3");
  await assert.rejects(call("view_artifact", { id: "deck", page: 4 }), /This PDF has 3 pages/);
});

test("another account's sandbox output cannot be imported", async () => {
  await assert.rejects(call("import_document", { file_id: outputs["report.docx"], id: "stolen", title: "x" }, tools("usr_other", "thr_flow_other")), /no longer saved/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM artifacts WHERE thread_id = 'thr_flow_other'").get()!.n, 0);
});

test("an import that would pass the quota stores nothing", async () => {
  const used = storageUsed(USER);
  db.prepare("UPDATE users SET storage_limit = ? WHERE id = ?").run(used + 1000, USER);
  try {
    const rows = db.prepare("SELECT count(*) AS n FROM artifacts WHERE thread_id = ?").get(THREAD)!.n;
    await assert.rejects(call("import_document", { file_id: outputs["deck.pptx"], id: "deck-again", title: "x" }), /storage/i);
    assert.equal(db.prepare("SELECT count(*) AS n FROM artifacts WHERE thread_id = ?").get(THREAD)!.n, rows);
    assert.equal(storageUsed(USER), used);
  } finally {
    db.prepare("UPDATE users SET storage_limit = NULL WHERE id = ?").run(USER);
  }
});

test("an output over 50 MB gets a size message instead of a dead link, and the others are kept", async () => {
  const result = await runCode({
    userId: USER,
    threadId: THREAD,
    language: "bash",
    code: "head -c 60000000 /dev/urandom > huge.bin && echo small > small.txt",
    timeoutS: 60,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(result.files.map((f) => f.path), ["small.txt"]);
  assert.deepEqual(result.tooLarge, [{ path: "huge.bin", size: 60_000_000 }]);
  assert.match(result.storageWarning!, /huge\.bin \(57\.2 MB\).*50 MB/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sandbox_files WHERE thread_id = ? AND path = 'huge.bin'").get(THREAD)!.n, 0);
});

test("a finished turn keeps the last file-writing run's outputs and earlier turns' files", async () => {
  const turn = new SandboxTurn();
  await runCode({ userId: USER, threadId: THREAD, language: "bash", code: "echo draft > draft.txt", turn });
  await runCode({ userId: USER, threadId: THREAD, language: "bash", code: "echo final > final.txt", turn });
  turn.prune(USER);
  const paths = (db.prepare("SELECT path FROM sandbox_files WHERE thread_id = ? ORDER BY path").all(THREAD) as Array<{ path: string }>).map((r) => r.path);
  assert.ok(paths.includes("final.txt") && !paths.includes("draft.txt") && paths.includes("report.docx"), paths.join(","));
});

test("stopping the chat cancels the run in the sandbox", async () => {
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 1500);
  const result = await runCode({ userId: USER, threadId: THREAD, language: "bash", code: "sleep 1000 & sleep 50; echo finished", timeoutS: 60, signal: controller.signal });
  assert.equal(result.stopped, "cancelled");
  assert.ok(Date.now() - started < 10_000, `${Date.now() - started} ms`);
  const after = await runCode({ userId: USER, threadId: THREAD, language: "bash", code: "pgrep -c sleep || true" });
  assert.equal(after.stdout.trim(), "0");
});
