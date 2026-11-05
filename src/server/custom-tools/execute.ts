import type { Json, Method, ReviewHeader, RunErrorCode, TestReview, ToolResult, ChatReview } from "../../shared/custom-tools.js";
import {
  CUSTOM_LIMITS,
  OUTPUT_JSON_LIMITS,
  canonicalJson,
  headerValues,
  parseToolJson,
  redactResult,
  resolveHttpRequest,
  reviewHeaders,
  runError,
  utf8Bytes,
  validateInput,
  validateJsonValue,
} from "../../shared/custom-tools.js";
import { sha256 } from "../crypto.js";
import { AppError } from "../errors.js";
import { publicFetch, readCapped } from "../public-fetch.js";
import { reserveOperation } from "../permissions/limits.js";
import { assertFeature } from "../permissions/guard.js";
import { scanForInjection } from "../prompt-injection.js";
import { runSandboxFunction } from "../sandbox-client.js";
import {
  claimRun,
  configBundle,
  decryptSecrets,
  denyRun,
  expireRun,
  finishRun,
  prepareRun,
  reviewOf,
  runByExecutionKey,
  runView,
  toolRow,
  type RunRow,
  type ToolRow,
} from "./store.js";

// Execution for one custom tool. Python never leaves the sandbox. HTTP always uses the address-checked
// publicFetch and a server-owned approval capability. Definitions are bound to the revision the caller
// admitted; an edit in the meantime changes the tool key and invalidates prepared work.

const INVOCATION_BRAND = Symbol("custom-tool-invocation");
export interface ApprovedInvocation {
  readonly runId: string;
  readonly requestHash: string;
  readonly revision: number;
  readonly [INVOCATION_BRAND]: true;
}

export function approvedInvocation(runId: string, requestHash: string, revision: number): ApprovedInvocation {
  return { runId, requestHash, revision, [INVOCATION_BRAND]: true };
}

export function isApprovedInvocation(value: unknown): value is ApprovedInvocation {
  return !!value && typeof value === "object" && (value as Record<PropertyKey, unknown>)[INVOCATION_BRAND] === true;
}

export interface ExecutionDeps {
  fetch?: typeof fetch;
  sandbox?: typeof runSandboxFunction;
  now?: () => number;
}

let deps: ExecutionDeps = {};
/** Test seam: injected transport and clock. Production uses publicFetch and the sandbox worker. */
export function setExecutionDeps(next: ExecutionDeps | null): void {
  deps = next ?? {};
}
// The executor registers a controller per running id so a cancel request arriving from another
// connection can stop the live fetch or sandbox call; a cancel for a queued or finished run is a no-op.
const activeExecutions = new Map<string, AbortController>();
export function abortExecution(runId: string): void {
  activeExecutions.get(runId)?.abort(new Error("cancelled"));
}
const now = () => (deps.now ?? Date.now)();
const fetcher = (): typeof fetch => deps.fetch ?? publicFetch;
const sandbox = () => deps.sandbox ?? runSandboxFunction;

export function inputHashOf(input: Json): string {
  return sha256(canonicalJson(input));
}

export function inputBytesOf(input: Json): number {
  return utf8Bytes(canonicalJson(input));
}

function requestHashFor(row: ToolRow, input: Json, expanded?: { method: Method; url: string; headers: ReviewHeader[]; body: string | null }): string {
  const config = configBundle(row)?.config;
  const parts = [row.id, String(row.revision), canonicalJson(input), sha256(row.config_enc), sha256(row.secrets_enc)];
  if (expanded) {
    parts.push(expanded.method, expanded.url, canonicalJson({ headers: expanded.headers } as unknown as Json), expanded.body ?? "");
  } else if (config?.kind === "python") {
    parts.push(sha256(config.code), String(config.timeoutMs));
  }
  return sha256(parts.join("\n"));
}

export interface PreparedHttp {
  review: ChatReview;
  requestHash: string;
  inputHash: string;
  inputBytes: number;
}

export function prepareHttpReview(row: ToolRow, input: Json): PreparedHttp {
  const bundle = configBundle(row);
  if (!bundle || bundle.config.kind !== "http") throw new AppError({ code: "validation", message: "This is not an HTTP tool.", details: { reason: "invalid_schema" } });
  const request = resolveHttpRequest(bundle.config, bundle.schema, input);
  if (!request.ok) throw new AppError({ code: "validation", message: "The request cannot be built from this input.", details: { reason: request.issues[0]!.reason, path: request.issues[0]!.path } });
  const headers = reviewHeaders(request.value.headers);
  const requestHash = requestHashFor(row, input, { method: request.value.method, url: request.value.url, headers, body: request.value.body });
  return {
    review: {
      runId: "",
      toolId: row.id,
      revision: row.revision,
      expiresAt: now() + CUSTOM_LIMITS.approvalTtlMs,
      method: request.value.method,
      url: request.value.url,
      headers,
      body: request.value.body,
      warning: request.value.warning,
    },
    requestHash,
    inputHash: inputHashOf(input),
    inputBytes: inputBytesOf(input),
  };
}

