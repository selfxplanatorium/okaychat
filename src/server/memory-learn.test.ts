import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test, type TestContext } from "node:test";
import type { ToolSet } from "ai";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-memory-learn-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "memory-learn-test-secret-only-not-for-production";
writeFileSync(path.join(dataDir, "models-dev.json"), JSON.stringify({ data: {}, fetchedAt: Date.now() }));
const { db } = await import("./db.js");
const { saveConnection } = await import("./catalog/providers.js");
const { updateSettings } = await import("./settings.js");
const { appendMessage, ensureThread, updateThread } = await import("./threads.js");
const { conversationMemory, listMemories, listSummaries, rankMemories, saveMemory } = await import("./memory.js");
const { memoryTick, parseOperations, refreshSummary, reviewThread } = await import("./memory-learn.js");
// Admin: a non-admin base URL goes through the address-checked fetch, which bypasses the mocked global fetch.
db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('alice', 'alice@example.test', 'Alice', 'unused', 'admin', 1)").run();
saveConnection("alice", "custom-test", { baseURL: "http://mock.test/v1" });
updateSettings("alice", { utilityModel: "custom-test/mock" });
after(() => { db.close(); rmSync(dataDir, { recursive: true, force: true }); });
beforeEach(() => {
  db.exec("DELETE FROM memories; DELETE FROM memory_summaries; DELETE FROM memory_preferences; DELETE FROM threads; DELETE FROM projects; DELETE FROM usage;");
  db.prepare("INSERT INTO memory_preferences (user_id, enabled, auto_save) VALUES ('alice', 1, 1)").run();
  db.prepare("INSERT INTO projects (id, user_id, name, created_at) VALUES ('project-a', 'alice', 'Garden', 1)").run();
});

/** Answers each non-streaming completion with the next reply and records the prompts. */
function model(t: TestContext, replies: string[]) {
  const prompts: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "http://mock.test/v1/models") return Response.json({ data: [{ id: "mock" }] });
    assert.equal(url, "http://mock.test/v1/chat/completions");
    const body = JSON.parse(init?.body as string) as { messages: Array<{ content: unknown }> };
    prompts.push(JSON.stringify(body.messages));
    const content = replies.shift() ?? '{"operations":[]}';
    return Response.json({ id: "r", object: "chat.completion", created: 1, model: "mock", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  });
  return prompts;
}
function say(threadId: string, id: string, role: "user" | "assistant", text: string, parent: string | null) {
  appendMessage("alice", threadId, { id, parent_id: parent, format: "ai-sdk/v6", content: { role, parts: [{ type: "text", text }] } });
}
async function execute(tools: ToolSet, name: string, input: unknown): Promise<any> {
  return tools[name]!.execute!(input, { toolCallId: name, messages: [] });
}
const entry = (id: string, content: string, updatedAt = 1) => ({ id, content, scope: null, source: "manual" as const, createdAt: 1, updatedAt });

test("BM25 ranking matches word forms, prefers rare terms, and breaks ties by recency", () => {
  const entries = [entry("a", "Uses PostgreSQL databases at work"), entry("b", "Likes hiking"), entry("c", "Works on the database team", 5), entry("d", "Prefers short answers")];
  const ranked = rankMemories(entries, "Which database should I use?", { matchesOnly: true });
  assert.deepEqual(ranked.map((e) => e.id), ["c", "a"], "both mention databases; the more recent one wins the tie");
  assert.equal(rankMemories(entries, "PostgreSQL database", { matchesOnly: true })[0]!.id, "a", "the rare term outweighs the common one");
  assert.deepEqual(rankMemories(entries, "", {}).map((e) => e.id)[0], "c", "an empty query ranks by recency");
});

test("operation parsing accepts fenced JSON and rejects malformed operations", () => {
  assert.deepEqual(parseOperations('Sure:\n```json\n{"operations":[{"op":"add","content":"Has a cat named Miso."}]}\n```'), [{ op: "add", content: "Has a cat named Miso." }]);
  assert.throws(() => parseOperations("No changes."));
  assert.throws(() => parseOperations('{"operations":[{"op":"merge","id":"x"}]}'));
});

