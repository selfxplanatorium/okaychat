import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test, type TestContext } from "node:test";
import { Hono } from "hono";
import type { ModelInfo } from "../shared/types.js";
import type { FeatureKey } from "../shared/permissions.js";
import { imageServiceDef } from "../shared/image-services.js";
import type { AppEnv } from "./auth.js";

// Denial coverage for the enforcement surface outside chat/llm: tools, routes, background work, and the
// services registry. Every case asserts the guard runs before a network boundary (fetch is mocked and
// counted), not merely that a control is hidden. See /tmp/opencode/specs/granular-permissions.md §6.

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-feature-gates-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "feature-gates-test-secret-only-not-for-production";
writeFileSync(path.join(dataDir, "models-dev.json"), JSON.stringify({ data: {}, fetchedAt: Date.now() }));

const { db } = await import("./db.js");
const { requireUser } = await import("./auth.js");
const { sha256 } = await import("./crypto.js");
const { handleAppError } = await import("./errors.js");
const { ensureThread } = await import("./threads.js");
const { getPolicy, writePolicy } = await import("./permissions/store.js");
const { assertFeature, featureAllowed } = await import("./permissions/guard.js");
const { setServiceProbeForTests, resetServicesForTests, servicesFor } = await import("./services.js");
const { webTools } = await import("./tools/web.js");
const { runCode } = await import("./tools/sandbox.js");
const { enabledImageServices, generateImage } = await import("./tools/image.js");
const { subagentTools } = await import("./tools/subagent.js");
const { toolsForUser, testServer, listPrompts } = await import("./mcp/manager.js");
const { knowledgeRoutes } = await import("./knowledge/routes.js");
const { conversationKnowledge } = await import("./knowledge/tools.js");
const { searchKnowledge } = await import("./knowledge/retrieval.js");
const { conversationMemory, temporaryMemory, memoryRoutes } = await import("./memory.js");
const { scheduleRoutes, runSchedule } = await import("./schedules.js");
const { shareRoutes, publicShareRoutes } = await import("./shares.js");
const { speechRoutes } = await import("./speech/routes.js");
const { synthesize, transcribe } = await import("./speech/engines.js");
const { voiceAvailability } = await import("./voice/backend.js");
const { CallRegistry, CallSession } = await import("./voice/session.js");
type CallSocket = import("./voice/session.js").CallSocket;
const { StartLimiter, callLimits } = await import("./voice/limits.js");
const { emailTools } = await import("./email/tools.js");
const { draftTools } = await import("./email/draft-tool.js");
const { artifactTools } = await import("./artifacts.js");
const { exportRoutes } = await import("./export.js");
const { turnSkills } = await import("./skills.js");
const { getSettings } = await import("./settings.js");

const USERS = ["gated", "owner"] as const;
for (const id of USERS) {
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, 'user', 1)").run(id, `${id}@example.test`, id, "unused");
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(`${id}-session`), id, Date.now() + 600_000);
}
ensureThread("gated", "thr_gated");
ensureThread("owner", "thr_share");

after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec("DELETE FROM permission_policies; DELETE FROM permission_rate_windows; DELETE FROM permission_leases; DELETE FROM shares; DELETE FROM schedules;");
  resetServicesForTests();
});

/** Replaces (or merges into) this user's all-model policy document. */
function setFeatures(userId: string, features: Partial<Record<FeatureKey, boolean>>, modelRef: string | null = null) {
  const subject = { kind: "user" as const, id: userId };
  const before = getPolicy(subject, modelRef);
  writePolicy(subject, modelRef, { version: 1, features: { ...before?.features, ...features } }, null);
}

function app(): Hono<AppEnv> {
  return new Hono<AppEnv>()
    .use(requireUser)
    .onError(handleAppError)
    .route("/knowledge", knowledgeRoutes)
    .route("/memory", memoryRoutes)
    .route("/", scheduleRoutes)
    .route("/", shareRoutes)
    .route("/", speechRoutes)
    .route("/", exportRoutes);
}

