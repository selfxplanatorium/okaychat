import type { UserAppearance } from "./appearance.js";
import type { ImageServiceSettings } from "./image-services.js";
import type { SpeechSettings } from "./speech.js";
import type { Spec } from "generative-frame/spec";

// Types shared by server and web. Keep free of runtime imports.

export type WireFormat = "openai-responses" | "openai-chat" | "anthropic" | "google" | "ollama";

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
  /** Admin listing only: who may use the server-wide connection. */
  audience?: ShareAudience;
}

/** Who may use something an admin shares: every user, or only the listed users and members of the listed groups. */
export interface ShareAudience {
  mode: "all" | "selected";
  userIds: string[];
  groupIds: string[];
}

export interface UserGroup {
  id: string;
  name: string;
  userIds: string[];
}

export interface ProviderConnectionInput {
  apiKey?: string;
  baseURL?: string;
  name?: string;
  enabled?: boolean;
}

/** A model installed on an Ollama daemon, from `/api/tags`, `/api/show`, and `/api/ps`. */
export interface OllamaInstalledModel {
  /** The native name, tag included (e.g. `qwen3:8b`). */
  name: string;
  size: number;
  digest?: string;
  modifiedAt?: string;
  family?: string;
  families?: string[];
  parameterSize?: string;
  quantization?: string;
  context: number;
  embeddingLength?: number;
  /** Native `/api/show` capabilities; unknown values are kept as sent. */
  capabilities: string[];
  loaded: boolean;
  sizeVram?: number;
  expiresAt?: string;
  /** Set when `/api/show` failed for this model; the row still lists its tag metadata. */
  showError?: string;
}

/** What a health check reports for one Ollama connection. */
export interface OllamaStatus {
  url: string;
  version?: string;
  modelCount: number;
  loadedCount: number;
}

export interface OllamaInventory {
  status: OllamaStatus;
  models: OllamaInstalledModel[];
}

/** One NDJSON line of `POST /api/pull`. */
export interface OllamaPullProgress {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
}

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const SIDEBAR_ITEMS = ["newChat", "scheduled", "library", "plugins", "projects"] as const;
export type SidebarItem = (typeof SIDEBAR_ITEMS)[number];

/** Per-account keyboard preferences. Absent fields fall back to the defaults in `src/web/keyboard/commands.ts`. */
export interface KeyboardSettings {
  /** Command id → key combos. A present key replaces that command's defaults; an empty list unbinds it. */
  bindings?: Record<string, string[]>;
  /** Which key sends a message. The other one (or Shift+Enter) inserts a new line. */
  sendWith?: "enter" | "modEnter";
  /** Shortcuts without Ctrl/⌘/Alt (message navigation, "?"). Off for people who trigger them by accident. */
  singleKeys?: boolean;
}

export interface UserSettings {
  keyboard?: KeyboardSettings;
  /** Visible sidebar shortcuts; omitted for older accounts to show all. */
  sidebarItems?: SidebarItem[];
  /** Synced appearance; absent until the first device migrates its local preferences. */
  appearance?: UserAppearance;
  /** The user dismissed the first-run provider screen and explores without a connection. */
  onboardingSkipped?: boolean;
  defaultModel?: string | null;
  /** Used for titles and compaction summaries. Falls back to the chat model. */
  utilityModel?: string | null;
  favoriteModels: string[];
  reasoningEffort: Record<string, ReasoningEffort>;
  systemPrompt: string;
  /** Fraction of the context window that triggers automatic compaction. 0 disables. */
  autoCompactAt: number;
  /** Auto-compaction first drops reasoning, tool results, and file contents from earlier messages, and summarizes only if that is not enough. */
  trimBeforeCompact?: boolean;
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
  /** Image generation services switched off and image models chosen per service. */
  imageServices?: ImageServiceSettings;
  /** Speech to text and read aloud. */
  speech?: SpeechSettings;
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
  /** Messages up to and including this id are replaced by the summary. Absent when the chat is only trimmed. */
  boundaryMessageId?: string;
  summary?: string;
  tokensBefore?: number;
  createdAt?: number;
  /** Messages after the summary, up to and including `throughMessageId`, are sent as text only. */
  trim?: TrimState;
}

export interface TrimState {
  throughMessageId: string;
  /** Newest message when trimming. Replies before it report the untrimmed size. */
  lastMessageId: string;
  /** Estimated context before and after trimming. */
  tokensBefore: number;
  tokensAfter: number;
  createdAt: number;
}

