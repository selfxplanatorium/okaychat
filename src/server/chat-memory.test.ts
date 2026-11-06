import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test, type TestContext } from "node:test";
import { Hono } from "hono";
import { RESUMABLE_STREAM_ID_HEADER } from "assistant-stream/resumable";
import { PDFDocument } from "@cantoo/pdf-lib";
import type { UIMessage } from "ai";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-chat-memory-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "chat-memory-test-secret-only-not-for-production";
writeFileSync(path.join(dataDir, "models-dev.json"), JSON.stringify({ data: {}, fetchedAt: Date.now() }));
const { db } = await import("./db.js");
const { saveConnection } = await import("./catalog/providers.js");
const { updateSettings } = await import("./settings.js");
const { ensureThread, updateThread, appendMessage } = await import("./threads.js");
const { listMemories, memoryRoutes, saveMemory } = await import("./memory.js");
const { turnStream, chatRoutes } = await import("./chat.js");
const { fileRoutes } = await import("./files.js");
const { requireUser } = await import("./auth.js");
const { sha256 } = await import("./crypto.js");
const app = new Hono().use(requireUser).route("/", chatRoutes).route("/", fileRoutes);
// Admin: a non-admin base URL goes through the address-checked fetch, which bypasses the mocked global fetch.
db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('alice', 'alice@example.test', 'Alice', 'unused', 'admin', 1)").run();
db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, 'alice', ?)").run(sha256("alice-session"), Date.now() + 600_000);
saveConnection("alice", "custom-test", { baseURL: "http://mock.test/v1" });
updateSettings("alice", { maxSteps: 1, maxSearches: 0, webTools: false, artifacts: false, generativeUI: false, subagents: false, autoCompactAt: 0 });
after(() => { db.close(); rmSync(dataDir, { recursive: true, force: true }); });
beforeEach(() => {
  db.exec("DELETE FROM memories; DELETE FROM memory_preferences; DELETE FROM threads; DELETE FROM projects; DELETE FROM uploads;");
  updateSettings("alice", { maxSteps: 1, maxSearches: 0, webTools: false, artifacts: false, generativeUI: false, subagents: false, autoCompactAt: 0, systemPrompt: "" });
  db.prepare("INSERT INTO memory_preferences (user_id, enabled, auto_save) VALUES ('alice', 1, 1)").run();
});

type ProviderRequest = { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }>; tool_choice?: unknown };
const FACT = "I prefer concise TypeScript examples";
function provider(t: TestContext, firstTool = true) {
  const requests: ProviderRequest[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "http://mock.test/v1/models") return Response.json({ data: [{ id: "mock" }] });
    assert.equal(url, "http://mock.test/v1/chat/completions", "all requests must stay inside the fake transport");
    const body = JSON.parse(init?.body as string) as ProviderRequest;
    requests.push(body);
    const callTool = firstTool && requests.length === 1;
    const delta = callTool
      ? { role: "assistant", tool_calls: [{ index: 0, id: "save-fact", type: "function", function: { name: "memory_save", arguments: JSON.stringify({ content: FACT }) } }] }
      : { role: "assistant", content: "I will keep that preference in mind." };
    const chunks = [
      { id: "mock-response", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta, finish_reason: null }] },
      { id: "mock-response", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta: {}, finish_reason: callTool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ];
    return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  });
  return requests;
}
async function run(threadId: string, messages: UIMessage[] = [{ id: "user-message", role: "user", parts: [{ type: "text", text: `Remember: ${FACT}` }] }], temporaryPersonalization?: boolean) {
  const chunks: Array<{ type: string; [key: string]: unknown }> = [];
  const stream = await turnStream({ userId: "alice", threadId, modelRef: "custom-test/mock", uiMessages: messages, temporaryPersonalization });
  for await (const chunk of stream) chunks.push(chunk);
  assert.ok(!chunks.some((chunk) => chunk.type === "error"), JSON.stringify(chunks.filter((chunk) => chunk.type === "error")));
  return chunks;
}
const names = (request: ProviderRequest) => request.tools?.map((tool) => tool.function.name) ?? [];
const system = (request: ProviderRequest) => request.messages.filter((message) => message.role === "system").map((message) => JSON.stringify(message.content)).join("\n");

