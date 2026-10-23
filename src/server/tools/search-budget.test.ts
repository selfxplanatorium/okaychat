import assert from "node:assert/strict";
import { test } from "node:test";
import { SearchBudget, agentStepsInCurrentTurn, searchesInCurrentTurn } from "./search-budget.js";
import { webTools } from "./web.js";

test("parent and delegated parallel searches share one hard limit", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    requests++;
    await Promise.resolve();
    if (new Headers(init?.headers).get("Accept") === "application/json") {
      return Response.json({ results: [{ title: "Evidence", url: "https://example.test", content: "" }] });
    }
    return new Response('<div data-type="web"><a href="https://example.test"><span class="title">Evidence</span></a></div>');
  });
  const searchBudget = new SearchBudget(2);
  const parent = webTools({ searchBudget });
  const delegated = webTools({ searchBudget });
  const results = await Promise.allSettled([parent, delegated, delegated, parent].map((tools, i) =>
    tools.web_search!.execute!({ query: `query ${i}` }, { toolCallId: String(i), messages: [] }),
  ));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  assert.equal(results.filter((r) => r.status === "rejected").length, 2);
  assert.equal(requests, 2);
  assert.equal(searchBudget.remaining, 0);
});

test("a zero search limit blocks the network without removing page reading", async (t) => {
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected network access"); });
  const tools = webTools({ searchBudget: new SearchBudget(0) });
  await assert.rejects(async () => tools.web_search!.execute!({ query: "blocked" }, { toolCallId: "zero", messages: [] }), /search limit/);
  assert.equal(network.mock.callCount(), 0);
  assert.ok(tools.web_fetch?.execute);
});

test("the composer search toggle hides searching but keeps page reading", () => {
  const tools = webTools({ search: false });
  assert.equal(tools.web_search, undefined);
  assert.ok(tools.web_fetch?.execute);
});

test("failed searches consume a query without granting retry loops", async (t) => {
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  const tools = webTools({ searchBudget: new SearchBudget(1) });
  await assert.rejects(async () => tools.web_search!.execute!({ query: "fails" }, { toolCallId: "first", messages: [] }), /Search failed/);
  const attempts = network.mock.callCount();
  await assert.rejects(async () => tools.web_search!.execute!({ query: "retries" }, { toolCallId: "second", messages: [] }), /search limit/);
  assert.equal(network.mock.callCount(), attempts);
});

test("browser-tool continuations retain parent and delegated search counts until the next user turn", () => {
  const prior = [
    { role: "user", parts: [] },
    { role: "assistant", parts: [{ type: "tool-web_search" }] },
    { role: "user", parts: [] },
    { role: "assistant", parts: [
      { type: "tool-web_search", state: "output-available" },
      { type: "dynamic-tool", toolName: "web_search" },
      { type: "tool-delegate_task", output: { tools: ["web_search", "web_fetch", "web_search"] } },
      { type: "tool-web_fetch" },
      { type: "tool-delegate_task", output: null },
    ] },
  ];
  assert.equal(searchesInCurrentTurn(prior), 4);
  const budget = new SearchBudget(5, searchesInCurrentTurn(prior));
  assert.equal(budget.reserve(), true);
  assert.equal(budget.reserve(), false);
  assert.equal(searchesInCurrentTurn([...prior, { role: "user", parts: [] }]), 0);
});

test("agent steps include all model invocations in the current reply across request continuations", () => {
  const messages = [
    { role: "user", parts: [] },
    { role: "assistant", parts: [{ type: "step-start" }, { type: "step-start" }] },
    { role: "user", parts: [] },
    { role: "assistant", parts: [
      { type: "step-start" },
      { type: "tool-web_search" },
      { type: "tool-web_search" },
      { type: "step-start" },
      { type: "tool-delegate_task", output: { steps: 15 } },
      { type: "step-start" },
      { type: "tool-memory_save", state: "approval-responded", approval: { approved: true } },
    ] },
    { role: "assistant", parts: [
      { type: "step-start" },
      { type: "text", text: "Final reply" },
    ] },
  ];
  assert.equal(agentStepsInCurrentTurn(messages), 4);
  assert.equal(agentStepsInCurrentTurn([...messages, { role: "user", parts: [] }]), 0);
  assert.equal(agentStepsInCurrentTurn([{ role: "assistant", parts: [null, undefined, { type: "text" }, { type: "tool-memory_save", state: "output-available" }] }]), 0);
});
