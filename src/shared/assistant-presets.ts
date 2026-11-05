import type { ModelInfo, ReasoningEffort } from "./types.js";

/**
 * Named assistant presets: reusable model, instructions, sampling, and a restrictive tool/knowledge
 * policy. A chat copies a snapshot when a preset is selected, so editing a library item never changes
 * an existing conversation. Everything here is pure so both sides validate the same way.
 */

/** One static icon name. A closed list keeps the picker from fetching or rendering remote icons. */
export const ASSISTANT_ICONS = [
  "sparkles",
  "bot",
  "book-open",
  "code",
  "pen-line",
  "search",
  "graduation-cap",
  "briefcase",
] as const;
export type AssistantIcon = (typeof ASSISTANT_ICONS)[number];

export const DEFAULT_ASSISTANT_ICON: AssistantIcon = "sparkles";

export const MAX_PRESET_NAME = 80;
export const MAX_PRESET_DESCRIPTION = 240;
export const MAX_PRESET_INSTRUCTIONS = 20_000;
/** Instructions are also capped in bytes, because code points undercount non-Latin text. */
export const MAX_PRESET_INSTRUCTIONS_BYTES = 80 * 1024;
export const MAX_PRESETS_PER_ACCOUNT = 100;
export const MAX_PRESET_CONFIG_BYTES = 96 * 1024;
export const MAX_PRESET_KNOWLEDGE_IDS = 20;
export const MAX_PRESET_MCP_TOOLS = 300;
export const PUBLISHED_PAGE_SIZE = 50;
export const PUBLISHED_PAGE_CAP = 500;

/** Exact builtin families. A preset grants a family, never an arbitrary tool string. */
export const TOOL_FAMILIES = [
  "web",
  "memory",
  "knowledge",
  "skills",
  "email-read",
  "email-write",
  "drafts",
  "artifacts",
  "images",
  "code",
  "widgets",
  "delegate",
  "research",
  "attachments",
] as const;
export type ToolFamily = (typeof TOOL_FAMILIES)[number];

/**
 * The concrete tool keys each family owns, as assembled by `chat.ts`. The server uses this to
 * intersect the live tool set; a key that is not listed anywhere is denied under a selected policy.
 */
export const FAMILY_TOOLS: Readonly<Record<ToolFamily, readonly string[]>> = {
  web: ["web_search", "web_fetch"],
  memory: ["memory_search", "memory_save", "memory_forget", "conversation_search", "conversation_read"],
  knowledge: ["search_knowledge", "read_knowledge_chunk"],
  skills: ["load_skill", "read_skill_file", "search_skill_sources", "install_skill", "create_skill"],
  "email-read": ["email_folders", "email_list", "email_search", "email_read"],
  "email-write": ["email_send", "email_reply"],
  drafts: ["draft_email", "draft_text"],
  artifacts: [
    "create_artifact",
    "update_artifact",
    "read_artifact",
    "create_document",
    "edit_document",
    "read_document",
    "import_document",
    "view_artifact",
  ],
  images: ["generate_image"],
  code: ["run_code"],
  // Browser-executed tools. Unknown frontend keys are denied under a selected policy.
  widgets: ["render_spec", "show_widget", "edit_widget", "read_me", "preview_widget"],
  delegate: ["delegate_task"],
  research: ["deep_research"],
  attachments: ["read_attachment"],
};

/** Family owning a concrete tool key, or undefined for an unknown key (denied under `selected`). */
export function toolFamilyOf(toolKey: string): ToolFamily | undefined {
  for (const family of TOOL_FAMILIES) {
    if (FAMILY_TOOLS[family].includes(toolKey)) return family;
  }
  return undefined;
}

export interface McpToolSelector {
  serverId: string;
  toolName: string;
}

/** `inherit` means the account's current tools; `selected` is an allowlist (empty means none). */
export interface ToolPolicy {
  mode: "inherit" | "selected";
  builtins: string[];
  mcpTools: McpToolSelector[];
}

export interface KnowledgePolicy {
  mode: "inherit" | "selected";
  ids: string[];
}

export interface SamplingSettings {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
}

export interface PresetConfig {
  modelRef: string | null;
  instructions: string;
  sampling: SamplingSettings;
  reasoningEffort?: ReasoningEffort;
  tools: ToolPolicy;
  knowledge: KnowledgePolicy;
}

export type PresetVisibility = "private" | "published";

export interface AssistantPreset {
  id: string;
  name: string;
  description: string;
  icon: AssistantIcon;
  config: PresetConfig;
  visibility: PresetVisibility;
  revision: number;
  createdAt: number;
  updatedAt: number;
  owner: { id: string; name: string };
  owned: boolean;
}

