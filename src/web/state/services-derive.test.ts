import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ToolCallMessagePart, ToolCallMessagePartStatus } from "@assistant-ui/react";
import type { ServiceStatus } from "@shared/services";
import {
  availabilityOf,
  customServiceMessageKey,
  hasServiceFailure,
  noticeServices,
  orderedStatuses,
  parseServices,
  pruneDismissed,
  toolPartsSignature,
  usedServicesForReply,
  usedServicesFromParts,
  type ServiceView,
} from "./services-derive.js";
import { resetServices, useServices } from "./services.js";

// The banner and the disabled controls depend on these rules, so they live in a pure module: no DOM, no fetch,
// no timers. See docs/implementation/service-health.md.

const status = (id: ServiceStatus["id"], state: ServiceStatus["state"], reasonKey: ServiceStatus["reasonKey"] = state === "up" ? "ok" : "unreachable"): ServiceStatus => ({
  id,
  state,
  reasonKey,
  checkedAt: 1_700_000_000_000,
});

const view = (statuses: ServiceStatus[] | null, used: Record<string, number> = {}, dismissed: Record<string, number> = {}): ServiceView => ({ statuses, used, dismissed });

test("checking is a state of its own, never shown as down", () => {
  assert.equal(availabilityOf(view(null), "browser"), "checking");
  assert.equal(availabilityOf(view([]), "browser"), "unknown", "an empty answer is not an outage either");
  assert.equal(availabilityOf(view([status("browser", "down")]), "browser"), "down");
  assert.equal(availabilityOf(view([status("browser", "degraded")]), "browser"), "degraded");
  assert.equal(availabilityOf(view([status("browser", "up")]), "browser"), "up");
  assert.equal(availabilityOf(view([status("browser", "up")]), "speech"), "unknown", "a missing entry is not an outage");
});

test("the registry payload keeps known fields only", () => {
  const parsed = parseServices({
    services: [
      { id: "browser", state: "down", reasonKey: "refuses", fixKey: "startBrowser", checkedAt: 12, latencyMs: 4.6, url: "http://internal:8080", token: "secret" },
      { id: "not-a-service", state: "down", reasonKey: "refuses", checkedAt: 1 },
      { id: "email:eml_1", state: "degraded", reasonKey: "emailUntested", fixKey: "email", checkedAt: 0 },
      { id: "browser", state: "melted", reasonKey: "refuses", checkedAt: 1 },
      "nonsense",
    ],
  });
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], { id: "browser", state: "down", reasonKey: "refuses", fixKey: "startBrowser", checkedAt: 12, latencyMs: 5 });
  assert.deepEqual(Object.keys(parsed[0]!).sort(), ["checkedAt", "fixKey", "id", "latencyMs", "reasonKey", "state"]);
  assert.equal(parsed[1]!.id, "email:eml_1");
  assert.deepEqual(parseServices(null), []);
  assert.deepEqual(parseServices({ services: "nope" }), []);
});

test("loading the registry never raises a notice; a used, down service does", () => {
  const statuses = [status("browser", "down"), status("sandbox", "up"), status("speech", "degraded"), status("searxng", "unconfigured")];
  assert.deepEqual(noticeServices(view(statuses)), [], "boot alone is not use");
  const used = { browser: 1, sandbox: 1, speech: 1, searxng: 1 };
  assert.deepEqual(noticeServices(view(statuses, used)).map((entry) => entry.id), ["browser", "speech"]);
  assert.deepEqual(noticeServices(view(statuses, used, { browser: 2 })).map((entry) => entry.id), ["speech"], "a dismissed service stays quiet");
});

test("a recovered service loses its dismissal, so the next outage is shown again", () => {
  const dismissed = { browser: 5, speech: 6 };
  assert.deepEqual(pruneDismissed(view(null, {}, dismissed), [status("browser", "up"), status("speech", "down")]), { speech: 6 });
});

