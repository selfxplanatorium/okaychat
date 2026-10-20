import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { Hono } from "hono";
import type { LibraryPage } from "../shared/types.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-library-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "library-test-secret-only-not-for-production";
const { db } = await import("./db.js");
const { requireUser } = await import("./auth.js");
const { sha256 } = await import("./crypto.js");
const { libraryRoutes } = await import("./library.js");
const { imagePath } = await import("./tools/image.js");

const app = new Hono().use(requireUser).route("/", libraryRoutes);
for (const id of ["alice", "bob"]) {
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, `${id}@example.test`, id, "unused", "user", Date.now());
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(id), id, Date.now() + 60_000);
}
after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});
const thread = (id: string, user: string, projectId: string | null, title: string) =>
  db.prepare("INSERT INTO threads (id, user_id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, user, projectId, title, Date.now(), Date.now());
beforeEach(() => {
  db.exec("DELETE FROM messages; DELETE FROM artifacts; DELETE FROM images; DELETE FROM uploads; DELETE FROM threads; DELETE FROM projects;");
  db.prepare("INSERT INTO projects (id, user_id, name, created_at) VALUES ('p1', 'alice', 'Atlas', ?)").run(Date.now());
  thread("t1", "alice", "p1", "Atlas chat");
  thread("t2", "alice", null, "Solo chat");
  thread("t9", "bob", null, "Bob chat");
});

const message = (threadId: string, id: string, text: string) =>
  db.prepare("INSERT INTO messages (thread_id, id, parent_id, format, content, created_at) VALUES (?, ?, NULL, 'ai-sdk/v6', ?, ?)").run(
    threadId,
    id,
    JSON.stringify({ role: "user", parts: [{ type: "text", text }] }),
    Date.now(),
  );

const upload = (id: string, user: string, name: string, mime: string) =>
  db.prepare("INSERT INTO uploads (id, user_id, name, mime, data, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, user, name, mime, Buffer.from("bytes"), Date.now());

const image = (id: string, user: string, threadId: string | null, prompt: string) => {
  mkdirSync(path.join(dataDir, "images", user), { recursive: true });
  writeFileSync(imagePath(user, id), Buffer.alloc(42));
  db.prepare("INSERT INTO images (id, user_id, thread_id, prompt, width, height, size, created_at) VALUES (?, ?, ?, ?, 8, 8, 42, ?)").run(id, user, threadId, prompt, Date.now());
};

const artifact = (threadId: string, id: string, version: number, title: string, kind: string, content: string, data?: Buffer) =>
  db.prepare("INSERT INTO artifacts (thread_id, id, version, title, kind, language, content, data, size, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)").run(
    threadId,
    id,
    version,
    title,
    kind,
    content,
    data ?? null,
    data?.byteLength ?? 0,
    Date.now() + version,
  );

const request = (path: string, user = "alice", method = "GET") => app.request(`http://app${path}`, { method, headers: { cookie: `okaychat_session=${user}` } });
const get = async (path: string, user = "alice") => (await (await request(path, user)).json()) as LibraryPage;
const names = (page: LibraryPage) => page.items.map((i) => i.name);

test("the library requires an authenticated account", async () => {
  assert.equal((await app.request("http://app/library")).status, 401);
});

test("it lists uploads, generated images, and the latest artifact version, for the user only", async () => {
  upload("upl_a", "alice", "report.pdf", "application/pdf");
  upload("upl_other", "bob", "secret.pdf", "application/pdf");
  image("img_a", "alice", "t1", "A red cube");
  image("img_bob", "bob", "t9", "Bob art");
  artifact("t1", "site", 1, "Old site", "html", "<h1>Hi</h1>");
  artifact("t1", "site", 2, "Site", "html", "<h1>Hi v2</h1>");
  artifact("t9", "bob-doc", 1, "Bob doc", "code", "print(1)");

  const page = await get("/library");
  assert.deepEqual(names(page), ["Site", "A red cube", "report.pdf"]);
  const site = page.items[0]!;
  assert.equal(site.kind, "code");
  assert.equal(site.artifactKind, "html");
  assert.equal(site.size, Buffer.byteLength("<h1>Hi v2</h1>"));
  assert.equal(site.source, "generated");
  assert.equal(site.threadTitle, "Atlas chat");
  assert.equal(site.projectId, "p1");
  assert.equal(site.downloadUrl, null);
  const pdf = page.items[2]!;
  assert.equal(pdf.source, "uploaded");
  assert.equal(pdf.deletable, true);
  assert.match(pdf.downloadUrl!, /^\/api\/uploads\/upl_a\/file/);
  const cube = page.items[1]!;
  assert.equal(cube.size, 42);
  assert.equal(cube.previewUrl, "/api/images/img_a");
});

test("upload threads are recovered from the attachment headers in messages", async () => {
  upload("upl_csv", "alice", "data.csv", "text/csv");
  message("t2", "m1", `<attachment name="data.csv" file_id="upl_csv"></attachment>`);
  const page = await get("/library");
  assert.equal(page.items[0]!.threadId, "t2");
  assert.equal(page.items[0]!.threadTitle, "Solo chat");
  assert.equal(page.items[0]!.projectId, null);
});

test("filters: kind, source, thread, project, name search, and date range", async () => {
  upload("upl_a", "alice", "report.pdf", "application/pdf");
  upload("upl_b", "alice", "photo.png", "image/png");
  upload("upl_c", "alice", "notes.txt", "text/plain");
  image("img_a", "alice", "t1", "A red cube");
  artifact("t1", "site", 1, "Site", "html", "<h1>Hi</h1>");

  assert.deepEqual(names(await get("/library?kind=pdf")), ["report.pdf"]);
  assert.deepEqual(names(await get("/library?source=generated")), ["Site", "A red cube"]);
  assert.deepEqual(names(await get("/library?thread=t2")), []);
  assert.deepEqual(names(await get("/library?project=p1")), ["Site", "A red cube"]);
  // LIKE wildcards in the query match literally.
  assert.deepEqual(names(await get("/library?q=repo%_rt")), []);
  assert.deepEqual(names(await get("/library?q=report")), ["report.pdf"]);
  const yesterday = Date.now() - 86_400_000;
  assert.deepEqual(names(await get(`/library?from=${Date.now() + 5000}`)), []);
  assert.deepEqual(names(await get(`/library?to=${yesterday}`)), []);
});

test("sorting by name and size orders the page", async () => {
  upload("upl_a", "alice", "big.bin", "application/octet-stream");
  db.prepare("UPDATE uploads SET data = ? WHERE id = 'upl_a'").run(Buffer.alloc(5000));
  upload("upl_b", "alice", "small.bin", "application/octet-stream");
  artifact("t1", "site", 1, "A site", "html", "<h1>Hi</h1>");
  assert.deepEqual(names(await get("/library?sort=name")), ["A site", "big.bin", "small.bin"]);
  assert.deepEqual(names(await get("/library?sort=size")), ["big.bin", "A site", "small.bin"]);
});

test("cursor pagination walks every row exactly once", async () => {
  for (let i = 0; i < 5; i++) artifact("t1", `doc${i}`, 1, `Doc ${i}`, "code", `x = ${i}`);
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await get(`/library?sort=name&limit=2${cursor ? `&cursor=${cursor}` : ""}`);
    seen.push(...page.items.map((i) => i.id));
    cursor = page.nextCursor ?? undefined;
    assert.ok((pages += 1) < 10, "pagination must end");
  } while (cursor);
  assert.deepEqual(seen.sort(), [0, 1, 2, 3, 4].map((d) => `artifact:t1/doc${d}`));
  // A garbage cursor is the end of the list, not an error.
  assert.deepEqual((await get("/library?cursor=not-a-cursor")).items, []);
});

test("deleting an image or upload is scoped to the owner", async () => {
  image("img_a", "alice", "t1", "A red cube");
  upload("upl_a", "alice", "report.pdf", "application/pdf");
  assert.equal((await request("/library/image/img_a", "bob", "DELETE")).status, 404);
  assert.equal((await request("/library/image/img_a", "alice", "DELETE")).status, 200);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM images").get() as { n: number }).n, 0);
  assert.throws(() => statSync(imagePath("alice", "img_a")));
  assert.equal((await request("/library/upload/upl_a", "alice", "DELETE")).status, 200);
  assert.equal((await request("/library/upload/upl_a", "alice", "DELETE")).status, 404);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM uploads").get() as { n: number }).n, 0);
});

test("case-insensitive name pagination does not skip case-only ties and size sorting uses stored image bytes", async () => {
  upload("upl_a", "alice", "Alpha.txt", "text/plain");
  upload("upl_b", "alice", "alpha.txt", "text/plain");
  image("img_large", "alice", "t1", "large image");
  const first = await get("/library?sort=name&limit=1");
  const second = await get(`/library?sort=name&limit=1&cursor=${first.nextCursor}`);
  assert.equal(first.items[0]!.id, "upload:upl_a");
  assert.equal(second.items[0]!.id, "upload:upl_b");
  assert.equal((await get("/library?sort=size&limit=1")).items[0]!.id, "image:img_large");
});
