import { randomBytes } from "node:crypto";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  isFeatureCode,
  isRecoveryAction,
  safeProviderField,
  type ErrorCode,
  type ErrorWire,
  type FeatureCode,
  type RecoveryAction,
} from "../shared/errors.js";
import { isAgentReason, type AgentReason } from "../shared/n8n-agents.js";
import { redactSecrets } from "../shared/redact.js";

export { redactSecrets } from "../shared/redact.js";

/** Safe English text per code. The web app shows its own translated `errors.*` text for the same code. */
interface CatalogEntry {
  status: number;
  retryable: boolean;
  messageKey: string;
  hintKey: string;
  message: string;
  hint: string;
}

export const ERROR_CATALOG: Record<ErrorCode, CatalogEntry> = {
  token_credit_exhausted: { status: 403, retryable: false, messageKey: "credits.exhausted", hintKey: "credits.exhausted", message: "Your token allowance is exhausted. Contact your administrator to increase or reset it.", hint: "Contact your administrator." },
  token_credit_usage_unknown: { status: 403, retryable: false, messageKey: "credits.unknown", hintKey: "credits.unknown", message: "Some provider usage was not reported. Contact your administrator before starting more work.", hint: "Contact your administrator." },
  token_credit_busy: { status: 409, retryable: true, messageKey: "credits.busy", hintKey: "credits.busy", message: "Another operation is using this account's allowance. Try again when it finishes.", hint: "Retry after the active operation finishes." },
  token_credit_unmetered: { status: 403, retryable: false, messageKey: "credits.unmetered", hintKey: "credits.unmetered", message: "This service cannot be used with a token allowance. Contact your administrator.", hint: "Contact your administrator." },
  video_invalid_reference: {status:400,retryable:false,messageKey:"errors.videoInvalidReferenceMessage",hintKey:"errors.videoHint",message:"The video starting image is invalid.",hint:"Check video settings. A new paid generation may be charged again."},
  video_reference_aspect_mismatch: {status:400,retryable:false,messageKey:"errors.videoReferenceAspectMismatchMessage",hintKey:"errors.videoHint",message:"The starting image does not match the requested video aspect ratio.",hint:"Check video settings. A new paid generation may be charged again."},
  video_unsupported_parameters: {status:400,retryable:false,messageKey:"errors.videoUnsupportedParametersMessage",hintKey:"errors.videoHint",message:"These video parameters are not supported.",hint:"Check video settings. A new paid generation may be charged again."},
  video_unsupported_endpoint: {status:400,retryable:false,messageKey:"errors.videoUnsupportedEndpointMessage",hintKey:"errors.videoHint",message:"Video generation requires the canonical service endpoint.",hint:"Check video settings. A new paid generation may be charged again."},
  video_service_unavailable: {status:503,retryable:false,messageKey:"errors.videoServiceUnavailableMessage",hintKey:"errors.videoHint",message:"The video service is unavailable.",hint:"Check video settings. A new paid generation may be charged again."},
  video_video_busy: {status:503,retryable:true,messageKey:"errors.videoVideoBusyMessage",hintKey:"errors.videoHint",message:"Video generation is busy. Try again after the current job finishes.",hint:"Check video settings. A new paid generation may be charged again."},
  video_video_rate_limit: {status:429,retryable:true,messageKey:"errors.videoVideoRateLimitMessage",hintKey:"errors.videoHint",message:"The daily video generation limit has been reached.",hint:"Check video settings. A new paid generation may be charged again."},
  video_credentials_changed: {status:403,retryable:false,messageKey:"errors.videoCredentialsChangedMessage",hintKey:"errors.videoHint",message:"The private video credentials or settings changed.",hint:"Check video settings. A new paid generation may be charged again."},
  video_provider_auth: {status:401,retryable:false,messageKey:"errors.videoProviderAuthMessage",hintKey:"errors.videoHint",message:"The video provider rejected the private credentials.",hint:"Check video settings. A new paid generation may be charged again."},
  video_provider_rate_limit: {status:429,retryable:true,messageKey:"errors.videoProviderRateLimitMessage",hintKey:"errors.videoHint",message:"The video provider is rate limiting requests.",hint:"Check video settings. A new paid generation may be charged again."},
  video_provider_unavailable: {status:503,retryable:true,messageKey:"errors.videoProviderUnavailableMessage",hintKey:"errors.videoHint",message:"The video provider is unavailable.",hint:"Check video settings. A new paid generation may be charged again."},
  video_provider_rejected: {status:422,retryable:false,messageKey:"errors.videoProviderRejectedMessage",hintKey:"errors.videoHint",message:"The video provider rejected the request.",hint:"Check video settings. A new paid generation may be charged again."},
  video_provider_protocol: {status:502,retryable:false,messageKey:"errors.videoProviderProtocolMessage",hintKey:"errors.videoHint",message:"The video provider returned an unsupported response.",hint:"Check video settings. A new paid generation may be charged again."},
  video_provider_moderation: {status:422,retryable:false,messageKey:"errors.videoProviderModerationMessage",hintKey:"errors.videoHint",message:"The video provider refused this request under its content policy.",hint:"Check video settings. A new paid generation may be charged again."},
  video_provider_failed: {status:502,retryable:false,messageKey:"errors.videoProviderFailedMessage",hintKey:"errors.videoHint",message:"The video provider could not complete this generation.",hint:"Check video settings. A new paid generation may be charged again."},
  video_provider_output_expired: {status:410,retryable:false,messageKey:"errors.videoProviderOutputExpiredMessage",hintKey:"errors.videoHint",message:"The provider video is no longer available for download.",hint:"Check video settings. A new paid generation may be charged again."},
  video_output_host_rejected: {status:502,retryable:false,messageKey:"errors.videoOutputHostRejectedMessage",hintKey:"errors.videoHint",message:"The video output host is not approved.",hint:"Check video settings. A new paid generation may be charged again."},
  video_output_too_large: {status:413,retryable:false,messageKey:"errors.videoOutputTooLargeMessage",hintKey:"errors.videoHint",message:"The generated video exceeds the file size limit.",hint:"Check video settings. A new paid generation may be charged again."},
  video_output_invalid: {status:422,retryable:false,messageKey:"errors.videoOutputInvalidMessage",hintKey:"errors.videoHint",message:"The generated video failed local container validation.",hint:"Check video settings. A new paid generation may be charged again."},
  video_download_failed: {status:502,retryable:true,messageKey:"errors.videoDownloadFailedMessage",hintKey:"errors.videoHint",message:"The generated video could not be downloaded.",hint:"Check video settings. A new paid generation may be charged again."},
  video_storage_failed: {status:507,retryable:true,messageKey:"errors.videoStorageFailedMessage",hintKey:"errors.videoHint",message:"The generated video could not be saved.",hint:"Check video settings. A new paid generation may be charged again."},
  video_job_timeout: {status:504,retryable:true,messageKey:"errors.videoJobTimeoutMessage",hintKey:"errors.videoHint",message:"Video generation exceeded the time limit.",hint:"Check video settings. A new paid generation may be charged again."},
  video_submission_unknown: {status:409,retryable:true,messageKey:"errors.videoSubmissionUnknownMessage",hintKey:"errors.videoHint",message:"The provider may have accepted this video request. Billing is unknown; another generation may charge again.",hint:"Check video settings. A new paid generation may be charged again."},
  video_cancelled: {status:409,retryable:false,messageKey:"errors.videoCancelledMessage",hintKey:"errors.videoHint",message:"Video generation stopped locally. The provider may still charge.",hint:"Check video settings. A new paid generation may be charged again."},
  provider_auth: {
    status: 401,
    retryable: false,
    messageKey: "errors.providerAuthMessage",
    hintKey: "errors.providerAuthHint",
    message: "The provider rejected the credentials.",
    hint: "Check the API key in Settings → Providers, then retry.",
  },
  provider_rate_limit: {
    status: 429,
    retryable: true,
    messageKey: "errors.providerRateLimitMessage",
    hintKey: "errors.providerRateLimitHint",
    message: "The provider is rate limiting requests.",
    hint: "Wait a moment and retry, or switch to another model.",
  },
  provider_quota: {
    status: 402,
    retryable: false,
    messageKey: "errors.providerQuotaMessage",
    hintKey: "errors.providerQuotaHint",
    message: "The provider account is out of quota.",
    hint: "Add credit to the provider account or switch providers.",
  },
  model_not_found: {
    status: 404,
    retryable: false,
    messageKey: "errors.modelNotFoundMessage",
    hintKey: "errors.modelNotFoundHint",
    message: "That model is not available for this connection.",
    hint: "Pick another model, or reconnect the provider in Settings → Providers.",
  },
  context_length: {
    status: 400,
    retryable: false,
    messageKey: "errors.contextLengthMessage",
    hintKey: "errors.contextLengthHint",
    message: "This conversation is too long for the model.",
    hint: "Compact this chat or choose a model with a larger context window.",
  },
  provider_overloaded: {
    status: 503,
    retryable: true,
    messageKey: "errors.providerOverloadedMessage",
    hintKey: "errors.providerOverloadedHint",
    message: "The provider is overloaded.",
    hint: "Retry in a moment, or switch to another model.",
  },
  network: {
    status: 502,
    retryable: true,
    messageKey: "errors.networkMessage",
    hintKey: "errors.networkHint",
    message: "The server could not reach the provider.",
    hint: "Check the server's internet connection, then retry.",
  },
  timeout: {
    status: 504,
    retryable: true,
    messageKey: "errors.timeoutMessage",
    hintKey: "errors.timeoutHint",
    message: "The provider took too long to respond.",
    hint: "Retry, or switch to a faster model.",
  },
  aborted: {
    status: 499,
    retryable: false,
    messageKey: "errors.abortedMessage",
    hintKey: "errors.abortedHint",
    message: "The request was stopped.",
    hint: "Nothing else was sent. Send again when ready.",
  },
  tool_failed: {
    status: 500,
    retryable: false,
    messageKey: "errors.toolFailedMessage",
    hintKey: "errors.toolFailedHint",
    message: "The tool did not finish.",
    hint: "Try again, or adjust the request.",
  },
  service_unavailable: {
    status: 503,
    retryable: true,
    messageKey: "errors.serviceUnavailableMessage",
    hintKey: "errors.serviceUnavailableHint",
    message: "A service this needs is unavailable.",
    hint: "Try again shortly.",
  },
  storage_quota: {
    status: 413,
    retryable: false,
    messageKey: "errors.storageQuotaMessage",
    hintKey: "errors.storageQuotaHint",
    message: "Storage is full.",
    hint: "Delete some files or chats in the Library, or ask an admin to raise your limit.",
  },
  validation: {
    status: 400,
    retryable: false,
    messageKey: "errors.validationMessage",
    hintKey: "errors.validationHint",
    message: "That request was not valid.",
    hint: "Check the field and try again.",
  },
  not_found: {
    status: 404,
    retryable: false,
    messageKey: "errors.notFoundMessage",
    hintKey: "errors.notFoundHint",
    message: "That item was not found.",
    hint: "It may have been deleted. Refresh and try again.",
  },
  forbidden: {
    status: 403,
    retryable: false,
    messageKey: "errors.forbiddenMessage",
    hintKey: "errors.forbiddenHint",
    message: "You do not have permission for that.",
    hint: "Ask an admin if it should be allowed.",
  },
  conflict: {
    status: 409,
    retryable: false,
    messageKey: "errors.conflictMessage",
    hintKey: "errors.conflictHint",
    message: "That change conflicts with the current state.",
    hint: "Refresh and try again.",
  },
  rate_limited: {
    status: 429,
    retryable: true,
    messageKey: "errors.rateLimitedMessage",
    hintKey: "errors.rateLimitedHint",
    message: "Too many requests are running at once.",
    hint: "Wait a moment and try again.",
  },
  agent_auth: {
    status: 502,
    retryable: false,
    messageKey: "errors.agentAuth",
    hintKey: "errors.agentAuthHint",
    message: "The agent's workflow rejected the request.",
    hint: "Check the agent's header in Settings → Agents and that this server may reach the workflow. Your okaychat session is fine.",
  },
  agent_response: {
    status: 502,
    retryable: false,
    messageKey: "errors.agentResponse",
    hintKey: "errors.agentResponseHint",
    message: "The agent's answer could not be read.",
    hint: "Check the workflow's response settings in n8n and the agent's response mode in Settings → Agents.",
  },
  agent_failed: {
    status: 502,
    retryable: false,
    messageKey: "errors.agentFailed",
    hintKey: "errors.agentFailedHint",
    message: "The agent's workflow failed.",
    hint: "Open the workflow's executions in n8n to see what went wrong. Sending again may repeat its actions.",
  },
  unknown: {
    status: 500,
    retryable: false,
    messageKey: "errors.unknownMessage",
    hintKey: "errors.unknownHint",
    message: "Something went wrong.",
    hint: "The server log has the details. Retry, or copy the details for support.",
  },
};

