import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test, type TestContext } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-chat-widgets-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "chat-widgets-test-secret-only-not-for-production";
writeFileSync(path.join(dataDir, "models-dev.json"), JSON.stringify({ data: {}, fetchedAt: Date.now() }));
const { db } = await import("./db.js");
const { saveConnection } = await import("./catalog/providers.js");
const { updateSettings } = await import("./settings.js");
const { turnStream } = await import("./chat.js");
const { writePolicy } = await import("./permissions/store.js");

// Admin: a non-admin base URL goes through the address-checked fetch, which bypasses the mocked global fetch.
db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('alice', 'alice@example.test', 'Alice', 'unused', 'admin', 1)").run();
saveConnection("alice", "custom-test", { baseURL: "http://mock.test/v1" });
const settings = { maxSteps: 1, maxSearches: 0, webTools: false, artifacts: false, generativeUI: true, subagents: false, autoCompactAt: 0, systemPrompt: "" };
after(() => { db.close(); rmSync(dataDir, { recursive: true, force: true }); });
beforeEach(() => {
  db.exec("DELETE FROM permission_policies; DELETE FROM threads;");
  updateSettings("alice", settings);
});

const clientTools = { render_spec: { description: "Render a spec", parameters: { type: "object", properties: {} } } };

function provider(t: TestContext) {
  const tools: string[][] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "http://mock.test/v1/models") return Response.json({ data: [{ id: "mock" }] });
    const body = JSON.parse(init?.body as string) as { tools?: Array<{ function: { name: string } }> };
    tools.push((body.tools ?? []).map((tool) => tool.function.name));
    const chunks = [
      { id: "r", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: null }] },
      { id: "r", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ];
    return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  });
  return tools;
}

async function offered(t: TestContext): Promise<string[]> {
  const tools = provider(t);
  const stream = await turnStream({
    userId: "alice",
    threadId: "thr_widgets",
    modelRef: "custom-test/mock",
    uiMessages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "Hi" }] }],
    clientTools,
  });
  for await (const chunk of stream) assert.notEqual(chunk.type, "error", JSON.stringify(chunk));
  return tools[0] ?? [];
}

test("browser widget tools reach the model when generative UI is on", async (t) => {
  assert.ok((await offered(t)).includes("render_spec"));
});

test("the setting and the generativeUI permission each withhold browser widget tools", async (t) => {
  updateSettings("alice", { ...settings, generativeUI: false });
  assert.ok(!(await offered(t)).includes("render_spec"));
  updateSettings("alice", settings);
  writePolicy({ kind: "user", id: "alice" }, null, { version: 1, features: { generativeUI: false } }, null);
  assert.ok(!(await offered(t)).includes("render_spec"));
});
