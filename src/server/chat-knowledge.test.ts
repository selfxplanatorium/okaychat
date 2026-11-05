import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test, type TestContext } from "node:test";
import type { UIMessage } from "ai";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-chat-knowledge-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "chat-knowledge-test-secret-only-not-for-production";
writeFileSync(path.join(dataDir, "models-dev.json"), JSON.stringify({ data: {}, fetchedAt: Date.now() }));
const { db } = await import("./db.js");
const { saveConnection } = await import("./catalog/providers.js");
const { updateSettings } = await import("./settings.js");
const { ensureThread, updateThread } = await import("./threads.js");
const { turnStream } = await import("./chat.js");
const { storeUpload } = await import("./files.js");
const { chunkDocument } = await import("./knowledge/chunker.js");
const { createCollection, createSource, replaceChunks, sourceRow } = await import("./knowledge/store.js");

db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('alice', 'alice@example.test', 'Alice', 'unused', 'admin', 1)").run();
saveConnection("alice", "custom-test", { baseURL: "http://mock.test/v1" });
updateSettings("alice", { maxSteps: 1, maxSearches: 0, webTools: false, artifacts: false, generativeUI: false, subagents: false, autoCompactAt: 0 });
after(() => { db.close(); rmSync(dataDir, { recursive: true, force: true }); });
beforeEach(() => {
  db.exec("DELETE FROM knowledge_chunks; DELETE FROM knowledge_sources; DELETE FROM knowledge_collections; DELETE FROM turn_context; DELETE FROM messages; DELETE FROM threads; DELETE FROM uploads; DELETE FROM projects;");
  updateSettings("alice", { maxSteps: 1, maxSearches: 0, webTools: false, artifacts: false, generativeUI: false, subagents: false, autoCompactAt: 0, systemPrompt: "" });
  db.prepare("INSERT OR REPLACE INTO provider_connections (user_id, provider_id, api_key_enc, base_url, config_json, enabled, created_at) VALUES ('alice', 'openai', NULL, NULL, '{}', 1, 1)").run();
});

const PASSAGE = "The quasar calibrates the starboard relay before every launch.";
const COLLECTION_NAME = "Flight handbook";

function seedCollection(embedding: { provider: "none" } | { provider: "openai"; model: string } = { provider: "none" }): string {
  const collection = createCollection("alice", { name: COLLECTION_NAME, embedding });
  const text = `# Launch\n\n${PASSAGE}\n\n${"Routine checklist item. ".repeat(30)}`;
  const uploadId = storeUpload("alice", "handbook.md", "text/markdown", Buffer.from(text));
  const source = createSource("alice", collection.id, { name: "handbook.md", kind: "paste", mime: "text/markdown", uploadId, bytes: Buffer.byteLength(text), text });
  const chunks = chunkDocument(text, { sourceId: source.id, title: "Launch" });
  assert.equal(replaceChunks("alice", source.id, sourceRow("alice", source.id)!.generation, collection.id, chunks.map((chunk) => ({ chunk, vector: null })), null), true);
  return collection.id;
}

type ProviderRequest = { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }>; tool_choice?: unknown };
const toolNames = (request: ProviderRequest) => request.tools?.map((tool) => tool.function.name) ?? [];
const systemText = (request: ProviderRequest) =>
  request.messages.filter((message) => message.role === "system").map((message) => JSON.stringify(message.content)).join("\n");
const userText = (request: ProviderRequest) => JSON.stringify(request.messages.filter((message) => message.role === "user"));

function provider(t: TestContext, callTool = false) {
  const requests: ProviderRequest[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "http://mock.test/v1/models") return Response.json({ data: [{ id: "mock" }] });
    assert.equal(url, "http://mock.test/v1/chat/completions");
    const body = JSON.parse(init?.body as string) as ProviderRequest;
    requests.push(body);
    const shouldCall = callTool && requests.length === 1 && toolNames(body).includes("search_knowledge");
    const delta = shouldCall
      ? { role: "assistant", tool_calls: [{ index: 0, id: "search-1", type: "function", function: { name: "search_knowledge", arguments: JSON.stringify({ query: "quasar starboard relay" }) } }] }
      : { role: "assistant", content: "It is in the flight handbook." };
    const chunks = [
      { id: "mock-response", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta, finish_reason: null }] },
      { id: "mock-response", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta: {}, finish_reason: shouldCall ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ];
    return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  });
  return requests;
}