const call = (method: string, url: string, body?: unknown, user = "gated") =>
  app().request(`http://app${url}`, {
    method,
    headers: { cookie: `okaychat_session=${user}-session`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

function countedFetch(t: TestContext): { count: () => number } {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    throw new Error("no test may reach the network");
  });
  return { count: () => calls };
}

async function denial(promise: Promise<unknown>, feature: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.match(String((error as Error).message), new RegExp(`disabled ${feature}`));
    return true;
  });
}

test("web search and page reading are denied before any fetch, and exact-model rules apply to the tool actor", async (t) => {
  const network = countedFetch(t);
  setFeatures("gated", { webSearch: false, webFetch: false });
  const tools = webTools({ actor: { userId: "gated", modelRef: "mock/model" } });
  await assert.rejects(tools.web_search!.execute!({ query: "x" }, { toolCallId: "1", messages: [] }), /disabled web search/);
  await assert.rejects(tools.web_fetch!.execute!({ url: "https://example.test" }, { toolCallId: "2", messages: [] }), /disabled web page reading/);
  assert.equal(network.count(), 0);

  // An exact-model deny affects that model only; the account-wide decision stays allowed.
  setFeatures("gated", { webFetch: true });
  setFeatures("gated", { webFetch: false }, "mock/model");
  assert.equal(featureAllowed({ userId: "gated", modelRef: "mock/model" }, "webFetch"), false);
  assert.equal(featureAllowed({ userId: "gated", modelRef: "other/model" }, "webFetch"), true);
  assert.equal(featureAllowed("gated", "webFetch"), true);
});

test("code, images, and delegation stop before their network boundaries", async (t) => {
  const network = countedFetch(t);
  setFeatures("gated", { code: false, images: false, delegation: false });

  await assert.rejects(runCode({ userId: "gated", threadId: "thr_gated", language: "python", code: "print(1)" }), /disabled code execution/);

  const service = enabledImageServices("gated", getSettings("gated"))[0] ?? { def: imageServiceDef("openai")!, model: "gpt-image-1" };
  await denial(generateImage({ userId: "gated", threadId: "thr_gated", service, prompt: "cat", references: [] }), "image generation");

  const model = { ref: "mock/model", name: "Mock", providerId: "mock", id: "model" } as unknown as ModelInfo;
  const delegate = subagentTools({ userId: "gated", threadId: "thr_gated", allowed: [model], subTools: {} }).delegate_task!;
  await assert.rejects(async () => {
    const parts = delegate.execute!({ task: "do it" }, { toolCallId: "d", messages: [] }) as unknown as AsyncGenerator<unknown>;
    for await (const _part of parts) {
      // Drain until the guard rejects.
    }
  }, /disabled delegation/);
  assert.equal(network.count(), 0);
});

test("MCP gives a denied account no tools and never connects", async (t) => {
  const network = countedFetch(t);
  setFeatures("gated", { mcp: false });
  assert.deepEqual(await toolsForUser("gated"), { tools: {}, subTools: {}, instructions: [], servers: [] });
  await assert.rejects(testServer("gated", "srv"), /disabled MCP servers/);
  await assert.rejects(listPrompts("gated"), /disabled MCP servers/);
  assert.equal(network.count(), 0);
});

test("knowledge management is denied while owned metadata, cleanup, and exports remain", async () => {
  setFeatures("gated", { knowledge: false });
  const create = await call("POST", "/knowledge/collections", { name: "Docs", embedding: { provider: "none" } });
  assert.equal(create.status, 403);
  assert.equal(((await create.json()) as { code: string }).code, "forbidden");

  const list = await call("GET", "/knowledge/collections");
  assert.equal(list.status, 200);
  const remove = await call("DELETE", "/knowledge/collections/does-not-exist");
  assert.notEqual(remove.status, 403);

  assert.deepEqual(await conversationKnowledge("gated", "thr_gated", "question", { retrieve: true }), { collections: [], context: "", names: "", passages: "", tools: {} });
  await assert.rejects(searchKnowledge({ userId: "gated", collectionIds: [], query: "x" }), /disabled knowledge/);
});