/** A copied configuration plus informational provenance. It grants no permission. */
export interface AssistantSnapshot extends PresetConfig {
  sourceId: string;
  sourceRevision: number;
  name: string;
  icon: AssistantIcon;
  origin: PresetVisibility;
}

/** Builder options: what the account may grant, never a permission by itself. */
export interface PresetOptions {
  models: ModelInfo[];
  builtins: Array<{ id: string; labelKey: string; available: boolean; reasonKey?: string }>;
  mcpTools: Array<{ serverId: string; serverName: string; toolName: string; available: boolean }>;
  collections: Array<{ id: string; name: string; available: boolean }>;
}

export interface ThreadAssistant {
  snapshot: AssistantSnapshot | null;
  revision: number;
}

/** The immutable configuration a provider request runs with. Kept private except its display fields. */
export interface ResolvedRunConfig {
  version: 1;
  requestKind: "send" | "retry" | "tool-result" | "continue";
  continuationOf?: string;
  /** Server context for outgoing events. Absent on legacy receipts, which emit nothing at startup. */
  turnOrigin?: "interactive" | "schedule" | "comparison";
  modelRef: string;
  reasoningEffort?: ReasoningEffort;
  sampling: SamplingSettings;
  instructions: string;
  toolPolicy: ToolPolicy;
  knowledgeIds: string[];
  assistantName: string | null;
  assistantIcon: AssistantIcon | null;
  assistantRevision: number | null;
  webSearch: boolean;
  deepResearch: boolean;
}

/** What an assistant picker needs to offer a model. */
export interface SamplingCapabilities {
  temperature: boolean;
  topP: boolean;
  maxOutputTokens: boolean;
  maxOutput: number;
  temperatureMax: number;
}

/** The plan-included personal login can only run its own model with default sampling. */
export const isPlanLoginProvider = (providerId: string): boolean => providerId === "chatgpt";

/**
 * Catalog-driven sampling support. Reasoning models expose no temperature/top-p unless reasoning is
 * explicitly off, because some providers reject the combination instead of ignoring it.
 */
export function samplingCapabilities(model: Pick<ModelInfo, "providerId" | "reasoning" | "temperature" | "maxOutput">, effort: ReasoningEffort | undefined): SamplingCapabilities {
  const plan = isPlanLoginProvider(model.providerId);
  const reasoningOff = effort === "none" || model.reasoning === false;
  const adjustable = model.temperature && !plan && reasoningOff;
  return {
    temperature: adjustable,
    topP: adjustable,
    maxOutputTokens: !plan && model.maxOutput > 0,
    maxOutput: model.maxOutput,
    temperatureMax: isAnthropic(model.providerId) ? 1 : 2,
  };
}

const isAnthropic = (providerId: string) => providerId === "anthropic";

export const MAX_OUTPUT_CEILING = 131_072;

export interface SamplingValidation {
  ok: boolean;
  message?: string;
  sampling: SamplingSettings;
}

/**
 * Strictly validates requested sampling against a model and effort. Never drops a field silently:
 * this is what turns a published preset from another account into an actionable error.
 */
export function validateSampling(
  requested: SamplingSettings,
  model: Pick<ModelInfo, "providerId" | "reasoning" | "temperature" | "maxOutput">,
  effort: ReasoningEffort | undefined,
): SamplingValidation {
  const caps = samplingCapabilities(model, effort);
  const sampling: SamplingSettings = {};
  if (requested.temperature !== undefined) {
    if (!caps.temperature) return { ok: false, message: "Temperature is not available for this model and reasoning effort.", sampling };
    if (!Number.isFinite(requested.temperature) || requested.temperature < 0 || requested.temperature > caps.temperatureMax) {
      return { ok: false, message: `Temperature must be between 0 and ${caps.temperatureMax} for this model.`, sampling };
    }
    sampling.temperature = requested.temperature;
  }
  if (requested.topP !== undefined) {
    if (!caps.topP) return { ok: false, message: "Top P is not available for this model and reasoning effort.", sampling };
    if (!Number.isFinite(requested.topP) || requested.topP <= 0 || requested.topP > 1) {
      return { ok: false, message: "Top P must be greater than 0 and at most 1.", sampling };
    }
    sampling.topP = requested.topP;
  }
  if (requested.temperature !== undefined && requested.topP !== undefined) {
    return { ok: false, message: "Set either temperature or top P, not both.", sampling };
  }
  if (requested.maxOutputTokens !== undefined) {
    if (!caps.maxOutputTokens) return { ok: false, message: "Max output tokens cannot be changed for this model.", sampling };
    const ceiling = Math.min(caps.maxOutput, MAX_OUTPUT_CEILING);
    if (!Number.isInteger(requested.maxOutputTokens) || requested.maxOutputTokens < 1 || requested.maxOutputTokens > ceiling) {
      return { ok: false, message: `Max output tokens must be a whole number between 1 and ${ceiling}.`, sampling };
    }
    sampling.maxOutputTokens = requested.maxOutputTokens;
  }
  return { ok: true, sampling };
}

