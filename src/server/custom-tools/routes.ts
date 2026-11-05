import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Json, ChatReview, RunView, SecretPatch, ToolWrite } from "../../shared/custom-tools.js";
import { CUSTOM_LIMITS, parseToolJson, utf8Bytes, validRequestId, validateSecretPatch } from "../../shared/custom-tools.js";
import type { AppEnv } from "../auth.js";
import { domainHmac } from "../crypto.js";
import { AppError } from "../errors.js";
import { assertFeature, requireFeature } from "../permissions/guard.js";
import { assertServiceAvailable } from "../services.js";
import { sandboxConfigured } from "../sandbox-client.js";
import {
  abortExecution,
  approvedInvocation,
  executePrepared,
  prepareExecution,
  testReview,
  validateToolInput,
  type AcceptedRuntime,
} from "./execute.js";
import {
  cleanupItems,
  createTool,
  deleteTool,
  detailOf,
  listRuns,
  listTools,
  makeRunToken,
  preparedInput,
  notFound,
  reviewOf,
  runRow,
  runView,
  setEnabled,
  testExecutionKey,
  toolRow,
  tokenMatches,
  updateTool,
  cancelRun,
} from "./store.js";

// Authenticated management and workspace-test API. Bodies are strict JSON with duplicate-key rejection
// and are capped while streaming, before any parse. Every owner query is scoped to the session user.

const MAX_MANAGEMENT = 128 * 1024;
const MAX_TEST = 24 * 1024;
const ID = /^[A-Za-z0-9_-]{1,100}$/;

const sessionHash = (userId: string, session: string) => domainHmac("custom-tools-session", `${userId}:${session}`);

class InputError extends AppError {
  constructor(message: string, reason = "invalid_json") {
    super({ code: "validation", message, details: { reason } });
  }
}

function isRecord(value: unknown): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBody(c: Context<AppEnv>, maxBytes: number): Promise<Record<string, Json>> {
  if (!(c.req.header("content-type") ?? "").toLowerCase().includes("application/json")) throw new InputError("Use application/json.");
  const text = await c.req.text();
  if (utf8Bytes(text) > maxBytes) throw new InputError("The request is too large.", "too_large");
  const parsed = parseToolJson(text, { maxBytes, maxDepth: 16, maxNodes: 4_096 });
  if (!parsed.ok) throw new InputError("The request is not valid JSON.", parsed.issues[0]!.reason);
  if (!isRecord(parsed.value)) throw new InputError("The request must be a JSON object.");
  return parsed.value;
}

function unknownFields(body: Record<string, Json>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) if (!allowed.includes(key)) throw new InputError("Unknown request field.");
}

function revision(value: Json | undefined): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > CUSTOM_LIMITS.revisionMax) throw new InputError("Invalid revision.");
  return value;
}

function idParam(value: string): string {
  if (!ID.test(value)) throw notFound();
  return value;
}

function toolWrite(value: Json | undefined): ToolWrite {
  // validateToolWrite is authoritative; the wire only needs to be an object.
  if (!isRecord(value)) throw new InputError("A tool definition is required.");
  return value as unknown as ToolWrite;
}

function secretsOf(body: Record<string, Json>, optional: boolean): SecretPatch | undefined {
  if (!Object.hasOwn(body, "secrets") || body.secrets === undefined) {
    if (optional) return undefined;
    throw new InputError("Secrets are required.");
  }
  const parsed = validateSecretPatch(body.secrets);
  if (!parsed.ok) throw new InputError("The secrets are invalid.", parsed.issues[0]!.reason);
  return parsed.value;
}

const missingTool = () => notFound();

/** The tool row at the caller's current revision, or the CAS error. */
function currentRow(userId: string, id: string, expected: number) {
  const row = toolRow(userId, id);
  if (!row) throw missingTool();
  if (row.revision !== expected) throw new AppError({ code: "conflict", message: "This tool changed. Reload it before saving.", details: { reason: "definition_changed", revision: row.revision } });
  return row;
}

function assertTestReady(userId: string, modelRef: string | null, toolId: string, expectedRevision: number, runtime: AcceptedRuntime): () => void {
  return () => {
    assertFeature({ userId, modelRef }, "customTools");
    const row = toolRow(userId, toolId);
    if (!row || row.revision !== expectedRevision) throw new AppError({ code: "conflict", message: "This tool changed. Reload it before testing.", details: { reason: "definition_changed" } });
    if (row.kind === "python") {
      assertFeature({ userId, modelRef }, "code");
      if (!sandboxConfigured()) throw new AppError({ code: "service_unavailable", message: "The sandbox is unavailable, so the function did not run.", details: { reason: "sandbox_unavailable" } });
    }
  };
}

