/// <reference types="node" />
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { DEFAULT_USER_SETTINGS, type ChatTargetInfo, type N8nAgentSummary } from "../../shared/types.js";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
  configurable: true,
});

const { useN8nAgents, startAgentAccount, invalidateAgentSession } = await import("./n8n-agents.js");
const { useData } = await import("./data.js");

const agentTarget = {
  kind: "agent" as const,
  ref: "n8n/agt_abcdefgh",
  providerId: "n8n" as const,
  id: "agt_abcdefgh",
  name: "Support workflow",
  description: "Answers from the support workflow",
  avatar: "workflow",
  shared: false,
  memoryMode: "remote" as const,
  reasoning: false as const,
  toolCall: false as const,
  attachments: false as const,
  inputModalities: ["text"] as ["text"],
  temperature: false as const,
  free: false as const,
  context: 0 as const,
  maxOutput: 0 as const,
} satisfies ChatTargetInfo;

const summary = (id: string): N8nAgentSummary => ({
  id,
  ref: `n8n/${id}`,
  name: id,
  description: "",
  avatar: "workflow",
  enabled: true,
  shared: false,
  canManage: true,
  memoryMode: "remote",
  protocol: "webhook",
  revision: 1,
});

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  useN8nAgents.getState().stop();
  useData.setState({ settings: { ...DEFAULT_USER_SETTINGS }, models: [], threadModels: {}, selectedModel: null, projects: [], activeProject: null });
});

test("a late answer for the previous account never paints the new account", async () => {
  const originalFetch = globalThis.fetch;
  const pending: Array<{ url: string; resolve: (response: Response) => void }> = [];
  globalThis.fetch = (input) => new Promise<Response>((resolve) => pending.push({ url: String(input), resolve }));
  try {
    startAgentAccount("account-a");
    startAgentAccount("account-b");
    // The first account's list answers after the switch.
    const listA = pending.find((p) => p.url.endsWith("/agents/n8n"));
    listA!.resolve(Response.json({ agents: [summary("agt_old00000")] }));
    await flush();
    assert.equal(useN8nAgents.getState().accountId, "account-b");
    assert.deepEqual(useN8nAgents.getState().agents, []);
    const listB = pending.filter((p) => p.url.endsWith("/agents/n8n")).at(-1)!;
    listB.resolve(Response.json({ agents: [summary("agt_new00000")] }));
    await flush();
    assert.deepEqual(useN8nAgents.getState().agents.map((agent) => agent.id), ["agt_new00000"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the store holds summaries only, never a URL or header value", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) =>
    String(input).endsWith("/agents/n8n")
      ? Response.json({ agents: [summary("agt_safe0000")] })
      : Response.json({ statuses: [] });
  try {
    startAgentAccount("account-safe");
    await flush();
    const serialized = JSON.stringify(useN8nAgents.getState());
    assert.equal(serialized.includes("webhookUrl"), false);
    assert.equal(serialized.includes("authHeader"), false);
    assert.equal(serialized.includes("session_enc"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a persistence failure resets only the current chat's agent session", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method?: string }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), method: init?.method });
    return Response.json({ ok: true });
  };
  try {
    useData.setState({ models: [agentTarget], threadModels: { t1: agentTarget.ref } });
    await invalidateAgentSession("t1");
    assert.deepEqual(calls, [{ url: "/api/threads/t1/agents/n8n/agt_abcdefgh/session", method: "DELETE" }]);
    // Temporary chats have no server session and must not call the endpoint.
    useData.setState({ threadModels: { tmp_1: agentTarget.ref } });
    await invalidateAgentSession("tmp_1");
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
