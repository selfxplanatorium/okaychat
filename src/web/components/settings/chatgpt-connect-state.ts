import type {
  ChatGPTAttemptStatus,
  ChatGPTPendingView,
  ChatGPTRegistrationView,
  ChatGPTRegistrationState,
  ChatGPTStatus,
  ChatGPTUnavailableReason,
} from "@shared/chatgpt";
import type { PlainMessageKey } from "@/i18n";

// Pure derivation for the ChatGPT connection card. No React, no DOM, no fetch: `useChatGPTConnection`
// owns requests and the component renders what these functions return, so every card state is testable in
// Node. See docs/implementation/codex-chat.md.

/** Attempts that can still finish; a terminal attempt is never shown as pending. */
export const LIVE_ATTEMPT_STATUSES: readonly ChatGPTAttemptStatus[] = ["preparing", "waiting", "exchanging"];
export const POLL_INTERVAL_MS = 2_000;
/** Stop the timer after repeated failures; a focus/visibility refresh restarts it. */
export const MAX_POLL_FAILURES = 3;

export type ChatGPTBusyAction = "start" | "download" | "cancel" | "activate" | "disconnect" | "forget" | "welcome" | null;

export type ChatGPTView =
  | { kind: "loading" }
  | { kind: "unavailable"; reason: ChatGPTUnavailableReason | "unknown"; legacyImagesConnected: boolean }
  | { kind: "pending"; pending: ChatGPTPendingView; keepsActive: boolean; mobile: boolean }
  | { kind: "disconnected"; mobile: boolean; legacyImagesConnected: boolean }
  | { kind: "ready"; registration: ChatGPTRegistrationView }
  | { kind: "plan_disabled"; registration: ChatGPTRegistrationView }
  | { kind: "reconnect_required"; registration: ChatGPTRegistrationView };

/** The registration that owns the chat connection. A disconnected record is history, not a connection. */
export function activeRegistration(status: ChatGPTStatus | null): ChatGPTRegistrationView | null {
  if (!status) return null;
  const active = status.registrations.find((registration) => registration.active);
  if (active && active.state !== "disconnected") return active;
  const named = status.activeRegistrationId ? status.registrations.find((registration) => registration.id === status.activeRegistrationId) : undefined;
  return named && named.state !== "disconnected" ? named : null;
}

/** Only a live, unexpired attempt is pending; the server keeps the last attempt row for a while. */
export function pendingAttempt(status: ChatGPTStatus | null, now = Date.now()): ChatGPTPendingView | null {
  const pending = status?.pending ?? null;
  if (!pending || !LIVE_ATTEMPT_STATUSES.includes(pending.status) || pending.expiresAt <= now) return null;
  return pending;
}

export function chatGptView(status: ChatGPTStatus | null, options: { now?: number; mobile?: boolean } = {}): ChatGPTView {
  const { now = Date.now(), mobile = false } = options;
  if (!status) return { kind: "loading" };
  const pending = pendingAttempt(status, now);
  const registration = activeRegistration(status);
  if (pending) {
    // A reconnect or an enable-plan attempt must not take the working connection away while it runs.
    return { kind: "pending", pending, keepsActive: registration?.state === "ready", mobile };
  }
  if (registration) {
    if (registration.state === "ready") return { kind: "ready", registration };
    if (registration.state === "plan_disabled") return { kind: "plan_disabled", registration };
    if (registration.state === "reconnect_required") return { kind: "reconnect_required", registration };
  }
  if (!status.available) return { kind: "unavailable", reason: status.unavailableReason ?? "unknown", legacyImagesConnected: status.legacyImagesConnected };
  return { kind: "disconnected", mobile, legacyImagesConnected: status.legacyImagesConnected };
}

/** Saved registrations a user may switch to. Disconnected ones only offer Forget. */
export function selectableRegistrations(status: ChatGPTStatus | null): ChatGPTRegistrationView[] {
  return (status?.registrations ?? []).filter((registration) => registration.state !== "disconnected");
}

export function forgettableRegistrations(status: ChatGPTStatus | null): ChatGPTRegistrationView[] {
  return (status?.registrations ?? []).filter((registration) => registration.state === "disconnected");
}

/** Activating is a local switch, never a new OAuth registration. */
export const canActivate = (registration: ChatGPTRegistrationView) => !registration.active && registration.state !== "disconnected";

/** Access-token renewal is not the subscription's expiry; the copy must keep the two apart. */
export function renewalKey(registration: ChatGPTRegistrationView): PlainMessageKey {
  return registration.renewable ? "providers.chatgptRenews" : "providers.chatgptNotRenewing";
}

export const REGISTRATION_STATE_KEY: Record<ChatGPTRegistrationState, PlainMessageKey> = {
  ready: "providers.chatgptConnectedLabel",
  plan_disabled: "providers.chatgptPlanDisabledShort",
  reconnect_required: "providers.chatgptReconnectNeededShort",
  disconnected: "providers.chatgptDisconnectedShort",
};