test("chat review adds, corrects, and deletes facts, then only reviews new messages", async (t) => {
  const old = saveMemory("alice", { content: "Lives in Hamburg." }, "manual").entry;
  const wrong = saveMemory("alice", { content: "Has a dog." }, "manual").entry;
  ensureThread("alice", "chat");
  say("chat", "u1", "user", "I moved from Hamburg to Munich last month. Also, I never had a dog. I'm a nurse.", null);
  say("chat", "a1", "assistant", "Noted.", "u1");
  const prompts = model(t, [JSON.stringify({ operations: [
    { op: "update", id: old.id, content: "Lives in Munich (since September 2026)." },
    { op: "delete", id: wrong.id },
    { op: "add", content: "Works as a nurse." },
    { op: "delete", id: "invented-id" },
  ] })]);
  const applied = await reviewThread("alice", "chat");
  assert.equal(applied!.length, 3, "operations on unknown ids are ignored");
  assert.ok(prompts[0]!.includes(old.id), "existing related facts are offered for reconciliation");
  assert.deepEqual(listMemories("alice").map((m) => m.content).sort(), ["Lives in Munich (since September 2026).", "Works as a nurse."]);
  assert.equal((db.prepare("SELECT count(*) AS n FROM usage WHERE kind = 'memory'").get() as { n: number }).n, 1);

  assert.deepEqual(await reviewThread("alice", "chat"), [], "nothing new: no model call");
  assert.equal(prompts.length, 1);
  say("chat", "u2", "user", "What should I cook tonight?", "a1");
  await reviewThread("alice", "chat");
  assert.equal(prompts.length, 2);
  assert.ok(!prompts[1]!.includes("I moved from Hamburg"), "only messages after the cursor are reviewed");
});

test("chat review respects automatic saving, excluded chats, and project scope", async (t) => {
  model(t, [JSON.stringify({ operations: [{ op: "add", content: "Grows tomatoes." }] })]);
  ensureThread("alice", "excluded");
  say("excluded", "u1", "user", "I grow tomatoes.", null);
  updateThread("alice", "excluded", { memoryDisabled: true });
  assert.equal(await reviewThread("alice", "excluded"), null);
  db.prepare("UPDATE memory_preferences SET auto_save = 0").run();
  ensureThread("alice", "manual-only");
  say("manual-only", "u1", "user", "I grow tomatoes.", null);
  assert.equal(await reviewThread("alice", "manual-only"), null);
  db.prepare("UPDATE memory_preferences SET auto_save = 1").run();
  ensureThread("alice", "garden", "project-a");
  say("garden", "u1", "user", "I grow tomatoes.", null);
  await reviewThread("alice", "garden");
  assert.deepEqual(listMemories("alice").map((m) => [m.content, m.scope]), [["Grows tomatoes.", "project-a"]]);
});

test("the background tick reviews only idle chats and then writes the summary", async (t) => {
  const prompts = model(t, [JSON.stringify({ operations: [{ op: "add", content: "Prefers metric units." }] }), "## Preferences for responses\n- Prefers metric units."]);
  ensureThread("alice", "idle");
  say("idle", "u1", "user", "Always use metric units.", null);
  ensureThread("alice", "active");
  say("active", "u1", "user", "I like Rust.", null);
  const now = Date.now();
  db.prepare("UPDATE threads SET updated_at = ? WHERE id = 'idle'").run(now - 20 * 60_000);
  await memoryTick(now);
  assert.equal(prompts.length, 1, "the active chat waits until it is idle");
  assert.deepEqual(listMemories("alice").map((m) => m.content), ["Prefers metric units."]);
  db.prepare("UPDATE memories SET updated_at = ?").run(now - 5 * 60_000);
  await memoryTick(now);
  assert.equal(prompts.length, 2);
  assert.match(listSummaries("alice")[0]!.content!, /metric units/);
  await memoryTick(now);
  assert.equal(prompts.length, 2, "an up-to-date summary is not rewritten");
});