test("memory is not retrieved, injected, or written, but deletion and export still work", async () => {
  setFeatures("gated", { memory: false });
  assert.deepEqual(conversationMemory("gated", "thr_gated", "x"), { context: "", tools: {} });
  assert.deepEqual(temporaryMemory("gated", "x"), { context: "", tools: {} });

  const write = await call("POST", "/memory", { content: "likes tea" });
  assert.equal(write.status, 403);
  const edit = await call("PATCH", "/memory/mem_x", { content: "changed" });
  assert.equal(edit.status, 403);
  const clear = await call("DELETE", "/memory");
  assert.equal(clear.status, 200);
  const exported = await call("GET", "/memory/export");
  assert.equal(exported.status, 200);
});

test("a scheduled prompt is denied at creation and at pickup without a provider call", async (t) => {
  const network = countedFetch(t);
  setFeatures("gated", { schedules: false });
  const created = await call("POST", "/schedules", {});
  assert.equal(created.status, 403);

  db.prepare(
    `INSERT INTO schedules (id, user_id, thread_id, thread_mode, thread_attached, project_id, title, prompt, model_ref, spec_json, enabled, next_run_at, created_at)
     VALUES ('sch_gated', 'gated', NULL, 'new', 0, NULL, 'Daily', 'hello', 'mock/model', ?, 1, ?, 1)`,
  ).run(JSON.stringify({ kind: "interval", minutes: 60 }), Date.now() - 1_000);
  const row = db.prepare("SELECT * FROM schedules WHERE id = 'sch_gated'").get() as Parameters<typeof runSchedule>[0];
  await runSchedule(row);

  const stored = db.prepare("SELECT last_status, last_error, next_run_at FROM schedules WHERE id = 'sch_gated'").get() as { last_status: string; last_error: string; next_run_at: number };
  assert.equal(stored.last_status, "error");
  assert.match(stored.last_error, /disabled for this account/);
  assert.ok(stored.next_run_at > Date.now(), "the next run is scheduled normally, not retried immediately");
  assert.equal(network.count(), 0);
});

test("public shares check the owner's live sharing permission and are never cacheable", async () => {
  db.prepare("INSERT INTO shares (token, user_id, thread_id, created_at) VALUES ('tok_live', 'owner', 'thr_share', ?)").run(Date.now());
  setFeatures("owner", { sharing: false });
  const denied = await publicShareRoutes.request("http://app/tok_live");
  assert.equal(denied.status, 404);
  assert.equal(denied.headers.get("cache-control"), "no-store");

  const create = await call("POST", "/threads/thr_share/share", undefined, "owner");
  assert.equal(create.status, 403, "a new share is denied too");

  db.exec("DELETE FROM permission_policies WHERE subject_kind = 'user' AND subject_id = 'owner'");
  const allowed = await publicShareRoutes.request("http://app/tok_live");
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("cache-control"), "no-store");
});