export const ATTEMPT_STATUS_KEY: Record<ChatGPTAttemptStatus, PlainMessageKey> = {
  preparing: "providers.chatgptStatusPreparing",
  waiting: "providers.chatgptStatusWaiting",
  exchanging: "providers.chatgptStatusExchanging",
  succeeded: "providers.chatgptStatusSucceeded",
  failed: "providers.chatgptStatusFailed",
  cancelled: "providers.chatgptStatusCancelled",
};

/** The deployment limitation is written for the person who can fix it. */
export function unavailableReasonKey(reason: ChatGPTUnavailableReason | "unknown", admin: boolean): PlainMessageKey {
  if (reason === "public_url_required") return admin ? "providers.chatgptUnavailablePublicUrlAdmin" : "providers.chatgptUnavailablePublicUrl";
  if (reason === "integration_unverified") return admin ? "providers.chatgptUnavailableUnverifiedAdmin" : "providers.chatgptUnavailableUnverified";
  return "providers.chatgptUnknownUnavailable";
}

/** A label and its stable local suffix, so two registrations of one email never look identical. */
export const registrationTitle = (registration: ChatGPTRegistrationView) =>
  registration.label.includes(registration.suffix) ? registration.label : `${registration.label} · ${registration.suffix}`;

/** The fallback label already carries the suffix; showing the badge again would duplicate it. */
export const suffixIsShownInLabel = (registration: ChatGPTRegistrationView) => registration.label.includes(registration.suffix);

/** The first successful, plan-enabled registration that has not shown its welcome notice yet. */
export function welcomeRegistration(status: ChatGPTStatus | null): ChatGPTRegistrationView | null {
  const registration = activeRegistration(status);
  return registration && registration.state === "ready" && !registration.welcomeSeen ? registration : null;
}

/** Poll only a live attempt, only while the page is visible, and never after repeated failures. */
export function shouldPoll(status: ChatGPTStatus | null, options: { now?: number; visible: boolean; failures: number }): boolean {
  const { now = Date.now(), visible, failures } = options;
  if (!visible || failures >= MAX_POLL_FAILURES) return false;
  return pendingAttempt(status, now) !== null;
}

export function pendingRemainingMs(pending: ChatGPTPendingView, now = Date.now()): number {
  return Math.max(0, pending.expiresAt - now);
}

export type ChatGPTDisconnectNotice = "confirmed" | "unconfirmed" | "not_applicable";

/** Disconnecting chat never revokes the image connection; the unconfirmed case says so explicitly. */
export function disconnectNoticeKey(remoteRevocation: ChatGPTDisconnectNotice): PlainMessageKey | null {
  if (remoteRevocation === "unconfirmed") return "providers.chatgptRevokeUnconfirmed";
  return null;
}

/** Terminal attempt codes the card can explain. A cancelled attempt is the user's own action. */
export const ATTEMPT_ERROR_KEY: Record<string, PlainMessageKey> = {
  chatgpt_login_expired: "providers.chatgptErrorExpired",
  chatgpt_login_cancelled: "providers.chatgptErrorCancelled",
  chatgpt_login_invalid: "providers.chatgptErrorInvalid",
  chatgpt_identity_mismatch: "providers.chatgptErrorIdentity",
  chatgpt_oauth_unavailable: "providers.chatgptErrorUnavailable",
};

export function attemptFailureKey(status: ChatGPTStatus | null): PlainMessageKey | null {
  const pending = status?.pending;
  if (!pending || pending.status !== "failed" || !pending.errorCode) return null;
  return ATTEMPT_ERROR_KEY[pending.errorCode] ?? "providers.chatgptErrorGeneric";
}

export interface ChatGPTConnectionState {
  /** The okaychat account these answers belong to. Null before the account is known. */
  accountId: string | null;
  status: ChatGPTStatus | null;
  /** A translated inline message for the last failed status request. */
  errorText: string | null;
  /** The last accepted answer's request number; older answers never overwrite a newer one. */
  sequence: number;
}

export const initialChatGPTConnection: ChatGPTConnectionState = { accountId: null, status: null, errorText: null, sequence: 0 };

export type ChatGPTConnectionEvent =
  | { type: "account"; accountId: string | null }
  | { type: "loaded"; accountId: string; sequence: number; status: ChatGPTStatus }
  | { type: "failed"; accountId: string; sequence: number; text: string }
  | { type: "clearError" };

/**
 * Account switches discard every answer for the previous account. Within one account, an answer is
 * accepted only when its request number is newer than the last accepted one, so a slow poll cannot undo a
 * write that already refreshed the screen.
 */
export function reduceChatGPTConnection(state: ChatGPTConnectionState, event: ChatGPTConnectionEvent): ChatGPTConnectionState {
  if (event.type === "account") {
    if (state.accountId === event.accountId) return state;
    return { ...initialChatGPTConnection, accountId: event.accountId };
  }
  if (event.type === "clearError") return state.errorText ? { ...state, errorText: null } : state;
  if (state.accountId !== event.accountId) return state;
  if (event.sequence <= state.sequence) return state;
  if (event.type === "loaded") return { ...state, status: event.status, errorText: null, sequence: event.sequence };
  return { ...state, errorText: event.text, sequence: event.sequence };
}