test("turnStream saves memory, gives a final answer at the agent limit, and recalls across chats", async (t) => {
  const requests = provider(t);
  const chunks = await run("first-chat");
  assert.equal(listMemories("alice").length, 1);
  assert.equal(listMemories("alice")[0]!.content, FACT);
  assert.equal(requests.length, 2, "one tool round plus a final model answer");
  assert.ok(names(requests[0]!).includes("memory_save"));
  assert.deepEqual(names(requests[1]!), names(requests[0]!), "the tool list stays constant so the prefix stays cached");
  assert.equal(requests[1]!.tool_choice, "none", "the final step must not call tools");
  assert.ok(chunks.some((chunk) => chunk.type === "text-delta"));
  assert.ok(chunks.some((chunk) => chunk.type === "finish"));
  await run("second-chat", [{ id: "recall", role: "user", parts: [{ type: "text", text: "What examples should you use?" }] }]);
  const recalled = requests[2]!;
  const recalledUsers = recalled.messages.filter((message) => message.role === "user");
  assert.equal(recalledUsers.length, 2, "saved facts arrive as ephemeral data before the current user message");
  assert.ok(JSON.stringify(recalledUsers[0]!.content).includes(FACT), "a new chat must receive the saved fact");
  assert.ok(JSON.stringify(recalledUsers[1]!.content).includes("What examples should you use?"));
  assert.ok(!system(recalled).includes(FACT), "retrieved facts must not churn the stable system prefix");
  ensureThread("alice", "excluded-chat");
  updateThread("alice", "excluded-chat", { memoryDisabled: true });
  await run("excluded-chat");
  assert.ok(!system(requests[3]!).includes(FACT));
  assert.ok(!JSON.stringify(requests[3]!.messages.filter((message) => message.role === "user")).includes("Retrieved saved memory"), "excluded chats receive no supplemental memory data");
  assert.ok(!names(requests[3]!).some((name) => name.startsWith("memory_")));
});

test("later turns replay each turn's recalled memory so the request prefix stays cached", async (t) => {
  const requests = provider(t, false);
  const { entry } = saveMemory("alice", { content: FACT }, "manual");
  const first: UIMessage = { id: "u1", role: "user", parts: [{ type: "text", text: "Which examples do I like?" }] };
  await run("cache-chat", [first]);
  const turn = [first, { id: "a1", role: "assistant", parts: [{ type: "text", text: "Concise TypeScript." }] } as UIMessage];
  await run("cache-chat", [...turn, { id: "u2", role: "user", parts: [{ type: "text", text: "And for Python?" }] }]);
  assert.deepEqual(requests[1]!.messages.slice(0, requests[0]!.messages.length), requests[0]!.messages, "the second request extends the first");
  assert.equal(JSON.stringify(requests[1]!.messages).split(FACT).length - 1, 1, "a fact already shown in this chat is not sent again");
  assert.equal(JSON.stringify(requests[1]!.messages).split("Today's date").length - 1, 1, "an unchanged date is not repeated");
  const deleted = await new Hono().use(requireUser).route("/", memoryRoutes).request(`/${entry.id}`, { method: "DELETE", headers: { Cookie: "okaychat_session=alice-session" } });
  assert.equal(deleted.status, 200);
  await run("cache-chat", [...turn, { id: "u2", role: "user", parts: [{ type: "text", text: "And for Python?" }] }]);
  assert.ok(!JSON.stringify(requests[2]!.messages).includes(FACT), "a deleted fact is never replayed");
});

test("every chat shares the first system message; chat context and the date come after the tools", async (t) => {
  const requests = provider(t, false);
  db.prepare("INSERT INTO projects (id, user_id, name, instructions, created_at) VALUES ('layer-project', 'alice', 'Layer', 'LAYER_PROJECT_INSTRUCTIONS', 1)").run();
  ensureThread("alice", "layer-a");
  db.prepare("UPDATE threads SET project_id = 'layer-project' WHERE id = 'layer-a'").run();
  await run("layer-a");
  await run("layer-b");
  const [a, b] = [requests[0]!.messages, requests[1]!.messages];
  assert.deepEqual(a[0], b[0], "the shared system part is identical across chats");
  assert.ok(!JSON.stringify(a[0]).includes("LAYER_PROJECT_INSTRUCTIONS") && !JSON.stringify(a[0]).includes("Today's date"));
  assert.equal(a[1]!.role, "system");
  assert.ok(JSON.stringify(a[1]).includes("LAYER_PROJECT_INSTRUCTIONS"), "project context is the second system message");
  assert.ok(JSON.stringify(a.filter((m) => m.role === "user")).includes("Today's date"), "the date rides in the turn context");
  const block = a.find((m) => m.role === "user" && JSON.stringify(m.content).includes("Today's date"));
  assert.ok(JSON.stringify(block!.content).startsWith('"<app_context>'), "the turn context names the app as its author, so it does not read as the user's words");
});

