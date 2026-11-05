/**
 * Sign in with ChatGPT for chat (`/api/chatgpt`). The chat connection is independent of the Codex CLI
 * login that generates images. See docs/implementation/codex-chat.md.
 */

export type ChatGPTRegistrationState = "ready" | "plan_disabled" | "reconnect_required" | "disconnected";
export type ChatGPTAttemptStatus = "preparing" | "waiting" | "exchanging" | "succeeded" | "failed" | "cancelled";
export type ChatGPTLoginIntent = "connect" | "reconnect" | "enable_plan";
export type ChatGPTUnavailableReason = "public_url_required" | "integration_unverified";

/** Stable feature codes carried as `featureCode` on error wires and as attempt/registration error codes. */
export const CHATGPT_FEATURE_CODES = [
  "chatgpt_setup_required",
  "chatgpt_login_expired",
  "chatgpt_login_cancelled",
  "chatgpt_login_invalid",
  "chatgpt_identity_mismatch",
  "chatgpt_plan_disabled",
  "chatgpt_reconnect_required",
  "chatgpt_refresh_uncertain",
  "chatgpt_oauth_unavailable",
  "chatgpt_protocol_error",
] as const;
export type ChatGPTFeatureCode = (typeof CHATGPT_FEATURE_CODES)[number];

export interface ChatGPTRegistrationView {
  id: string;
  /** Verified name or email when known, else `ChatGPT account · <suffix>`. */
  label: string;
  email?: string;
  /** Stable short local suffix, shown next to the label so two registrations of one email differ. */
  suffix: string;
  planLabel: "ChatGPT plan";
  state: ChatGPTRegistrationState;
  active: boolean;
  /** A refresh token is held, so access renews without signing in again. */
  renewable: boolean;
  /** Access-token expiry, not the subscription's. */
  accessExpiresAt: number | null;
  connectedAt: number;
  welcomeSeen: boolean;
  lastErrorCode?: string;
}

export interface ChatGPTPendingView {
  id: string;
  status: ChatGPTAttemptStatus;
  expiresAt: number;
  errorCode?: string;
}

export interface ChatGPTStatus {
  mode: "desktop_helper";
  publicOrigin: string | null;
  available: boolean;
  unavailableReason: ChatGPTUnavailableReason | null;
  /** Synchronizer token for writes (`X-CSRF-Token`). Grants nothing without the session cookie. */
  csrfToken: string;
  activeRegistrationId: string | null;
  registrations: ChatGPTRegistrationView[];
  pending: ChatGPTPendingView | null;
  /** The Codex CLI login for images exists. Never means chat is connected. */
  legacyImagesConnected: boolean;
  /** Static path of the desktop helper script in the built web distribution. */
  helperUrl: string;
  manageUsageUrl: "https://chatgpt.com/settings/usage";
}

export interface ChatGPTLoginStart {
  attemptId: string;
  expiresAt: number;
  launchDownloadUrl: string;
}

export const CHATGPT_MANAGE_USAGE_URL = "https://chatgpt.com/settings/usage" as const;
export const CHATGPT_HELPER_PATH = "/chatgpt-connect.mjs";
/** Launch-file format version understood by the desktop helper. */
export const CHATGPT_LAUNCH_VERSION = 1;
