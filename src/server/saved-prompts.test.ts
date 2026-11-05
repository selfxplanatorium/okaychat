import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { Hono } from "hono";
import { MAX_PROMPT_BODY, MAX_SAVED_PROMPTS, SAVED_PROMPT_BODY_LIMIT, type SavedPrompt } from "../shared/saved-prompts.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-saved-prompts-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "saved-prompts-test-secret-only-not-for-production";
writeFileSync(path.join(dataDir, "models-dev.json"), JSON.stringify({ data: {}, fetchedAt: Date.now() }));
const { db } = await import("./db.js");
const { sha256 } = await import("./crypto.js");
const { api } = await import("./routes.js");
const { storageUsed } = await import("./quota.js");

const app = new Hono().route("/api", api);
after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

type Call = { method?: string; json?: unknown; body?: string; user?: string };
const call = (url: string, init: Call = {}) =>
  app.request(`http://app/api/saved-prompts${url}`, {
    method: init.method ?? "GET",
    headers: {
      cookie: `okaychat_session=${init.user ?? "alice"}`,
      ...(init.json !== undefined || init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init.body ?? (init.json !== undefined ? JSON.stringify(init.json) : undefined),
  });

const create = (json: unknown, user = "alice") => call("", { method: "POST", json, user });
const list = async (user = "alice") => ((await (await call("", { user })).json()) as { prompts: SavedPrompt[] }).prompts;
const update = (id: string, json: unknown, user = "alice") => call(`/${id}`, { method: "PUT", json, user });
const remove = (id: string, json: unknown, user = "alice") => call(`/${id}`, { method: "DELETE", json, user });
const body = async <T>(res: Response) => (await res.json()) as T;

const write = (over: Partial<{ name: string; shortcut: string; body: string; revision: number }> = {}) => ({
  name: "Summarize",
  shortcut: "summarize",
  body: "Summarize {{topic}} for {{audience}}.",
  ...over,
});

beforeEach(() => {
  db.exec("DELETE FROM saved_prompts; UPDATE users SET storage_limit = NULL;");
  for (const id of ["alice", "bob"]) {
    db.prepare("INSERT OR IGNORE INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, `${id}@example.test`, id, "unused", "user", 1);
    db.prepare("INSERT OR IGNORE INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(id), id, Date.now() + 600_000);
  }
});

test("create, list, update, and delete round trip", async () => {
  const res = await create(write({ name: "  Summarize  ", shortcut: "/Summarize", body: "Summarize {{topic}}.\n" }));
  assert.equal(res.status, 201, await res.clone().text());
  const prompt = await body<SavedPrompt>(res);
  assert.match(prompt.id, /^sp_/);
  assert.equal(prompt.name, "Summarize", "the name is trimmed");
  assert.equal(prompt.shortcut, "summarize", "the slash and the case are normalized away");
  assert.equal(prompt.body, "Summarize {{topic}}.\n", "body whitespace is preserved");
  assert.equal(prompt.revision, 1);
  assert.equal(typeof prompt.createdAt, "number");
  assert.equal(prompt.updatedAt, prompt.createdAt);
  assert.deepEqual(await list(), [prompt]);

  const updated = await update(prompt.id, write({ name: "Summarizer", body: "Summarize it.", revision: 1 }));
  assert.equal(updated.status, 200, await updated.clone().text());
  const next = await body<SavedPrompt>(updated);
  assert.equal(next.id, prompt.id);
  assert.equal(next.name, "Summarizer");
  assert.equal(next.body, "Summarize it.");
  assert.equal(next.revision, 2);
  assert.equal(next.createdAt, prompt.createdAt);
  assert.ok(next.updatedAt >= prompt.updatedAt);

  const deleted = await remove(prompt.id, { revision: 2 });
  assert.equal(deleted.status, 200, await deleted.clone().text());
  assert.deepEqual(await body<unknown>(deleted), { ok: true });
  assert.deepEqual(await list(), []);
});

test("the list is sorted by name without case, then id, and is private per account", async () => {
  for (const [name, shortcut] of [["beta", "b"], ["Alpha", "a"], ["gamma", "g"]] as const) await create(write({ name, shortcut, body: name }));
  assert.deepEqual((await list()).map((p) => p.name), ["Alpha", "beta", "gamma"]);
  const shared = (await list())[0]!;
  assert.deepEqual(await list("bob"), [], "another account never sees the prompts");
  assert.equal((await update(shared.id, write({ revision: 1 }), "bob")).status, 404);
  assert.equal((await remove(shared.id, { revision: 1 }, "bob")).status, 404);
  assert.deepEqual((await list()).map((p) => p.name), ["Alpha", "beta", "gamma"], "bob's attempts changed nothing");
});

test("a duplicate shortcut is refused regardless of case", async () => {
  assert.equal((await create(write({ shortcut: "summarize" }))).status, 201);
  const duplicate = await create(write({ name: "Other", shortcut: "Summarize" }));
  assert.equal(duplicate.status, 409);
  assert.match((await body<{ message: string }>(duplicate)).message, /already uses this shortcut/);
  // The same shortcut on the same row is not a conflict.
  const prompt = (await list())[0]!;
  assert.equal((await update(prompt.id, write({ body: "changed", revision: 1 }))).status, 200);
  // But another row cannot take it.
  const second = await body<SavedPrompt>(await create(write({ name: "Second", shortcut: "second" })));
  assert.equal((await update(second.id, write({ shortcut: "summarize", revision: 1 }))).status, 409);
});

test("invalid names, shortcuts, bodies, and variables are 400 with a plain message", async () => {
  const cases: Array<[Partial<{ name: string; shortcut: string; body: string }>, RegExp]> = [
    [{ name: "   " }, /Give the prompt a name/],
    [{ name: "x".repeat(81) }, /at most 80 characters/],
    [{ shortcut: "1abc" }, /lowercase letter first/],
    [{ shortcut: "has space" }, /lowercase letter first/],
    [{ shortcut: "" }, /lowercase letter first/],
    [{ body: "   \n " }, /Write the prompt text/],
    [{ body: "x".repeat(MAX_PROMPT_BODY + 1) }, /at most 20000 characters/],
    [{ body: Array.from({ length: 21 }, (_, i) => `{{v${i}}}`).join(" ") }, /at most 20 variables/],
  ];
  for (const [over, message] of cases) {
    const res = await create(write(over));
    assert.equal(res.status, 400, JSON.stringify(over));
    assert.match((await body<{ message: string }>(res)).message, message);
  }
  assert.deepEqual(await list(), [], "nothing was stored");
});

test("unknown fields, malformed JSON, and oversized bodies are refused", async () => {
  assert.equal((await create({ ...write(), extra: true })).status, 400);
  assert.equal((await create({ ...write(), revision: 1 })).status, 400, "a create cannot carry a revision");
  const prompt = await body<SavedPrompt>(await create(write()));
  assert.equal((await update(prompt.id, { ...write({ revision: 1 }), hidden: "x" })).status, 400);
  assert.equal((await remove(prompt.id, { revision: 1, extra: 1 })).status, 400);
  assert.equal((await call("", { method: "POST", body: "{" })).status, 400);
  assert.equal((await call("", { method: "POST", body: "null" })).status, 400);
  assert.equal((await update(prompt.id, { ...write(), revision: "1" })).status, 400, "the revision must be a number");
  assert.equal((await remove(prompt.id, { revision: 0 })).status, 400, "the revision must be positive");
  assert.equal((await remove(prompt.id, {})).status, 400);

  const huge = await call("", { method: "POST", body: JSON.stringify(write({ body: "x".repeat(SAVED_PROMPT_BODY_LIMIT) })) });
  assert.equal(huge.status, 400);
  assert.match((await body<{ message: string }>(huge)).message, /too large/);
  assert.equal((await call(`/${prompt.id}`, { method: "PUT", body: JSON.stringify(write({ revision: 1, body: "x".repeat(SAVED_PROMPT_BODY_LIMIT) })) })).status, 400);
  assert.equal((await call(`/${prompt.id}`, { method: "DELETE", body: JSON.stringify({ revision: 1, pad: "x".repeat(2048) }) })).status, 400);

  assert.equal((await list()).length, 1);
  assert.equal((await list())[0]!.revision, 1, "no refused request moved the revision");
});

test("two tabs saving the same revision: exactly one wins and the revision moves once", async () => {
  const prompt = await body<SavedPrompt>(await create(write()));
  const results = await Promise.all([
    update(prompt.id, write({ body: "From the first tab.", revision: 1 })),
    update(prompt.id, write({ body: "From the second tab.", revision: 1 })),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const stale = results.find((r) => r.status === 409)!;
  assert.match((await body<{ message: string }>(stale)).message, /changed in another tab/);
  const stored = (await list())[0]!;
  assert.equal(stored.revision, 2);
  assert.ok(["From the first tab.", "From the second tab."].includes(stored.body));
  // The losing tab can still save after reloading the current revision.
  assert.equal((await update(prompt.id, write({ body: "Merged.", revision: 2 }))).status, 200);
  assert.equal((await list())[0]!.revision, 3);
});

test("a stale delete is 409 and a missing one is 404", async () => {
  const prompt = await body<SavedPrompt>(await create(write()));
  assert.equal((await update(prompt.id, write({ body: "Second.", revision: 1 }))).status, 200);
  const stale = await remove(prompt.id, { revision: 1 });
  assert.equal(stale.status, 409);
  assert.match((await body<{ message: string }>(stale)).message, /changed in another tab/);
  assert.equal((await list()).length, 1, "the stale delete removed nothing");
  assert.equal((await remove(prompt.id, { revision: 2 })).status, 200);
  const absent = await remove(prompt.id, { revision: 2 });
  assert.equal(absent.status, 404);
  assert.equal((await body<{ message: string }>(absent)).message, "Saved prompt not found");
  assert.equal((await remove("sp_missing", { revision: 1 })).status, 404);
});

test("the 200-prompt cap is checked inside the write", async () => {
  const insert = db.prepare("INSERT INTO saved_prompts (id, user_id, name, shortcut, body, revision, created_at, updated_at) VALUES (?, 'alice', ?, ?, ?, 1, 1, 1)");
  for (let i = 0; i < MAX_SAVED_PROMPTS - 1; i++) insert.run(`sp_seed_${i}`, `Prompt ${i}`, `seed-${i}`, "text");
  assert.equal((await list()).length, 199);
  assert.equal((await create(write({ name: "Last", shortcut: "last" }))).status, 201);
  const over = await create(write({ name: "Too many", shortcut: "too-many" }));
  assert.equal(over.status, 409);
  assert.match((await body<{ message: string }>(over)).message, /up to 200 prompts/);
  assert.equal((await list()).length, 200);
});

test("quota counts UTF-8 bytes of name, shortcut, and body", async () => {
  const before = storageUsed("alice");
  const prompt = await body<SavedPrompt>(await create(write({ name: "Café ☕", shortcut: "cafe", body: "é😀\n{{topic}}" })));
  assert.equal(prompt.name, "Café ☕");
  const expected = Buffer.byteLength("Café ☕") + Buffer.byteLength("cafe") + Buffer.byteLength("é😀\n{{topic}}");
  assert.equal(storageUsed("alice") - before, expected);
  // Growth is charged on update, and a shrink gives the bytes back.
  await update(prompt.id, write({ name: "Café ☕", shortcut: "cafe", body: "é", revision: 1 }));
  assert.equal(storageUsed("alice") - before, Buffer.byteLength("Café ☕") + Buffer.byteLength("cafe") + Buffer.byteLength("é"));
});

test("an over-quota account cannot grow a prompt, but can shrink and delete", async () => {
  const prompt = await body<SavedPrompt>(await create(write({ name: "Keep", shortcut: "keep", body: "text" })));
  db.prepare("UPDATE users SET storage_limit = ? WHERE id = 'alice'").run(storageUsed("alice") - 1);
  const created = await create(write({ name: "New", shortcut: "new", body: "é".repeat(20) }));
  assert.equal(created.status, 413);
  assert.equal((await body<{ code: string }>(created)).code, "storage_quota");
  assert.equal((await list()).length, 1, "the refused create stored nothing");

  const grow = await update(prompt.id, write({ name: "Keep", shortcut: "keep", body: "text and more", revision: 1 }));
  assert.equal(grow.status, 413);
  const unchanged = (await list())[0]!;
  assert.equal(unchanged.revision, 1, "a refused update does not increment the revision");
  assert.equal(unchanged.body, "text");

  // A same-size write is not growth, so it still works.
  assert.equal((await update(prompt.id, write({ name: "Keep", shortcut: "keep", body: "txt!", revision: 1 }))).status, 200);
  // A shrink always works while over quota.
  assert.equal((await update(prompt.id, write({ name: "Keep", shortcut: "keep", body: "t", revision: 2 }))).status, 200);
  assert.equal((await remove(prompt.id, { revision: 3 })).status, 200);
});

test("deleting the account cascades its saved prompts", async () => {
  await create(write({ shortcut: "bob-one" }), "bob");
  assert.equal((await list("bob")).length, 1);
  db.prepare("DELETE FROM users WHERE id = 'bob'").run();
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM saved_prompts WHERE user_id = 'bob'").get() as { n: number }).n, 0);
});

test("every response, including errors, is private and uncached", async () => {
  const header = (res: Response) => res.headers.get("cache-control");
  const prompt = await body<SavedPrompt>(await create(write()));
  assert.equal(header(await call("")), "private, no-store");
  assert.equal(header(await create(write({ shortcut: "second" }))), "private, no-store");
  assert.equal(header(await update(prompt.id, write({ body: "changed", revision: 1 }))), "private, no-store");
  assert.equal(header(await create(write())), "private, no-store", "a 409 is uncached too");
  assert.equal(header(await call("", { method: "POST", body: "{" })), "private, no-store");
  assert.equal(header(await remove("sp_missing", { revision: 1 })), "private, no-store");
  assert.equal(header(await remove(prompt.id, { revision: 2 })), "private, no-store");
});