test("a temporary chat sends the date once, before its first user message", async (t) => {
  const requests = provider(t, false);
  const user = (id: string, text: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });
  const reply = (id: string): UIMessage => ({ id, role: "assistant", parts: [{ type: "text", text: "Okay." }] });
  await run("tmp_dates", [user("t1", "first")]);
  await run("tmp_dates", [user("t1", "first"), reply("r1"), user("t2", "second")]);
  await run("tmp_dates", [user("t1", "first"), reply("r1"), user("t2", "second"), reply("r2"), user("t3", "third")]);
  for (const request of requests) {
    const sent = request.messages.filter((m) => m.role !== "system").map((m) => JSON.stringify(m.content));
    assert.equal(sent.filter((text) => text.includes("Today's date")).length, 1, "the date is not repeated beside every message");
    assert.ok(sent[0]!.includes("Today's date") && sent[1]!.includes("first"), "the date sits before the first user message");
  }
  assert.deepEqual(requests[2]!.messages.slice(0, requests[1]!.messages.length), requests[1]!.messages, "each temporary request extends the previous one");
});

for (const approved of [true, false]) {
  test(`turnStream ${approved ? "saves an approved" : "does not save a denied"} memory and finishes within the continued agent budget`, async (t) => {
    db.prepare("UPDATE memory_preferences SET auto_save = 0 WHERE user_id = 'alice'").run();
    const requests = provider(t);
    const chunks = await run("approval-chat");
    assert.equal(listMemories("alice").length, 0, "requesting approval must not write memory");
    assert.equal(requests.length, 1);
    const approval = chunks.find((chunk) => chunk.type === "tool-approval-request");
    assert.ok(approval);
    assert.equal(typeof approval.approvalId, "string");
    const continued = await run("approval-chat", [
      { id: "user-message", role: "user", parts: [{ type: "text", text: `Remember: ${FACT}` }] },
      { id: "pending-assistant", role: "assistant", parts: [
        { type: "step-start" },
        { type: "tool-memory_save", toolCallId: "save-fact", input: { content: FACT }, state: "approval-responded", approval: { id: approval.approvalId as string, approved } },
      ] },
    ]);
    assert.equal(listMemories("alice").length, approved ? 1 : 0);
    if (approved) assert.equal(listMemories("alice")[0]!.content, FACT);
    assert.equal(requests.length, 2, "approval continuation gets exactly one final model response");
    assert.equal(requests[1]!.tool_choice, "none", "continuations cannot reset their tool-round allowance");
    assert.ok(continued.some((chunk) => chunk.type === "text-delta"));
    assert.ok(continued.some((chunk) => chunk.type === "finish"));
  });
}

test("continuations at an exhausted agent budget receive exactly one final step that cannot call tools", async (t) => {
  const requests = provider(t, false);
  const chunks = await run("continued-chat", [
    { id: "user", role: "user", parts: [{ type: "text", text: "Check my preferences" }] },
    { id: "assistant", role: "assistant", parts: [
      { type: "step-start" },
      { type: "tool-memory_search", toolCallId: "prior-search", input: { query: "preferences" }, state: "output-available", output: { memories: [] } },
    ] },
  ]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.tool_choice, "none");
  assert.ok(chunks.some((chunk) => chunk.type === "text-delta"));
});

