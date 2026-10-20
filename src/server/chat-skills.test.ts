import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test, type TestContext } from "node:test";
import { Hono } from "hono";
import type { UIMessage } from "ai";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-chat-skills-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "chat-skills-test-secret-only-not-for-production";
writeFileSync(path.join(dataDir, "models-dev.json"), JSON.stringify({ data: {}, fetchedAt: Date.now() }));
const { db } = await import("./db.js");
const { saveConnection } = await import("./catalog/providers.js");
const { updateSettings } = await import("./settings.js");
const { turnStream, chatRoutes } = await import("./chat.js");
const { requireUser } = await import("./auth.js");
const { sha256 } = await import("./crypto.js");
const { saveSkill } = await import("./skills.js");
const app = new Hono().use(requireUser).route("/", chatRoutes);
db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('alice', 'alice@example.test', 'Alice', 'unused', 'user', 1)").run();
db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, 'alice', ?)").run(sha256("alice-session"), Date.now() + 600_000);
saveConnection("alice", "custom-test", { baseURL: "http://mock.test/v1" });
updateSettings("alice", { maxSteps: 2, maxSearches: 0, webTools: false, artifacts: false, generativeUI: false, subagents: false, autoCompactAt: 0 });
after(() => { db.close(); rmSync(dataDir, { recursive: true, force: true }); });
beforeEach(() => {
  db.exec("DELETE FROM skills; DELETE FROM skill_files; DELETE FROM skill_sources; DELETE FROM skill_preferences; DELETE FROM threads;");
  updateSettings("alice", { maxSteps: 2, maxSearches: 0, webTools: false, artifacts: false, generativeUI: false, subagents: false, autoCompactAt: 0, systemPrompt: "" });
});