export function pythonRequestHash(row: ToolRow, input: Json): string {
  return requestHashFor(row, input);
}

/** Validate the runtime value against the stored schema. Neither path trusts a client-side check. */
export function validateToolInput(row: ToolRow, input: unknown): Json {
  const bundle = configBundle(row);
  if (!bundle) throw new AppError({ code: "validation", message: "This tool definition is invalid.", details: { reason: "definition_invalid" } });
  const prepared = validateJsonValue(input, OUTPUT_JSON_LIMITS);
  if (!prepared.ok) throw new AppError({ code: "validation", message: "The input is not valid JSON.", details: { reason: prepared.issues[0]!.reason, path: prepared.issues[0]!.path } });
  const validated = validateInput(bundle.schema, prepared.value);
  if (!validated.ok) throw new AppError({ code: "validation", message: "The input does not match this tool's schema.", details: { reason: validated.issues[0]!.reason, path: validated.issues[0]!.path } });
  if (inputBytesOf(validated.value) > CUSTOM_LIMITS.inputBytes) throw new AppError({ code: "validation", message: "The input is too large.", details: { reason: "too_large" } });
  return validated.value;
}

export type AcceptedRuntime = "interactiveChat" | "workspaceTest";

function resultOf(row: RunRow): ToolResult {
  const view = runView(row, true);
  const injection = view.result !== null ? scanForInjection(canonicalJson(view.result)) : undefined;
  return {
    toolId: row.tool_id,
    name: toolRow(row.user_id, row.tool_id)?.name ?? "custom tool",
    revision: row.revision,
    runId: row.id,
    ok: view.state === "succeeded",
    value: view.result,
    error: view.error,
    durationMs: view.durationMs ?? 0,
    httpStatus: row.http_status,
    ...(injection?.flagged ? { injection } : {}),
  };
}

function errorResult(tool: Pick<ToolRow, "id" | "revision"> & { name?: string }, code: RunErrorCode, runId = "", durationMs = 0): ToolResult {
  return {
    toolId: tool.id,
    name: tool.name ?? "custom tool",
    revision: tool.revision,
    runId,
    ok: false,
    value: null,
    error: runError(code),
    durationMs,
    httpStatus: null,
  };
}

interface DispatchOutcome {
  state: "succeeded" | "failed" | "cancelled" | "unknown";
  code: RunErrorCode | null;
  value: Json | null;
  outputBytes: number;
  httpStatus: number | null;
  dispatched: boolean;
}

