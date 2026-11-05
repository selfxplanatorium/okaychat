/// <reference types="node" />
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { DEFAULT_USER_SETTINGS, type McpPromptInfo, type ModelInfo, type Project } from "../../shared/types.js";

const storage = new Map<string, string>([["okaychat:selected-model", "p/deepseek"]]);
Object.defineProperty(globalThis, "localStorage", { value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
}, configurable: true });
const { useData, getActiveModel, getActiveTarget } = await import("./data.js");
const models = ["deepseek", "luna", "project"].map((id) => ({ ref: `p/${id}` })) as ModelInfo[];
const agentTarget = {
  kind: "agent" as const,
  ref: "n8n/agt_12345678",
  providerId: "n8n" as const,
  id: "agt_12345678",
  name: "Support workflow",
  description: "",
  avatar: "workflow",
  shared: false,
  memoryMode: "history" as const,
  reasoning: false as const,
  toolCall: false as const,
  attachments: false as const,
  inputModalities: ["text"] as ["text"],
  temperature: false as const,
  free: false as const,
  context: 0 as const,
  maxOutput: 0 as const,
};
const initiallySelected = useData.getState().selectedModel;
beforeEach(() => useData.setState({ settings: { ...DEFAULT_USER_SETTINGS, defaultModel: "p/luna" }, models, projects: [], activeProject: null, selectedModel: null, threadModels: {} }));

test("a persisted composer choice cannot override the account default on load", () => {
  assert.equal(initiallySelected, null);
  assert.equal(getActiveModel()?.ref, "p/luna");
});

test("a new chat resets its composer override and uses the current default", () => {
  useData.getState().selectModel("p/deepseek");
  assert.equal(getActiveModel()?.ref, "p/deepseek");
  useData.getState().resetModel();
  assert.equal(getActiveModel()?.ref, "p/luna");
  assert.equal(storage.has("okaychat:selected-model"), false);
});

test("project defaults inherit the account model after clearing or leaving the project", () => {
  useData.setState({ projects: [{ id: "project", defaultModel: "p/project" }] as Project[] });
  useData.getState().setActiveProject("project");
  assert.equal(getActiveModel()?.ref, "p/project");
  useData.setState({ projects: [{ id: "project", defaultModel: null }] as Project[] });
  assert.equal(getActiveModel()?.ref, "p/luna");
  useData.getState().setActiveProject(null);
  assert.equal(getActiveModel()?.ref, "p/luna");
});

test("saving a default replaces the stale composer override and supports clearing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => Response.json({ ...useData.getState().settings, ...JSON.parse(init!.body as string) });
  try {
    useData.getState().selectModel("p/deepseek");
    await useData.getState().updateSettings({ defaultModel: "p/luna" });
    assert.equal(getActiveModel()?.ref, "p/luna");
    await useData.getState().updateSettings({ defaultModel: null });
    assert.equal(getActiveModel()?.ref, "p/deepseek");
    useData.getState().selectModel("unavailable/model");
    assert.equal(getActiveModel()?.ref, "p/deepseek");
  } finally { globalThis.fetch = originalFetch; }
});

test("each chat keeps its own model when another chat or the new chat picks one", async () => {
  const originalFetch = globalThis.fetch;
  const patches: unknown[] = [];
  globalThis.fetch = async (input, init) => (patches.push([String(input), JSON.parse(init!.body as string)]), Response.json({ ok: true }));
  try {
    useData.getState().rememberThreadModels({ a: "p/deepseek" });
    useData.getState().selectModel("p/project", "b");
    useData.getState().selectModel("p/luna");
    assert.equal(getActiveModel("a")?.ref, "p/deepseek");
    assert.equal(getActiveModel("b")?.ref, "p/project");
    assert.equal(getActiveModel()?.ref, "p/luna");
    assert.deepEqual(patches, [["/api/threads/b", { modelRef: "p/project" }]]);
    useData.getState().rememberThreadModels({ b: "p/deepseek" });
    assert.equal(getActiveModel("b")?.ref, "p/project");
  } finally { globalThis.fetch = originalFetch; }
});

test("a superseded discovery cannot restore prompts from an old MCP configuration", async () => {
  const originalFetch = globalThis.fetch;
  const pending: Array<(response: Response) => void> = [];
  globalThis.fetch = () => new Promise<Response>((resolve) => pending.push(resolve));
  try {
    const oldDiscovery = useData.getState().refreshMcpPrompts();
    const newDiscovery = useData.getState().refreshMcpPrompts();
    pending[1]!(Response.json([]));
    await newDiscovery;
    pending[0]!(Response.json([{ serverId: "old", server: "Old server", name: "old-prompt", arguments: [] }]));
    await oldDiscovery;
    assert.deepEqual(useData.getState().mcpPrompts, []);
  } finally { globalThis.fetch = originalFetch; }
});

test("prompt discovery failures remove previously available prompts", async () => {
  const originalFetch = globalThis.fetch;
  useData.setState({ mcpPrompts: [{ serverId: "server", server: "Server", name: "prompt", arguments: [] }] as McpPromptInfo[] });
  globalThis.fetch = async () => { throw new Error("Server unavailable"); };
  try {
    await useData.getState().refreshMcpPrompts();
    assert.deepEqual(useData.getState().mcpPrompts, []);
  } finally { globalThis.fetch = originalFetch; }
});

test("an explicit n8n ref that is gone stays unavailable instead of falling back to an LLM", () => {
  useData.getState().selectModel("n8n/agt_gone0000");
  assert.equal(getActiveModel(), undefined);
  assert.equal(getActiveTarget().unavailableRef, "n8n/agt_gone0000");
  // A non-agent stale ref keeps the previous fallback behavior.
  useData.getState().selectModel("p/gone");
  assert.equal(getActiveModel()?.ref, "p/luna");
  assert.equal(getActiveTarget().unavailableRef, undefined);
});

test("an agents-only account resolves the agent target and an explicit agent choice wins over defaults", () => {
  useData.setState({ models: [agentTarget], settings: { ...DEFAULT_USER_SETTINGS, defaultModel: "p/luna" } });
  assert.equal(getActiveModel()?.ref, agentTarget.ref);
  useData.setState({ models: [...models, agentTarget] });
  useData.getState().selectModel(agentTarget.ref);
  assert.equal(getActiveModel()?.ref, agentTarget.ref);
  assert.equal(getActiveTarget().unavailableRef, undefined);
});

test("an agent ref persists as a favorite without being treated as a language model", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => Response.json({ ...useData.getState().settings, ...JSON.parse(init!.body as string) });
  try {
    useData.setState({ models: [...models, agentTarget] });
    await useData.getState().updateSettings({ favoriteModels: [agentTarget.ref, "p/luna"] });
    assert.deepEqual(useData.getState().settings?.favoriteModels, [agentTarget.ref, "p/luna"]);
    // The account default may be an agent too; the chat target resolver accepts it.
    await useData.getState().updateSettings({ defaultModel: agentTarget.ref });
    assert.equal(getActiveModel()?.ref, agentTarget.ref);
  } finally { globalThis.fetch = originalFetch; }
});
