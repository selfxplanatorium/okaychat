import { parseErrorWire, type ErrorCode, type ErrorWire } from "@shared/errors";
import { redactSecrets } from "@shared/redact";
import type { PlainMessageKey } from "@/i18n";
import type { SettingsDestinationId } from "@/lib/settings-link";

/**
 * One pure decision for how an error is shown. Components render the result; they never choose a
 * surface, an action, or a message themselves. Keep every message/hint in `i18n/en/errors.ts`.
 */
export type ErrorContext = "chat" | "tool" | "settings" | "upload" | "background" | "render";

export interface ErrorActions {
  retry: boolean;
  switchModel: boolean;
  settings?: SettingsDestinationId;
  copyDetails: boolean;
  reload: boolean;
}

export interface ErrorPresentation {
  surface: "inline" | "page";
  messageKey: PlainMessageKey;
  hintKey: PlainMessageKey;
  /** A safe, specific server message for inline field/row errors. Never shown as raw detail in chat. */
  detail?: string;
  actions: ErrorActions;
  retryable: boolean;
  code: ErrorCode;
}

const MESSAGES: Record<ErrorCode, PlainMessageKey> = {
  video_invalid_reference: "errors.videoInvalidReferenceMessage",
  video_reference_aspect_mismatch: "errors.videoReferenceAspectMismatchMessage",
  video_unsupported_parameters: "errors.videoUnsupportedParametersMessage",
  video_unsupported_endpoint: "errors.videoUnsupportedEndpointMessage",
  video_service_unavailable: "errors.videoServiceUnavailableMessage",
  video_video_busy: "errors.videoVideoBusyMessage",
  video_video_rate_limit: "errors.videoVideoRateLimitMessage",
  video_credentials_changed: "errors.videoCredentialsChangedMessage",
  video_provider_auth: "errors.videoProviderAuthMessage",
  video_provider_rate_limit: "errors.videoProviderRateLimitMessage",
  video_provider_unavailable: "errors.videoProviderUnavailableMessage",
  video_provider_rejected: "errors.videoProviderRejectedMessage",
  video_provider_protocol: "errors.videoProviderProtocolMessage",
  video_provider_moderation: "errors.videoProviderModerationMessage",
  video_provider_failed: "errors.videoProviderFailedMessage",
  video_provider_output_expired: "errors.videoProviderOutputExpiredMessage",
  video_output_host_rejected: "errors.videoOutputHostRejectedMessage",
  video_output_too_large: "errors.videoOutputTooLargeMessage",
  video_output_invalid: "errors.videoOutputInvalidMessage",
  video_download_failed: "errors.videoDownloadFailedMessage",
  video_storage_failed: "errors.videoStorageFailedMessage",
  video_job_timeout: "errors.videoJobTimeoutMessage",
  video_submission_unknown: "errors.videoSubmissionUnknownMessage",
  video_cancelled: "errors.videoCancelledMessage",
  provider_auth: "errors.providerAuthMessage",
  provider_rate_limit: "errors.providerRateLimitMessage",
  provider_quota: "errors.providerQuotaMessage",
  model_not_found: "errors.modelNotFoundMessage",
  context_length: "errors.contextLengthMessage",
  provider_overloaded: "errors.providerOverloadedMessage",
  network: "errors.networkMessage",
  timeout: "errors.timeoutMessage",
  aborted: "errors.abortedMessage",
  tool_failed: "errors.toolFailedMessage",
  service_unavailable: "errors.serviceUnavailableMessage",
  storage_quota: "errors.storageQuotaMessage",
  validation: "errors.validationMessage",
  not_found: "errors.notFoundMessage",
  forbidden: "errors.forbiddenMessage",
  conflict: "errors.conflictMessage",
  rate_limited: "errors.rateLimitedMessage",
  unknown: "errors.unknownMessage",
  agent_auth: "errors.agentAuth",
  agent_response: "errors.agentResponse",
  agent_failed: "errors.agentFailed",
};