// The real shape in `s.thread.messages[].parts`: assistant-ui's converted ToolCallMessagePart plus the
// PartState status wrapper. A tool error arrives as `isError` and `result: { error }` from `@assistant-ui/ai-sdk`.
type ToolPart = ToolCallMessagePart & { status: ToolCallMessagePartStatus };
let callId = 0;
const tool = (toolName: string, options: { args?: ToolCallMessagePart["args"]; result?: unknown; isError?: boolean; status?: ToolCallMessagePartStatus } = {}): ToolPart => ({
  type: "tool-call",
  toolCallId: `call_${++callId}`,
  toolName,
  args: options.args ?? {},
  argsText: JSON.stringify(options.args ?? {}),
  result: options.result,
  isError: options.isError,
  status: options.status ?? { type: "complete" },
});
const serviceError = (service: string) => tool("create_document", {
  isError: true,
  result: { error: JSON.stringify({ code: "service_unavailable", message: `${service} unavailable`, retryable: true }) },
});

test("assistant-ui tool parts name the service they exercised, including a failed call", () => {
  assert.deepEqual(usedServicesFromParts([
    tool("run_code"),
    tool("view_artifact"),
    tool("web_search"),
  ]), ["sandbox", "browser", "searxng"]);
  assert.deepEqual(usedServicesFromParts([
    tool("create_document", { result: { id: "a", kind: "pdf", size: 10 } }),
    tool("edit_document", { result: { id: "b", kind: "docx", size: 10 } }),
    tool("import_document", { result: { id: "c", kind: "pdf", size: 10 } }),
  ]), ["browser"], "only a PDF document needs the browser worker");
  assert.deepEqual(usedServicesFromParts([
    tool("create_document", { args: { kind: "pdf" }, isError: true, result: { error: JSON.stringify({ code: "service_unavailable" }) } }),
  ]), ["browser"], "a PDF that failed before it had a result still used the browser");
  assert.deepEqual(usedServicesFromParts([{ type: "text" }]), [], "text is not a service use");
  assert.deepEqual(usedServicesFromParts([serviceError("browser")]), ["browser"]);
});

test("page reading marks Scrapling only when the fallback actually served the page", () => {
  assert.deepEqual(usedServicesFromParts([tool("web_fetch", { result: { title: "A", via: "fetch" } })]), []);
  assert.deepEqual(usedServicesFromParts([tool("web_fetch", { result: { title: "B", via: "scrapling" } })]), ["scrapling"]);
  assert.deepEqual(usedServicesFromParts([tool("web_fetch", { isError: true, result: { error: "network" } })]), []);
});

test("an email call marks its actual account, and folder inventory marks the listed accounts", () => {
  assert.deepEqual(usedServicesFromParts([tool("email_read", { args: { accountId: "eml_a" }, result: { account: { id: "eml_b" } } })]), ["email:eml_a"]);
  assert.deepEqual(usedServicesFromParts([tool("email_list", { result: { account: { id: "eml_b" } } })]), ["email:eml_b"]);
  assert.deepEqual(usedServicesFromParts([tool("email_folders", { result: { accounts: [{ id: "eml_a" }, { id: "eml_c" }], account: { id: "eml_a" } } })]), ["email:eml_a", "email:eml_c"]);
});

test("a reply marks providers, and Codex only for a ChatGPT model", () => {
  assert.deepEqual(usedServicesForReply([tool("web_search")], "openai/gpt-5"), ["searxng", "providers"]);
  assert.deepEqual(usedServicesForReply([], "chatgpt/gpt-5"), ["providers", "codex"]);
  assert.deepEqual(usedServicesForReply([], undefined), ["providers"]);
});

test("the tool signature changes when a result or an error arrives, not for text", () => {
  const running = tool("web_fetch", { status: { type: "running" } });
  const done = { ...running, result: { via: "scrapling" }, status: { type: "complete" as const } };
  const failed = { ...running, isError: true, result: { error: JSON.stringify({ code: "service_unavailable" }) } };
  assert.notEqual(toolPartsSignature([running]), toolPartsSignature([done]));
  assert.notEqual(toolPartsSignature([done]), toolPartsSignature([failed]));
  assert.equal(toolPartsSignature([{ type: "text" }]), "");
  assert.equal(toolPartsSignature([running]), toolPartsSignature([running]), "stable across renders");
  assert.equal(hasServiceFailure([failed]), true);
  assert.equal(hasServiceFailure([done]), false);
});