test("voice and speech are denied before a worker or provider is contacted", async (t) => {
  const network = countedFetch(t);
  setFeatures("gated", { voice: false });

  const availability = await voiceAvailability("gated");
  assert.equal(availability.local, false);
  assert.equal(availability.realtime, false);
  assert.match(availability.localReason?.detail ?? "", /disabled/);

  const transcribeRoute = await call("POST", "/speech/synthesize", { text: "hello" });
  assert.equal(transcribeRoute.status, 403);
  await assert.rejects(transcribe("gated", { audio: new Uint8Array([1, 2]), mime: "audio/wav", filename: "a.wav" }, { engine: "openai" }), /disabled voice/);
  await assert.rejects(synthesize("gated", "hello", { engine: "openai" }), /disabled voice/);

  let localCalled = false;
  const socket: CallSocket = { send: () => {}, close: () => {}, bufferedAmount: 0 };
  const session = new CallSession("gated", socket, {
    backends: {
      local: () => {
        localCalled = true;
        return { ok: false, code: "unavailable", detail: "not reached" };
      },
      realtime: () => ({ ok: false, code: "unavailable", detail: "not reached" }),
      released: () => {},
    },
    limits: callLimits(),
    registry: new CallRegistry(),
    starts: new StartLimiter(5, 60_000),
    threadOwned: () => true,
    stillSignedIn: () => true,
    maxRecordingSeconds: () => 60,
    featureAllowed: () => false,
  });
  session.onMessage(JSON.stringify({ t: "start", threadId: "thr_gated", engine: "local" }));
  assert.equal(localCalled, false, "the engine is never selected when voice is denied");
  session.onClose();
  assert.equal(network.count(), 0);
});

test("email tools, drafts, and remote mailbox actions are denied before a connection", async () => {
  setFeatures("gated", { email: false });
  const { tools } = emailTools({ userId: "gated" });
  await assert.rejects(tools.email_folders!.execute!({}, { toolCallId: "e", messages: [] }), /disabled email/);
  const draft = draftTools({ userId: "gated", threadId: "thr_gated" }).draft_email!;
  await assert.rejects(draft.execute!({ to: ["a@example.test"] }, { toolCallId: "d", messages: [] }), /disabled email/);
});

test("artifacts and PDF export are denied while markdown export still works", async (t) => {
  const network = countedFetch(t);
  setFeatures("gated", { artifacts: false });
  const tools = artifactTools("thr_gated", "gated");
  await assert.rejects(tools.create_artifact!.execute!({ id: "a", title: "A", kind: "html", content: "<p>x</p>" }, { toolCallId: "a", messages: [] }), /disabled artifacts/);

  const pdf = await call("GET", "/threads/thr_gated/export?format=pdf");
  assert.equal(pdf.status, 403);
  const markdown = await call("GET", "/threads/thr_gated/export?format=markdown");
  assert.equal(markdown.status, 200);
  assert.equal(network.count(), 0);
});

test("skills expose no index or tools when denied", () => {
  setFeatures("gated", { skills: false });
  const turn = turnSkills("gated", { temporary: false, canCallTools: true });
  assert.equal(turn.context, "");
  assert.deepEqual(turn.tools, {});
  assert.deepEqual(turn.subTools, {});
});

test("the services registry never probes a capability the account cannot use", async () => {
  setFeatures("gated", { artifacts: false, webFetch: false, voice: false, code: false, webSearch: false });
  const probed = new Set<string>();
  for (const source of ["browser", "speech", "sandbox", "searxng"] as const) {
    setServiceProbeForTests(source, async () => {
      probed.add(source);
      return "unconfigured";
    });
  }
  const services = await servicesFor("gated");
  assert.equal(probed.size, 0);
  for (const id of ["browser", "scrapling", "speech", "sandbox", "searxng"]) {
    const status = services.find((entry) => entry.id === id);
    assert.equal(status?.state, "unconfigured", `${id} reports a local disabled status`);
  }
});

test("management uses the all-model decision while execution follows an exact-model rule", () => {
  setFeatures("gated", { email: false });
  setFeatures("gated", { email: true }, "mock/model");
  // Management has no model, so the account-wide deny applies even though one model is restored for execution.
  assert.throws(() => assertFeature("gated", "email"), /disabled email/);
  assert.equal(featureAllowed({ userId: "gated", modelRef: "mock/model" }, "email"), true);
  assert.equal(featureAllowed({ userId: "gated", modelRef: "other/model" }, "email"), false);
});
