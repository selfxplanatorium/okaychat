import assert from "node:assert/strict";
import { test } from "node:test";
import { ERROR_CODES, parseErrorWire, type ErrorWire } from "@shared/errors";
import { errorDetails, presentError, settingsForError, toolErrorPresentation } from "./error-presentation.js";

const wire = (code: ErrorWire["code"], extra: Partial<ErrorWire> = {}): ErrorWire => ({
  code,
  message: "server fallback",
  retryable: true,
  ...extra,
});

test("every taxonomy code has a message and hint decision, including unknown", () => {
  assert.equal(ERROR_CODES.length, 49);
  assert.ok(ERROR_CODES.includes("video_submission_unknown"));
  for (const code of ERROR_CODES) {
    const chat = presentError(wire(code), "chat");
    assert.match(chat.messageKey, /^errors\./, code);
    assert.match(chat.hintKey, /^errors\./, code);
    assert.equal(chat.surface, "inline");
  }
});

test("agent errors route to Agents settings without logout or leaking authored reasons to Copy details", () => {
  for (const code of ["agent_auth", "agent_response", "agent_failed"] as const) {
    const result = presentError(wire(code, { retryable: false, agentReason: code === "agent_response" ? "inactive" : undefined }), "chat");
    assert.equal(result.actions.settings, "agents");
    assert.equal(result.actions.retry, true, "manual retry remains available");
    assert.equal(result.actions.switchModel, false);
    assert.equal(result.messageKey, code === "agent_auth" ? "errors.agentAuth" : code === "agent_response" ? "errors.agentResponse" : "errors.agentFailed");
  }
  const details = errorDetails(wire("agent_response", { agentReason: "inactive", hint: "SECRET_REASON" }));
  assert.equal(details, "code: agent_response");
});

test("agent reason is allowlisted on the wire but never copied", () => {
  const parsed = parseErrorWire({ code: "agent_response", message: "Safe", retryable: false, agentReason: "inactive", url: "SECRET_URL" });
  assert.equal(parsed?.agentReason, "inactive");
  assert.equal(parseErrorWire({ code: "agent_response", message: "Safe", retryable: false, agentReason: "SECRET_URL" })?.agentReason, undefined);
});

test("chat failures offer retry only when retrying can help", () => {
  const rate = presentError(wire("provider_rate_limit"), "chat");
  assert.equal(rate.actions.retry, true);
  assert.equal(rate.actions.switchModel, true);
  assert.equal(rate.actions.copyDetails, true);

  const auth = presentError(wire("provider_auth", { retryable: false }), "chat");
  assert.equal(auth.actions.retry, true, "a manual retry is still available");
  assert.equal(auth.actions.settings, "providers");

  const stopped = presentError(wire("aborted", { retryable: false }), "chat");
  assert.equal(stopped.actions.retry, false);
  assert.equal(stopped.actions.switchModel, false);

  const context = presentError(wire("context_length", { retryable: false }), "chat");
  assert.equal(context.actions.settings, "compaction");
  assert.equal(settingsForError("storage_quota"), "account");
});

test("credit failures point to Usage and skip a retry that cannot help", () => {
  const exhausted = presentError(wire("token_credit_exhausted", { retryable: false }), "chat");
  assert.equal(exhausted.actions.retry, false);
  assert.equal(exhausted.actions.settings, "usage");
  assert.equal(exhausted.messageKey, "errors.tokenCreditExhaustedMessage");

  const unknown = presentError(wire("token_credit_usage_unknown", { retryable: false }), "chat");
  assert.equal(unknown.actions.retry, false);
  assert.equal(unknown.actions.settings, "usage");

  const busy = presentError(wire("token_credit_busy"), "chat");
  assert.equal(busy.actions.retry, true, "a manual retry is allowed after the active operation");
  assert.equal(busy.hintKey, "errors.tokenCreditBusyHint");

  const unmetered = presentError(wire("token_credit_unmetered", { retryable: false }), "chat");
  assert.equal(unmetered.actions.retry, false);
  assert.equal(unmetered.actions.copyDetails, true);
});

