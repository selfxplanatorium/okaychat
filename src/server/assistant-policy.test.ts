import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolSet } from "ai";
import type { ToolPolicy } from "../shared/assistant-presets.js";
import { allowedToolKeys, assistantAllowsResearch, filterAssistantTools } from "./assistant-policy.js";

const tools = (keys: string[]): ToolSet => Object.fromEntries(keys.map((key) => [key, { marker: key }])) as unknown as ToolSet;
const keys = (set: ToolSet) => Object.keys(set).sort();

const selected = (builtins: string[], mcpTools: Array<{ serverId: string; toolName: string }> = []): ToolPolicy => ({
  mode: "selected",
  builtins,
  mcpTools,
});

test("selected policy keeps exact builtin families and denies unknown keys", () => {
  const filtered = filterAssistantTools(
    selected(["web", "code"]),
    tools(["web_search", "web_fetch", "run_code", "create_artifact", "mystery_tool"]),
  );
  assert.deepEqual(keys(filtered), ["run_code", "web_fetch", "web_search"]);
});

test("inherit leaves the account's full tool set untouched", () => {
  const all = tools(["web_search", "email_send", "search_knowledge"]);
  assert.equal(filterAssistantTools({ mode: "inherit", builtins: [], mcpTools: [] }, all), all);
});

test("research requires both the research and web families", () => {
  assert.equal(assistantAllowsResearch(selected(["research"])), false);
  assert.equal(assistantAllowsResearch(selected(["web"])), false);
  assert.equal(assistantAllowsResearch(selected(["research", "web"])), true);
  assert.deepEqual(keys(filterAssistantTools(selected(["research"]), tools(["deep_research", "web_search"]))), []);
  assert.deepEqual(keys(filterAssistantTools(selected(["research", "web"]), tools(["deep_research", "web_search"]))), ["deep_research", "web_search"]);
});

test("delegation is dropped without the delegate family", () => {
  assert.deepEqual(keys(filterAssistantTools(selected(["web"]), tools(["delegate_task", "web_search"]))), ["web_search"]);
  assert.deepEqual(keys(filterAssistantTools(selected(["delegate"]), tools(["delegate_task", "web_search"]))), ["delegate_task"]);
});

test("MCP grants keep exact server identity, so a same-named tool on another server is denied", () => {
  const identities = new Map([
    ["alpha__run", { serverId: "alpha", toolName: "run" }],
    ["beta__run", { serverId: "beta", toolName: "run" }],
  ]);
  const filtered = filterAssistantTools(
    selected([], [{ serverId: "alpha", toolName: "run" }]),
    tools(["alpha__run", "beta__run", "web_search"]),
    { mcpIdentities: identities },
  );
  assert.deepEqual(keys(filtered), ["alpha__run"]);
});

test("a selected policy omits MCP resource helpers that could name a server at call time", () => {
  const identities = new Map([
    ["mcp_list_resources", { serverId: "alpha", toolName: "mcp_list_resources" }],
    ["mcp_read_resource", { serverId: "alpha", toolName: "mcp_read_resource" }],
  ]);
  const filtered = filterAssistantTools(
    selected([], [
      { serverId: "alpha", toolName: "mcp_list_resources" },
      { serverId: "alpha", toolName: "mcp_read_resource" },
    ]),
    tools(["mcp_list_resources", "mcp_read_resource"]),
    { mcpIdentities: identities },
  );
  assert.deepEqual(keys(filtered), []);
});

test("allowedToolKeys lists exactly what the filtered set can contain", () => {
  const allowed = allowedToolKeys(selected(["knowledge", "memory"]));
  assert.ok(allowed.has("search_knowledge"));
  assert.ok(allowed.has("memory_search"));
  assert.ok(!allowed.has("run_code"));
});
