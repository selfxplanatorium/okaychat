import type { ToolSet } from "ai";
import type { ToolFamily, ToolPolicy } from "../shared/assistant-presets.js";
import { FAMILY_TOOLS, TOOL_FAMILIES } from "../shared/assistant-presets.js";

/**
 * Deterministic capability intersection for a restrictive assistant. Under `inherit` the account's
 * normal tools pass through. Under `selected`, a tool is kept only if its exact builtin family was
 * chosen or its MCP server/tool identity was chosen; anything unknown is denied. This is applied to
 * the main tool set, to the read-only set handed to sub-agents, and to research workers, so a filtered
 * main list can never leave an unfiltered delegation path.
 */

export interface McpToolIdentity {
  serverId: string;
  toolName: string;
}

/** MCP resource helpers let the model name a server at call time, so a selected policy omits them. */
export const MCP_RESOURCE_TOOLS = ["mcp_list_resources", "mcp_read_resource"] as const;

const familyToolKeys = (family: ToolFamily): readonly string[] => FAMILY_TOOLS[family];

export function assistantAllowsFamily(policy: ToolPolicy, family: ToolFamily): boolean {
  return policy.mode === "inherit" || policy.builtins.includes(family);
}

/** Research needs the research family and the web family: it cannot search otherwise. */
export function assistantAllowsResearch(policy: ToolPolicy): boolean {
  return assistantAllowsFamily(policy, "research") && assistantAllowsFamily(policy, "web");
}

export function assistantAllowsDelegation(policy: ToolPolicy): boolean {
  return assistantAllowsFamily(policy, "delegate");
}

export interface FilterAssistantToolsOptions {
  /** Exposed MCP tool name → exact server/tool identity, from the manager's selector-filtered build. */
  mcpIdentities?: ReadonlyMap<string, McpToolIdentity>;
  /** Tool keys that are browser-executed (frontend tool schemas). Unknown keys in this family are denied. */
  frontendKeys?: ReadonlySet<string>;
}

/** The set of exact tool keys a selected policy permits. Exported for tests and for the options API. */
export function allowedToolKeys(policy: ToolPolicy, options: FilterAssistantToolsOptions = {}): Set<string> {
  if (policy.mode === "inherit") return new Set();
  const allowed = new Set<string>();
  for (const family of policy.builtins) {
    if (!(TOOL_FAMILIES as readonly string[]).includes(family)) continue;
    for (const key of familyToolKeys(family as ToolFamily)) allowed.add(key);
  }
  // Research is one tool; the web family is checked separately where the caller assembles it.
  if (!assistantAllowsResearch(policy)) allowed.delete("deep_research");
  if (!assistantAllowsDelegation(policy)) allowed.delete("delegate_task");
  for (const mcp of policy.mcpTools) {
    for (const [exposed, identity] of options.mcpIdentities ?? []) {
      if (identity.serverId === mcp.serverId && identity.toolName === mcp.toolName) allowed.add(exposed);
    }
  }
  // A selected policy never exposes the resource helpers: their server argument would bypass selectors.
  for (const key of MCP_RESOURCE_TOOLS) allowed.delete(key);
  return allowed;
}

export function filterAssistantTools(policy: ToolPolicy, tools: ToolSet, options: FilterAssistantToolsOptions = {}): ToolSet {
  if (policy.mode === "inherit") return tools;
  const allowed = allowedToolKeys(policy, options);
  const out: ToolSet = {};
  for (const [key, tool] of Object.entries(tools)) {
    if (allowed.has(key)) out[key] = tool;
  }
  return out;
}

/**
 * A lightweight projection for the composer: which builtin families this preset would allow. It never
 * claims availability; the options route intersects it with the live account catalog.
 */
export const selectedFamilies = (policy: ToolPolicy): readonly ToolFamily[] =>
  policy.mode === "inherit" ? TOOL_FAMILIES : (policy.builtins.filter((family) => (TOOL_FAMILIES as readonly string[]).includes(family)) as ToolFamily[]);