export interface ThreadSummary {
  id: string;
  title: string | null;
  status: "regular" | "archived";
  modelRef: string | null;
  projectId: string | null;
  memoryDisabled: boolean;
  pinned: boolean;
  /** The chat this one was forked from, while that chat still exists. */
  branchedFrom: { id: string; title: string | null } | null;
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
  /** The owner (an admin) shares it with other users. */
  shared: boolean;
  /** The owner's view of a shared server: who it is shared with. */
  audience?: ShareAudience;
  /** Someone else's shared server: the viewer can switch it and its tools, and authorize, but not edit it. */
  sharedWithMe: boolean;
  status: McpStatus;
  error?: string;
  tools: McpToolInfo[];
  /** Config with secrets masked. Shared servers show viewers only the URL, timeout, and approval policy. */
  config: McpServerConfig;
}

/** One input in an MCP elicitation form. Servers may only ask for flat primitive values. */
export type McpElicitationField = { name: string; title?: string; description?: string; required: boolean } & (
  | { type: "string"; format?: string; minLength?: number; maxLength?: number; default?: string }
  | { type: "number" | "integer"; minimum?: number; maximum?: number; default?: number }
  | { type: "boolean"; default?: boolean }
  | { type: "select"; options: Array<{ value: string; label: string }>; default?: string }
  | { type: "multiselect"; options: Array<{ value: string; label: string }>; default?: string[] }
);

/** An MCP server asking the user for input while one of its tools runs. Shown in that tool's card. */
export interface McpElicitation {
  id: string;
  server: string;
  message: string;
  fields: McpElicitationField[];
  /** Set once the user answered, so the card shows the outcome instead of the form. */
  answered?: "accept" | "decline" | "cancel";
}

/** A prompt template an MCP server offers; the composer fills it in as the user's message. */
export interface McpPromptInfo {
  serverId: string;
  server: string;
  name: string;
  title?: string;
  description?: string;
  arguments: Array<{ name: string; description?: string; required?: boolean }>;
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
  | { kind: "interval"; minutes: number; timeZone?: string };

export interface Schedule {
  id: string;
  /** "same" keeps one chat for every run; "new" starts a chat per run and `threadId` is the latest one. */
  threadMode: "same" | "new";
  threadId: string | null;
  /** `threadId` is a chat the user picked rather than one the schedule created. */
  threadAttached: boolean;
  /** Project for chats the schedule creates. */
  projectId: string | null;
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
  | { type: "widget"; title: string; code: string }
  | { type: "spec"; title: string; spec: Spec }
  | { type: "tool"; name: string };

export interface SharedThread {
  title: string | null;
  createdAt: number;
  messages: Array<{ id: string; role: "user" | "assistant"; parts: SharedPart[] }>;
}

/** Library entries grouped by what the browser can do with them. */
export type LibraryKind = "image" | "document" | "pdf" | "spreadsheet" | "code" | "other";
/** How the item entered the library: attached by the user or produced by the agent. */
export type LibrarySource = "uploaded" | "generated";
export type LibrarySort = "newest" | "oldest" | "name" | "size";

export interface LibraryItem {
  /** Stable across sources: the row id, or `artifact:<threadId>/<artifactId>` for artifacts. */
  id: string;
  name: string;
  kind: LibraryKind;
  mime: string;
  /** Bytes; 0 when unknown (generated images get their real size from disk). */
  size: number;
  createdAt: number;
  source: LibrarySource;
  threadId: string | null;
  threadTitle: string | null;
  projectId: string | null;
  /** Inline preview URL (images, PDFs, spreadsheets); null for text-only artifacts. */
  previewUrl: string | null;
  /** Bytes URL, when the item is a file. */
  downloadUrl: string | null;
  /** Set for artifacts so the web page can fetch their versions for the preview. */
  artifactId?: string;
  artifactKind?: ArtifactKind;
  /** True when DELETE /api/library/:id supports this item. */
  deletable: boolean;
}

export interface LibraryPage {
  items: LibraryItem[];
  /** Cursor for the next page; null at the end. */
  nextCursor: string | null;
}

export type PromptKey =
  | "chat"
  | "modelIdentity"
  | "date"
  | "artifacts"
  | "temporary"
  | "subagent"
  | "subagentSearchBudget"
  | "researchPlan"
  | "researchWorker"
  | "researchReview"
  | "researchReport"
  | "compaction"
  | "title"
  | "imageRelay"
  | "speechRealtime"
  | "memory"
  | "memoryExtract"
  | "memorySummary";

/** A server-wide system prompt as the admin page shows it. */
export interface AdminPrompt {
  key: PromptKey;
  label: string;
  description: string;
  /** Names usable as `{name}` in the text. */
  placeholders: string[];
  defaultValue: string;
  /** The admin's override, or null when the default is in use. */
  value: string | null;
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
