import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test, type TestContext } from "node:test";
import type { UIMessage } from "ai";

// draft_email through a real chat turn: offered without any mailbox, executed without approval (a
// draft never leaves the app), and its result reaches the next model step only inside an envelope.

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-email-draft-chat-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "email-draft-chat-test-secret-only-not-for-production";
writeFileSync(path.join(dataDir, "models-dev.json"), JSON.stringify({ data: {}, fetchedAt: Date.now() }));
const { db } = await import("../db.js");
const { saveConnection } = await import("../catalog/providers.js");
const { updateSettings } = await import("../settings.js");
const { ensureThread } = await import("../threads.js");
const { turnStream } = await import("../chat.js");
const { getDraft } = await import("./drafts.js");

db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('alice', 'alice@example.test', 'Alice', 'unused', 'admin', 1)").run();
saveConnection("alice", "custom-test", { baseURL: "http://mock.test/v1" });
updateSettings("alice", { maxSteps: 3, maxSearches: 0, webTools: false, artifacts: false, generativeUI: false, subagents: false, autoCompactAt: 0 });
after(() => { db.close(); rmSync(dataDir, { recursive: true, force: true }); });

type ProviderRequest = { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> };

function fakeProvider(t: TestContext, args: Record<string, unknown>, toolName = "draft_email") {
  const requests: ProviderRequest[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "http://mock.test/v1/models") return Response.json({ data: [{ id: "mock" }] });
    const body = JSON.parse(init?.body as string) as ProviderRequest;
    requests.push(body);
    const first = requests.length === 1;
    const delta = first
      ? { role: "assistant", tool_calls: [{ index: 0, id: "draft-1", type: "function", function: { name: toolName, arguments: JSON.stringify(args) } }] }
      : { role: "assistant", content: "Here is a draft." };
    const chunks = [
      { id: "mock", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta, finish_reason: null }] },
      { id: "mock", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ];
    return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  });
  return { requests };
}

test("draft_email is offered without a mailbox, runs without approval, and returns an enveloped draft", async (t) => {
  const { requests } = fakeProvider(t, { to: ["bob@example.test"], subject: "Lunch", body: "Noon?" });
  ensureThread("alice", "draft-chat");
  const messages: UIMessage[] = [{ id: "u1", role: "user", parts: [{ type: "text", text: "Draft a lunch email to Bob." }] }];
  const chunks: Array<{ type: string; [key: string]: unknown }> = [];
  for await (const chunk of await turnStream({ userId: "alice", threadId: "draft-chat", modelRef: "custom-test/mock", uiMessages: messages, interactive: true })) chunks.push(chunk);
  const names = requests[0]?.tools?.map((item) => item.function.name) ?? [];
  assert.ok(names.includes("draft_email"));
  assert.equal(names.includes("email_send"), false, "no mailbox, no send tools");
  assert.equal(chunks.some((chunk) => chunk.type === "tool-approval-request"), false);
  const output = chunks.find((chunk) => chunk.type === "tool-output-available") as { output: { draft: { id: string } } } | undefined;
  assert.ok(output);
  assert.equal(getDraft("alice", "draft-chat", output.output.draft.id).subject, "Lunch");
  const toolMessage = JSON.stringify(requests[1]?.messages.find((message) => message.role === "tool"));
  assert.match(toolMessage, /untrusted_data/);
  assert.match(toolMessage, /email_draft/);
});


test("draft_text is offered in stored chats and creates an enveloped writing draft", async (t) => {
  const { requests } = fakeProvider(t, { title: "Team message", body: "See you Friday." }, "draft_text");
  ensureThread("alice", "writing-chat");
  const messages: UIMessage[] = [{ id: "u1", role: "user", parts: [{ type: "text", text: "Write a message to my team." }] }];
  const chunks: Array<{ type: string; [key: string]: unknown }> = [];
  for await (const chunk of await turnStream({ userId: "alice", threadId: "writing-chat", modelRef: "custom-test/mock", uiMessages: messages, interactive: true })) chunks.push(chunk);
  assert.ok(requests[0]?.tools?.some((item) => item.function.name === "draft_text"));
  const output = chunks.find((chunk) => chunk.type === "tool-output-available") as { output: { draft: { id: string } } } | undefined;
  assert.ok(output);
  const draft = getDraft("alice", "writing-chat", output.output.draft.id);
  assert.equal(draft.kind, "text");
  assert.equal(draft.body, "See you Friday.");
  assert.equal(chunks.some((chunk) => chunk.type === "tool-approval-request"), false);
  assert.match(JSON.stringify(requests[1]?.messages.find((message) => message.role === "tool")), /text_draft/);
});