export interface AppErrorInit {
  code: ErrorCode;
  /** Safe English fallback. Never put provider JSON, prompts, file text, or a stack here. */
  message?: string;
  hint?: string;
  status?: number;
  retryable?: boolean;
  retryAfterMs?: number;
  /** Server-side only. Never serialized. */
  details?: unknown;
  ref?: string;
  model?: string;
  provider?: string;
  requestId?: string;
  /** Authored detail for the ChatGPT plan surface; a value outside the union is dropped. */
  featureCode?: FeatureCode;
  /** Bounded upstream machine code for diagnostics, never a message or URL. */
  providerCode?: string;
  /** Bounded upstream parameter name for diagnostics. */
  providerParam?: string;
  /** Authored next step. Upstream URLs are never accepted here. */
  recoveryAction?: RecoveryAction;
  agentReason?: AgentReason;
  cause?: unknown;
}

/** The only server-side error type for failures the user can meet. Simple routes may keep HTTPException. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly messageKey: string;
  readonly hintKey: string;
  readonly hint: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly details?: unknown;
  ref?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly requestId?: string;
  readonly featureCode?: FeatureCode;
  readonly providerCode?: string;
  readonly providerParam?: string;
  readonly recoveryAction?: RecoveryAction;
  readonly agentReason?: AgentReason;

  constructor(init: AppErrorInit) {
    const entry = ERROR_CATALOG[init.code];
    super(init.message ?? entry.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "AppError";
    this.code = init.code;
    this.status = init.status ?? entry.status;
    this.messageKey = entry.messageKey;
    this.hintKey = entry.hintKey;
    this.hint = init.hint ?? entry.hint;
    this.retryable = init.retryable ?? entry.retryable;
    if (init.retryAfterMs !== undefined) this.retryAfterMs = init.retryAfterMs;
    if (init.details !== undefined) this.details = init.details;
    if (init.ref) this.ref = init.ref;
    if (init.model) this.model = init.model;
    if (init.provider) this.provider = init.provider;
    if (init.requestId) this.requestId = init.requestId;
    // Normalise here, not only at serialization: an invalid code or a URL-shaped action never
    // exists on the error object, so no later consumer can accidentally trust it.
    if (isFeatureCode(init.featureCode)) this.featureCode = init.featureCode;
    const providerCode = safeProviderField(init.providerCode);
    if (providerCode) this.providerCode = providerCode;
    const providerParam = safeProviderField(init.providerParam);
    if (providerParam) this.providerParam = providerParam;
    if (isRecoveryAction(init.recoveryAction)) this.recoveryAction = init.recoveryAction;
    if (isAgentReason(init.agentReason) && init.code === "agent_response") this.agentReason = init.agentReason;
  }

  static isInstance(error: unknown): error is AppError {
    return error instanceof AppError;
  }
}

export const isAppError = (error: unknown): error is AppError => AppError.isInstance(error);

/** A short reference support can match to one server log line. */
export const newErrorRef = () => randomBytes(4).toString("hex");