test("summaries enter the system prompt, stay pinned per chat, and are withdrawn when a fact is deleted", async (t) => {
  model(t, ["## Personal context\n- Has a cat named Miso.", "## Personal context\n- Has a cat named Miso and a parrot."]);
  const cat = saveMemory("alice", { content: "Has a cat named Miso." }, "manual").entry;
  await refreshSummary("alice", "");
  ensureThread("alice", "first");
  const first = conversationMemory("alice", "first", "hello");
  assert.match(first.instructions!, /Memory summary[\s\S]*cat named Miso/);
  assert.ok(!first.context.includes("Has a cat named Miso."), "a summarized scope does not repeat every recent fact");

  saveMemory("alice", { content: "Has a parrot." }, "manual");
  await refreshSummary("alice", "");
  assert.ok(!conversationMemory("alice", "first", "hello").instructions!.includes("parrot"), "a running chat keeps its pinned summary");
  ensureThread("alice", "second");
  assert.ok(conversationMemory("alice", "second", "hello").instructions!.includes("parrot"), "a new chat gets the new summary");

  const { memoryRoutes } = await import("./memory.js");
  const { Hono } = await import("hono");
  const { requireUser } = await import("./auth.js");
  const { sha256 } = await import("./crypto.js");
  db.prepare("INSERT OR IGNORE INTO sessions (token_hash, user_id, expires_at) VALUES (?, 'alice', ?)").run(sha256("alice"), Date.now() + 600_000);
  const app = new Hono().use(requireUser).route("/memory", memoryRoutes);
  assert.equal((await app.request(`http://app/memory/${cat.id}`, { method: "DELETE", headers: { cookie: "okaychat_session=alice" } })).status, 200);
  for (const id of ["first", "second"]) assert.ok(!conversationMemory("alice", id, "hello").instructions!.includes("Miso"), "no chat may keep a summary that mentions a deleted fact");
  assert.equal(listSummaries("alice")[0]!.content, null);
});

test("past-chat search stays inside the chat's scope and skips excluded chats", async () => {
  db.prepare("UPDATE memory_preferences SET auto_save = 0").run();
  ensureThread("alice", "current");
  say("current", "c1", "user", "Kubernetes ingress question", null);
  ensureThread("alice", "global-old");
  say("global-old", "g1", "user", "We set up the Kubernetes ingress with Traefik", null);
  updateThread("alice", "global-old", { title: "Ingress setup" });
  ensureThread("alice", "secret");
  say("secret", "s1", "user", "Kubernetes ingress for the secret project", null);
  updateThread("alice", "secret", { memoryDisabled: true });
  ensureThread("alice", "garden-chat", "project-a");
  say("garden-chat", "p1", "user", "Kubernetes ingress inside a project", null);

  const tools = conversationMemory("alice", "current", "").tools;
  const found = await execute(tools, "conversation_search", { query: "kubernetes traefik" });
  assert.deepEqual(found.chats.map((c: { id: string }) => c.id), ["global-old"]);
  assert.match(found.chats[0].excerpts[0], /\*\*Traefik\*\*/);
  assert.deepEqual((await execute(tools, "conversation_search", { query: "" })).chats.map((c: { id: string }) => c.id), ["global-old"]);
  const read = await execute(tools, "conversation_read", { id: "global-old" });
  assert.match(read.text, /User: We set up the Kubernetes ingress with Traefik/);
  await assert.rejects(execute(tools, "conversation_read", { id: "garden-chat" }), /not available/);
  await assert.rejects(execute(tools, "conversation_read", { id: "secret" }), /not available/);

  const projectTools = conversationMemory("alice", "garden-chat", "").tools;
  assert.deepEqual((await execute(projectTools, "conversation_search", { query: "kubernetes" })).chats, [], "a project chat sees only its project's other chats");
  db.prepare("UPDATE memory_preferences SET chat_search = 0").run();
  assert.equal(conversationMemory("alice", "current", "").tools.conversation_search, undefined);
});

test("the settings snapshot lists scopes awaiting their first summary, never deleted projects", () => {
  saveMemory("alice", { content: "Global fact." }, "manual");
  saveMemory("alice", { content: "Garden fact.", scope: "project-a" }, "manual");
  db.prepare("INSERT INTO memories (id, user_id, scope, content_enc, content_hash, source, created_at, updated_at) VALUES ('orphan', 'alice', 'gone-project', 'x', 'h', 'manual', 1, 1)").run();
  assert.deepEqual(listSummaries("alice").map((s) => [s.scope, s.content, s.stale]), [[null, null, true], ["project-a", null, true]]);
});
