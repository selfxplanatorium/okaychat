import type { ModelInfo, ShareAudience } from "./types.js";

// n8n webhook agents are chat targets, not language models: okaychat sends the latest message (plus
// optional history or a session id) to a workflow URL and shows the text it answers. See
// docs/implementation/n8n-agents.md.

export type N8nProtocol = "webhook" | "chat-trigger";
export type N8nMemoryMode = "none" | "history" | "remote";
export type N8nResponseMode = "auto" | "ndjson" | "sse" | "json" | "text";
export type N8nResolvedMode = Exclude<N8nResponseMode, "auto">;

export interface N8nAgentConfig {
  webhookUrl: string;
  protocol: N8nProtocol;
  memoryMode: N8nMemoryMode;
  /** Body field of the latest message: `message` (webhook) or `chatInput` (chat trigger) by default. */
  inputKey: string;
  sessionKey: string;
  /** Used only in history mode. */
  historyKey: string;
  responseMode: N8nResponseMode;
  /** RFC 6901 pointer into a whole JSON response. */
  responsePointer: string | null;
  timeoutMs: number;
  idleTimeoutMs: number;
  authHeader: { name: string; value: string } | null;
}

export type N8nAgentPublicConfig = Omit<N8nAgentConfig, "authHeader">;

export const AGENT_AVATARS = ["workflow", "bot", "sparkles", "message-circle"] as const;
export type AgentAvatar = (typeof AGENT_AVATARS)[number];

export interface N8nAgentSummary {
  id: string;
  ref: string;
  name: string;
  description: string;
  avatar: string;
  enabled: boolean;
  shared: boolean;
  canManage: boolean;
  memoryMode: N8nMemoryMode;
  protocol: N8nProtocol;
  revision: number;
}

export interface N8nAgentDetail extends N8nAgentSummary {
  config: N8nAgentPublicConfig;
  authHeader: { name: string; configured: boolean } | null;
  /** Shared admin detail only. */
  audience?: ShareAudience;
}

export interface N8nAgentInput {
  name: string;
  description: string;
  avatar: string;
  enabled: boolean;
  config: N8nAgentPublicConfig;
  /** Omitted keeps the stored header (only while the URL and header name are unchanged); null removes it. */
  authHeader?: { name: string; value: string } | null;
  /** Admin shared API only. */
  audience?: ShareAudience;
}

export interface N8nAgentTarget {
  kind: "agent";
  ref: string;
  providerId: "n8n";
  id: string;
  name: string;
  description: string;
  avatar: string;
  shared: boolean;
  memoryMode: N8nMemoryMode;
  reasoning: false;
  toolCall: false;
  attachments: false;
  inputModalities: ["text"];
  temperature: false;
  free: false;
  /** 0 means unknown/unmanaged; never rendered as a limit. */
  context: 0;
  maxOutput: 0;
  format?: never;
  baseURL?: never;
  cost?: never;
}

export type ChatTargetInfo = ModelInfo | N8nAgentTarget;

export interface N8nAgentStatus {
  agentId: string;
  revision: number;
  state: "unknown" | "ok" | "error";
  checkedAt: number | null;
  latencyMs?: number;
  code?: string;
}

export interface N8nTestResult {
  ok: true;
  mode: N8nResolvedMode;
  preview: string;
  truncated: boolean;
  durationMs: number;
}

/** Usage counters for agent requests; agents report no tokens or cost. */
export interface AgentUsageCounters {
  runs: number;
  ok: number;
  error: number;
  aborted: number;
  durationMs: number;
}

export const N8N_PROVIDER = "n8n";
export const N8N_REF_PREFIX = "n8n/";

export const isAgentRef = (ref: string | null | undefined): boolean => typeof ref === "string" && ref.startsWith(N8N_REF_PREFIX);

export function isAgentTarget(target: ChatTargetInfo): target is N8nAgentTarget {
  return "kind" in target && target.kind === "agent";
}

/** LLM-only lists (utility, sub-agent, research, embedding selectors). */
export const llmTargets = (targets: ChatTargetInfo[]): ModelInfo[] => targets.filter((t): t is ModelInfo => !isAgentTarget(t));

export const N8N_DEFAULTS = {
  timeoutMs: 120_000,
  idleTimeoutMs: 60_000,
  responseMode: "auto" as N8nResponseMode,
  responsePointer: null,
  sessionKey: "sessionId",
  historyKey: "history",
};

/** Keys and memory a protocol preset starts with. Editing an existing agent never applies these silently. */
export function protocolPreset(protocol: N8nProtocol): Pick<N8nAgentConfig, "inputKey" | "sessionKey" | "historyKey" | "memoryMode"> {
  return protocol === "webhook"
    ? { inputKey: "message", sessionKey: "sessionId", historyKey: "history", memoryMode: "history" }
    : { inputKey: "chatInput", sessionKey: "sessionId", historyKey: "history", memoryMode: "remote" };
}

export const N8N_LIMITS = {
  ownedPerAccount: 30,
  sharedPerServer: 100,
  nameChars: 80,
  descriptionChars: 1000,
  urlBytes: 4096,
  configCipherBytes: 16 * 1024,
  authValueBytes: 4096,
  timeoutMin: 5_000,
  timeoutMax: 600_000,
  idleMin: 5_000,
  idleMax: 120_000,
  testMessageChars: 1000,
} as const;

/** Why an agent answer could not be used. Authored keys only: never remote text. */
export const AGENT_REASONS = ["inactive", "redirect", "empty", "malformed", "truncated", "limit", "interactive", "html", "acknowledged"] as const;
export type AgentReason = (typeof AGENT_REASONS)[number];
export const isAgentReason = (value: unknown): value is AgentReason => typeof value === "string" && (AGENT_REASONS as readonly string[]).includes(value);