test("tool cards stay a plain message and hint with no actions", () => {
  const tool = presentError(wire("tool_failed", { retryable: false }), "tool");
  assert.deepEqual(tool.actions, { retry: false, switchModel: false, copyDetails: false, reload: false });
});

test("a raw historical tool error becomes the generic translated tool failure", () => {
  const raw = toolErrorPresentation("apiKey=sk-live-SECRETVALUE and prompt PROMPT_SECRET");
  assert.equal(raw?.messageKey, "errors.toolFailedMessage");
  assert.equal(raw?.hintKey, "errors.toolFailedHint");
  assert.equal(raw?.code, "tool_failed");

  assert.equal(toolErrorPresentation("Error: boom\n    at run (file.ts:12:3)")?.code, "tool_failed");
  assert.equal(toolErrorPresentation({ message: "PROMPT_SECRET", apiKey: "sk-secret" })?.code, "tool_failed");
  assert.equal(toolErrorPresentation(JSON.stringify({ code: "unknown", message: "raw body", retryable: false }))?.code, "tool_failed");
  assert.equal(toolErrorPresentation(undefined), undefined);

  const wireText = JSON.stringify({ code: "provider_rate_limit", message: "rate limited", retryable: true });
  assert.equal(toolErrorPresentation(wireText)?.code, "provider_rate_limit");
});

test("settings and uploads are inline with a safe specific detail only where it helps", () => {
  const validation = presentError(wire("validation", { message: "Enter a display name between 1 and 80 characters." }), "settings");
  assert.equal(validation.surface, "inline");
  assert.equal(validation.detail, "Enter a display name between 1 and 80 characters.");
  assert.equal(validation.actions.copyDetails, false);

  const auth = presentError(wire("provider_auth", { message: "raw provider text" }), "settings");
  assert.equal(auth.detail, undefined);

  const upload = presentError(wire("storage_quota", { message: "Storage quota exceeded: 1 GB of 1 GB used." }), "upload");
  assert.match(upload.detail ?? "", /Storage quota exceeded/);
});

test("the render boundary shows a page with reload and copy", () => {
  const render = presentError(wire("unknown"), "render");
  assert.equal(render.surface, "page");
  assert.equal(render.actions.reload, true);
  assert.equal(render.actions.copyDetails, true);
  assert.equal(render.messageKey, "errors.renderTitle");
});

test("Copy details is an allowlist and ignores planted secrets", () => {
  const poisoned = {
    code: "provider_rate_limit",
    message: "raw provider message with PROMPT_SECRET",
    retryable: true,
    ref: "abc12345",
    model: "openai/gpt-5",
    provider: "openai",
    requestId: "req_1",
    apiKey: "sk-proj-SECRET1234567890",
    prompt: "PROMPT_SECRET",
    file: "FILE_SECRET",
    stack: "at SECRET_STACK",
  } as unknown as ErrorWire;
  const details = errorDetails(poisoned);
  assert.equal(details, "code: provider_rate_limit\nref: abc12345\nmodel: openai/gpt-5\nprovider: openai\nrequestId: req_1");
  for (const secret of ["SECRET", "PROMPT_SECRET", "FILE_SECRET", "stack", "apiKey"]) assert.ok(!details.includes(secret), secret);
});

test("wire parsing rejects unknown codes and drops every unknown field", () => {
  const parsed = parseErrorWire(JSON.stringify({
    code: "network",
    message: "The server could not reach the provider.",
    retryable: true,
    apiKey: "sk-proj-SECRET1234567890",
    prompt: "PROMPT_SECRET",
    stack: "SECRET_STACK",
  }));
  assert.deepEqual(parsed, { code: "network", message: "The server could not reach the provider.", retryable: true });
  assert.equal(parseErrorWire({ code: "made_up", message: "x", retryable: false }), undefined);
  assert.equal(parseErrorWire("not json"), undefined);
});
