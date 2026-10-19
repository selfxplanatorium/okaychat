// Types shared by server and web. Keep free of runtime imports.

export type WireFormat = "openai-responses" | "openai-chat" | "anthropic" | "google";

export interface ModelCost {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Higher price once a request's input exceeds `above` tokens. */
  tiers?: Array<{ above: number; input: number; output: number; cacheRead?: number; cacheWrite?: number }>;
}

export interface ModelInfo {
  /** `${providerId}/${modelId}` */
  ref: string;
  providerId: string;
  id: string;
  name: string;
  family?: string;
  format: WireFormat;
  baseURL?: string;
  context: number;
  maxOutput: number;
  reasoning: boolean;
  reasoningEfforts?: string[];
  toolCall: boolean;
  attachments: boolean;
  inputModalities: string[];
  temperature: boolean;
  cost?: ModelCost;
  free: boolean;
  releaseDate?: string;
  knowledge?: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  doc?: string;
  /** Primary providers are shown first and set up during onboarding. */
  primary: boolean;
  custom: boolean;
  needsBaseURL: boolean;
  connected: boolean;
  enabled: boolean;
  baseURL?: string;
  modelCount: number;
}

export interface ProviderConnectionInput {
  apiKey?: string;
  baseURL?: string;
  name?: string;
  enabled?: boolean;
}

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface UserSettings {
  defaultModel?: string;
  /** Used for titles and compaction summaries. Falls back to the chat model. */
  utilityModel?: string;
  favoriteModels: string[];
  reasoningEffort: Record<string, ReasoningEffort>;
  systemPrompt: string;
  /** Fraction of the context window that triggers automatic compaction. 0 disables. */
  autoCompactAt: number;
  /** Max agent steps (tool round trips) per turn. */
  maxSteps: number;
  /** Built-in web_search and web_fetch tools. */
  webTools: boolean;
  /** Built-in artifact tools: documents and apps shown in a side panel. */
  artifacts: boolean;
  /** Generative UI: declarative components and sandboxed HTML/SVG widgets, rendered in the browser. */
  generativeUI: boolean;
  /** Lets the chat model delegate tasks to sub-agents. */
  subagents: boolean;
  /** Default sub-agent model. The utility model and the chat model are also offered. */
  subagentModel?: string;
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  favoriteModels: [],
  reasoningEffort: {},
  systemPrompt: "",
  autoCompactAt: 0.8,
  maxSteps: 20,
  webTools: true,
  artifacts: true,
  generativeUI: true,
  subagents: true,
};

export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Attached to every assistant message as AI SDK message metadata. */
export interface AssistantMetadata {
  modelRef?: string;
  usage?: TokenUsage;
  cost?: number;
  /** Tokens the conversation occupies after this turn (last step input + output). */
  contextTokens?: number;
  contextWindow?: number;
  durationMs?: number;
  compacted?: boolean;
  /** Set when the turn ran in plan mode. */
  mode?: "plan";
}

export interface CompactionState {
  /** Messages up to and including this id are replaced by the summary. */
  boundaryMessageId: string;
  summary: string;
  tokensBefore: number;
  createdAt: number;
}

export interface ThreadSummary {
  id: string;
  title: string | null;
  status: "regular" | "archived";
  modelRef: string | null;
  createdAt: number;
  updatedAt: number;
}

export type McpTransport = "http" | "sse" | "stdio";

export interface McpServerConfig {
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Per tool call timeout. */
  timeoutMs?: number;
  /** When to ask the user before a tool runs. Default `destructive`. */
  approval?: McpApproval;
}

/** `destructive`: tools that declare `destructiveHint` (or are not read-only with no hint either way). */
export type McpApproval = "destructive" | "always" | "never";

export type McpStatus = "disabled" | "idle" | "connecting" | "connected" | "error" | "needs-auth";

export interface McpToolInfo {
  name: string;
  /** Name the model sees: `${server}__${tool}`, sanitized. */
  exposedName: string;
  description?: string;
  enabled: boolean;
  /** Asks for approval under the server's current policy. */
  needsApproval: boolean;
}

export interface McpServerInfo {
  id: string;
  name: string;
  transport: McpTransport;
  enabled: boolean;
  status: McpStatus;
  error?: string;
  tools: McpToolInfo[];
  /** Config with secrets masked. */
  config: McpServerConfig;
}

export interface UsageRow {
  key: string;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  requests: number;
}

export interface GoWindow {
  label: "5 hours" | "Week" | "Month";
  spent: number;
}

export interface Me {
  id: string;
  email: string;
  name: string;
  role: "admin" | "user";
}

export type ArtifactKind = "html" | "react" | "svg" | "markdown" | "code";

export interface ArtifactVersion {
  id: string;
  version: number;
  title: string;
  kind: ArtifactKind;
  /** Language of `code` artifacts. */
  language: string | null;
  content: string;
  createdAt: number;
}

/** What the artifact tools return to the model and the UI. Content stays out to save tokens. */
export interface ArtifactToolResult {
  id: string;
  version: number;
  title: string;
  kind: ArtifactKind;
}

/** `daily`: at a local time on chosen weekdays (0 = Sunday). `interval`: every N minutes from the last run. */
export type ScheduleSpec =
  | { kind: "daily"; time: string; weekdays: number[]; timeZone: string }
  | { kind: "interval"; minutes: number };

export interface Schedule {
  id: string;
  threadId: string | null;
  title: string;
  prompt: string;
  modelRef: string;
  spec: ScheduleSpec;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: "ok" | "error" | "running" | null;
  lastError: string | null;
}
