import type { UserAppearance } from "./appearance.js";

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
  /** Connected with a server-wide key from an admin. */
  shared: boolean;
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

export const SIDEBAR_ITEMS = ["newChat", "scheduled", "library", "plugins", "projects"] as const;
export type SidebarItem = (typeof SIDEBAR_ITEMS)[number];

export interface UserSettings {
  /** Visible sidebar shortcuts; omitted for older accounts to show all. */
  sidebarItems?: SidebarItem[];
  /** Synced appearance; absent until the first device migrates its local preferences. */
  appearance?: UserAppearance;
  defaultModel?: string | null;
  /** Used for titles and compaction summaries. Falls back to the chat model. */
  utilityModel?: string | null;
  favoriteModels: string[];
  reasoningEffort: Record<string, ReasoningEffort>;
  systemPrompt: string;
  /** Fraction of the context window that triggers automatic compaction. 0 disables. */
  autoCompactAt: number;
  /** Max agent steps (tool round trips) per turn. */
  maxSteps: number;
  /** Max built-in web searches per reply, shared with sub-agents. 0 disables searching. */
  maxSearches: number;
  /** Built-in web_search and web_fetch tools. */
  webTools: boolean;
  /** Built-in artifact tools: documents and apps shown in a side panel. */
  artifacts: boolean;
  /** Generative UI: declarative components and sandboxed HTML/SVG widgets, rendered in the browser. */
  generativeUI: boolean;
  /** Lets the chat model delegate tasks to sub-agents. */
  subagents: boolean;
  /** run_code in the server's code sandbox. Offered only when the server has one configured. */
  codeExecution: boolean;
  /** A model ref, "chat" to follow the chat model, or null/absent to follow the utility model. */
  subagentModel?: string | null;
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  favoriteModels: [],
  reasoningEffort: {},
  systemPrompt: "",
  autoCompactAt: 0.8,
  maxSteps: 20,
  maxSearches: 5,
  webTools: true,
  artifacts: true,
  generativeUI: true,
  subagents: true,
  codeExecution: true,
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
  projectId: string | null;
  memoryDisabled: boolean;
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
  avatarUrl?: string;
}

export type TextArtifactKind = "html" | "react" | "svg" | "markdown" | "code";
/** Files the server builds from a text source and serves as bytes. */
export type DocumentArtifactKind = "pdf" | "docx" | "xlsx";
export type ArtifactKind = TextArtifactKind | DocumentArtifactKind;

export const DOCUMENT_KINDS: readonly DocumentArtifactKind[] = ["pdf", "docx", "xlsx"];

export interface ArtifactVersion {
  id: string;
  version: number;
  title: string;
  kind: ArtifactKind;
  /** Language of `code` artifacts. */
  language: string | null;
  /**
   * Text artifacts: the content. Documents: the source they are built from (HTML for pdf/docx,
   * workbook JSON for xlsx). Empty for an imported file, which is edited in place instead.
   */
  content: string;
  /** Bytes of the built document; 0 for text artifacts. */
  size: number;
  createdAt: number;
}

/** A cell as the web grid renders it. Mirrors the shape `previewXlsx` builds. */
export interface SheetPreviewCell {
  /** Display text */
  t: string;
  b?: boolean;
  i?: boolean;
  u?: boolean;
  color?: string;
  bg?: string;
  size?: number;
  align?: "left" | "center" | "right";
  wrap?: boolean;
  border?: boolean;
}

export interface SheetPreview {
  name: string;
  /** Column widths in characters. */
  columns: number[];
  rows: Array<{ height?: number; cells: Array<SheetPreviewCell | null> }>;
  merges: Array<{ top: number; left: number; bottom: number; right: number }>;
  frozen?: { rows: number; cols: number };
  truncated: boolean;
}

/** What the artifact tools return to the model and the UI. Content stays out to save tokens. */
export interface ArtifactToolResult {
  id: string;
  version: number;
  title: string;
  kind: ArtifactKind;
  /** Bytes of the built document; 0 for text artifacts. */
  size: number;
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

export interface ProjectFile {
  id: string;
  name: string;
  chars: number;
  createdAt: number;
}

/** A font file the user uploaded. The browser loads it from `/api/fonts/:id/file`. */
export interface InstalledFont {
  id: string;
  family: string;
  filename: string;
  bytes: number;
}

export interface Project {
  id: string;
  name: string;
  instructions: string;
  defaultModel: string | null;
  files: ProjectFile[];
  createdAt: number;
}

/** A message as a public share shows it: text and results, no reasoning, usage, or tool inputs. */
export type SharedPart =
  | { type: "text"; text: string }
  | { type: "image"; url: string }
  | { type: "artifact"; id: string; title: string; kind: ArtifactKind; version: number }
  | { type: "tool"; name: string };

export interface SharedThread {
  title: string | null;
  createdAt: number;
  messages: Array<{ id: string; role: "user" | "assistant"; parts: SharedPart[] }>;
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: "admin" | "user";
  createdAt: number;
  threads: number;
  /** Spend in the last 30 days, from recorded usage. */
  cost30d: number;
  /** Bytes the user currently stores, over every counted kind. */
  storageUsed: number;
  /** Per-user byte limit. null means the server default (see /api/storage). */
  storageLimit: number | null;
}

/** The signed-in user's storage usage against their limit. */
export interface StorageInfo {
  used: number;
  limit: number;
  /** The server-wide default limit, for UIs that show what null means. */
  defaultLimit: number;
}