async function run(threadId: string, messages: UIMessage[]) {
  const chunks: Array<{ type: string }> = [];
  const stream = await turnStream({ userId: "alice", threadId, modelRef: "custom-test/mock", uiMessages: messages });
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

const turn = (id = "u1", text = "Where is the quasar relay documented?") => ({ id, role: "user", parts: [{ type: "text", text }] }) as UIMessage;

test("attached collections add only per-turn context, keep the system prefix stable, and expose read-only tools", async (t) => {
  const collectionId = seedCollection();
  ensureThread("alice", "knowledge-chat");
  updateThread("alice", "knowledge-chat", { knowledgeIds: [collectionId] });
  const requests = provider(t, true);
  await run("knowledge-chat", [turn()]);

  assert.equal(requests.length, 2, "one tool round plus a final answer");
  assert.ok(toolNames(requests[0]!).includes("search_knowledge"));
  assert.ok(toolNames(requests[0]!).includes("read_knowledge_chunk"));
  assert.deepEqual(toolNames(requests[1]!), toolNames(requests[0]!), "the tool block stays constant within the turn");
  assert.equal(requests[1]!.tool_choice, "none");

  const users = requests[0]!.messages.filter((message) => message.role === "user");
  assert.equal(users.length, 2, "retrieved context is inserted directly before the user message");
  assert.ok(JSON.stringify(users[0]!.content).includes(COLLECTION_NAME));
  assert.ok(JSON.stringify(users[0]!.content).includes("starboard relay"));
  assert.ok(JSON.stringify(users[0]!.content).includes("<untrusted_data"), "knowledge arrives inside the data envelope");
  assert.ok(JSON.stringify(users[1]!.content).includes("Where is the quasar relay"));
  assert.ok(!systemText(requests[0]!).includes(PASSAGE), "knowledge text never enters the stable system prefix");
  assert.ok(!systemText(requests[0]!).includes(COLLECTION_NAME));

  const stored = db.prepare("SELECT knowledge, knowledge_ids FROM turn_context WHERE thread_id = 'knowledge-chat' AND message_id = 'u1'").get() as { knowledge: string; knowledge_ids: string };
  assert.ok(stored.knowledge.includes("starboard relay"));
  assert.deepEqual(JSON.parse(stored.knowledge_ids), [collectionId]);
  const toolResult = JSON.stringify(requests[1]!.messages.filter((message) => message.role === "tool"));
  assert.ok(toolResult.includes("<untrusted_data"), "the search result reaches the model enveloped");
});

test("later turns replay the stored block byte for byte and drop it when the collection is detached", async (t) => {
  const collectionId = seedCollection();
  ensureThread("alice", "cache-chat");
  updateThread("alice", "cache-chat", { knowledgeIds: [collectionId] });
  const requests = provider(t, false);
  const first = turn();
  await run("cache-chat", [first]);
  const second = { id: "a1", role: "assistant", parts: [{ type: "text", text: "It is in the flight handbook." }] } as UIMessage;
  const third = turn("u2", "And what comes after the relay?");
  await run("cache-chat", [first, second, third]);
  assert.deepEqual(requests[1]!.messages.slice(0, requests[0]!.messages.length), requests[0]!.messages, "the second request extends the first");
  assert.equal(userText(requests[1]!).split("Attached knowledge collections").length - 1, 1, "the collection-names line is not repeated for the new turn");
  assert.ok(userText(requests[1]!).includes("starboard relay"), "the earlier block is replayed");

  updateThread("alice", "cache-chat", { knowledgeIds: [] });
  await run("cache-chat", [first, second, third, { id: "a2", role: "assistant", parts: [{ type: "text", text: "Checklist." }] } as UIMessage, turn("u3", "Unrelated question")]);
  const last = requests[2]!;
  assert.ok(!toolNames(last).includes("search_knowledge"), "detaching revokes the offered tools");
  assert.ok(!userText(last).includes("starboard relay"), "a detached collection's text is never replayed from history");
  assert.ok(!userText(last).includes(COLLECTION_NAME));
});

test("a chat without attachments keeps the original tool and system blocks; temporary chats never gain knowledge", async (t) => {
  seedCollection();
  ensureThread("alice", "plain-chat");
  ensureThread("alice", "other-chat");
  const requests = provider(t, false);
  await run("plain-chat", [turn()]);
  await run("other-chat", [turn()]);
  await run("tmp_knowledge", [turn()]);
  assert.ok(!toolNames(requests[0]!).includes("search_knowledge"));
  assert.ok(!toolNames(requests[2]!).includes("search_knowledge"));
  assert.ok(!userText(requests[2]!).includes(COLLECTION_NAME));
  assert.deepEqual(requests[0]!.messages[0], requests[1]!.messages[0], "the shared system part is identical across chats");
});


test("detaching during new retrieval also revokes earlier replay blocks", async (t) => {
  const collectionId = seedCollection({ provider: "openai", model: "fake" });
  ensureThread("alice", "race-chat");
  updateThread("alice", "race-chat", { knowledgeIds: [collectionId] });
  const requests = provider(t);
  const { setRetrievalEmbedderFactoryForTests } = await import("./knowledge/retrieval.js");
  setRetrievalEmbedderFactoryForTests(() => ({
    provider: "openai", providerId: "openai", model: "fake",
    embed: async () => [new Float32Array([1, 0])],
  }));
  const first = turn();
  await run("race-chat", [first]);
  assert.ok(userText(requests[0]!).includes(PASSAGE));
  setRetrievalEmbedderFactoryForTests(() => ({
    provider: "openai", providerId: "openai", model: "fake",
    embed: async () => {
      updateThread("alice", "race-chat", { knowledgeIds: [] });
      return [new Float32Array([1, 0])];
    },
  }));
  try {
    await run("race-chat", [first, { id: "a1", role: "assistant", parts: [{ type: "text", text: "Found." }] } as UIMessage, turn("u2", "Another question")]);
    assert.ok(!userText(requests[1]!).includes(PASSAGE), "old blocks are gated after the awaited retrieval");
    assert.ok(!userText(requests[1]!).includes(COLLECTION_NAME));
  } finally {
    setRetrievalEmbedderFactoryForTests(null);
  }
});
