import type { ReasoningEffort, TokenUsage } from "./types.js";

// External API access (docs/implementation/api-access.md). Shared wire contracts only: this module is
// imported by the web settings page and by the server, so it stays free of runtime dependencies except
// constant tuples. Management DTOs use camelCase; the OpenAI-compatible protocol uses snake_case.

export const API_SCOPES = ["models:read", "chat:write"] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export const API_SCOPE_BITS: Readonly<Record<ApiScope, number>> = {
  "models:read": 1,
  "chat:write": 2,
};

export function scopesFromBits(bits: number): ApiScope[] {
  // Unknown bits mean a corrupted row: the caller must fail closed rather than grant something.
  if (!Number.isInteger(bits) || bits < 1 || bits > 3) return [];
  return API_SCOPES.filter((scope) => (bits & API_SCOPE_BITS[scope]) !== 0);
}

export function bitsFromScopes(scopes: readonly ApiScope[]): number {
  return scopes.reduce((bits, scope) => bits | API_SCOPE_BITS[scope], 0);
}

/** Hard limits. They are code constants and cannot be raised through request fields. */
export const API_LIMITS = {
  activeKeys: 20,
  retainedKeys: 200,
  requestsPerKeyMinute: 60,
  requestsPerAccountMinute: 120,
  concurrentPerKey: 2,
  concurrentPerAccount: 4,
  concurrentProcess: 32,
  catalogConcurrentProcess: 8,
  bodyBytes: 1_048_576,
  totalContentBytes: 786_432,
  messageBytes: 262_144,
  maxMessages: 256,
  maxOutputTokens: 32_768,
  defaultOutputTokens: 4_096,
  contextSafetyTokens: 1_024,
  durationMs: 300_000,
  catalogDurationMs: 30_000,
  firstEventMs: 60_000,
  inactivityMs: 60_000,
  providerBytes: 16 * 1024 * 1024,
  providerRecordBytes: 256 * 1024,
  generatedBytes: 1024 * 1024,
  bufferedBytes: 2 * 1024 * 1024,
  sseBytes: 8 * 1024 * 1024,
  ssePieceBytes: 8 * 1024,
  outputQueueBytes: 64 * 1024,
  drainTimeoutMs: 30_000,
  requestRetentionDays: 30,
  requestRetentionRows: 10_000,
  auditRetentionDays: 90,
  auditRetentionRows: 1_000,
  telemetryDays: 30,
  keyBytes: 1_024,
  labelCodePoints: 80,
  labelBytes: 320,
  keyMaxDays: 366,
  createRetries: 3,
} as const;

export interface ApiAccessLimits {
  activeKeys: number;
  retainedKeys: number;
  requestsPerKeyMinute: number;
  requestsPerAccountMinute: number;
  concurrentPerKey: number;
  concurrentPerAccount: number;
  bodyBytes: number;
  maxOutputTokens: number;
  defaultOutputTokens: number;
  durationMs: number;
}

export const API_ACCESS_LIMITS: ApiAccessLimits = {
  activeKeys: API_LIMITS.activeKeys,
  retainedKeys: API_LIMITS.retainedKeys,
  requestsPerKeyMinute: API_LIMITS.requestsPerKeyMinute,
  requestsPerAccountMinute: API_LIMITS.requestsPerAccountMinute,
  concurrentPerKey: API_LIMITS.concurrentPerKey,
  concurrentPerAccount: API_LIMITS.concurrentPerAccount,
  bodyBytes: API_LIMITS.bodyBytes,
  maxOutputTokens: API_LIMITS.maxOutputTokens,
  defaultOutputTokens: API_LIMITS.defaultOutputTokens,
  durationMs: API_LIMITS.durationMs,
};

export type ApiKeyStatus = "active" | "expired" | "revoked";

export interface ApiKeySummary {
  id: string;
  label: string;
  /** `okc_api_v1_<selector>`: public lookup material, not a credential. */
  prefix: string;
  scopes: ApiScope[];
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
  status: ApiKeyStatus;
}

export interface CreateApiKeyInput {
  label: string;
  scopes: ApiScope[];
  expiresAt: number | null;
}

export interface CreateApiKeyResult {
  key: ApiKeySummary;
  secret: string;
}