test("a panel note is used for down, never for degraded", () => {
  assert.equal(customServiceMessageKey("down", "services.voiceLocalNote"), "services.voiceLocalNote");
  assert.equal(customServiceMessageKey("degraded", "services.voiceLocalNote"), undefined);
  assert.equal(customServiceMessageKey("up", "services.voiceLocalNote"), undefined);
});

test("notices follow registry order so the banner does not jump", () => {
  const ordered = orderedStatuses([status("providers", "down"), status("email:eml_1", "down"), status("browser", "down"), status("sandbox", "down")]);
  assert.deepEqual(ordered.map((entry) => entry.id), ["browser", "sandbox", "providers", "email:eml_1"]);
});

// --- the store: one request per account, late answers dropped, no polling ---

const payload = (services: unknown[]) => Response.json({ services });

afterEach(() => {
  resetServices();
});

test("start loads once per account and ignores an answer for the previous account", async (t) => {
  const pending: Array<(response: Response) => void> = [];
  t.mock.method(globalThis, "fetch", () => new Promise<Response>((resolve) => pending.push(resolve)));
  const store = useServices.getState();
  store.start("alice");
  store.start("alice");
  assert.equal(pending.length, 1, "starting twice for the same account shares the request");
  assert.equal(availabilityOf(useServices.getState(), "browser"), "checking");

  store.start("bob");
  assert.equal(pending.length, 2, "an account switch starts its own request");
  pending[1]!(payload([status("browser", "down", "refuses")]));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(availabilityOf(useServices.getState(), "browser"), "down");

  // Alice's answer arrives late and must not replace Bob's.
  pending[0]!(payload([status("browser", "up")]));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(availabilityOf(useServices.getState(), "browser"), "down");
  assert.equal(useServices.getState().accountId, "bob");
});

test("use, dismissal, and recovery flow through the store", async (t) => {
  let respond = async () => payload([status("browser", "down", "refuses"), status("sandbox", "down")]);
  t.mock.method(globalThis, "fetch", () => respond());
  const store = useServices.getState();
  store.start("alice");
  await new Promise((resolve) => setTimeout(resolve, 0));
  store.markUsed("browser");
  assert.deepEqual(noticeServices(useServices.getState()).map((entry) => entry.id), ["browser"]);
  store.dismiss(["browser"]);
  assert.deepEqual(noticeServices(useServices.getState()), []);

  // A later refresh that finds it up clears the dismissal for the next outage.
  respond = async () => payload([status("browser", "up"), status("sandbox", "down")]);
  await useServices.getState().refresh(true);
  assert.deepEqual(useServices.getState().dismissed, {});
  assert.deepEqual(noticeServices(useServices.getState()), []);
});

test("a burst of forced refreshes is throttled on the client, not only by single-flight", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return payload([status("browser", "down")]);
  });
  const store = useServices.getState();
  store.start("alice");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  await store.refresh(true);
  assert.equal(calls, 2, "the first forced refresh reaches the server");
  await store.refresh(true);
  await store.refresh(true);
  assert.equal(calls, 2, "a burst of failed actions shares the cooldown");
});

test("a failed health request keeps the last answer and never invents an outage", async (t) => {
  let respond = async () => payload([status("browser", "down")]);
  t.mock.method(globalThis, "fetch", () => respond());
  useServices.getState().start("alice");
  await new Promise((resolve) => setTimeout(resolve, 0));
  respond = async () => new Response("nope", { status: 500 });
  await useServices.getState().refresh(true);
  assert.equal(availabilityOf(useServices.getState(), "browser"), "down", "the previous status is still shown");
  assert.equal(useServices.getState().error, true);
});
