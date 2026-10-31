import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-documents-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "documents-test-secret-only-not-for-production";
const { db } = await import("../db.js");
const { artifactData, artifactTools, artifactVersions, artifactsInCurrentTurn } = await import("../artifacts.js");
const { startTestWorker } = await import("../../browser/test-worker.js");
const worker = await startTestWorker();

after(async () => {
  await worker.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const USER = "usr_docs_test";
const THREAD = "thr_docs_test";
db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(USER, "docs@example.test", "Docs", "x", "user", Date.now());
db.prepare("INSERT INTO threads (id, user_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(THREAD, USER, "Docs", "regular", Date.now(), Date.now());

type Execute = (input: never, options: never) => Promise<unknown>;
const run = async (name: string, input: unknown) => {
  const tool = artifactTools(THREAD, USER)[name] as unknown as { execute: Execute };
  return tool.execute(input as never, { toolCallId: "t", messages: [] } as never) as Promise<Record<string, unknown>>;
};

/** The JSON-quoted body of the deterministic data envelope. */
const envelopeBody = (text: string): string => {
  const end = text.lastIndexOf("\n</untrusted_data>");
  return JSON.parse(text.slice(text.lastIndexOf("\n", end - 1) + 1, end)) as string;
};

test("create_document builds an xlsx artifact, edits rebuild it, and read_document sees values", async () => {
  const created = await run("create_document", {
    id: "Budget",
    title: "Q4 Budget",
    kind: "xlsx",
    content: JSON.stringify({ sheets: [{ name: "Budget", header: true, rows: [["Item", "Cost"], ["Hosting", 120], ["Total", "=SUM(B2:B2)"]] }] }),
  });
  assert.equal(created.id, "budget");
  assert.equal(created.version, 1);
  assert.ok((created.size as number) > 1000);
  // Bytes stay out of the version list.
  const versions = artifactVersions(THREAD, "budget");
  assert.equal(versions[0]!.content.includes('"sheets"'), true);
  assert.equal(versions[0]!.size, created.size);
  assert.ok(artifactData(THREAD, "budget")!.byteLength > 1000);

  const read = await run("read_document", { id: "budget" });
  assert.match(read.text as string, /=SUM\(B2:B2\)/);

  const edited = await run("edit_document", { id: "budget", edits: [{ old: '"Hosting",120', new: '"Hosting",150' }] });
  assert.equal(edited.version, 2);
  const after = await run("read_document", { id: "budget" });
  assert.match(after.text as string, /150/);

  // A binary edit drops the source, so a later rebuild cannot undo it.
  const binary = await run("edit_document", { id: "budget", xlsx_ops: [{ op: "set_cells", start: "C1", values: [["Note"]] }] });
  assert.equal(binary.version, 3);
  assert.equal(artifactVersions(THREAD, "budget").at(-1)!.content, "");
});

test("read_artifact and read_document keep paging/edit metadata inside the data envelope", async () => {
  db.prepare("INSERT INTO artifacts (thread_id, id, version, title, kind, language, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(THREAD, "snippet", 1, "Snippet", "code", "ts", "const a = 1;", Date.now());
  const tools = artifactTools(THREAD, USER);
  const toModel = (name: string, output: unknown) =>
    (tools[name] as unknown as { toModelOutput: (options: { toolCallId: string; input: unknown; output: unknown }) => Promise<{ type: string; value: string }> })
      .toModelOutput({ toolCallId: "t", input: { id: "snippet" }, output });

  const artifact = await run("read_artifact", { id: "snippet" });
  const artifactView = await toModel("read_artifact", artifact);
  assert.match(artifactView.value, /kind="artifact"/);
  assert.deepEqual(JSON.parse(envelopeBody(artifactView.value)), { id: "snippet", version: 1, title: "Snippet", kind: "code", language: "ts", content: "const a = 1;" });
  assert.doesNotMatch(artifactView.value, /injection/, "advisory bookkeeping is not part of the model contract");

  const created = await run("create_document", { id: "docview", title: "View", kind: "docx", content: "<p>Hello</p>" });
  const read = await run("read_document", { id: "docview" });
  const documentView = await toModel("read_document", read);
  const parsed = JSON.parse(envelopeBody(documentView.value)) as { id: string; version: number; kind: string; text: string };
  assert.equal(parsed.id, "docview");
  assert.equal(parsed.version, created.version);
  assert.equal(parsed.kind, "docx");
  assert.match(parsed.text, /Hello/);
});

test("create_document builds a docx artifact that reads and edits by paragraph", async () => {
  const created = await run("create_document", {
    id: "Letter",
    title: "Offer Letter",
    kind: "docx",
    content: "<h1>Offer</h1><p>Dear <strong>Ada</strong>,</p><p>Welcome.</p>",
  });
  assert.equal(created.kind, "docx");
  const read = await run("read_document", { id: "letter" });
  assert.match(read.text as string, /\[Heading1\] Offer/);

  await run("edit_document", { id: "letter", docx_ops: [{ op: "replace_text", find: "Welcome.", replace: "Welcome aboard." }] });
  const after = await run("read_document", { id: "letter" });
  assert.match(after.text as string, /Welcome aboard\./);
});

test("import_document copies an upload and refuses unknown formats", async () => {
  const bytes = new Uint8Array([80, 75, 3, 4]);
  db.prepare("INSERT INTO uploads (id, user_id, name, mime, data, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    "upl_test",
    USER,
    "source.docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    Buffer.from(bytes),
    Date.now(),
  );
  // The copy carries the attachment's bytes verbatim, even if it is not a valid Office file.
  const imported = await run("import_document", { file_id: "upl_test", id: "Source", title: "Source" });
  assert.equal(imported.kind, "docx");
  assert.deepEqual([...artifactData(THREAD, "source")!], [...bytes]);

  // Models that receive the extracted text instead of the PDF file part only see the filename.
  const byName = await run("import_document", { name: "source.docx", id: "ByName", title: "By name" });
  assert.equal(byName.kind, "docx");

  await assert.rejects(run("import_document", { file_id: "nope", id: "x", title: "x" }), /no longer available/);
  await assert.rejects(run("import_document", { id: "x", title: "x" }), /file_id or name/);
});

test("import_document takes the caller's own run_code outputs by fileId, never another account's", async () => {
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("usr_docs_other", "other@example.test", "Other", "x", "user", Date.now());
  db.prepare("INSERT INTO threads (id, user_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("thr_docs_other", "usr_docs_other", "Other", "regular", Date.now(), Date.now());
  const insert = db.prepare("INSERT INTO sandbox_files (id, user_id, thread_id, path, mime, data, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const pdf = Buffer.from("%PDF-1.4 fake");
  insert.run("sbf_mine", USER, THREAD, "out/report.pdf", "application/pdf", pdf, pdf.byteLength, Date.now());
  insert.run("sbf_theirs", "usr_docs_other", "thr_docs_other", "secret.pdf", "application/pdf", pdf, pdf.byteLength, Date.now());
  insert.run("sbf_notes", USER, THREAD, "notes.txt", "text/plain", Buffer.from("x"), 1, Date.now());
  const imported = await run("import_document", { file_id: "sbf_mine", id: "report", title: "Report" });
  assert.equal(imported.kind, "pdf");
  assert.deepEqual(Buffer.from(artifactData(THREAD, "report")!), pdf);
  await assert.rejects(run("import_document", { file_id: "sbf_theirs", id: "stolen", title: "x" }), /no longer saved/);
  await assert.rejects(run("import_document", { file_id: "sbf_notes", id: "notes", title: "x" }), /notes\.txt/);
  // Without a sandbox there is no LibreOffice to turn a presentation into a PDF.
  insert.run("sbf_deck", USER, THREAD, "deck.pptx", "application/octet-stream", Buffer.from("PK"), 2, Date.now());
  await assert.rejects(run("import_document", { file_id: "sbf_deck", id: "deck", title: "Deck" }), /needs the code sandbox/);
  assert.equal(artifactVersions(THREAD, "deck").length, 0);
});

test("import_document re-imports a run_code output that a later run rewrote under the same fileId", async () => {
  const insert = db.prepare("INSERT INTO sandbox_files (id, user_id, thread_id, path, mime, data, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const first = Buffer.from("%PDF-1.4 draft");
  insert.run("sbf_score", USER, THREAD, "score.pdf", "application/pdf", first, first.byteLength, Date.now());
  const tools = artifactTools(THREAD, USER);
  const importDoc = (tools.import_document as unknown as { execute: Execute }).execute;
  const call = () => importDoc({ file_id: "sbf_score", id: "score", title: "Score" } as never, { toolCallId: "t", messages: [] } as never) as Promise<Record<string, unknown>>;
  assert.equal((await call()).size, first.byteLength);
  // A retry of unchanged bytes is the same result.
  assert.equal((await call()).size, first.byteLength);
  const fixed = Buffer.from("%PDF-1.4 fixed score");
  db.prepare("UPDATE sandbox_files SET data = ?, size = ? WHERE id = ?").run(fixed, fixed.byteLength, "sbf_score");
  assert.equal((await call()).size, fixed.byteLength);
  assert.deepEqual(Buffer.from(artifactData(THREAD, "score")!), fixed);
});

test("view_artifact is offered only to vision models and stores one screenshot per call", { skip: !worker.available && "Chromium is not installed" }, async () => {
  const blind = artifactTools(THREAD, USER, { canViewImages: false });
  assert.equal(blind.view_artifact, undefined);

  const shots = new Map();
  const tools = artifactTools(THREAD, USER, { shots, canViewImages: true });
  const view = tools.view_artifact as unknown as { execute: (input: unknown, options: unknown) => Promise<Record<string, unknown>> } | undefined;
  assert.ok(view, "vision models get the visual check");

  await run("create_artifact", { id: "visual-page", title: "Visual page", kind: "html", content: "<style>body{padding:24px}</style><h1>Hello</h1>" });
  const result = await view!.execute({ id: "visual-page" }, { toolCallId: "call-shot", messages: [] });
  assert.equal(result.kind, "html");
  assert.equal(result.capture, "the visible page");
  assert.ok((result.width as number) > 100);
  assert.ok(shots.has("call-shot"));

  const stored = shots.get("call-shot") as { png: Uint8Array };
  assert.deepEqual([...stored.png.slice(0, 4)], [137, 80, 78, 71]);
});

test("each turn saves one version per artifact, however many edits it makes", async () => {
  const turn = (savedThisTurn?: string[]) => {
    const tools = artifactTools(THREAD, USER, { savedThisTurn });
    return (name: string, input: unknown) =>
      (tools[name] as unknown as { execute: Execute }).execute(input as never, { toolCallId: "t", messages: [] } as never) as Promise<Record<string, unknown>>;
  };
  await turn()("create_artifact", { id: "notes", title: "Notes", kind: "markdown", content: "a" });
  const second = turn();
  await second("update_artifact", { id: "notes", content: "b" });
  const last = await second("update_artifact", { id: "notes", content: "c" });
  assert.equal(last.version, 2);
  // A browser-tool continuation of the same turn still edits version 2.
  await turn(["notes"])("update_artifact", { id: "notes", content: "d" });
  assert.deepEqual(artifactVersions(THREAD, "notes").map((v) => [v.version, v.content]), [[1, "a"], [2, "d"]]);
  assert.deepEqual(
    [...artifactsInCurrentTurn([
      { role: "user", parts: [] },
      { role: "assistant", parts: [{ type: "tool-update_artifact", output: { id: "old" } }] },
      { role: "user", parts: [] },
      { role: "assistant", parts: [{ type: "tool-edit_document", output: { id: "report" } }, { type: "tool-edit_document", output: "Edit failed" }] },
    ])],
    ["report"],
  );
});
