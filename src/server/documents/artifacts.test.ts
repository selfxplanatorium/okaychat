import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-documents-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "documents-test-secret-only-not-for-production";
const { db } = await import("../db.js");
const { artifactData, artifactTools, artifactVersions } = await import("../artifacts.js");
const { closeRenderer, rendererAvailable } = await import("./render.js");

after(async () => {
  await closeRenderer();
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

test("view_artifact is offered only to vision models and stores one screenshot per call", { skip: !rendererAvailable() && "Chromium is not installed" }, async () => {
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