const mediaType = (response: Response): string => (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
const isJsonType = (type: string) => type === "application/json" || /^application\/[a-z0-9.+-]+\+json$/.test(type);
const isTextType = (type: string) => type === "text/plain" || type === "text/csv" || type === "application/json";
const utf8 = (bytes: Uint8Array): string | null => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

async function dispatchHttp(row: ToolRow, input: Json, signal: AbortSignal | undefined): Promise<DispatchOutcome> {
  const bundle = configBundle(row);
  if (!bundle || bundle.config.kind !== "http") return { state: "failed", code: "invalid_result", value: null, outputBytes: 0, httpStatus: null, dispatched: false };
  const request = resolveHttpRequest(bundle.config, bundle.schema, input);
  if (!request.ok) return { state: "failed", code: "invalid_input", value: null, outputBytes: 0, httpStatus: null, dispatched: false };
  // Secrets are decrypted only at dispatch, after every live guard and approval check has passed.
  const secretMap = decryptSecrets(row);
  const secrets = Object.values(secretMap);
  const headers = headerValues(request.value.headers, secretMap);
  if (!headers.ok) return { state: "failed", code: "invalid_result", value: null, outputBytes: 0, httpStatus: null, dispatched: false };
  let headerBytes = 0;
  for (const [name, value] of Object.entries(headers.value)) headerBytes += utf8Bytes(name) + utf8Bytes(value) + 4;
  if (headerBytes > CUSTOM_LIMITS.requestHeadersBytes) return { state: "failed", code: "invalid_result", value: null, outputBytes: 0, httpStatus: null, dispatched: false };
  const timeout = AbortSignal.timeout(bundle.config.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const response = await fetcher()(request.value.url, {
      method: request.value.method,
      headers: headers.value,
      ...(request.value.body !== null ? { body: request.value.body } : {}),
      redirect: "error",
      signal: combined,
    });
    const status = response.status;
    if (status >= 300 && status < 400) {
      await response.body?.cancel().catch(() => {});
      return { state: "failed", code: "redirect_blocked", value: null, outputBytes: 0, httpStatus: status, dispatched: true };
    }
    if (status < 200 || status >= 300) {
      await response.body?.cancel().catch(() => {});
      return { state: "failed", code: "http_status", value: null, outputBytes: 0, httpStatus: status, dispatched: true };
    }
    if (request.value.method === "HEAD" || status === 204 || status === 205) {
      await response.body?.cancel().catch(() => {});
      return { state: "succeeded", code: null, value: null, outputBytes: 0, httpStatus: status, dispatched: true };
    }
    const type = mediaType(response);
    if (bundle.config.response === "json" ? !isJsonType(type) : !isTextType(type)) {
      await response.body?.cancel().catch(() => {});
      return { state: "failed", code: "invalid_result", value: null, outputBytes: 0, httpStatus: status, dispatched: true };
    }
    let bytes: Uint8Array;
    try {
      bytes = await readCapped(response, CUSTOM_LIMITS.outputBytes, "Response too large.");
    } catch {
      if (signal?.aborted) return { state: "cancelled", code: "outcome_unknown", value: null, outputBytes: 0, httpStatus: status, dispatched: true };
      if (timeout.aborted) return { state: "unknown", code: "outcome_unknown", value: null, outputBytes: 0, httpStatus: status, dispatched: true };
      return { state: "failed", code: "response_too_large", value: null, outputBytes: 0, httpStatus: status, dispatched: true };
    }
    const text = utf8(bytes);
    if (text === null) return { state: "failed", code: "invalid_result", value: null, outputBytes: 0, httpStatus: status, dispatched: true };
    let value: Json;
    if (bundle.config.response === "json") {
      const parsed = parseToolJson(text, OUTPUT_JSON_LIMITS);
      if (!parsed.ok) return { state: "failed", code: "invalid_json", value: null, outputBytes: 0, httpStatus: status, dispatched: true };
      value = parsed.value;
    } else {
      value = text;
    }
    // Redact known secrets before persistence, scanning and model delivery; then remeasure.
    const redacted = redactResult(value, secrets);
    if (!redacted.ok) return { state: "failed", code: "invalid_result", value: null, outputBytes: 0, httpStatus: status, dispatched: true };
    const serialized = canonicalJson(redacted.value);
    if (utf8Bytes(serialized) > CUSTOM_LIMITS.outputBytes) return { state: "failed", code: "response_too_large", value: null, outputBytes: 0, httpStatus: status, dispatched: true };
    return { state: "succeeded", code: null, value: redacted.value, outputBytes: utf8Bytes(serialized), httpStatus: status, dispatched: true };
  } catch (error) {
    const message = (error as Error).message ?? "";
    if (/redirect/i.test(message)) return { state: "failed", code: "redirect_blocked", value: null, outputBytes: 0, httpStatus: null, dispatched: true };
    if (signal?.aborted) return { state: "cancelled", code: "outcome_unknown", value: null, outputBytes: 0, httpStatus: null, dispatched: true };
    if (timeout.aborted) return { state: "unknown", code: "outcome_unknown", value: null, outputBytes: 0, httpStatus: null, dispatched: true };
    if (/public internet|blocked/i.test(message)) return { state: "failed", code: "blocked_destination", value: null, outputBytes: 0, httpStatus: null, dispatched: false };
    return { state: "unknown", code: "outcome_unknown", value: null, outputBytes: 0, httpStatus: null, dispatched: true };
  }
}

async function dispatchPython(row: ToolRow, runId: string, input: Json, signal: AbortSignal | undefined): Promise<DispatchOutcome> {
  const bundle = configBundle(row);
  if (!bundle || bundle.config.kind !== "python") return { state: "failed", code: "invalid_result", value: null, outputBytes: 0, httpStatus: null, dispatched: false };
  const result = await sandbox()({ runId, code: bundle.config.code, input: canonicalJson(input), timeoutMs: bundle.config.timeoutMs, signal });
  if (result.stdoutOverflow || result.stderrOverflow) return { state: "failed", code: "response_too_large", value: null, outputBytes: 0, httpStatus: null, dispatched: true };
  if (result.stopped) {
    if (/cancel/i.test(result.stopped)) return { state: "cancelled", code: "cancelled", value: null, outputBytes: 0, httpStatus: null, dispatched: true };
    if (/time/i.test(result.stopped)) return { state: "failed", code: "timeout", value: null, outputBytes: 0, httpStatus: null, dispatched: true };
    return { state: "failed", code: "invalid_result", value: null, outputBytes: 0, httpStatus: null, dispatched: true };
  }
  if (result.exitCode !== 0) return { state: "failed", code: "python_error", value: null, outputBytes: 0, httpStatus: null, dispatched: true };
  const parsed = parseToolJson(result.stdout, OUTPUT_JSON_LIMITS);
  if (!parsed.ok) return { state: "failed", code: "invalid_json", value: null, outputBytes: 0, httpStatus: null, dispatched: true };
  const redacted = redactResult(parsed.value, []);
  if (!redacted.ok) return { state: "failed", code: "invalid_result", value: null, outputBytes: 0, httpStatus: null, dispatched: true };
  const serialized = canonicalJson(redacted.value);
  if (utf8Bytes(serialized) > CUSTOM_LIMITS.outputBytes) return { state: "failed", code: "response_too_large", value: null, outputBytes: 0, httpStatus: null, dispatched: true };
  return { state: "succeeded", code: null, value: redacted.value, outputBytes: utf8Bytes(serialized), httpStatus: null, dispatched: true };
}

function errorCodeOf(error: unknown): RunErrorCode {
  if (error instanceof AppError) {
    if (error.code === "rate_limited") return "rate_limited";
    if (error.code === "service_unavailable") return "service_unavailable";
    if (error.code === "forbidden") return "permission_denied";
    if (error.code === "validation") return "invalid_input";
    if (error.code === "conflict") return "definition_changed";
  }
  const status = (error as { status?: unknown }).status;
  if (status === 429) return "rate_limited";
  if (status === 503) return "service_unavailable";
  return "python_error";
}

export interface ExecutePreparedOptions {
  actor: { userId: string; modelRef?: string | null };
  runId: string;
  input: Json;
  runtime: AcceptedRuntime;
  executionKey: string;
  sessionHash: string;
  requestHash: string;
  approvedInvocation?: ApprovedInvocation;
  signal?: AbortSignal;
  assertReady: () => void;
}

/**
 * The only entrypoint that can run work. A prepared run is claimed in one transaction (rate window, counters,
 * operation lease, running transition), then dispatched. Approval for HTTP is a server-owned capability.
 */
export async function executePrepared(opts: ExecutePreparedOptions): Promise<ToolResult> {
  // The executor enforces the runtime and feature itself, not only the assembly that offered the tool.
  if (opts.runtime !== "interactiveChat" && opts.runtime !== "workspaceTest") return errorResult({ id: "", revision: 0 }, "permission_denied");
  assertFeature(opts.actor, "customTools");
  const run = runByExecutionKey(opts.actor.userId, opts.executionKey);
  if (!run || run.id !== opts.runId) return errorResult({ id: "", revision: 0 }, "definition_changed");
  const tool = toolRow(opts.actor.userId, run.tool_id);
  if (!tool) return errorResult({ id: run.tool_id, revision: run.revision }, "definition_changed");
  if (run.state === "running") throw new AppError({ code: "conflict", status: 409, message: "This execution is already in progress.", details: { reason: "execution_in_progress" } });
  if (["succeeded", "failed", "cancelled", "unknown"].includes(run.state)) return resultOf(run);
  if (run.state === "denied" || run.state === "expired") return errorResult(tool, run.state === "expired" ? "approval_expired" : "approval_denied", run.id);
  if (run.expires_at <= now()) {
    expireRun(opts.actor.userId, run.id);
    return errorResult(tool, "approval_expired", run.id);
  }
  const bundle = configBundle(tool);
  if (!bundle) return errorResult(tool, "disabled", run.id);
  if (bundle.config.kind === "python") {
    try {
      assertFeature(opts.actor, "code");
    } catch {
      // Denying here still releases the prepared row and its quota reservation immediately.
      if (run.state === "prepared") denyRun(opts.actor.userId, run.id);
      return errorResult(tool, "permission_denied", run.id);
    }
  }
  if (bundle.config.kind === "http" && run.source === "chat") {
    if (!isApprovedInvocation(opts.approvedInvocation) || opts.approvedInvocation.runId !== run.id ||
      opts.approvedInvocation.requestHash !== opts.requestHash || opts.approvedInvocation.revision !== run.revision) {
      return errorResult(tool, "approval_required", run.id);
    }
  }
  let release: (() => void) | undefined;
  let activeId: string | undefined;
  try {
    const claim = claimRun(
      { userId: opts.actor.userId, runId: run.id, requestHash: opts.requestHash, sessionHash: opts.sessionHash },
      opts.assertReady,
      () => {
        const lease = reserveOperation(opts.actor, "customTool.run");
        release = lease.release;
        return lease;
      },
      now(),
    );
    const started = now();
    // A running test can be stopped from the workspace; the controller is only reachable by run id.
    const controller = new AbortController();
    const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
    activeId = claim.row.id;
    activeExecutions.set(activeId, controller);
    const outcome = bundle.config.kind === "http"
      ? await dispatchHttp(tool, opts.input, signal)
      : await dispatchPython(tool, run.id, opts.input, signal);
    const finished = finishRun({
      userId: opts.actor.userId,
      runId: claim.row.id,
      state: outcome.state,
      result: outcome.value,
      errorCode: outcome.code,
      outputBytes: outcome.outputBytes,
      httpStatus: outcome.httpStatus,
      dispatched: outcome.dispatched,
      durationMs: now() - started,
    }, now());
    return resultOf(finished);
  } catch (error) {
    if (error instanceof AppError && [403, 409, 410, 429].includes(error.status)) {
      const current = runByExecutionKey(opts.actor.userId, opts.executionKey);
      if (current?.state === "prepared") denyRun(opts.actor.userId, current.id, error.status === 410 ? "expired" : "denied");
      return errorResult(tool, errorCodeOf(error), run.id);
    }
    const current = runByExecutionKey(opts.actor.userId, opts.executionKey);
    if (current?.state === "running") {
      const failed = finishRun({
        userId: opts.actor.userId,
        runId: current.id,
        state: "failed",
        result: null,
        errorCode: errorCodeOf(error),
        outputBytes: 0,
        httpStatus: null,
        dispatched: true,
        durationMs: 0,
      }, now());
      return resultOf(failed);
    }
    return errorResult(tool, errorCodeOf(error), run.id);
  } finally {
    if (activeId) activeExecutions.delete(activeId);
    release?.();
  }
}

export interface PrepareExecutionResult {
  row: RunRow;
  review: ChatReview | null;
  requestHash: string;
  input: Json;
  replayed: boolean;
}

/** Validate and persist a prepared run before an approval prompt or a test review. */
export function prepareExecution(opts: {
  userId: string;
  row: ToolRow;
  input: unknown;
  source: "chat" | "test";
  executionKey: string;
  sessionHash: string;
  threadId?: string | null;
  approvalId?: string | null;
  tokenHash?: string | null;
}): PrepareExecutionResult {
  const input = validateToolInput(opts.row, opts.input);
  const bundle = configBundle(opts.row);
  if (!bundle) throw new AppError({ code: "validation", message: "This tool definition is invalid.", details: { reason: "definition_invalid" } });
  const prepared = bundle.config.kind === "http" ? prepareHttpReview(opts.row, input) : null;
  const requestHash = prepared?.requestHash ?? pythonRequestHash(opts.row, input);
  const inputHash = inputHashOf(input);
  const existing = runByExecutionKey(opts.userId, opts.executionKey);
  if (existing) {
    if (existing.tool_id !== opts.row.id || existing.revision !== opts.row.revision || existing.input_hash !== inputHash || existing.request_hash !== requestHash) {
      throw new AppError({ code: "conflict", message: "This request id was already used for a different request.", details: { reason: "execution_key_conflict" } });
    }
    return { row: existing, review: reviewOf(opts.userId, existing.id), requestHash, input, replayed: true };
  }
  const result = prepareRun({
    userId: opts.userId,
    toolId: opts.row.id,
    revision: opts.row.revision,
    input,
    inputHash,
    requestHash,
    inputBytes: inputBytesOf(input),
    source: opts.source,
    executionKey: opts.executionKey,
    sessionHash: opts.sessionHash,
    threadId: opts.threadId ?? null,
    review: prepared?.review ?? null,
    tokenHash: opts.tokenHash ?? null,
    approvalId: opts.approvalId ?? null,
    expiresAt: now() + CUSTOM_LIMITS.approvalTtlMs,
  });
  return { row: result.row, review: reviewOf(opts.userId, result.row.id), requestHash, input, replayed: result.replayed };
}

export function reviewForRun(userId: string, runId: string): ChatReview | null {
  return reviewOf(userId, runId);
}

export function testReview(row: RunRow, review: ChatReview, token: string): TestReview {
  return { ...review, runId: row.id, toolId: row.tool_id, revision: row.revision, token };
}

/** Whether the worker's response code means capacity rather than a broken service. */
export function sandboxBusy(error: unknown): boolean {
  return (error as { status?: unknown }).status === 429;
}
