import type { AgentReason } from "@shared/n8n-agents";
import type { ErrorWire } from "@shared/errors";
import { t, type PlainMessageKey } from "@/i18n";
import { ApiError } from "@/lib/api";
import { presentError } from "@/lib/error-presentation";

// Authored reason text for an agent answer that could not be used. The server sends a stable key, never
// the workflow's text; these labels are the only thing a test panel or chat error shows for the reason.

const REASON_KEYS: Record<AgentReason, PlainMessageKey> = {
  inactive: "agents.errorInactive",
  redirect: "agents.errorRedirect",
  empty: "agents.errorEmpty",
  malformed: "agents.errorMalformed",
  truncated: "agents.errorTruncated",
  limit: "agents.errorLimit",
  interactive: "agents.errorInteractive",
  html: "agents.errorHtml",
  acknowledged: "agents.errorAcknowledged",
};

export const agentReasonKey = (reason: AgentReason | undefined): PlainMessageKey | undefined =>
  reason ? REASON_KEYS[reason] : undefined;

/** The wire fields of an ApiError, without the raw message that a provider body could poison. */
export function wireOf(error: unknown): ErrorWire {
  if (error instanceof ApiError) {
    return {
      code: error.code,
      message: "",
      retryable: error.retryable,
      ...(error.agentReason ? { agentReason: error.agentReason } : {}),
    };
  }
  return { code: "unknown", message: "", retryable: false };
}

/** Safe title, hint, and reason line for a management/test failure. */
export function agentErrorText(error: unknown): { message: string; hint?: string; reason?: string } {
  const wire = wireOf(error);
  const presentation = presentError(wire, "settings");
  const reason = agentReasonKey(wire.agentReason);
  return {
    message: t(presentation.messageKey),
    hint: t(presentation.hintKey),
    ...(reason ? { reason: t(reason) } : {}),
  };
}