type ProviderRequest = { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> };
/** A provider that calls one tool in the first step, then answers. */
function provider(t: TestContext, calls: Array<{ tool: string; input: unknown }>) {
  const requests: ProviderRequest[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "http://mock.test/v1/models") return Response.json({ data: [{ id: "mock" }] });
    assert.equal(url, "http://mock.test/v1/chat/completions", "all requests must stay inside the fake transport");
    const body = JSON.parse(init?.body as string) as ProviderRequest;
    requests.push(body);
    const call = requests.length <= calls.length ? calls[requests.length - 1] : undefined;
    const delta = call
      ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${requests.length}`, type: "function", function: { name: call.tool, arguments: JSON.stringify(call.input) } }] }
      : { role: "assistant", content: "Done." };
    const chunks = [
      { id: "mock-response", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta, finish_reason: null }] },
      { id: "mock-response", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ];
    return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  });
  return requests;
}

async function run(threadId: string, messages: UIMessage[] = [{ id: "user-message", role: "user", parts: [{ type: "text", text: "Hi" }] }]) {
  const chunks: Array<{ type: string; [key: string]: unknown }> = [];
  const stream = await turnStream({ userId: "alice", threadId, modelRef: "custom-test/mock", uiMessages: messages });
  for await (const chunk of stream) chunks.push(chunk);
  assert.ok(!chunks.some((chunk) => chunk.type === "error"), JSON.stringify(chunks.filter((chunk) => chunk.type === "error")));
  return chunks;
}
const names = (request: ProviderRequest) => request.tools?.map((tool) => tool.function.name) ?? [];
const system = (request: ProviderRequest) => request.messages.filter((message) => message.role === "system").map((message) => JSON.stringify(message.content)).join("\n");

test("turnStream injects the enabled skill index and offers skill tools", async (t) => {
  const requests = provider(t, [{ tool: "load_skill", input: { name: "release-notes" } }]);
  const approval = db.prepare("INSERT INTO skill_preferences (user_id, enabled, revision) VALUES ('alice', 1, 1)").run();
  assert.ok(approval.changes === 1);
  saveSkill("alice", { name: "release-notes", description: "Formats release notes in house style.", body: "# Format\n\nKeep it terse." }, "manual");
  await run("skills-chat");
  const sent = system(requests[0]!);
  assert.ok(!sent.includes("# Skills"));
  const tail = JSON.stringify(requests[0]!.messages.filter((m) => m.role !== "system"));
  assert.ok(tail.includes("# Skills"));
  assert.ok(tail.includes("`release-notes`: Formats release notes in house style."));
  assert.ok(!sent.includes("Keep it terse"), "skill bodies stay out of the stable prefix until load_skill");
  for (const tool of ["load_skill", "read_skill_file", "search_skill_sources", "install_skill", "create_skill"]) {
    assert.ok(names(requests[0]!).includes(tool), tool);
  }
  // The tool ran; the second step still offers tools (budget left).
  assert.ok(requests[1]!.messages.some((message) => JSON.stringify(message.content).includes("Keep it terse") || message.role === "tool"));
});

test("turnStream leaves skills out when the preference is off or the chat is anonymous", async (t) => {
  const requests = provider(t, []);
  saveSkill("alice", { name: "release-notes", description: "Formats release notes in house style.", body: "Keep it terse." }, "manual");
  db.prepare("INSERT INTO skill_preferences (user_id, enabled, revision) VALUES ('alice', 0, 0)").run();
  await run("plain-chat");
  assert.ok(!system(requests[0]!).includes("# Skills"));
  assert.ok(!names(requests[0]!).some((name) => name.includes("skill")));
  // Anonymous chats never see skills, even with the preference on.
  db.prepare("UPDATE skill_preferences SET enabled = 1, revision = 1 WHERE user_id = 'alice'").run();
  await run("tmp_anon");
  assert.ok(!system(requests[1]!).includes("# Skills"));
  assert.ok(!names(requests[1]!).some((name) => name.includes("skill")));
});

test("an approved create_skill stores the drafted skill; a denied one does not", async (t) => {
  const requests = provider(t, [{ tool: "create_skill", input: { name: "chat-skill", description: "From this chat.", instructions: "# Steps\n1. Drafted from chat." } }]);
  db.prepare("INSERT INTO skill_preferences (user_id, enabled, revision) VALUES ('alice', 1, 1)").run();
  const chunks = await run("draft-chat");
  assert.equal(db.prepare("SELECT count(*) AS n FROM skills WHERE user_id = 'alice'").get().n, 0, "the draft waits for approval");
  const approval = chunks.find((chunk) => chunk.type === "tool-approval-request");
  assert.ok(approval);
  assert.equal(typeof approval.approvalId, "string");
  const messages = [
    { id: "user-message", role: "user" as const, parts: [{ type: "text" as const, text: "Hi" }] },
    { id: "assistant", role: "assistant" as const, parts: [
      { type: "step-start" as const },
      { type: "tool-create_skill" as const, toolCallId: "call-1", input: { name: "chat-skill", description: "From this chat.", instructions: "# Steps\n1. Drafted from chat." }, state: "approval-responded" as const, approval: { id: approval.approvalId as string, approved: true } },
    ] },
  ];
  // Continue on a fresh thread-less run: the approved tool result replays from the message list.
  const continued = await run("draft-chat", messages as UIMessage[]);
  assert.equal(db.prepare("SELECT name, origin FROM skills WHERE user_id = 'alice'").get() !== undefined, true);
  const row = db.prepare("SELECT name, description, body, origin FROM skills WHERE user_id = 'alice'").get() as { name: string; description: string; body: string; origin: string };
  assert.equal(row.name, "chat-skill");
  assert.equal(row.origin, "conversation");
  assert.ok(row.body.includes("Drafted from chat."));
  assert.ok(continued.some((chunk) => chunk.type === "finish"));
  // The prompt index of the NEXT chat contains the new skill.
  const requests2 = provider(t, []);
  await run("next-chat");
  assert.ok(JSON.stringify(requests2[0]!.messages.filter((m) => m.role !== "system")).includes("`chat-skill`: From this chat."));
  assert.equal(system(requests2[0]!), system(requests[0]!), "installing a skill must not alter the system prefix");
});
