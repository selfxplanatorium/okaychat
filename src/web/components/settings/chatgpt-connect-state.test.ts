/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHATGPT_MANAGE_USAGE_URL, type ChatGPTPendingView, type ChatGPTRegistrationView, type ChatGPTStatus } from "@shared/chatgpt";
import {
  MAX_POLL_FAILURES,
  activeRegistration,
  attemptFailureKey,
  canActivate,
  chatGptView,
  disconnectNoticeKey,
  forgettableRegistrations,
  initialChatGPTConnection,
  pendingAttempt,
  pendingRemainingMs,
  reduceChatGPTConnection,
  registrationTitle,
  renewalKey,
  selectableRegistrations,
  shouldPoll,
  suffixIsShownInLabel,
  unavailableReasonKey,
  welcomeRegistration,
  type ChatGPTConnectionState,
} from "./chatgpt-connect-state.js";

const now = 1_800_000_000_000;

const registration = (patch: Partial<ChatGPTRegistrationView> = {}): ChatGPTRegistrationView => ({
  id: "cgr_one",
  label: "Ada",
  suffix: "a1b2c3",
  planLabel: "ChatGPT plan",
  state: "ready",
  active: true,
  renewable: true,
  accessExpiresAt: now + 3_600_000,
  connectedAt: now - 60_000,
  welcomeSeen: true,
  ...patch,
});

const status = (patch: Partial<ChatGPTStatus> = {}): ChatGPTStatus => ({
  mode: "desktop_helper",
  publicOrigin: "https://chat.example.com",
  available: true,
  unavailableReason: null,
  csrfToken: "csrf-token",
  activeRegistrationId: "cgr_one",
  registrations: [registration()],
  pending: null,
  legacyImagesConnected: false,
  helperUrl: "/chatgpt-connect.mjs",
  manageUsageUrl: CHATGPT_MANAGE_USAGE_URL,
  ...patch,
});

const pending = (patch: Partial<ChatGPTPendingView> = {}): ChatGPTPendingView => ({
  id: "cgl_one",
  status: "waiting",
  expiresAt: now + 300_000,
  ...patch,
});

test("no answer yet is loading, never a disconnected card", () => {
  assert.deepEqual(chatGptView(null), { kind: "loading" });
});

test("a fresh account offers desktop setup, and a phone only explains the limitation", () => {
  const empty = status({ activeRegistrationId: null, registrations: [] });
  assert.deepEqual(chatGptView(empty, { now }), { kind: "disconnected", mobile: false, legacyImagesConnected: false });
  assert.deepEqual(chatGptView(empty, { now, mobile: true }), { kind: "disconnected", mobile: true, legacyImagesConnected: false });
  assert.equal(chatGptView(status({ activeRegistrationId: null, registrations: [], legacyImagesConnected: true }), { now }).kind, "disconnected");
});

test("unavailable reasons survive without a registration", () => {
  const noPublicUrl = status({ available: false, unavailableReason: "public_url_required", activeRegistrationId: null, registrations: [] });
  assert.deepEqual(chatGptView(noPublicUrl, { now }), { kind: "unavailable", reason: "public_url_required", legacyImagesConnected: false });
  const unverified = status({ available: false, unavailableReason: "integration_unverified", activeRegistrationId: null, registrations: [] });
  assert.equal(chatGptView(unverified, { now }).kind, "unavailable");
  assert.equal(unavailableReasonKey("public_url_required", false), "providers.chatgptUnavailablePublicUrl");
  assert.equal(unavailableReasonKey("public_url_required", true), "providers.chatgptUnavailablePublicUrlAdmin");
  assert.equal(unavailableReasonKey("integration_unverified", true), "providers.chatgptUnavailableUnverifiedAdmin");
  assert.equal(unavailableReasonKey("unknown", false), "providers.chatgptUnknownUnavailable");
});

test("an existing connection still works when the deployment stops accepting new sign-ins", () => {
  const view = chatGptView(status({ available: false, unavailableReason: "integration_unverified" }), { now });
  assert.equal(view.kind, "ready");
});