function storedCounts() {
  return Object.fromEntries(["threads", "messages", "usage", "memories", "memory_preferences", "uploads", "artifacts"].map((table) =>
    [table, (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n],
  ));
}

/**
 * Temporary model calls are now metered (one usage row per provider invocation) without storing any
 * content. Everything else must stay untouched, and the new row must not name the temporary chat.
 */
function assertOnlyTemporaryUsageGrew(before: Record<string, number>, added = 1) {
  const after = storedCounts();
  assert.equal(after.usage, before.usage + added, "temporary model calls are metered");
  assert.deepEqual({ ...after, usage: before.usage }, before);
  const latest = db.prepare("SELECT thread_id AS thread FROM usage ORDER BY rowid DESC LIMIT 1").get() as { thread: string | null } | undefined;
  assert.equal(latest?.thread, null, "temporary usage retains no thread identifier");
}

test("temporary turns do not save data or include account personalization by default", async (t) => {
  const requests = provider(t, false);
  updateSettings("alice", { systemPrompt: "ACCOUNT_PRIVATE_INSTRUCTIONS", artifacts: true, generativeUI: true, subagents: true });
  saveMemory("alice", { content: FACT }, "manual");
  const before = storedCounts();
  await run("tmp_default", [{ id: "temporary-user", role: "user", parts: [{ type: "text", text: "Give me an example" }] }]);
  assert.ok(system(requests[0]!).includes("This is a temporary chat."));
  assertOnlyTemporaryUsageGrew(before);
  assert.ok(!JSON.stringify(requests[0]!.messages).includes(FACT));
  assert.ok(!system(requests[0]!).includes("ACCOUNT_PRIVATE_INSTRUCTIONS"));
  assert.deepEqual(names(requests[0]!), [], "temporary mode excludes memory mutations, artifacts, images, delegates, and browser tools");
});

test("temporary personalization reads only global memory and instructions without any writes", async (t) => {
  const requests = provider(t, false);
  updateSettings("alice", { systemPrompt: "ACCOUNT_PRIVATE_INSTRUCTIONS", artifacts: true, subagents: true });
  db.prepare("INSERT INTO projects (id, user_id, name, instructions, created_at) VALUES ('private-project', 'alice', 'Private', 'PROJECT_PRIVATE_INSTRUCTIONS', 1)").run();
  saveMemory("alice", { content: FACT }, "manual");
  saveMemory("alice", { content: "PROJECT_PRIVATE_FACT", scope: "private-project" }, "manual");
  const before = storedCounts();
  await run("tmp_personalized", [{ id: "temporary-user", role: "user", parts: [{ type: "text", text: "Give me an example" }] }], true);
  const sent = JSON.stringify(requests[0]!.messages);
  assert.ok(sent.includes(FACT));
  assert.ok(system(requests[0]!).includes("ACCOUNT_PRIVATE_INSTRUCTIONS"));
  assert.ok(!sent.includes("PROJECT_PRIVATE_FACT"));
  assert.ok(!sent.includes("PROJECT_PRIVATE_INSTRUCTIONS"));
  assert.deepEqual(names(requests[0]!), ["memory_search"]);
  assertOnlyTemporaryUsageGrew(before);
});

test("temporary API streams bypass replay storage and reject history and compaction writes", async (t) => {
  provider(t, false);
  const before = storedCounts();
  const response = await app.request("http://app/chat", { method: "POST", headers: { cookie: "okaychat_session=alice-session", "Content-Type": "application/json" }, body: JSON.stringify({
    id: "tmp_http", config: { modelName: "custom-test/mock" }, messages: [{ id: "user", role: "user", parts: [{ type: "text", text: "Private temporary content" }] }],
  }) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get(RESUMABLE_STREAM_ID_HEADER), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(await response.text(), /text-delta/);
  assert.throws(() => ensureThread("alice", "tmp_http"), /cannot be saved/);
  assert.throws(() => appendMessage("alice", "tmp_http", { id: "never", parent_id: null, format: "ai-sdk/v6", content: { role: "user", parts: [] } }), /cannot be saved/);
  const request = (method: string, route: string) => app.request(`http://app/threads/tmp_http/${route}`, { method, headers: { cookie: "okaychat_session=alice-session" } });
  assert.deepEqual(await (await request("POST", "title")).json(), { title: "Temporary chat" });
  assert.equal((await request("POST", "compact")).status, 400);
  assert.equal((await request("DELETE", "compact")).status, 400);
  assertOnlyTemporaryUsageGrew(before);
});

test("temporary PDF extraction returns text without storing original uploads", async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage().drawText("Temporary document content");
  const bytes = await pdf.save();
  const upload = (temporary: boolean) => {
    const form = new FormData();
    form.append("file", new File([bytes], "private.pdf", { type: "application/pdf" }));
    return app.request(`http://app/files/extract${temporary ? "?temporary=1" : ""}`, { method: "POST", headers: { cookie: "okaychat_session=alice-session" }, body: form });
  };
  const before = storedCounts();
  const response = await upload(true);
  assert.equal(response.status, 200);
  const content = await response.json();
  assert.match(content.text, /Temporary document content/);
  assert.equal(content.fileId, undefined);
  assert.deepEqual(storedCounts(), before);
  const normal = await (await upload(false)).json();
  assert.equal(typeof normal.fileId, "string", "normal document uploads must remain importable");
  assert.equal(storedCounts().uploads, before.uploads + 1);
});