/** True when the catalog offers no adjustable field, so the editor can hide the whole Advanced foldout. */
export const hasSamplingControls = (caps: SamplingCapabilities): boolean => caps.temperature || caps.topP || caps.maxOutputTokens;

/** Code-point count, not UTF-16 units: names and instructions count what people see. */
export const codePoints = (text: string): number => [...text].length;
export const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

export interface PresetInput {
  name: string;
  description: string;
  icon: AssistantIcon;
  config: PresetConfig;
  visibility: PresetVisibility;
}

export type Validation<T> = { ok: true; value: T } | { ok: false; message: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";

/** Builds an empty config for a new assistant. */
export const emptyPresetConfig = (): PresetConfig => ({
  modelRef: null,
  instructions: "",
  sampling: {},
  tools: { mode: "inherit", builtins: [], mcpTools: [] },
  knowledge: { mode: "inherit", ids: [] },
});

const REASONING_EFFORTS: readonly ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const isReasoningEffort = (value: unknown): value is ReasoningEffort => REASONING_EFFORTS.includes(value as ReasoningEffort);

/** Validates one tool policy independently, so the editor and the server agree. */
export function validateToolPolicy(value: unknown): Validation<ToolPolicy> {
  if (!isRecord(value)) return { ok: false, message: "Choose how this assistant may use tools." };
  if (value.mode !== "inherit" && value.mode !== "selected") return { ok: false, message: "Unknown tool mode." };
  const builtinsRaw = value.builtins ?? [];
  if (!Array.isArray(builtinsRaw) || builtinsRaw.some((entry) => !isString(entry))) return { ok: false, message: "Invalid tool selection." };
  const builtins = [...new Set(builtinsRaw)];
  if (builtins.length > TOOL_FAMILIES.length || builtins.some((entry) => !(TOOL_FAMILIES as readonly string[]).includes(entry))) {
    return { ok: false, message: "Unknown tool family." };
  }
  const mcpRaw = value.mcpTools ?? [];
  if (!Array.isArray(mcpRaw) || mcpRaw.length > MAX_PRESET_MCP_TOOLS) return { ok: false, message: "Too many MCP tools selected." };
  const seen = new Set<string>();
  const mcpTools: McpToolSelector[] = [];
  for (const entry of mcpRaw) {
    if (!isRecord(entry) || !isString(entry.serverId) || !isString(entry.toolName)) return { ok: false, message: "Invalid MCP tool selection." };
    if (!entry.serverId || !entry.toolName || entry.serverId.length > 200 || entry.toolName.length > 200) return { ok: false, message: "Invalid MCP tool selection." };
    const key = `${entry.serverId}\0${entry.toolName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mcpTools.push({ serverId: entry.serverId, toolName: entry.toolName });
  }
  const policy: ToolPolicy = { mode: value.mode, builtins: builtins.sort(), mcpTools };
  return { ok: true, value: policy };
}

/** Stable JSON ordering for quota accounting and byte-equality comparisons. */
export function configKey(config: PresetConfig): string {
  return JSON.stringify({
    modelRef: config.modelRef,
    instructions: config.instructions,
    sampling: config.sampling,
    reasoningEffort: config.reasoningEffort ?? null,
    tools: { mode: config.tools.mode, builtins: [...config.tools.builtins].sort(), mcpTools: config.tools.mcpTools },
    knowledge: config.knowledge,
  });
}

/**
 * Validates a preset config. Model-dependent sampling is checked later against the live catalog, so a
 * stored preset stays readable after its model disappears.
 */
export function validatePresetConfig(value: unknown): Validation<PresetConfig> {
  if (!isRecord(value)) return { ok: false, message: "Invalid assistant configuration." };
  const modelRef = value.modelRef ?? null;
  if (modelRef !== null && (!isString(modelRef) || modelRef.length < 3 || modelRef.length > 300)) return { ok: false, message: "Invalid model." };
  const instructions = value.instructions ?? "";
  if (!isString(instructions)) return { ok: false, message: "Invalid instructions." };
  if (codePoints(instructions) > MAX_PRESET_INSTRUCTIONS || utf8Bytes(instructions) > MAX_PRESET_INSTRUCTIONS_BYTES) {
    return { ok: false, message: "Instructions are too long." };
  }
  const tools = validateToolPolicy(value.tools ?? { mode: "inherit" });
  if (!tools.ok) return tools;
  if (tools.value.mode === "inherit" && (tools.value.builtins.length || tools.value.mcpTools.length)) {
    return { ok: false, message: "Inherited tools cannot also list selected tools." };
  }
  const knowledgeRaw = value.knowledge ?? { mode: "inherit" };
  if (!isRecord(knowledgeRaw) || (knowledgeRaw.mode !== "inherit" && knowledgeRaw.mode !== "selected")) {
    return { ok: false, message: "Choose how this assistant may use knowledge." };
  }
  const idsRaw = knowledgeRaw.ids ?? [];
  if (!Array.isArray(idsRaw) || idsRaw.some((entry) => !isString(entry))) return { ok: false, message: "Invalid knowledge selection." };
  const ids = [...new Set(idsRaw)];
  if (ids.length > MAX_PRESET_KNOWLEDGE_IDS || ids.some((id) => !id || id.length > 200)) return { ok: false, message: "Too many knowledge collections selected." };
  if (knowledgeRaw.mode === "inherit" && ids.length) return { ok: false, message: "Inherited knowledge cannot also list collections." };
  const samplingRaw = value.sampling ?? {};
  if (!isRecord(samplingRaw)) return { ok: false, message: "Invalid sampling settings." };
  const sampling: SamplingSettings = {};
  for (const key of ["temperature", "topP", "maxOutputTokens"] as const) {
    const raw = samplingRaw[key];
    if (raw === undefined || raw === null) continue;
    // Numeric strings, NaN, and Infinity are all rejected here, before any provider sees them.
    if (typeof raw !== "number" || !Number.isFinite(raw)) return { ok: false, message: "Sampling values must be finite numbers." };
    sampling[key] = raw;
  }
  let reasoningEffort: ReasoningEffort | undefined;
  if (value.reasoningEffort !== undefined && value.reasoningEffort !== null) {
    if (!isReasoningEffort(value.reasoningEffort)) return { ok: false, message: "Unknown reasoning effort." };
    reasoningEffort = value.reasoningEffort;
  }
  const config: PresetConfig = {
    modelRef,
    instructions,
    sampling,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    tools: tools.value,
    knowledge: { mode: knowledgeRaw.mode, ids },
  };
  if (utf8Bytes(configKey(config)) > MAX_PRESET_CONFIG_BYTES) return { ok: false, message: "This assistant configuration is too large." };
  return { ok: true, value: config };
}

/** Whole create/update body. Kept strict so a client cannot smuggle extra fields into storage. */
export function validatePresetInput(value: unknown): Validation<PresetInput> {
  if (!isRecord(value)) return { ok: false, message: "Invalid assistant." };
  if (!isString(value.name)) return { ok: false, message: "Give this assistant a name." };
  const name = value.name.trim();
  if (!name || codePoints(name) > MAX_PRESET_NAME) return { ok: false, message: `Names are 1 to ${MAX_PRESET_NAME} characters.` };
  const description = value.description ?? "";
  if (!isString(description) || codePoints(description) > MAX_PRESET_DESCRIPTION) return { ok: false, message: "Description is too long." };
  const icon = value.icon ?? DEFAULT_ASSISTANT_ICON;
  if (!isString(icon) || !(ASSISTANT_ICONS as readonly string[]).includes(icon)) return { ok: false, message: "Unknown icon." };
  const config = validatePresetConfig(value.config ?? {});
  if (!config.ok) return config;
  const visibility = value.visibility ?? "private";
  if (visibility !== "private" && visibility !== "published") return { ok: false, message: "Unknown visibility." };
  return { ok: true, value: { name, description, icon: icon as AssistantIcon, config: config.value, visibility } };
}

/** Published items may not reference private resources another user cannot resolve. */
export function publishabilityError(config: PresetConfig): string | null {
  if (config.knowledge.mode === "selected" && config.knowledge.ids.length) {
    return "Published assistants cannot select private knowledge collections.";
  }
  if (config.tools.mode === "selected" && config.tools.mcpTools.length) {
    return "Published assistants cannot select MCP tools from private servers.";
  }
  return null;
}

/** A copy taken into a chat. Built from validated values only, never from a client-supplied snapshot. */
export function snapshotOf(preset: Pick<AssistantPreset, "id" | "revision" | "name" | "icon" | "config" | "visibility">): AssistantSnapshot {
  return {
    ...preset.config,
    sourceId: preset.id,
    sourceRevision: preset.revision,
    name: preset.name,
    icon: preset.icon,
    origin: preset.visibility,
  };
}

/** Config part of a snapshot, without provenance. */
export const configOfSnapshot = (snapshot: AssistantSnapshot): PresetConfig => ({
  modelRef: snapshot.modelRef,
  instructions: snapshot.instructions,
  sampling: snapshot.sampling,
  reasoningEffort: snapshot.reasoningEffort,
  tools: snapshot.tools,
  knowledge: snapshot.knowledge,
});
