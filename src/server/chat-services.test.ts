import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test, type TestContext } from "node:test";
import type { UIMessage } from "ai";
import type { TurnUnavailable } from "../shared/services.js";

// A turn with a missing optional sidecar still answers, withholds only the tools that sidecar needs, and
// stores the reason on the reply. No real worker is contacted: the registry's probes are fakes.
const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-chat-services-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "chat-services-test-secret-only-not-for-production";
process.env.OKAYCHAT_SANDBOX_URL = "http://127.0.0.1:9";
process.env.OKAYCHAT_SANDBOX_TOKEN = "sandbox-test-token-0123456789abcdef";
writeFileSync(path.join(dataDir, "models-dev.json"), JSON.stringify({ data: {}, fetchedAt: Date.now() }));
const { db } = await import("./db.js");
const { saveConnection } = await import("./catalog/providers.js");
const { updateSettings } = await import("./settings.js");
const { ensureThread } = await import("./threads.js");
const { turnStream } = await import("./chat.js");
const { artifactTools } = await import("./artifacts.js");
const services = await import("./services.js");

db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('alice', 'alice@example.test', 'Alice', 'unused', 'admin', 1)").run();
saveConnection("alice", "custom-test", { baseURL: "http://mock.test/v1" });
const restrict = () => updateSettings("alice", { maxSteps: 1, maxSearches: 0, webTools: false, artifacts: true, generativeUI: false, subagents: false, autoCompactAt: 0, codeExecution: true, systemPrompt: "" });
restrict();
after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => {
  db.exec("DELETE FROM messages; DELETE FROM threads;");
  restrict();
  services.resetServicesForTests();
  services.setServiceProbeForTests("browser", async () => "unconfigured");
  services.setServiceProbeForTests("sandbox", async () => "unconfigured");
  services.setServiceProbeForTests("speech", async () => "unconfigured");
  services.setServiceProbeForTests("searxng", async () => "unconfigured");
});

type ProviderRequest = { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> };
const toolNames = (request: ProviderRequest) => request.tools?.map((tool) => tool.function.name) ?? [];

function provider(t: TestContext) {
  const requests: ProviderRequest[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "http://mock.test/v1/models") return Response.json({ data: [{ id: "mock" }] });
    assert.equal(url, "http://mock.test/v1/chat/completions");
    requests.push(JSON.parse(init?.body as string) as ProviderRequest);
    const chunks = [
      { id: "mock-response", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta: { role: "assistant", content: "The answer does not need a sandbox." }, finish_reason: null }] },
      { id: "mock-response", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ];
    return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  });
  return requests;
}

type Chunk = { type: string; messageMetadata?: { unavailable?: TurnUnavailable[] }; delta?: string };
async function run(threadId: string, messages: UIMessage[]) {
  const chunks: Chunk[] = [];
  const stream = await turnStream({ userId: "alice", threadId, modelRef: "custom-test/mock", uiMessages: messages });
  for await (const chunk of stream) chunks.push(chunk as Chunk);
  return chunks;
}

const turn = (id = "u1", text = "Hello there") => ({ id, role: "user", parts: [{ type: "text", text }] }) as UIMessage;
const unavailableOf = (chunks: Chunk[]) => chunks.find((chunk) => chunk.type === "start")?.messageMetadata?.unavailable ?? [];

test("a down sandbox withholds run_code, records the reason, and the chat still answers", async (t) => {
  services.setServiceProbeForTests("sandbox", async () => ({ results: { sandbox: { state: "down", reasonKey: "refuses", fixKey: "startSandbox" } } }));
  const requests = provider(t);
  ensureThread("alice", "down-sandbox");
  const chunks = await run("down-sandbox", [turn()]);

  assert.equal(requests.length, 1);
  assert.ok(!toolNames(requests[0]!).includes("run_code"), "a tool that needs the down sandbox is not offered");
  assert.ok(toolNames(requests[0]!).includes("create_document"), "unrelated tools keep working");
  const unavailable = unavailableOf(chunks);
  assert.deepEqual(unavailable, [{ service: "sandbox", tools: ["run_code"], reasonKey: "refuses", fixKey: "startSandbox" }]);
  assert.ok(chunks.some((chunk) => chunk.type === "text-delta" && chunk.delta?.includes("does not need a sandbox")), "the ordinary reply still streams");
});

