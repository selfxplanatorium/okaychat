import { CHATGPT_FEATURE_CODES, type ChatGPTFeatureCode } from "./chatgpt.js";
import { isAgentReason, type AgentReason } from "./n8n-agents.js";

/**
 * The one error vocabulary shared by the server and the browser. The server maps every boundary
 * (HTTP, streamed chat, tools, schedules) into this shape and sends only these fields: raw provider
 * text, request bodies, prompts, and stacks stay in the server log behind `ref`.
 */
export const ERROR_CODES = [
  "token_credit_exhausted", "token_credit_usage_unknown", "token_credit_busy", "token_credit_unmetered",
  "video_invalid_reference",
  "video_reference_aspect_mismatch",
  "video_unsupported_parameters",
  "video_unsupported_endpoint",
  "video_service_unavailable",
  "video_video_busy",
  "video_video_rate_limit",
  "video_credentials_changed",
  "video_provider_auth",
  "video_provider_rate_limit",
  "video_provider_unavailable",
  "video_provider_rejected",
  "video_provider_protocol",
  "video_provider_moderation",
  "video_provider_failed",
  "video_provider_output_expired",
  "video_output_host_rejected",
  "video_output_too_large",
  "video_output_invalid",
  "video_download_failed",
  "video_storage_failed",
  "video_job_timeout",
  "video_submission_unknown",
  "video_cancelled",
  "provider_auth",
  "provider_rate_limit",
  "provider_quota",
  "model_not_found",
  "context_length",
  "provider_overloaded",
  "network",
  "timeout",
  "aborted",
  "tool_failed",
  "service_unavailable",
  "storage_quota",
  "validation",
  "not_found",
  "forbidden",
  "conflict",
  "rate_limited",
  "agent_auth",
  "agent_response",
  "agent_failed",
  "unknown",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Authored feature codes that add detail to a stable `ErrorCode`. They belong to the ChatGPT plan
 * surface, so the union lives with its DTOs and both sides read one list.
 */
export const FEATURE_CODES = CHATGPT_FEATURE_CODES;
export type FeatureCode = ChatGPTFeatureCode;

/**
 * Authored recovery actions the browser may offer. This is a closed list on purpose: an upstream
 * URL, message, or free text must never become a clickable action.
 */
export const RECOVERY_ACTIONS = [
  "retry",
  "reconnect_chatgpt",
  "enable_chatgpt_plan",
  "manage_chatgpt_usage",
  "choose_provider",
  "contact_admin",
] as const;

export type RecoveryAction = (typeof RECOVERY_ACTIONS)[number];

/** Safe metadata for "Copy details". It never carries a provider message, key, prompt, or stack. */
export interface ErrorWire {
  code: ErrorCode;
  message: string;
  hint?: string;
  retryable: boolean;
  retryAfterMs?: number;
  ref?: string;
  model?: string;
  provider?: string;
  requestId?: string;
  /** An authored sub-code; generic consumers may ignore it. */
  featureCode?: FeatureCode;
  /** The upstream machine code (`subscription_sharing_invalid_user`), bounded and never a message. */
  providerCode?: string;
  /** The upstream parameter name the provider named, bounded (`tools[0].name`). */
  providerParam?: string;
  /** An authored next step, never selected from an upstream-provided URL. */
  recoveryAction?: RecoveryAction;
  /** Authored reason for an unusable n8n agent answer (agent_response only); never remote text. */
  agentReason?: AgentReason;
}

/** Data written into the chat stream while a provider call waits before another attempt. */
export interface RetryNotice {
  attempt: number;
  delayMs: number;
  code: ErrorCode;
  /** `done` clears the notice after a successful attempt or after the last attempt returned. */
  status?: "done";
}

const CODES = new Set<string>(ERROR_CODES);
const FEATURES = new Set<string>(FEATURE_CODES);
const ACTIONS = new Set<string>(RECOVERY_ACTIONS);
const MAX_ERROR_TEXT = 8 * 1024;
const MAX_PROVIDER_FIELD = 200;
/** Machine codes and parameter names only: no spaces, quotes, slashes, or query syntax. */
const PROVIDER_FIELD = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,199}$/;

export const isErrorCode = (value: unknown): value is ErrorCode => typeof value === "string" && CODES.has(value);

export const isFeatureCode = (value: unknown): value is FeatureCode => typeof value === "string" && FEATURES.has(value);

export const isRecoveryAction = (value: unknown): value is RecoveryAction =>
  typeof value === "string" && ACTIONS.has(value);

/**
 * A bounded upstream machine code or parameter name. Messages, tokens, and URLs are refused, so a
 * forged or unusual provider body cannot smuggle a secret into "Copy details".
 */
export function safeProviderField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_PROVIDER_FIELD || !PROVIDER_FIELD.test(trimmed)) return undefined;
  if (/^(?:https?|ftp|data|javascript):/i.test(trimmed) || trimmed.includes("//")) return undefined;
  return trimmed;
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.slice(0, 2_000) : undefined;

/** Keeps only known fields, so a forged payload cannot smuggle a key, prompt, or stack into the UI. */
export function parseErrorWire(value: unknown): ErrorWire | undefined {
  let input = value;
  if (typeof input === "string") {
    if (!input.trim() || input.length > MAX_ERROR_TEXT) return undefined;
    try {
      input = JSON.parse(input);
    } catch {
      return undefined;
    }
  }
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  if (!isErrorCode(record.code)) return undefined;
  const message = text(record.message);
  if (!message) return undefined;
  const retryAfterMs = typeof record.retryAfterMs === "number" && Number.isFinite(record.retryAfterMs) && record.retryAfterMs >= 0
    ? Math.round(record.retryAfterMs)
    : undefined;
  const featureCode = isFeatureCode(record.featureCode) ? record.featureCode : undefined;
  const recoveryAction = isRecoveryAction(record.recoveryAction) ? record.recoveryAction : undefined;
  const providerCode = safeProviderField(record.providerCode);
  const providerParam = safeProviderField(record.providerParam);
  return {
    code: record.code,
    message,
    ...(text(record.hint) ? { hint: text(record.hint) } : {}),
    retryable: record.retryable === true,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(text(record.ref) ? { ref: text(record.ref) } : {}),
    ...(text(record.model) ? { model: text(record.model) } : {}),
    ...(text(record.provider) ? { provider: text(record.provider) } : {}),
    ...(text(record.requestId) ? { requestId: text(record.requestId) } : {}),
    ...(featureCode ? { featureCode } : {}),
    ...(providerCode ? { providerCode } : {}),
    ...(providerParam ? { providerParam } : {}),
    ...(recoveryAction ? { recoveryAction } : {}),
    ...(record.code === "agent_response" && isAgentReason(record.agentReason) ? { agentReason: record.agentReason } : {}),
  };
}

/** The wire shape of an error no boundary identified. The caller supplies a translated UI message. */
export function unknownWire(message = "Something went wrong."): ErrorWire {
  return { code: "unknown", message, retryable: false };
}
