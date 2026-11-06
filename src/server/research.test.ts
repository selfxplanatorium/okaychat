import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test, type TestContext } from "node:test";
import { Hono } from "hono";
import { readUIMessageStream, type UIMessage } from "ai";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-research-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "research-test-secret-only-not-for-production";
delete process.env.OKAYCHAT_SEARXNG_URL;
writeFileSync(path.join(dataDir, "models-dev.json"), JSON.stringify({ data: {}, fetchedAt: Date.now() }));
const { db } = await import("./db.js");
const { saveConnection } = await import("./catalog/providers.js");
const { updateSettings } = await import("./settings.js");
const { turnStream, chatRoutes } = await import("./chat.js");
const { requireUser } = await import("./auth.js");
const { sha256 } = await import("./crypto.js");
const { agentStepsInCurrentTurn, searchesInCurrentTurn } = await import("./tools/search-budget.js");
const app = new Hono().use(requireUser).route("/", chatRoutes);
// Admin: a non-admin base URL goes through the address-checked fetch, which bypasses the mocked global fetch.
db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('alice', 'alice@example.test', 'Alice', 'unused', 'admin', 1)").run();
db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, 'alice', ?)").run(sha256("alice-session"), Date.now() + 600_000);
saveConnection("alice", "custom-test", { baseURL: "http://mock.test/v1" });
const defaults = { maxSteps: 20, maxSearches: 10, webTools: true, artifacts: false, generativeUI: false, subagents: false, autoCompactAt: 0, systemPrompt: "" };
after(() => { db.close(); rmSync(dataDir, { recursive: true, force: true }); });
beforeEach(() => {
  db.exec("DELETE FROM threads; DELETE FROM usage;");
  updateSettings("alice", defaults);
});

type Body = { stream?: boolean; messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }>; tool_choice?: unknown };
type Reply = { text: string } | { tool: string; input: unknown } | { status: number };
type Stage = "plan" | "worker" | "review" | "chat";

const systemText = (body: Body) => body.messages.filter((m) => m.role === "system").map((m) => JSON.stringify(m.content)).join("\n");
const stageOf = (body: Body): Stage => {
  const system = systemText(body);
  if (system.includes("You plan a web research project")) return "plan";
  if (system.includes("You are a research worker")) return "worker";
  if (system.includes("You review research notes")) return "review";
  return "chat";
};
const toolNames = (body: Body) => body.tools?.map((tool) => tool.function.name).sort() ?? [];
const toolResults = (body: Body) => body.messages.filter((m) => m.role === "tool").length;
const json = (value: unknown) => ({ text: JSON.stringify(value) });