test("only a live attempt is pending, and a reconnect keeps the working connection", () => {
  const live = chatGptView(status({ pending: pending() }), { now });
  assert.equal(live.kind, "pending");
  assert.equal(live.kind === "pending" && live.keepsActive, true);
  assert.equal(live.kind === "pending" && live.mobile, false);

  const withoutActive = status({ pending: pending(), activeRegistrationId: null, registrations: [] });
  const withoutActiveView = chatGptView(withoutActive, { now });
  assert.equal(withoutActiveView.kind, "pending");
  assert.equal(withoutActiveView.kind === "pending" && withoutActiveView.keepsActive, false);

  assert.equal(chatGptView(status({ pending: pending({ expiresAt: now }) }), { now }).kind, "ready");
  assert.equal(chatGptView(status({ pending: pending({ status: "succeeded" }) }), { now }).kind, "ready");
  assert.equal(chatGptView(status({ pending: pending({ status: "cancelled" }) }), { now }).kind, "ready");
  assert.equal(pendingAttempt(status({ pending: pending({ expiresAt: now }) }), now), null);
  assert.equal(pendingAttempt(status({ pending: pending() }), now)?.id, "cgl_one");
  assert.equal(pendingRemainingMs(pending(), now), 300_000);
  assert.equal(pendingRemainingMs(pending({ expiresAt: now - 5 }), now), 0);
});

test("ready, identity-only and reconnect states each stay distinct", () => {
  assert.equal(chatGptView(status(), { now }).kind, "ready");
  const planDisabled = chatGptView(status({ registrations: [registration({ state: "plan_disabled" })] }), { now });
  assert.equal(planDisabled.kind, "plan_disabled");
  assert.equal(planDisabled.kind === "plan_disabled" && planDisabled.registration.state, "plan_disabled");
  const reconnect = chatGptView(status({ registrations: [registration({ state: "reconnect_required" })] }), { now });
  assert.equal(reconnect.kind, "reconnect_required");
});

test("the active registration is the connected one, not a disconnected record", () => {
  const mixed = status({
    activeRegistrationId: null,
    registrations: [registration({ id: "cgr_old", active: false, state: "disconnected" })],
  });
  assert.equal(activeRegistration(mixed), null);
  assert.equal(chatGptView(mixed, { now }).kind, "disconnected");
  assert.equal(activeRegistration(status({ registrations: [registration({ id: "cgr_old", active: false, state: "disconnected" }), registration()] }))?.id, "cgr_one");
});

test("switching accounts only offers validated registrations; disconnected records can be forgotten", () => {
  const mixed = status({
    registrations: [
      registration(),
      registration({ id: "cgr_two", active: false, label: "Grace", state: "plan_disabled" }),
      registration({ id: "cgr_old", active: false, label: "Old", state: "disconnected" }),
    ],
  });
  assert.deepEqual(selectableRegistrations(mixed).map((entry) => entry.id), ["cgr_one", "cgr_two"]);
  assert.deepEqual(forgettableRegistrations(mixed).map((entry) => entry.id), ["cgr_old"]);
  assert.equal(canActivate(selectableRegistrations(mixed)[1]!), true);
  assert.equal(canActivate(selectableRegistrations(mixed)[0]!), false);
  assert.equal(canActivate(forgettableRegistrations(mixed)[0]!), false);
});

test("renewal copy describes the access token, never the subscription", () => {
  assert.equal(renewalKey(registration()), "providers.chatgptRenews");
  assert.equal(renewalKey(registration({ renewable: false })), "providers.chatgptNotRenewing");
  assert.equal(registrationTitle(registration()), "Ada · a1b2c3");
  assert.equal(registrationTitle(registration({ label: "ChatGPT account · a1b2c3" })), "ChatGPT account · a1b2c3");
  assert.equal(suffixIsShownInLabel(registration({ label: "ChatGPT account · a1b2c3" })), true);
  assert.equal(suffixIsShownInLabel(registration()), false);
});

test("the plan welcome appears once per registration, only when plan use is ready", () => {
  assert.equal(welcomeRegistration(status({ registrations: [registration({ welcomeSeen: false })] }))?.id, "cgr_one");
  assert.equal(welcomeRegistration(status({ registrations: [registration({ welcomeSeen: true })] })), null);
  assert.equal(welcomeRegistration(status({ registrations: [registration({ state: "plan_disabled", welcomeSeen: false })] })), null);
  assert.equal(welcomeRegistration(status({ registrations: [] })), null);
});