export interface ApiKeyListResponse {
  keys: ApiKeySummary[];
  limits: ApiAccessLimits;
  enabled: boolean;
  serverTime: number;
}

export type ApiRequestState = "admitted" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";

/** Every protocol and internal terminal code an external request can record. */
export const API_FAILURE_CODES = [
  "invalid_api_key",
  "insufficient_scope",
  "permission_denied",
  "invalid_policy",
  "invalid_request",
  "unsupported_parameter",
  "context_length_exceeded",
  "model_not_found",
  "request_too_large",
  "unsupported_media_type",
  "not_found",
  "method_not_allowed",
  "rate_limit_exceeded",
  "concurrent_limit",
  "upstream_rate_limit",
  "upstream_auth",
  "upstream_quota",
  "upstream_model_not_found",
  "upstream_unavailable",
  "timeout",
  "upstream_network",
  "unsupported_output",
  "incomplete_response",
  "response_limit",
  "catalog_limit",
  "request_timeout",
  "cancelled",
  "client_disconnected",
  "interrupted",
  "server_error",
] as const;
export type ApiFailureCode = (typeof API_FAILURE_CODES)[number];

export interface ApiRequestSummary {
  id: string;
  keyId: string;
  modelRef: string;
  stream: boolean;
  startedAt: number;
  dispatchedAt: number | null;
  finishedAt: number | null;
  state: ApiRequestState;
  httpStatus: number | null;
  errorCode: ApiFailureCode | null;
  finishReason: "stop" | "length" | "content_filter" | null;
  usageState: "reported" | "unknown";
  usage: TokenUsage | null;
  cost: number | null;
}

export interface ApiRequestPage {
  rows: ApiRequestSummary[];
  nextCursor: string | null;
}

export type ApiKeyAuditEvent = "created" | "revoked" | "password_revoked" | "expired";

export interface ApiKeyAuditRow {
  id: number;
  keyId: string;
  event: ApiKeyAuditEvent;
  createdAt: number;
}

export interface ApiKeyAuditPage {
  rows: ApiKeyAuditRow[];
  nextCursor: number | null;
}

export interface ApiUsageGroup {
  key: string | null;
  usage: TokenUsage;
  cost: number;
  meteredRequests: number;
}

export interface ApiUsageResponse {
  since: number;
  until: number;
  groupBy: "day" | "model" | "key";
  rows: ApiUsageGroup[];
  totals: { usage: TokenUsage; cost: number; meteredRequests: number };
  telemetrySince: number;
  telemetryTruncated: boolean;
  requests: {
    admitted: number;
    running: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    interrupted: number;
    unknownUsage: number;
  };
}

export type ApiUsageDays = 1 | 7 | 30 | 90;

// OpenAI-compatible protocol shapes -------------------------------------------------------------------

export interface ApiChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ApiChatRequest {
  model: string;
  messages: ApiChatMessage[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  temperature?: number;
  reasoning_effort?: ReasoningEffort;
  max_tokens?: number;
  max_completion_tokens?: number;
  n?: 1;
}

export interface ApiProtocolError {
  error: {
    message: string;
    type: "invalid_request_error" | "authentication_error" | "permission_error" | "rate_limit_error" | "server_error";
    param: string | null;
    code: string;
  };
  request_id: string;
}

export interface ModelListEntry {
  id: string;
  object: "model";
  created: 0;
  owned_by: string;
}

export interface ModelList {
  object: "list";
  data: ModelListEntry[];
}

export interface CompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details: { cached_tokens: number };
  completion_tokens_details: { reasoning_tokens: number };
}

export interface CompletionChoice {
  index: 0;
  message: { role: "assistant"; content: string };
  finish_reason: "stop" | "length" | "content_filter";
  logprobs: null;
}

export interface CompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: CompletionChoice[];
  usage: CompletionUsage | null;
}

export interface CompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: 0;
    delta: { role?: "assistant"; content?: string };
    finish_reason: "stop" | "length" | "content_filter" | null;
    logprobs: null;
  }>;
  usage?: CompletionUsage | null;
}

/** Server-side: what a bearer credential authorizes. Never includes a role, session, or profile. */
export interface ApiPrincipal {
  userId: string;
  keyId: string;
  scopes: ApiScope[];
}