async function runTest(c: Context<AppEnv>, runtime: AcceptedRuntime) {
  const user = c.get("user");
  const toolId = idParam(c.req.param("id") ?? "");
  const body = await readBody(c, MAX_TEST);
  unknownFields(body, ["expectedRevision", "input", "requestId"]);
  const expected = revision(body.expectedRevision);
  const row = currentRow(user.id, toolId, expected);
  if (typeof body.requestId !== "string" || !validRequestId(body.requestId)) throw new InputError("Invalid request id.");
  const requestId = body.requestId;
  const session = sessionHash(user.id, c.get("session"));
  const input = validateToolInput(row, body.input);
  const executionKey = testExecutionKey(session, requestId);
  if (row.kind === "python") {
    const prepared = prepareExecution({ userId: user.id, row, input, source: "test", executionKey, sessionHash: session, tokenHash: null });
    const result = await executePrepared({
      actor: { userId: user.id },
      runId: prepared.row.id,
      input: prepared.input,
      runtime,
      executionKey,
      sessionHash: session,
      requestHash: prepared.requestHash,
      assertReady: assertTestReady(user.id, null, toolId, expected, runtime),
    });
    const run = runRow(user.id, prepared.row.id);
    if (!run) throw notFound();
    return c.json({ run: runView(run, true) }, 200);
  }
  // HTTP test: prepare a review, send nothing. The token is returned once, never from a GET.
  const token = makeRunToken();
  const prepared = prepareExecution({ userId: user.id, row, input, source: "test", executionKey, sessionHash: session, tokenHash: token.hash });
  if (prepared.replayed) {
    const run = runRow(user.id, prepared.row.id);
    if (run && ["succeeded", "failed", "cancelled", "unknown"].includes(run.state)) return c.json({ run: runView(run, true) }, 200);
    throw new AppError({ code: "conflict", message: "This review is already prepared. Use a new request id.", details: { reason: "review_exists" } });
  }
  const review = reviewOf(user.id, prepared.row.id);
  if (!review) throw new InputError("The review could not be prepared.");
  return c.json({ review: testReview(prepared.row, review, token.token) }, 202);
}