const safeText = (value: string, max: number) => redactSecrets(value).slice(0, max);

/** Logs may name what failed, never a code, state, verifier, or token carried in a query string. */
const stripUrlSecrets = (value: string) =>
  value.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (url) => url.split(/[?#]/)[0] ?? url);

/** The safe client payload. `details`, the raw provider body, and the stack are never included. */
export function toWireError(error: AppError): ErrorWire {
  // Re-check the authored lists at the boundary as defense in depth, so a forged value can never
  // reach the browser even if it was assigned somewhere other than the constructor.
  const featureCode = isFeatureCode(error.featureCode) ? error.featureCode : undefined;
  const providerCode = safeProviderField(error.providerCode);
  const providerParam = safeProviderField(error.providerParam);
  const recoveryAction = isRecoveryAction(error.recoveryAction) ? error.recoveryAction : undefined;
  return {
    code: error.code,
    message: safeText(error.message, 500),
    ...(error.hint ? { hint: safeText(error.hint, 500) } : {}),
    retryable: error.retryable,
    ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
    ...(error.ref ? { ref: error.ref } : {}),
    ...(error.model ? { model: safeText(error.model, 200) } : {}),
    ...(error.provider ? { provider: safeText(error.provider, 100) } : {}),
    ...(error.requestId ? { requestId: safeText(error.requestId, 200) } : {}),
    ...(featureCode ? { featureCode } : {}),
    ...(providerCode ? { providerCode } : {}),
    ...(providerParam ? { providerParam } : {}),
    ...(recoveryAction ? { recoveryAction } : {}),
    ...(error.agentReason ? { agentReason: error.agentReason } : {}),
  };
}

const STATUS_CODES: Record<number, ErrorCode> = {
  400: "validation",
  401: "forbidden",
  402: "provider_quota",
  403: "forbidden",
  404: "not_found",
  408: "timeout",
  409: "conflict",
  413: "validation",
  422: "validation",
  429: "rate_limited",
  499: "aborted",
  502: "network",
  503: "service_unavailable",
  504: "timeout",
};

/** An HTTPException keeps its message, but gains a code and the safe metadata the error UI reads. */
export function appErrorFromStatus(status: number, message: string, options: Partial<AppErrorInit> = {}): AppError {
  return new AppError({
    code: STATUS_CODES[status] ?? (status >= 500 ? "unknown" : "validation"),
    status,
    message,
    ...options,
  });
}

/** Adds the structured fields to an existing JSON body while keeping `error` for older clients and tests. */
export function errorJson(c: Context, error: AppError, status = error.status) {
  const wire = toWireError(error);
  return c.json({ error: wire.message, ...wire }, status as ContentfulStatusCode);
}

/** The one HTTP boundary for errors: app errors keep their code, route errors keep their message. */
export function handleAppError(error: unknown, c: Context) {
  if (error instanceof AppError) return errorJson(c, error);
  if (error instanceof HTTPException) return errorJson(c, appErrorFromStatus(error.status, error.message));
  // Raw messages can carry SQL, file paths, prompts, or upstream responses. Only the redacted log gets them.
  const ref = newErrorRef();
  console.error(`[${c.req.method} ${c.req.path}] ref=${ref}`, stripUrlSecrets(redactSecrets(String((error as Error)?.stack ?? error))));
  return errorJson(c, appErrorFromStatus(500, `Something went wrong (ref ${ref}). The server log has details.`, { ref }));
}