function respond(reply: Reply, n: number, stream: boolean): Response {
  if ("status" in reply) return Response.json({ error: { message: "provider exploded" } }, { status: reply.status });
  if (!stream) {
    assert.ok("text" in reply, "tool-free stages never call tools");
    return Response.json({ id: `r${n}`, object: "chat.completion", created: 1, model: "mock", choices: [{ index: 0, message: { role: "assistant", content: reply.text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  }
  const delta = "tool" in reply
    ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${n}`, type: "function", function: { name: reply.tool, arguments: JSON.stringify(reply.input) } }] }
    : { role: "assistant", content: reply.text };
  const chunks = [
    { id: `r${n}`, object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta, finish_reason: null }] },
    { id: `r${n}`, object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "tool" in reply ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ];
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
}

const notes = (topic: string) => `## Answer\n${topic} is answered.\n## Evidence\n- ${topic} fact [Spec](https://example.test/${encodeURIComponent(topic)}) (primary)\n## Open points\n- None`;

/**
 * One fake provider for every stage, told apart by system prompt, and a fake search engine. Workers search
 * until a tool result comes back, then write notes; a step that forbids tools always gets notes.
 */
function transport(t: TestContext, script: {
  plan?: () => Reply;
  worker?: (body: Body, call: number) => Reply;
  review?: (call: number) => Reply;
  search?: (signal?: AbortSignal | null) => Promise<Response>;
}) {
  const log: Array<{ stage: Stage; body: Body }> = [];
  let searches = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "http://mock.test/v1/models") return Response.json({ data: [{ id: "mock" }] });
    if (url.startsWith("https://search.brave.com/")) {
      searches++;
      if (script.search) return script.search(init?.signal);
      return new Response(`<div data-type="web"><a href="https://example.test/${searches}"><span class="title">Result ${searches}</span></a></div>`);
    }
    assert.equal(url, "http://mock.test/v1/chat/completions", `unexpected request to ${url}`);
    const body = JSON.parse(init?.body as string) as Body;
    const stage = stageOf(body);
    log.push({ stage, body });
    const calls = log.filter((entry) => entry.stage === stage).length;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    // Let parallel workers overlap, as real requests would.
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    const forbid = body.tool_choice === "none";
    const reply: Reply =
      stage === "plan" ? script.plan?.() ?? json({ objective: "Compare A and B", questions: ["What is A?", "What is B?"] })
      : stage === "worker" ? (forbid ? { text: notes("forced") } : script.worker?.(body, calls) ?? (toolResults(body) ? { text: notes(`worker ${calls}`) } : { tool: "web_search", input: { query: `query ${calls}` } }))
      : stage === "review" ? script.review?.(calls) ?? json({ gaps: [], conflicts: [] })
      : { text: "Final cited report." };
    return respond(reply, log.length, body.stream === true);
  });
  return { log, searches: () => searches, maxInFlight: () => maxInFlight, of: (stage: Stage) => log.filter((entry) => entry.stage === stage).map((entry) => entry.body) };
}

type Chunk = { type: string; [key: string]: unknown };
const userMessage = (text = "Research A versus B"): UIMessage => ({ id: `user-${text.length}`, role: "user", parts: [{ type: "text", text }] });

async function run(threadId: string, opts: { messages?: UIMessage[]; deepResearch?: boolean; webSearch?: boolean; signal?: AbortSignal } = {}) {
  const chunks: Chunk[] = [];
  const stream = await turnStream({ userId: "alice", threadId, modelRef: "custom-test/mock", uiMessages: opts.messages ?? [userMessage()], deepResearch: opts.deepResearch ?? true, webSearch: opts.webSearch, signal: opts.signal });
  for await (const chunk of stream) chunks.push(chunk as Chunk);
  return chunks;
}
type Progress = { phase: string; round: number; questions: Array<{ question: string; status: string; error?: string }>; steps: number; searches: number; limited?: string; findings?: string; conflicts: string[]; gaps: string[]; cost: number };
const outputs = (chunks: Chunk[]) => chunks.filter((c) => c.type === "tool-output-available").map((c) => ({ ...(c.output as Progress), preliminary: c.preliminary === true }));
const finalOutput = (chunks: Chunk[]) => outputs(chunks).find((o) => !o.preliminary)!;
const usageKinds = () => (db.prepare("SELECT kind, count(*) AS n FROM usage GROUP BY kind ORDER BY kind").all() as Array<{ kind: string; n: number }>).map((row) => `${row.kind}:${row.n}`);

test("deep research plans, collects, follows up a gap, and hands cited findings to the chat model", async (t) => {
  const fake = transport(t, { review: (call) => (call === 1 ? json({ gaps: ["Is B still maintained?"], conflicts: [] }) : json({ gaps: [], conflicts: ["Source X and Y disagree on B's release date."] })) });
  const chunks = await run("research-chat", { webSearch: true });
  assert.ok(!chunks.some((c) => c.type === "error"), JSON.stringify(chunks.filter((c) => c.type === "error")));

  // Stages ran in order: plan, two workers, review, one follow-up worker, review, then the chat model's report.
  assert.deepEqual(fake.log.map((entry) => entry.stage).filter((stage, i, all) => stage !== all[i - 1]), ["plan", "worker", "review", "worker", "review", "chat"]);
  const call = chunks.find((c) => c.type === "tool-input-available");
  assert.equal(call?.toolName, "deep_research");
  assert.deepEqual(call?.input, { request: "Research A versus B" });
  assert.ok(chunks.findIndex((c) => c.type === "start") < chunks.findIndex((c) => c.type === "tool-input-available"), "the reply starts before its research part");
  assert.equal(chunks.filter((c) => c.type === "start").length, 1);
  const phases = new Set(outputs(chunks).filter((o) => o.preliminary).map((o) => o.phase));
  for (const phase of ["planning", "researching", "reviewing"]) assert.ok(phases.has(phase), phase);

  const final = finalOutput(chunks);
  assert.equal(final.phase, "done");
  assert.equal(final.round, 2);
  assert.deepEqual(final.questions.map((q) => [q.question, q.status]), [["What is A?", "done"], ["What is B?", "done"], ["Is B still maintained?", "done"]]);
  assert.equal(final.searches, 3);
  assert.equal(fake.searches(), 3);
  // Each worker took two tool-capable steps: one search, then its notes.
  assert.equal(final.steps, 6);
  assert.deepEqual(final.conflicts, ["Source X and Y disagree on B's release date."]);
  assert.ok(final.findings?.includes("### What is A?\n## Answer"));
  assert.match(final.findings ?? "", /\[Spec\]\(https:\/\/example.test\/worker%20\d+\) \(primary\)/);
  assert.ok(final.cost >= 0);

  // Workers search; the chat model gets the research result without a separate search mode.
  for (const body of fake.of("worker")) assert.deepEqual(toolNames(body), ["web_fetch", "web_search"]);
  const [chat] = fake.of("chat");
  assert.ok(toolNames(chat!).includes("deep_research"));
  assert.ok(!toolNames(chat!).includes("web_search"), "research takes priority even when both flags are sent");
  assert.ok(toolNames(chat!).includes("web_fetch"));
  const result = JSON.stringify(chat!.messages.filter((m) => m.role === "tool"));
  assert.ok(result.includes("Deep research has finished"));
  assert.ok(result.includes("disagree on B's release date"));
  assert.notEqual(chat!.tool_choice, "none", "14 of 20 steps are left for the reply");
  assert.ok(chunks.some((c) => c.type === "text-delta" && c.delta === "Final cited report."));

  // Every model invocation is metered under its own kind; the reply is metered as chat.
  const researchRequests = fake.log.length - fake.of("chat").length;
  assert.deepEqual(usageKinds(), ["chat:1", `research:${researchRequests}`]);
  const research = db.prepare("SELECT COUNT(*) AS requests, SUM(input_tokens) AS input FROM usage WHERE kind = 'research'").get() as { requests: number; input: number };
  assert.equal(research.requests, researchRequests, "one ledger row per non-chat invocation");
  assert.equal(research.input, 10 * researchRequests);
});

test("the client assembles research progress and the report into one replayable assistant message", async (t) => {
  transport(t, {});
  const stream = await turnStream({ userId: "alice", threadId: "assembled-chat", modelRef: "custom-test/mock", uiMessages: [userMessage()], deepResearch: true });
  let message: UIMessage | undefined;
  for await (const update of readUIMessageStream({ stream })) message = update;
  assert.ok(message?.id, "the stream assigns an id for history persistence");
  assert.equal(message.role, "assistant");
  const research = message.parts.find((part) => part.type === "tool-deep_research");
  assert.ok(research && "state" in research && research.state === "output-available");
  assert.ok(message.parts.some((part) => part.type === "text" && part.text === "Final cited report."));
  assert.ok(searchesInCurrentTurn([userMessage(), message]) > 0, "assembled history retains nested search counts");
  assert.ok(agentStepsInCurrentTurn([userMessage(), message]) > 0, "assembled history retains nested step counts");
});

test("research stages receive today's date outside their cached system prompts", async (t) => {
  const fake = transport(t, {});
  await run("dated-chat");
  const date = new Date().toISOString().slice(0, 10);
  for (const stage of ["plan", "worker", "review"] as const) {
    for (const body of fake.of(stage)) {
      assert.ok(JSON.stringify(body.messages.filter((m) => m.role === "user")).includes(date), stage);
      assert.ok(!systemText(body).includes(date), "the date must not churn the system prefix");
    }
  }
});

test("a failed final review preserves unanswered questions and reports incomplete verification", async (t) => {
  const fake = transport(t, {
    review: (call) => call === 1 ? json({ gaps: ["Is B still maintained?"], conflicts: ["A's sources disagree."] }) : { text: "not valid JSON" },
  });
  const final = finalOutput(await run("review-failed-chat"));
  assert.equal(final.phase, "done", "paid-for notes still reach the report");
  assert.ok(final.gaps.includes("Is B still maintained?"));
  assert.ok(final.gaps.some((gap) => gap.includes("review did not complete")));
  assert.deepEqual(final.conflicts, ["A's sources disagree."]);
  assert.match(final.findings ?? "", /coverage and conflicts remain unverified/);
  assert.equal(fake.of("chat").length, 1);
});

test("a repeated unresolved question stays visible after the last research round", async (t) => {
  transport(t, { review: () => json({ gaps: ["What is A?"], conflicts: [] }) });
  const final = finalOutput(await run("unresolved-chat"));
  assert.equal(final.round, 2);
  assert.deepEqual(final.gaps, ["What is A?"]);
  assert.match(final.findings ?? "", /## Open questions\n- What is A/);
});

test("research respects the account's search and step limits and leaves the reply no tool steps", async (t) => {
  updateSettings("alice", { maxSearches: 1, maxSteps: 3 });
  // The worker keeps searching; the second query is refused by the shared budget.
  const fake = transport(t, { worker: () => ({ tool: "web_search", input: { query: "again" } }), review: () => json({ gaps: ["More?"], conflicts: [] }) });
  const chunks = await run("limited-chat");
  assert.ok(systemText(fake.of("plan")[0]!).includes("at most 1 research questions"));
  const final = finalOutput(chunks);
  assert.equal(fake.searches(), 1, "the search limit is a hard cap");
  assert.equal(final.searches, 1);
  assert.equal(final.steps, 3);
  assert.equal(final.limited, "searches");
  assert.equal(final.round, 1, "no follow-up round without budget");
  assert.ok(final.findings?.includes("web search limit for this reply was reached"));
  // Three tool steps, then one forced answer.
  assert.equal(fake.of("worker").length, 4);
  assert.equal(fake.of("worker").at(-1)!.tool_choice, "none");
  assert.equal(fake.of("chat")[0]!.tool_choice, "none", "research used the reply's whole step allowance");
});

test("a failing worker is reported while the others' evidence is kept", async (t) => {
  const fake = transport(t, { worker: (body, call) => (call === 1 ? { status: 400 } : toolResults(body) ? { text: notes("B") } : { tool: "web_search", input: { query: "B" } }) });
  const chunks = await run("failure-chat");
  const final = finalOutput(chunks);
  assert.deepEqual(final.questions.map((q) => q.status), ["failed", "done"]);
  // The card gets the safe taxonomy message; the raw provider body stays in the server log.
  assert.equal(final.questions[0]!.error, "That request was not valid.");
  assert.ok(!JSON.stringify(final).includes("provider exploded"));
  assert.ok(final.findings?.includes("No notes: "));
  assert.equal(fake.of("chat").length, 1);
});

test("research that collects no evidence fails the reply instead of inventing one", async (t) => {
  const fake = transport(t, { worker: () => ({ status: 400 }) });
  const chunks = await run("empty-chat");
  const failed = chunks.find((c) => c.type === "tool-output-error");
  const wire = JSON.parse(String(failed?.errorText)) as { code: string; message: string };
  assert.equal(wire.code, "tool_failed");
  assert.match(wire.message, /could not collect evidence/);
  assert.ok(chunks.some((c) => c.type === "error"));
  assert.equal(fake.of("chat").length, 0);
  assert.deepEqual(usageKinds(), ["research:1"], "spent research is still metered");
});

test("Stop cancels in-flight searches and every later stage", async (t) => {
  const controller = new AbortController();
  let searchAborted = false;
  const fake = transport(t, {
    plan: () => json({ objective: "A", questions: ["What is A?"] }),
    search: (signal) => new Promise((_, reject) => {
      signal?.addEventListener("abort", () => { searchAborted = true; reject(signal.reason); }, { once: true });
      controller.abort();
    }),
  });
  const chunks = await run("stopped-chat", { signal: controller.signal });
  assert.ok(searchAborted, "the search request saw the abort");
  const stopped = JSON.parse(String(chunks.find((c) => c.type === "tool-output-error")?.errorText)) as { code: string; message: string };
  assert.equal(stopped.code, "aborted");
  assert.equal(stopped.message, "Stopped.");
  assert.equal(fake.of("review").length, 0);
  assert.equal(fake.of("chat").length, 0);
  assert.equal(fake.of("worker").length, 1);
});

test("with sub-agents allowed, workers run in parallel on the delegate model", async (t) => {
  updateSettings("alice", { subagents: true });
  const fake = transport(t, { plan: () => json({ objective: "ABC", questions: ["A?", "B?", "C?"] }) });
  const final = finalOutput(await run("parallel-chat"));
  assert.equal(final.questions.filter((q) => q.status === "done").length, 3);
  assert.ok(fake.maxInFlight() > 1, "workers overlapped");
});

test("a continuation of a researched reply does not research again and keeps its counts", async (t) => {
  updateSettings("alice", { maxSearches: 4, maxSteps: 6 });
  const fake = transport(t, {});
  const researched: UIMessage = {
    id: "assistant-1",
    role: "assistant",
    parts: [{ type: "tool-deep_research", toolCallId: "research_1", state: "output-available", input: { request: "Research A versus B" }, output: { phase: "done", steps: 5, searches: 4, findings: "Objective: A\n\n## Findings\n### A?\nA [Spec](https://example.test/a)" } }],
  } as UIMessage;
  const messages = [userMessage(), researched];
  assert.equal(searchesInCurrentTurn(messages), 4);
  assert.equal(agentStepsInCurrentTurn(messages), 5);
  await run("continued-chat", { messages });
  assert.deepEqual(fake.log.map((entry) => entry.stage), ["chat"]);
  const [chat] = fake.of("chat");
  assert.ok(toolNames(chat!).includes("deep_research"), "the tool stays listed so the stored result converts the same way");
  assert.ok(JSON.stringify(chat!.messages).includes("Deep research has finished"));
  // One step was left, so the reply may use it once before it must answer.
  assert.notEqual(chat!.tool_choice, "none");
});

test("chats without research keep their tool block; temporary research is metered without retaining its chat", async (t) => {
  const fake = transport(t, {});
  await run("plain-chat", { deepResearch: false });
  assert.ok(!toolNames(fake.of("chat")[0]!).includes("deep_research"));
  assert.ok(toolNames(fake.of("chat")[0]!).includes("web_search"));
  await run("tmp_research");
  assert.equal(fake.of("chat").length, 2);
  const temporaryResearch = fake.log.length - fake.of("chat").length;
  assert.deepEqual(usageKinds(), ["chat:2", `research:${temporaryResearch}`], "each invocation is metered, including temporary research");
  const temporary = db.prepare("SELECT COUNT(*) AS n FROM usage WHERE thread_id IS NULL").get() as { n: number };
  assert.equal(temporary.n, temporaryResearch + 1, "temporary research and its reply retain no thread identifier");
  const stored = db.prepare("SELECT COUNT(*) AS n FROM usage WHERE thread_id = 'plain-chat'").get() as { n: number };
  assert.equal(stored.n, 1, "the stored chat keeps its thread linkage");
});

test("unavailable deep research is refused with the reason before anything runs", async (t) => {
  const fake = transport(t, {});
  const post = (config: Record<string, unknown>) => app.request("http://app/chat", {
    method: "POST",
    headers: { cookie: "okaychat_session=alice-session", "Content-Type": "application/json" },
    body: JSON.stringify({ id: "tmp_unavailable", messages: [userMessage()], config: { modelName: "custom-test/mock", deepResearch: true, ...config } }),
  });
  updateSettings("alice", { webTools: false });
  let response = await post({});
  assert.equal(response.status, 400);
  assert.match(((await response.json()) as { error: string }).error, /needs web tools/);
  updateSettings("alice", { webTools: true, maxSearches: 0 });
  response = await post({});
  assert.equal(response.status, 400);
  assert.match(((await response.json()) as { error: string }).error, /search limit is 0/);
  assert.equal(fake.log.length, 0);
  // The request config reaches the turn: with research available, the stream opens with the research part.
  updateSettings("alice", { maxSearches: 10 });
  response = await post({});
  assert.equal(response.status, 200);
  assert.match(await response.text(), /"toolName":"deep_research"/);
});