export const customToolRoutes = new Hono<AppEnv>()
  .use("*", async (c, next) => {
    if ([...new URL(c.req.url).searchParams.keys()].length) throw new InputError("Unknown query parameter.");
    await next();
  })
  .post("/:id/test/execute", bodyLimit({ maxSize: MAX_TEST, onError: (c) => c.json({ error: "Request is too large." }, 413) }), requireFeature("customTools"), async (c) => {
    const user = c.get("user");
    const toolId = idParam(c.req.param("id"));
    const body = await readBody(c, MAX_TEST);
    unknownFields(body, ["runId", "token"]);
    if (typeof body.runId !== "string" || !ID.test(body.runId) || typeof body.token !== "string" || body.token.length < 20 || body.token.length > 200) {
      throw new InputError("Invalid review reference.");
    }
    const run = runRow(user.id, body.runId);
    if (!run || run.tool_id !== toolId || run.source !== "test") throw notFound();
    const session = sessionHash(user.id, c.get("session"));
    if (run.session_hash !== session) throw new AppError({ code: "forbidden", message: "This review belongs to another session.", details: { reason: "approval_session" } });
    if (["succeeded", "failed", "cancelled", "unknown"].includes(run.state)) return c.json({ run: runView(run, true) });
    if (run.state === "expired") throw new AppError({ code: "conflict", status: 410, message: "This review expired. Prepare a new test.", details: { reason: "approval_expired" } });
    if (run.state === "denied") throw new AppError({ code: "conflict", message: "This review was denied.", details: { reason: "approval_denied" } });
    if (!tokenMatches(run.token_hash, body.token)) throw new AppError({ code: "forbidden", message: "This review token is not valid.", details: { reason: "approval_token" } });
    if (run.expires_at <= Date.now()) throw new AppError({ code: "conflict", status: 410, message: "This review expired. Prepare a new test.", details: { reason: "approval_expired" } });
    const row = toolRow(user.id, run.tool_id);
    if (!row || row.revision !== run.revision) throw new AppError({ code: "conflict", message: "The tool changed. Review its current revision before running it.", details: { reason: "definition_changed" } });
    const input = validateToolInput(row, preparedInput(user.id, run.id));
    const result = await executePrepared({
      actor: { userId: user.id },
      runId: run.id,
      input,
      runtime: "workspaceTest",
      executionKey: run.execution_key,
      sessionHash: session,
      requestHash: run.request_hash,
      approvedInvocation: approvedInvocation(run.id, run.request_hash, run.revision),
      assertReady: assertTestReady(user.id, null, run.tool_id, run.revision, "workspaceTest"),
    });
    const finished = runRow(user.id, run.id);
    if (!finished) throw notFound();
    return c.json({ run: runView(finished, true) });
  })
  .get("/cleanup", async (c) => c.json({ items: cleanupItems(c.get("user").id) }))
  .get("/", requireFeature("customTools"), (c) => c.json({ items: listTools(c.get("user").id) }))
  .post("/", requireFeature("customTools"), bodyLimit({ maxSize: MAX_MANAGEMENT, onError: (c) => c.json({ error: "Request is too large." }, 413) }), async (c) => {
    const body = await readBody(c, MAX_MANAGEMENT);
    unknownFields(body, ["tool", "secrets"]);
    const secrets = secretsOf(body, true);
    if (secrets && secrets.remove.length) throw new InputError("A new tool cannot remove secrets.");
    const created = createTool(c.get("user").id, toolWrite(body.tool), secrets);
    return c.json({ tool: { ...created, lastRun: created.lastRun } }, 201);
  })
  .post("/:id/test", requireFeature("customTools"), bodyLimit({ maxSize: MAX_TEST, onError: (c) => c.json({ error: "Request is too large." }, 413) }), (c) => runTest(c, "workspaceTest"))
  .get("/:id/runs/:runId/review", requireFeature("customTools"), (c) => {
    const user = c.get("user");
    const toolId = idParam(c.req.param("id"));
    const runId = idParam(c.req.param("runId"));
    const run = runRow(user.id, runId);
    if (!run || run.tool_id !== toolId) throw notFound();
    if (run.session_hash !== sessionHash(user.id, c.get("session"))) throw new AppError({ code: "forbidden", message: "This review belongs to another session.", details: { reason: "approval_session" } });
    if (run.state === "expired" || run.expires_at <= Date.now()) throw new AppError({ code: "conflict", status: 410, message: "This review expired. Prepare a new request.", details: { reason: "approval_expired" } });
    const review = reviewOf(user.id, runId);
    if (!review) throw new AppError({ code: "conflict", status: 409, message: "This review is no longer available.", details: { reason: "definition_changed" } });
    return c.json({ review });
  })
  .get("/:id/runs/:runId", requireFeature("customTools"), (c) => {
    const user = c.get("user");
    const runId = idParam(c.req.param("runId"));
    const run = runRow(user.id, runId);
    if (!run || run.tool_id !== idParam(c.req.param("id"))) throw notFound();
    return c.json({ run: runView(run, true) });
  })
  .post("/:id/runs/:runId/cancel", requireFeature("customTools"), bodyLimit({ maxSize: MAX_TEST, onError: (c) => c.json({ error: "Request is too large." }, 413) }), async (c) => {
    const user = c.get("user");
    const toolId = idParam(c.req.param("id"));
    const runId = idParam(c.req.param("runId"));
    await readBody(c, MAX_TEST);
    const run = runRow(user.id, runId);
    if (!run || run.tool_id !== toolId) throw notFound();
    const updated = cancelRun(user.id, runId);
    if (!updated) throw notFound();
    // A live execution is stopped where it runs; the executor then records the cancelled terminal state.
    abortExecution(runId);
    return c.json({ run: updated });
  })
  .get("/:id/runs", requireFeature("customTools"), (c) => {
    const user = c.get("user");
    const toolId = idParam(c.req.param("id"));
    if (!toolRow(user.id, toolId)) throw notFound();
    return c.json({ items: listRuns(user.id, toolId) });
  })
  .get("/:id", requireFeature("customTools"), (c) => {
    const user = c.get("user");
    const row = toolRow(user.id, idParam(c.req.param("id")));
    if (!row) throw notFound();
    const detail = detailOf(row);
    if (!detail) throw new AppError({ code: "validation", status: 409, message: "This tool's stored definition is invalid. Delete it and create a new one.", details: { reason: "definition_invalid" } });
    return c.json({ tool: detail });
  })
  .put("/:id", requireFeature("customTools"), bodyLimit({ maxSize: MAX_MANAGEMENT, onError: (c) => c.json({ error: "Request is too large." }, 413) }), async (c) => {
    const user = c.get("user");
    const toolId = idParam(c.req.param("id"));
    const body = await readBody(c, MAX_MANAGEMENT);
    unknownFields(body, ["expectedRevision", "tool", "secrets"]);
    const updated = updateTool(user.id, toolId, revision(body.expectedRevision), toolWrite(body.tool), secretsOf(body, true));
    return c.json({ tool: updated });
  })
  .patch("/:id/enabled", requireFeature("customTools"), bodyLimit({ maxSize: MAX_TEST, onError: (c) => c.json({ error: "Request is too large." }, 413) }), async (c) => {
    const user = c.get("user");
    const body = await readBody(c, MAX_TEST);
    unknownFields(body, ["expectedRevision", "enabled"]);
    if (typeof body.enabled !== "boolean") throw new InputError("Invalid enabled value.");
    const summary = setEnabled(user.id, idParam(c.req.param("id")), revision(body.expectedRevision), body.enabled);
    return c.json({ tool: summary });
  })
  // Deletion stays available when customTools is denied: a user must be able to remove stored data.
  .delete("/:id", bodyLimit({ maxSize: MAX_TEST, onError: (c) => c.json({ error: "Request is too large." }, 413) }), async (c) => {
    const user = c.get("user");
    const body = await readBody(c, MAX_TEST);
    unknownFields(body, ["expectedRevision"]);
    deleteTool(user.id, idParam(c.req.param("id")), revision(body.expectedRevision));
    return c.body(null, 204);
  });