test("the reason is kept on the finish metadata too, so a stored reply shows it", async (t) => {
  services.setServiceProbeForTests("sandbox", async () => ({ results: { sandbox: { state: "down", reasonKey: "timeout", fixKey: "startSandbox" } } }));
  provider(t);
  ensureThread("alice", "stored-reason");
  const chunks = await run("stored-reason", [turn()]);
  const finish = chunks.find((chunk) => chunk.type === "finish");
  assert.ok(finish?.messageMetadata?.unavailable?.some((entry) => entry.service === "sandbox" && entry.reasonKey === "timeout"));
});

test("a continuation keeps the tool list its turn started with, even after the sandbox recovers", async (t) => {
  services.setServiceProbeForTests("sandbox", async () => ({ results: { sandbox: { state: "down", reasonKey: "refuses", fixKey: "startSandbox" } } }));
  const requests = provider(t);
  ensureThread("alice", "continuation");
  const user = turn();
  const first = await run("continuation", [user]);
  const unavailable = unavailableOf(first);
  assert.deepEqual(unavailable.map((entry) => entry.service), ["sandbox"]);

  // The client sends the reply back with its metadata; the sandbox is reachable again by then.
  services.setServiceProbeForTests("sandbox", async () => ({ results: { sandbox: { state: "up", reasonKey: "ok" } } }));
  const assistant = { id: "a1", role: "assistant", parts: [{ type: "text", text: "The answer does not need a sandbox." }], metadata: { custom: { unavailable } } } as unknown as UIMessage;
  const second = await run("continuation", [user, assistant]);
  assert.equal(requests.length, 2);
  assert.ok(!toolNames(requests[1]!).includes("run_code"), "a mid-turn recovery must not change the cached tool block");
  assert.deepEqual(unavailableOf(second), unavailable, "the continuation reports the same reason");
});

test("a turn that started with every service up keeps its tools when one fails later", async (t) => {
  services.setServiceProbeForTests("sandbox", async () => ({ results: { sandbox: { state: "up", reasonKey: "ok" } } }));
  const requests = provider(t);
  ensureThread("alice", "stable-tools");
  const user = turn();
  await run("stable-tools", [user]);
  assert.ok(toolNames(requests[0]!).includes("run_code"));
  const assistant = { id: "a1", role: "assistant", parts: [{ type: "text", text: "Done." }] } as unknown as UIMessage;
  services.setServiceProbeForTests("sandbox", async () => ({ results: { sandbox: { state: "down", reasonKey: "refuses" } } }));
  await run("stable-tools", [user, assistant]);
  assert.ok(toolNames(requests[1]!).includes("run_code"), "the tool block is identical within the turn");
});

test("a document tool withholds only PDF, and says so with the service error", async () => {
  process.env.OKAYCHAT_BROWSER_URL = "";
  ensureThread("alice", "thr_pdf");
  const tools = artifactTools("thr_pdf", "alice", { shots: new Map(), canViewImages: false });
  assert.ok(tools.create_document, "Word and Excel keep working without a browser");
  await assert.rejects(
    tools.create_document!.execute!({ id: "report", title: "Report", kind: "pdf", content: "<h1>Hi</h1>" }, { toolCallId: "1", messages: [] }),
    (error: Error & { code?: string }) => error.code === "service_unavailable",
  );
  const docx = await tools.create_document!.execute!({ id: "letter", title: "Letter", kind: "docx", content: "<h1>Hi</h1>" }, { toolCallId: "2", messages: [] });
  assert.equal((docx as { kind: string }).kind, "docx");
});

test("view_artifact is omitted when the browser worker is down, and offered when it is up", () => {
  ensureThread("alice", "thr_shot");
  process.env.OKAYCHAT_BROWSER_URL = "http://127.0.0.1:9";
  try {
    const down = artifactTools("thr_shot", "alice", { shots: new Map(), canViewImages: true, browserDown: true });
    assert.equal(down.view_artifact, undefined);
    const up = artifactTools("thr_shot", "alice", { shots: new Map(), canViewImages: true });
    assert.ok(up.view_artifact, "a configured worker keeps the visual check");
  } finally {
    process.env.OKAYCHAT_BROWSER_URL = "";
  }
});
