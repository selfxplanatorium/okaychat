import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test, type TestContext } from "node:test";
import { Hono } from "hono";
import type { AppEnv } from "./auth.js";

// Per-message translation: a standalone model call whose answer is derived, stored text. These tests pin
// the request shape, the cache, the limits, the guards, and the promise that no chat row changes.

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-translation-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "translation-test-secret-only-not-for-production";
writeFileSync(path.join(dataDir, "models-dev.json"), JSON.stringify({ data: {}, fetchedAt: Date.now() }));

const { db } = await import("./db.js");
const { saveConnection } = await import("./catalog/providers.js");
const { updateSettings, getSettings } = await import("./settings.js");
const { requireUser } = await import("./auth.js");
const { sha256 } = await import("./crypto.js");
const { handleAppError } = await import("./errors.js");
const { ensureThread, updateThread, appendMessage, listMessages, getThread } = await import("./threads.js");
const { messageTranslationRoutes, translateMessage } = await import("./message-translations.js");
const { editMessage } = await import("./message-edits.js");
const { storageUsed } = await import("./quota.js");
const { threadMarkdown } = await import("./export.js");
const { buildArchive } = await import("./archive-export.js");
const { publicShareRoutes } = await import("./shares.js");
const { wrapUntrusted } = await import("./prompt-injection.js");
const { promptText } = await import("./prompts.js");
const { markBusy } = await import("./thread-runs.js");
const { MAX_TRANSLATIONS_PER_MESSAGE, MAX_TRANSLATION_SOURCE_CHARS } = await import("../shared/message-translations.js");

for (const id of ["alice", "bob"]) {
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, 'unused', 'admin', 1)").run(id, `${id}@example.test`, id);
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(`${id}-session`), id, Date.now() + 600_000);
}
saveConnection("alice", "custom-test", { baseURL: "http://mock.test/v1" });
ensureThread("alice", "thr_1");
ensureThread("bob", "thr_bob");
updateThread("alice", "thr_1", { modelRef: "custom-test/mock" });