test("polling stops when hidden, expired, terminal, or failing, and resumes otherwise", () => {
  const live = status({ pending: pending() });
  assert.equal(shouldPoll(live, { now, visible: true, failures: 0 }), true);
  assert.equal(shouldPoll(live, { now, visible: false, failures: 0 }), false);
  assert.equal(shouldPoll(live, { now: now + 3_600_000, visible: true, failures: 0 }), false);
  assert.equal(shouldPoll(live, { now, visible: true, failures: MAX_POLL_FAILURES }), false);
  assert.equal(shouldPoll(status(), { now, visible: true, failures: 0 }), false);
  assert.equal(shouldPoll(status({ pending: pending({ status: "failed" }) }), { now, visible: true, failures: 0 }), false);
});

test("the disconnect notice stays scoped to chat", () => {
  assert.equal(disconnectNoticeKey("unconfirmed"), "providers.chatgptRevokeUnconfirmed");
  assert.equal(disconnectNoticeKey("confirmed"), null);
  assert.equal(disconnectNoticeKey("not_applicable"), null);
});

test("a failed attempt explains itself, while a cancelled or successful one does not", () => {
  assert.equal(attemptFailureKey(status({ pending: pending({ status: "failed", errorCode: "chatgpt_login_expired" }) })), "providers.chatgptErrorExpired");
  assert.equal(attemptFailureKey(status({ pending: pending({ status: "failed", errorCode: "chatgpt_identity_mismatch" }) })), "providers.chatgptErrorIdentity");
  assert.equal(attemptFailureKey(status({ pending: pending({ status: "failed", errorCode: "unknown" }) })), "providers.chatgptErrorGeneric");
  assert.equal(attemptFailureKey(status({ pending: pending({ status: "failed" }) })), null);
  assert.equal(attemptFailureKey(status({ pending: pending({ status: "cancelled", errorCode: "chatgpt_login_cancelled" }) })), null);
  assert.equal(attemptFailureKey(status({ pending: pending({ status: "succeeded" }) })), null);
  assert.equal(attemptFailureKey(status()), null);
});

test("stale answers are dropped on account switch and out-of-order responses", () => {
  const start: ChatGPTConnectionState = { ...initialChatGPTConnection, accountId: "user_a", status: status(), sequence: 4 };
  const otherAccount = reduceChatGPTConnection(start, { type: "loaded", accountId: "user_b", sequence: 9, status: status({ csrfToken: "b" }) });
  assert.equal(otherAccount, start);

  const stale = reduceChatGPTConnection(start, { type: "loaded", accountId: "user_a", sequence: 3, status: status({ csrfToken: "old" }) });
  assert.equal(stale, start);

  const fresh = reduceChatGPTConnection(start, { type: "loaded", accountId: "user_a", sequence: 5, status: status({ csrfToken: "new", activeRegistrationId: null, registrations: [] }) });
  assert.equal(fresh.sequence, 5);
  assert.equal(fresh.status?.csrfToken, "new");
  assert.equal(fresh.status?.activeRegistrationId, null);

  // A newer failure must not be overwritten by an older success that was still in flight.
  const failed = reduceChatGPTConnection(fresh, { type: "failed", accountId: "user_a", sequence: 6, text: "offline" });
  assert.equal(failed.errorText, "offline");
  assert.equal(reduceChatGPTConnection(failed, { type: "loaded", accountId: "user_a", sequence: 5, status: status() }), failed);

  const switched = reduceChatGPTConnection(failed, { type: "account", accountId: "user_b" });
  assert.deepEqual(switched, { ...initialChatGPTConnection, accountId: "user_b" });
  assert.equal(reduceChatGPTConnection(switched, { type: "loaded", accountId: "user_a", sequence: 99, status: status() }), switched);
  assert.equal(reduceChatGPTConnection(switched, { type: "loaded", accountId: "user_b", sequence: 1, status: status({ csrfToken: "b" }) }).status?.csrfToken, "b");
});

test("the same account event does not throw away a loaded answer", () => {
  const loaded = reduceChatGPTConnection(initialChatGPTConnection, { type: "account", accountId: "user_a" });
  const answer = reduceChatGPTConnection(loaded, { type: "loaded", accountId: "user_a", sequence: 1, status: status() });
  assert.equal(reduceChatGPTConnection(answer, { type: "account", accountId: "user_a" }), answer);
  const cleared = reduceChatGPTConnection({ ...answer, errorText: "x" }, { type: "clearError" });
  assert.equal(cleared.errorText, null);
  assert.equal(cleared.status, answer.status);
});