const HINTS: Record<ErrorCode, PlainMessageKey> = {
  video_invalid_reference: "errors.videoHint",
  video_reference_aspect_mismatch: "errors.videoHint",
  video_unsupported_parameters: "errors.videoHint",
  video_unsupported_endpoint: "errors.videoHint",
  video_service_unavailable: "errors.videoHint",
  video_video_busy: "errors.videoHint",
  video_video_rate_limit: "errors.videoHint",
  video_credentials_changed: "errors.videoHint",
  video_provider_auth: "errors.videoHint",
  video_provider_rate_limit: "errors.videoHint",
  video_provider_unavailable: "errors.videoHint",
  video_provider_rejected: "errors.videoHint",
  video_provider_protocol: "errors.videoHint",
  video_provider_moderation: "errors.videoHint",
  video_provider_failed: "errors.videoHint",
  video_provider_output_expired: "errors.videoHint",
  video_output_host_rejected: "errors.videoHint",
  video_output_too_large: "errors.videoHint",
  video_output_invalid: "errors.videoHint",
  video_download_failed: "errors.videoHint",
  video_storage_failed: "errors.videoHint",
  video_job_timeout: "errors.videoHint",
  video_submission_unknown: "errors.videoHint",
  video_cancelled: "errors.videoHint",
  provider_auth: "errors.providerAuthHint",
  provider_rate_limit: "errors.providerRateLimitHint",
  provider_quota: "errors.providerQuotaHint",
  model_not_found: "errors.modelNotFoundHint",
  context_length: "errors.contextLengthHint",
  provider_overloaded: "errors.providerOverloadedHint",
  network: "errors.networkHint",
  timeout: "errors.timeoutHint",
  aborted: "errors.abortedHint",
  tool_failed: "errors.toolFailedHint",
  service_unavailable: "errors.serviceUnavailableHint",
  storage_quota: "errors.storageQuotaHint",
  validation: "errors.validationHint",
  not_found: "errors.notFoundHint",
  forbidden: "errors.forbiddenHint",
  conflict: "errors.conflictHint",
  rate_limited: "errors.rateLimitedHint",
  unknown: "errors.unknownHint",
  agent_auth: "errors.agentAuthHint",
  agent_response: "errors.agentResponseHint",
  agent_failed: "errors.agentFailedHint",
};

/** The one setting a user can change to fix this class of failure. */
export function settingsForError(code: ErrorCode): SettingsDestinationId | undefined {
  switch (code) {
    case "provider_auth":
    case "provider_quota":
    case "model_not_found":
      return "providers";
    case "agent_auth":
    case "agent_response":
    case "agent_failed":
      return "agents";
    case "context_length":
      return "compaction";
    case "storage_quota":
      return "account";
    default:
      return undefined;
  }
}

const SWITCH_MODEL: ReadonlySet<ErrorCode> = new Set([
  "provider_auth",
  "provider_rate_limit",
  "provider_quota",
  "model_not_found",
  "context_length",
  "provider_overloaded",
  "network",
  "timeout",
  "unknown",
]);

const FIELD_DETAIL: ReadonlySet<ErrorCode> = new Set(["validation", "not_found", "forbidden", "conflict", "storage_quota", "unknown"]);

const safeDetail = (message: string | undefined) =>
  message && message.trim() && message.length <= 300 ? message.trim() : undefined;

export function presentError(error: ErrorWire, context: ErrorContext): ErrorPresentation {
  const settings = settingsForError(error.code);
  const base = {
    messageKey: MESSAGES[error.code],
    hintKey: HINTS[error.code],
    retryable: error.retryable,
    code: error.code,
  } as const;
  if (context === "render") {
    return {
      surface: "page",
      messageKey: "errors.renderTitle",
      hintKey: "errors.renderBody",
      actions: { retry: false, switchModel: false, copyDetails: true, reload: true },
      retryable: false,
      code: "unknown",
    };
  }
  if (context === "chat") {
    return {
      surface: "inline",
      ...base,
      actions: {
        // Automatic retries are limited to transient codes; a manual Retry is always a valid next step.
        retry: error.code !== "aborted",
        switchModel: SWITCH_MODEL.has(error.code),
        ...(settings ? { settings } : {}),
        copyDetails: true,
        reload: false,
      },
    };
  }
  if (context === "tool") {
    return {
      surface: "inline",
      ...base,
      actions: { retry: false, switchModel: false, copyDetails: false, reload: false },
    };
  }
  // Settings, uploads, and background rows stay where the failure happened; no toast and no alert.
  const detail = FIELD_DETAIL.has(error.code) ? safeDetail(error.message) : undefined;
  return {
    surface: "inline",
    ...base,
    ...(detail ? { detail } : {}),
    actions: { retry: false, switchModel: false, copyDetails: false, reload: false },
  };
}

/**
 * The one tool-card decision. A tool error is wire JSON from the server; a historical or local
 * error may still be a raw string or object, which must never reach the card. Anything that is not
 * a known wire code falls back to the generic tool failure message and hint.
 */
export function toolErrorPresentation(error: unknown): ErrorPresentation | undefined {
  if (error === undefined || error === null || error === "") return undefined;
  const wire = parseErrorWire(error);
  return presentError(wire && wire.code !== "unknown" ? wire : { code: "tool_failed", message: "", retryable: false }, "tool");
}

/**
 * The "Copy details" payload. It is an allowlist, not a serialization: a poisoned wire object with
 * apiKey, prompt, file, or stack fields contributes none of them.
 */
const detailValue = (value: string) => redactSecrets(value).slice(0, 200);

export function errorDetails(error: ErrorWire): string {
  const lines = [`code: ${error.code}`];
  if (error.ref) lines.push(`ref: ${detailValue(error.ref)}`);
  if (error.model) lines.push(`model: ${detailValue(error.model)}`);
  if (error.provider) lines.push(`provider: ${detailValue(error.provider)}`);
  if (error.requestId) lines.push(`requestId: ${detailValue(error.requestId)}`);
  return lines.join("\n");
}