const app = new Hono<AppEnv>().use(requireUser).onError(handleAppError).route("/", messageTranslationRoutes);
const call = (user: string, method: string, url: string, body?: unknown) =>
  app.request(`http://app${url}`, {
    method,
    headers: { cookie: `okaychat_session=${user}-session`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const translationPath = (threadId: string, messageId: string, lang?: string) =>
  `/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/translations${lang ? `/${encodeURIComponent(lang)}` : ""}`;
const put = (threadId: string, messageId: string, lang: string, body: unknown = {}, user = "alice") =>
  call(user, "PUT", translationPath(threadId, messageId, lang), body);

type ChatBody = {
  messages: Array<{ role: string; content: unknown }>;
  tools?: unknown;
  stream?: boolean;
  max_tokens?: number;
};

/** One fake provider: every call answers a fixed German sentence and is logged for shape assertions. */
function transport(t: TestContext, answer = "Hallo Welt", onChat?: () => Promise<void>) {
  const log: ChatBody[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "http://mock.test/v1/models") return Response.json({ data: [{ id: "mock" }] });
    assert.equal(url, "http://mock.test/v1/chat/completions", `unexpected request to ${url}`);
    log.push(JSON.parse(init?.body as string) as ChatBody);
    await onChat?.();
    return Response.json({
      id: `r${log.length}`,
      object: "chat.completion",
      created: 1,
      model: "mock",
      choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  });
  return log;
}

const addMessage = (threadId: string, id: string, role: "user" | "assistant", parts: unknown[], parent: string | null = null) =>
  appendMessage("alice", threadId, { id, parent_id: parent, format: "ai-sdk/v6", content: { role, parts } });

const seedPair = () => {
  addMessage("thr_1", "u1", "user", [{ type: "text", text: "How do I bake bread?" }]);
  addMessage("thr_1", "a1", "assistant", [{ type: "text", text: "Mix flour and water, then wait." }], "u1");
};

const usageRows = () =>
  (db.prepare("SELECT kind, count(*) AS n FROM usage GROUP BY kind ORDER BY kind").all() as Array<{ kind: string; n: number }>).map((row) => [row.kind, row.n]);
const translationRows = () => db.prepare("SELECT * FROM message_translations").all() as Array<Record<string, unknown>>;

beforeEach(() => {
  db.exec("DELETE FROM message_translations; DELETE FROM message_bookmarks; DELETE FROM message_feedback; DELETE FROM usage; DELETE FROM messages; DELETE FROM permission_policies");
  updateSettings("alice", { utilityModel: "custom-test/mock", translateMessages: true, editAssistantMessages: true, systemPrompt: "" });
  db.prepare("UPDATE threads SET model_ref = 'custom-test/mock', updated_at = 1 WHERE id = 'thr_1'").run();
});

after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("translates an assistant reply and a user message with a canonical language and source hash", async (t) => {
  transport(t);
  seedPair();
  const assistant = await put("thr_1", "a1", "DE-at");
  assert.equal(assistant.status, 200, await assistant.clone().text());
  const assistantRow = (await assistant.json()) as Record<string, unknown>;
  assert.equal(assistantRow.lang, "de-AT");
  assert.equal(assistantRow.text, "Hallo Welt");
  assert.equal(assistantRow.sourceHash, sha256(JSON.stringify(["Mix flour and water, then wait."])));
  assert.equal(String(assistantRow.sourceHash).length, 64);
  assert.equal(assistantRow.sourceChars, "Mix flour and water, then wait.".length);
  assert.equal(assistantRow.truncated, false);
  assert.equal(assistantRow.modelRef, "custom-test/mock");

  const user = await put("thr_1", "u1", "fr");
  assert.equal(user.status, 200, await user.clone().text());
  const userRow = (await user.json()) as Record<string, unknown>;
  assert.equal(userRow.lang, "fr");
  assert.equal(translationRows().length, 2);
});

test("a message edited while the model answers is refused instead of stored stale", async (t) => {
  const log = transport(t, "Hallo Welt", async () => {
    // The reply changes during the provider call; the answer now describes text that is gone.
    db.prepare("UPDATE messages SET content = ? WHERE thread_id = 'thr_1' AND id = 'a1'")
      .run(JSON.stringify({ role: "assistant", parts: [{ type: "text", text: "Rewritten while translating." }] }));
  });
  seedPair();
  const response = await put("thr_1", "a1", "de");
  assert.equal(response.status, 409);
  assert.equal(translationRows().length, 0, "the stale answer is never stored");
  assert.equal(log.length, 1);
  assert.equal(usageRows().some(([kind]) => kind === "translation"), true, "the provider call is still charged");
});

test("the provider request is one English system prompt, one enveloped user message, and no tools", async (t) => {
  const log = transport(t);
  seedPair();
  assert.equal((await put("thr_1", "a1", "de")).status, 200);
  assert.equal(log.length, 1);
  const body = log[0]!;
  const system = body.messages.filter((message) => message.role === "system");
  assert.equal(system.length, 1);
  assert.equal(system[0]!.content, promptText("translation", { language: "German" }));
  const users = body.messages.filter((message) => message.role === "user");
  assert.equal(users.length, 1);
  const content = String(users[0]!.content);
  assert.ok(content.startsWith("<untrusted_data"), content.slice(0, 40));
  assert.ok(content.includes("Mix flour and water"), "the message body is quoted, not inserted into the prompt");
  assert.equal(body.tools, undefined);
  assert.notEqual(body.stream, true);
});

test("a repeat is served from the cache; refresh calls once and keeps createdAt", async (t) => {
  const log = transport(t);
  seedPair();
  const first = (await (await put("thr_1", "a1", "de")).json()) as { text: string; createdAt: number; updatedAt: number };
  const second = (await (await put("thr_1", "a1", "de")).json()) as { text: string; createdAt: number; updatedAt: number };
  assert.equal(log.length, 1, "a cache hit makes no provider call");
  assert.equal(second.createdAt, first.createdAt);
  assert.equal(second.updatedAt, first.updatedAt);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const refreshed = (await (await put("thr_1", "a1", "de", { refresh: true })).json()) as { createdAt: number; updatedAt: number };
  assert.equal(log.length, 2);
  assert.equal(refreshed.createdAt, first.createdAt);
  assert.ok(refreshed.updatedAt > first.updatedAt);
});

test("editing a reply makes its translation stale and regenerates it", async (t) => {
  const log = transport(t);
  seedPair();
  await put("thr_1", "a1", "de");
  editMessage("alice", "thr_1", "a1", { text: "Knead the dough instead." });
  const listed = (await (await call("alice", "GET", translationPath("thr_1", "a1"))).json()) as {
    sourceHash: string;
    translations: Array<{ lang: string; stale: boolean; text: string }>;
  };
  assert.equal(listed.translations[0]?.stale, true);
  assert.notEqual(listed.sourceHash, listed.translations[0] ? sha256(JSON.stringify(["Mix flour and water, then wait."])) : "");
  const fresh = (await (await put("thr_1", "a1", "de")).json()) as { text: string; sourceHash: string };
  assert.equal(log.length, 2);
  assert.equal(fresh.sourceHash, listed.sourceHash);
  assert.equal(translationRows().length, 1, "the stale row is replaced in place");
});

test("translation writes no chat row, no turn context, no activity, and no generation receipt", async (t) => {
  transport(t);
  seedPair();
  const before = {
    thread: db.prepare("SELECT updated_at, model_ref, title FROM threads WHERE id = 'thr_1'").get(),
    messages: db.prepare("SELECT id, content, bytes, edited_at FROM messages ORDER BY id").all(),
    turnContext: db.prepare("SELECT count(*) AS n FROM turn_context").get(),
    runs: db.prepare("SELECT count(*) AS n FROM generation_runs").get(),
  };
  assert.equal((await put("thr_1", "a1", "de")).status, 200);
  assert.equal((await put("thr_1", "u1", "de")).status, 200);
  assert.deepEqual(db.prepare("SELECT updated_at, model_ref, title FROM threads WHERE id = 'thr_1'").get(), before.thread);
  assert.deepEqual(db.prepare("SELECT id, content, bytes, edited_at FROM messages ORDER BY id").all(), before.messages);
  assert.deepEqual(db.prepare("SELECT count(*) AS n FROM turn_context").get(), before.turnContext);
  assert.deepEqual(db.prepare("SELECT count(*) AS n FROM generation_runs").get(), before.runs);
});

test("each paid request lands in the usage ledger as one translation row; a cache hit adds none", async (t) => {
  transport(t);
  seedPair();
  await put("thr_1", "a1", "de");
  const rows = db.prepare("SELECT kind, input_tokens, output_tokens, cost FROM usage").all() as Array<{ kind: string; input_tokens: number; output_tokens: number; cost: number }>;
  assert.deepEqual(rows.map((row) => row.kind), ["translation"]);
  assert.equal(rows[0]?.input_tokens, 10);
  assert.equal(rows[0]?.output_tokens, 5);
  assert.ok((rows[0]?.cost ?? -1) >= 0);
  await put("thr_1", "a1", "de");
  assert.deepEqual(usageRows(), [["translation", 1]]);
});

test("stored translations count toward storage and deleting one frees it", async (t) => {
  transport(t);
  seedPair();
  const before = storageUsed("alice");
  const created = (await (await put("thr_1", "a1", "de")).json()) as { text: string };
  const after = storageUsed("alice");
  assert.equal(after - before, Buffer.byteLength(created.text));
  assert.equal((await call("alice", "DELETE", translationPath("thr_1", "a1", "de"))).status, 200);
  assert.equal(storageUsed("alice"), before);
});

test("a quota refusal is a 413 and still leaves the honest usage row", async (t) => {
  transport(t);
  seedPair();
  db.prepare("UPDATE users SET storage_limit = ? WHERE id = 'alice'").run(storageUsed("alice") + 1);
  try {
    const response = await put("thr_1", "a1", "de");
    assert.equal(response.status, 413, await response.clone().text());
    assert.equal(translationRows().length, 0);
    assert.deepEqual(usageRows(), [["translation", 1]]);
  } finally {
    db.prepare("UPDATE users SET storage_limit = NULL WHERE id = 'alice'").run();
  }
});

test("the language and chat caps answer 409 without calling the provider", async (t) => {
  const log = transport(t);
  seedPair();
  const insert = db.prepare(`INSERT INTO message_translations
    (thread_id, message_id, lang, source_hash, source_chars, translated, truncated, model_ref, created_at, updated_at)
    VALUES ('thr_1', ?, ?, ?, 1, 'Text', 0, 'custom-test/mock', 1, 1)`);
  for (let i = 0; i < MAX_TRANSLATIONS_PER_MESSAGE; i++) insert.run("a1", `x${i}`, "a".repeat(64));
  const perMessage = await put("thr_1", "a1", "de");
  assert.equal(perMessage.status, 409, await perMessage.clone().text());
  assert.equal(log.length, 0);

  db.exec("DELETE FROM message_translations");
  db.exec("BEGIN");
  for (let i = 0; i < 5_000; i++) insert.run("a1", `x${i}`, "a".repeat(64));
  db.exec("COMMIT");
  const perThread = await put("thr_1", "a1", "de");
  assert.equal(perThread.status, 409, await perThread.clone().text());
  assert.equal(log.length, 0);
});

test("temporary chats, foreign chats, unknown messages, busy chats, and empty text are refused", async (t) => {
  const log = transport(t);
  seedPair();
  assert.equal((await put("tmp_x", "a1", "de")).status, 404);
  assert.equal((await put("thr_bob", "a1", "de")).status, 404);
  assert.equal((await put("thr_1", "nope", "de")).status, 404);
  const release = markBusy("thr_1");
  try {
    assert.equal((await put("thr_1", "a1", "de")).status, 409);
  } finally {
    release();
  }
  addMessage("thr_1", "file1", "user", [{ type: "file", filename: "notes.txt", mediaType: "text/plain", url: "data:text/plain;base64,aGk=" }], "a1");
  assert.equal((await put("thr_1", "file1", "de")).status, 400);
  assert.equal((await put("thr_1", "a1", "not a language")).status, 400);
  assert.equal(log.length, 0);
});

test("the account switch and a denied feature both answer 403", async (t) => {
  transport(t);
  seedPair();
  updateSettings("alice", { translateMessages: false });
  assert.equal((await put("thr_1", "a1", "de")).status, 403);
  updateSettings("alice", { translateMessages: true });
  db.prepare("INSERT INTO permission_policies (subject_kind, subject_id, model_ref, document, updated_at) VALUES ('everyone', '', '', ?, 1)")
    .run(JSON.stringify({ version: 1, features: { translation: false } }));
  try {
    assert.equal((await put("thr_1", "a1", "de")).status, 403);
    assert.equal((await call("alice", "GET", translationPath("thr_1", "a1"))).status, 403);
  } finally {
    db.exec("DELETE FROM permission_policies");
  }
});

test("no model answers 409, and an aborted request writes nothing", async (t) => {
  const log = transport(t);
  seedPair();
  updateSettings("alice", { utilityModel: null });
  updateThread("alice", "thr_1", { modelRef: null });
  assert.equal((await put("thr_1", "a1", "de")).status, 409);
  updateSettings("alice", { utilityModel: "custom-test/mock" });
  await assert.rejects(() => translateMessage("alice", "thr_1", "a1", "de", {}, AbortSignal.abort()));
  assert.equal(log.length, 0);
  assert.equal(translationRows().length, 0);
  assert.deepEqual(usageRows(), []);
});

test("a long message is cut before the provider sees it and is stored as truncated", async (t) => {
  const log = transport(t);
  const text = `${"a".repeat(6000)}\n\n${"b".repeat(6000)}\n\nEND-MARKER`;
  addMessage("thr_1", "long1", "user", [{ type: "text", text }]);
  const created = (await (await put("thr_1", "long1", "de")).json()) as { truncated: boolean; sourceChars: number };
  assert.equal(created.truncated, true);
  assert.equal(created.sourceChars, text.length);
  const sent = String(log[0]!.messages.find((message) => message.role === "user")?.content);
  assert.ok(sent.includes("a".repeat(6000)));
  assert.ok(!sent.includes("END-MARKER"));
  assert.ok(sent.length < MAX_TRANSLATION_SOURCE_CHARS + 1_000);
});

test("shares, Markdown exports, and archives keep the original words only", async (t) => {
  transport(t, "Maschine uebersetzt");
  seedPair();
  await put("thr_1", "a1", "de");
  const thread = getThread("alice", "thr_1");
  assert.ok(thread);
  const markdown = threadMarkdown(thread.title, listMessages("alice", "thr_1").map((row) => ({ id: row.id, ...(row.content as Omit<import("ai").UIMessage, "id">) })));
  assert.ok(markdown.includes("Mix flour and water"));
  assert.ok(!markdown.includes("Maschine uebersetzt"));

  const archive = buildArchive({ userId: "alice", threads: [{ id: "thr_1" }] });
  assert.ok(!JSON.stringify(archive.manifest).includes("Maschine uebersetzt"));
  assert.ok(!JSON.stringify(archive.manifest).includes("message_translations"));

  db.prepare("INSERT INTO shares (token, user_id, thread_id, created_at) VALUES ('tok_translation', 'alice', 'thr_1', ?)").run(Date.now());
  const publicApp = new Hono().route("/", publicShareRoutes);
  const payload = await (await publicApp.request("http://app/tok_translation")).text();
  assert.ok(payload.includes("Mix flour and water"));
  assert.ok(!payload.includes("Maschine uebersetzt"));
  assert.ok(!payload.includes("translation"));
  assert.equal(getSettings("alice").translateMessages, true);
});

/** Pause a provider response so another request can mutate storage before commit. */
function pausedTransport(t: TestContext) {
  let resume!: () => void;
  let arrived!: () => void;
  const started = new Promise<void>((resolve) => { arrived = resolve; });
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  transport(t, "Hallo Welt", () => { arrived(); return gate; });
  return { started, resume };
}

test("refresh charges current net growth when its old row was deleted during generation", async (t) => {
  seedPair();
  db.prepare(`INSERT INTO message_translations
    (thread_id, message_id, lang, source_hash, source_chars, translated, truncated, model_ref, created_at, updated_at)
    VALUES ('thr_1', 'a1', 'de', ?, 1, 'Hallo Welt', 0, 'custom-test/mock', 1, 1)`).run("a".repeat(64));
  const provider = pausedTransport(t);
  const request = put("thr_1", "a1", "de", { refresh: true });
  await provider.started;
  assert.equal((await call("alice", "DELETE", translationPath("thr_1", "a1", "de"))).status, 200);
  db.prepare("UPDATE users SET storage_limit = ? WHERE id = 'alice'").run(storageUsed("alice") + 1);
  try {
    provider.resume();
    const response = await request;
    assert.equal(response.status, 413, await response.clone().text());
    assert.equal(translationRows().length, 0);
    assert.deepEqual(usageRows(), [["translation", 1]]);
  } finally {
    db.prepare("UPDATE users SET storage_limit = NULL WHERE id = 'alice'").run();
  }
});

test("concurrent languages cannot exceed the per-message limit at commit", async (t) => {
  seedPair();
  const insert = db.prepare(`INSERT INTO message_translations
    (thread_id, message_id, lang, source_hash, source_chars, translated, truncated, model_ref, created_at, updated_at)
    VALUES ('thr_1', 'a1', ?, ?, 1, 'Text', 0, 'custom-test/mock', 1, 1)`);
  for (let i = 0; i < MAX_TRANSLATIONS_PER_MESSAGE - 1; i++) insert.run(`x${i}`, "a".repeat(64));
  const provider = pausedTransport(t);
  const request = put("thr_1", "a1", "de");
  await provider.started;
  // Another language has committed while this provider response is still pending.
  insert.run("fr", "a".repeat(64));
  provider.resume();
  const response = await request;
  assert.equal(response.status, 409, await response.clone().text());
  assert.equal(translationRows().length, MAX_TRANSLATIONS_PER_MESSAGE);
  assert.deepEqual(usageRows(), [["translation", 1]]);
});
