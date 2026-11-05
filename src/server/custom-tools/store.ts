import type { InputSchema, Json, ReviewHeader, RunErrorCode, RunState, RunView, SecretPatch, TestReview, ToolConfig, ToolDetail, ToolSummary, ToolWrite, ChatReview } from "../../shared/custom-tools.js";
import {
  CUSTOM_LIMITS,
  canonicalJson,
  parseToolKey,
  runError,
  toolKeyFor,
  utf8Bytes,
  validateInputSchema,
  validateSecretMap,
  validateSecretReferences,
  validateToolWrite,
} from "../../shared/custom-tools.js";
import { assertStorage } from "../quota.js";
import { encrypt, decrypt, newId, randomToken, sha256 } from "../crypto.js";
import { db, tx } from "../db.js";
import { AppError } from "../errors.js";

// Persistence for private custom tools. Every read and write is owner-scoped. Config, secrets, inputs,
// reviews and results are encrypted with an ownership-binding envelope, so a ciphertext copied to another
// row fails closed. Runs hold a fixed 128 KiB quota reservation instead of their payload bytes.

export interface ToolRow {
  id: string;
  user_id: string;
  base_key: string;
  kind: "python" | "http";
  name: string;
  description: string;
  icon: ToolWrite["icon"];
  enabled: number;
  input_schema_json: string;
  config_enc: string;
  secrets_enc: string;
  revision: number;
  created_at: number;
  updated_at: number;
}

export interface RunRow {
  id: string;
  user_id: string;
  tool_id: string;
  revision: number;
  source: "chat" | "test";
  thread_id: string | null;
  execution_key: string;
  state: RunState;
  input_enc: string | null;
  input_hash: string;
  request_hash: string;
  review_enc: string | null;
  approval_id: string | null;
  token_hash: string | null;
  session_hash: string;
  payload_pruned: number;
  expires_at: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  duration_ms: number | null;
  dispatched: number;
  input_bytes: number;
  output_bytes: number;
  http_status: number | null;
  result_enc: string | null;
  error_code: string | null;
}

interface Envelope<T> {
  v: 1;
  userId: string;
  toolId: string;
  runId?: string;
  value: T;
}

function seal<T>(userId: string, toolId: string, value: T, runId?: string): string {
  const envelope: Envelope<T> = { v: 1, userId, toolId, ...(runId ? { runId } : {}), value };
  return encrypt(JSON.stringify(envelope));
}

function unseal<T>(cipher: string, binding: { userId: string; toolId: string; runId?: string }): T | null {
  try {
    const parsed = JSON.parse(decrypt(cipher)) as Envelope<T>;
    if (parsed.v !== 1 || parsed.userId !== binding.userId || parsed.toolId !== binding.toolId) return null;
    if (binding.runId !== undefined && parsed.runId !== binding.runId) return null;
    return parsed.value;
  } catch {
    return null;
  }
}

export function sealValue<T>(userId: string, toolId: string, value: T, runId?: string): string {
  return seal(userId, toolId, value, runId);
}

export function unsealValue<T>(cipher: string, binding: { userId: string; toolId: string; runId?: string }): T | null {
  return unseal<T>(cipher, binding);
}

const toolById = (userId: string, id: string) =>
  db.prepare("SELECT * FROM custom_tools WHERE user_id = ? AND id = ?").get(userId, id) as ToolRow | undefined;

export function toolRow(userId: string, id: string): ToolRow | undefined {
  return toolById(userId, id);
}

function configOf(row: ToolRow): ToolConfig | null {
  return unseal<ToolConfig>(row.config_enc, { userId: row.user_id, toolId: row.id });
}
function secretsOf(row: ToolRow): Record<string, string> | null {
  const value = unseal<Record<string, string>>(row.secrets_enc, { userId: row.user_id, toolId: row.id });
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}
function schemaOf(row: ToolRow): InputSchema | null {
  try {
    const parsed = JSON.parse(row.input_schema_json) as unknown;
    const result = validateInputSchema(parsed);
    return result.ok ? result.value : null;
  } catch {
    return null;
  }
}

/** A corrupt config, schema or ciphertext withholds that definition instead of breaking the list. */
export function toolValid(row: ToolRow): boolean {
  return !!schemaOf(row) && !!configOf(row) && !!secretsOf(row);
}

export function secretNames(row: ToolRow): string[] {
  const secrets = secretsOf(row);
  return secrets ? Object.keys(secrets).sort() : [];
}

export function decryptSecrets(row: ToolRow): Record<string, string> {
  const secrets = secretsOf(row);
  if (!secrets) throw new AppError({ code: "validation", status: 409, message: "This tool's stored secrets cannot be read.", details: { reason: "definition_invalid" } });
  return secrets;
}

export interface ConfigBundle {
  config: ToolConfig;
  schema: InputSchema;
}

export function configBundle(row: ToolRow): ConfigBundle | null {
  const config = configOf(row);
  const schema = schemaOf(row);
  return config && schema ? { config, schema } : null;
}

const countersOf = (userId: string, toolId: string) => {
  const row = db.prepare("SELECT attempts, succeeded, failed, cancelled, unknown FROM custom_tool_counters WHERE user_id = ? AND tool_id = ?")
    .get(userId, toolId) as { attempts: number; succeeded: number; failed: number; cancelled: number; unknown: number } | undefined;
  return row ?? { attempts: 0, succeeded: 0, failed: 0, cancelled: 0, unknown: 0 };
};

const lastAdmitted = (userId: string, toolId: string, includeResult: boolean): RunView | null => {
  const row = db.prepare(
    `SELECT * FROM custom_tool_runs WHERE user_id = ? AND tool_id = ?
     AND state IN ('running','succeeded','failed','cancelled','unknown')
     ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).get(userId, toolId) as RunRow | undefined;
  return row ? runView(row, includeResult) : null;
};

export function summaryOf(row: ToolRow): ToolSummary {
  const valid = toolValid(row);
  return {
    id: row.id,
    toolKey: toolKeyFor(row.base_key, row.revision),
    kind: row.kind,
    name: row.name,
    description: row.description,
    icon: row.icon,
    enabled: row.enabled === 1,
    invalid: !valid,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    secretNames: secretNames(row),
    lastRun: lastAdmitted(row.user_id, row.id, false),
    counters: countersOf(row.user_id, row.id),
  };
}

export function detailOf(row: ToolRow): ToolDetail | null {
  const bundle = configBundle(row);
  if (!bundle) return null;
  return {
    ...summaryOf(row),
    inputSchema: bundle.schema,
    config: bundle.config,
    lastRun: lastAdmitted(row.user_id, row.id, true),
  };
}

export function listTools(userId: string): ToolSummary[] {
  prune(userId);
  const rows = db.prepare("SELECT * FROM custom_tools WHERE user_id = ? ORDER BY created_at ASC, id ASC LIMIT ?")
    .all(userId, CUSTOM_LIMITS.definitions) as unknown as ToolRow[];
  return rows.map(summaryOf);
}

export function cleanupItems(userId: string): Array<{ id: string; name: string; revision: number }> {
  return (db.prepare("SELECT id, name, revision FROM custom_tools WHERE user_id = ? ORDER BY created_at ASC, id ASC LIMIT ?")
    .all(userId, CUSTOM_LIMITS.definitions) as unknown as Array<{ id: string; name: string; revision: number }>);
}

/** Definition bytes as the quota counts them. */
function definitionBytes(row: Pick<ToolRow, "name" | "description" | "icon" | "input_schema_json" | "base_key" | "config_enc" | "secrets_enc">): number {
  return utf8Bytes(row.name) + utf8Bytes(row.description) + utf8Bytes(row.icon) + utf8Bytes(row.input_schema_json) +
    utf8Bytes(row.base_key) + utf8Bytes(row.config_enc) + utf8Bytes(row.secrets_enc);
}

function newBaseKey(id: string): string {
  return `custom_${sha256(id).slice(0, CUSTOM_LIMITS.customKeys)}`;
}

function unusedBaseKey(id: string): string {
  let base = newBaseKey(id);
  let attempt = 0;
  while (db.prepare("SELECT 1 FROM custom_tools WHERE base_key = ?").get(base)) {
    base = newBaseKey(`${id}:${++attempt}`);
  }
  return base;
}

function mergeSecrets(previous: Record<string, string>, patch: SecretPatch | undefined, originChanged: boolean): Record<string, string> {
  const merged: Record<string, string> = Object.create(null) as Record<string, string>;
  if (!originChanged) for (const [name, value] of Object.entries(previous)) merged[name] = value;
  if (patch) {
    for (const name of patch.remove) delete merged[name];
    for (const [name, value] of Object.entries(patch.set)) merged[name] = value;
  }
  return merged;
}

function assertSecretState(config: ToolConfig, secrets: Record<string, string>): void {
  if (config.kind === "python") {
    if (Object.keys(secrets).length) throw new AppError({ code: "validation", message: "Python tools cannot store secrets.", details: { reason: "invalid_header" } });
    return;
  }
  const issues = validateSecretReferences(config.headers, secrets);
  if (issues.length) throw new AppError({ code: "validation", message: "Secrets must match the header references.", details: { reason: issues[0]!.reason } });
}

/** A definition write is strictly validated once, then persisted with encrypted config and secrets. */
export function createTool(userId: string, write: unknown, patch: SecretPatch | undefined): ToolDetail {
  const validated = validateToolWrite(write);
  if (!validated.ok) throw new AppError({ code: "validation", message: "This tool definition is invalid.", details: { reason: validated.issues[0]!.reason, path: validated.issues[0]!.path } });
  const secrets = patch ? mergeSecrets({}, patch, false) : {};
  const checkedSecrets = validateSecretMap(secrets);
  if (!checkedSecrets.ok) throw new AppError({ code: "validation", message: "The secrets are invalid.", details: { reason: checkedSecrets.issues[0]!.reason } });
  assertSecretState(validated.value.config, checkedSecrets.value);
  const now = Date.now();
  const id = newId("ct");
  const base = unusedBaseKey(id);
  const configEnc = seal(userId, id, validated.value.config);
  const secretsEnc = seal(userId, id, checkedSecrets.value);
  const schemaJson = canonicalJson(validated.value.inputSchema as unknown as Json);
  const bytes = definitionBytes({ ...validated.value, base_key: base, input_schema_json: schemaJson, config_enc: configEnc, secrets_enc: secretsEnc });
  const result = tx(() => {
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM custom_tools WHERE user_id = ?").get(userId) as { n: number };
    if (n >= CUSTOM_LIMITS.definitions) throw new AppError({ code: "conflict", message: `You can keep at most ${CUSTOM_LIMITS.definitions} custom tools.`, details: { reason: "definition_limit" } });
    if (validated.value.enabled) assertEnabledRoom(userId);
    assertStorage(userId, bytes);
    db.prepare(
      `INSERT INTO custom_tools (id, user_id, base_key, kind, name, description, icon, enabled, input_schema_json, config_enc, secrets_enc, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(id, userId, base, validated.value.config.kind, validated.value.name, validated.value.description, validated.value.icon,
      validated.value.enabled ? 1 : 0, schemaJson, configEnc, secretsEnc, now, now);
    return toolById(userId, id)!;
  });
  return detailOf(result)!;
}

function assertEnabledRoom(userId: string): void {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM custom_tools WHERE user_id = ? AND enabled = 1").get(userId) as { n: number };
  if (n >= CUSTOM_LIMITS.enabledDefinitions) throw new AppError({ code: "conflict", message: `You can enable at most ${CUSTOM_LIMITS.enabledDefinitions} custom tools.`, details: { reason: "enabled_limit" } });
}

function conflict(revision: number): AppError {
  return new AppError({ code: "conflict", message: "This tool changed. Reload it before saving.", details: { reason: "definition_changed", revision } });
}

function revisionExhausted(): AppError {
  return new AppError({ code: "conflict", message: "This tool reached its last revision. Create a new tool instead.", details: { reason: "revision_exhausted" } });
}

export function updateTool(userId: string, id: string, expectedRevision: number, write: unknown, patch: SecretPatch | undefined): ToolDetail {
  const validated = validateToolWrite(write);
  if (!validated.ok) throw new AppError({ code: "validation", message: "This tool definition is invalid.", details: { reason: validated.issues[0]!.reason, path: validated.issues[0]!.path } });
  return tx(() => {
    const row = toolById(userId, id);
    if (!row) throw notFound();
    if (row.revision !== expectedRevision) throw conflict(row.revision);
    if (row.revision >= CUSTOM_LIMITS.revisionMax) throw revisionExhausted();
    if (row.kind !== validated.value.config.kind) throw new AppError({ code: "validation", message: "A tool's type cannot change. Create a new tool instead.", details: { reason: "kind_immutable" } });
    const previous = secretsOf(row);
    if (!previous) throw new AppError({ code: "validation", message: "This tool's stored secrets cannot be read.", details: { reason: "definition_invalid" } });
    const old = configOf(row);
    const originChanged = row.kind === "http" && (old?.kind === "http" ? old.origin : null) !== (validated.value.config.kind === "http" ? validated.value.config.origin : null);
    const merged = mergeSecrets(previous, patch, originChanged);
    const checked = validateSecretMap(merged);
    if (!checked.ok) throw new AppError({ code: "validation", message: "The secrets are invalid.", details: { reason: checked.issues[0]!.reason } });
    assertSecretState(validated.value.config, checked.value);
    if (validated.value.enabled) {
      const enabled = db.prepare("SELECT COUNT(*) AS n FROM custom_tools WHERE user_id = ? AND enabled = 1 AND id <> ?").get(userId, id) as { n: number };
      if (enabled.n >= CUSTOM_LIMITS.enabledDefinitions) throw new AppError({ code: "conflict", message: `You can enable at most ${CUSTOM_LIMITS.enabledDefinitions} custom tools.`, details: { reason: "enabled_limit" } });
    }
    const configEnc = seal(userId, id, validated.value.config);
    const secretsEnc = seal(userId, id, checked.value);
    const schemaJson = canonicalJson(validated.value.inputSchema as unknown as Json);
    const next = { ...row, ...validated.value, base_key: row.base_key, input_schema_json: schemaJson, config_enc: configEnc, secrets_enc: secretsEnc, revision: row.revision + 1 };
    const delta = definitionBytes(next) - definitionBytes(row);
    if (delta > 0) assertStorage(userId, delta);
    const now = Date.now();
    const result = db.prepare(
      `UPDATE custom_tools SET name = ?, description = ?, icon = ?, enabled = ?, input_schema_json = ?, config_enc = ?, secrets_enc = ?, revision = ?, updated_at = ?
       WHERE user_id = ? AND id = ? AND revision = ?`,
    ).run(next.name, next.description, next.icon, validated.value.enabled ? 1 : 0, schemaJson, configEnc, secretsEnc, row.revision + 1, now, userId, id, expectedRevision);
    if (Number(result.changes) !== 1) throw conflict(toolById(userId, id)?.revision ?? row.revision);
    // A prepared approval for the old revision is invalid; the editor's next call prepares a new review.
    expirePrepared(userId, id);
    return detailOf(toolById(userId, id)!)!;
  });
}

export function setEnabled(userId: string, id: string, expectedRevision: number, enabled: boolean): ToolSummary {
  return tx(() => {
    const row = toolById(userId, id);
    if (!row) throw notFound();
    if (row.revision !== expectedRevision) throw conflict(row.revision);
    if (row.revision >= CUSTOM_LIMITS.revisionMax) throw revisionExhausted();
    if (enabled) {
      const count = db.prepare("SELECT COUNT(*) AS n FROM custom_tools WHERE user_id = ? AND enabled = 1 AND id <> ?").get(userId, id) as { n: number };
      if (count.n >= CUSTOM_LIMITS.enabledDefinitions) throw new AppError({ code: "conflict", message: `You can enable at most ${CUSTOM_LIMITS.enabledDefinitions} custom tools.`, details: { reason: "enabled_limit" } });
    }
    const result = db.prepare("UPDATE custom_tools SET enabled = ?, revision = ?, updated_at = ? WHERE user_id = ? AND id = ? AND revision = ?")
      .run(enabled ? 1 : 0, row.revision + 1, Date.now(), userId, id, expectedRevision);
    if (Number(result.changes) !== 1) throw conflict(toolById(userId, id)?.revision ?? row.revision);
    expirePrepared(userId, id);
    return summaryOf(toolById(userId, id)!);
  });
}

export function deleteTool(userId: string, id: string, expectedRevision: number): void {
  tx(() => {
    const row = toolById(userId, id);
    if (!row) throw notFound();
    if (row.revision !== expectedRevision) throw conflict(row.revision);
    const running = db.prepare("SELECT 1 FROM custom_tool_runs WHERE user_id = ? AND tool_id = ? AND state = 'running' LIMIT 1").get(userId, id);
    if (running) throw new AppError({ code: "conflict", message: "Wait for the running execution to finish.", details: { reason: "tool_busy" } });
    // Cascade removes runs, counters, and their reservations.
    db.prepare("DELETE FROM custom_tools WHERE user_id = ? AND id = ?").run(userId, id);
  });
}

export function notFound(): AppError {
  return new AppError({ code: "not_found", status: 404, message: "Tool not found." });
}

// ---------------------------------------------------------------------------
// Runs

export function runRow(userId: string, runId: string): RunRow | undefined {
  return db.prepare("SELECT * FROM custom_tool_runs WHERE user_id = ? AND id = ?").get(userId, runId) as RunRow | undefined;
}

export function runByExecutionKey(userId: string, executionKey: string): RunRow | undefined {
  return db.prepare("SELECT * FROM custom_tool_runs WHERE user_id = ? AND execution_key = ?").get(userId, executionKey) as RunRow | undefined;
}

export function runView(row: RunRow, includeResult = true): RunView {
  let result: Json | null = null;
  if (includeResult && row.result_enc && row.payload_pruned === 0) {
    result = unseal<Json>(row.result_enc, { userId: row.user_id, toolId: row.tool_id, runId: row.id });
  }
  return {
    id: row.id,
    toolId: row.tool_id,
    revision: row.revision,
    source: row.source,
    state: row.state,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    dispatched: row.dispatched === 1,
    inputBytes: row.input_bytes,
    outputBytes: row.output_bytes,
    httpStatus: row.http_status,
    result,
    resultRetained: row.state === "succeeded" && row.payload_pruned === 0 && !!row.result_enc,
    error: row.error_code ? runError(row.error_code as RunErrorCode) : null,
  };
}

export function listRuns(userId: string, toolId: string): RunView[] {
  const rows = db.prepare(
    `SELECT * FROM custom_tool_runs WHERE user_id = ? AND tool_id = ? AND state NOT IN ('prepared','denied','expired')
     ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(userId, toolId, CUSTOM_LIMITS.visibleRuns) as unknown as RunRow[];
  return rows.map((row) => runView(row, false));
}

export function lastTerminalRun(userId: string, toolId: string): RunRow | undefined {
  return db.prepare(
    "SELECT * FROM custom_tool_runs WHERE user_id = ? AND tool_id = ? AND state IN ('succeeded','failed','cancelled','unknown') ORDER BY created_at DESC, id DESC LIMIT 1",
  ).get(userId, toolId) as RunRow | undefined;
}

export interface PrepareInput {
  userId: string;
  toolId: string;
  revision: number;
  input: Json;
  inputHash: string;
  requestHash: string;
  inputBytes: number;
  source: "chat" | "test";
  executionKey: string;
  sessionHash: string;
  threadId?: string | null;
  review: ChatReview | null;
  tokenHash: string | null;
  approvalId?: string | null;
  expiresAt: number;
}

export interface PreparedRun {
  row: RunRow;
  replayed: boolean;
}

function assertAttemptsLeft(userId: string, executionKey: string): void {
  if (executionKey.startsWith("chat:")) {
    const logical = executionKey.split(":")[1] ?? "";
    const { n } = db.prepare(
      "SELECT COUNT(*) AS n FROM custom_tool_runs WHERE user_id = ? AND execution_key LIKE ? AND state IN ('running','succeeded','failed','cancelled','unknown')",
    ).get(userId, `chat:${logical}:%`) as { n: number };
    if (n >= CUSTOM_LIMITS.attemptsPerReply) throw rateLimited("This reply reached its custom tool limit.");
  }
}

function rateLimited(message = "Too many custom tool executions. Try again shortly."): AppError {
  return new AppError({ code: "rate_limited", status: 429, message, retryAfterMs: 60_000, details: { retryAfterSeconds: 60 } });
}

export function prepareRun(opts: PrepareInput): PreparedRun {
  return tx(() => {
    const existing = runByExecutionKey(opts.userId, opts.executionKey);
    if (existing) {
      if (existing.tool_id !== opts.toolId || existing.revision !== opts.revision || existing.input_hash !== opts.inputHash || existing.request_hash !== opts.requestHash) {
        throw new AppError({ code: "conflict", message: "This request id was already used for a different request.", details: { reason: "execution_key_conflict" } });
      }
      return { row: existing, replayed: true };
    }
    prune(opts.userId);
    const prepared = db.prepare("SELECT COUNT(*) AS n FROM custom_tool_runs WHERE user_id = ? AND state = 'prepared'").get(opts.userId) as { n: number };
    if (prepared.n >= CUSTOM_LIMITS.preparedRuns) throw rateLimited("Too many requests are waiting for approval.");
    assertAttemptsLeft(opts.userId, opts.executionKey);
    assertStorage(opts.userId, CUSTOM_LIMITS.resultReservation);
    const id = newId("ctr");
    const now = Date.now();
    db.prepare(
      `INSERT INTO custom_tool_runs (id, user_id, tool_id, revision, source, thread_id, execution_key, state, input_enc, input_hash, request_hash, review_enc, approval_id, token_hash, session_hash, expires_at, created_at, input_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, opts.userId, opts.toolId, opts.revision, opts.source, opts.threadId ?? null, opts.executionKey, seal(opts.userId, opts.toolId, opts.input, id), opts.inputHash, opts.requestHash,
      opts.review ? seal(opts.userId, opts.toolId, opts.review, id) : null, opts.approvalId ?? null, opts.tokenHash, opts.sessionHash, opts.expiresAt, now, opts.inputBytes);
    return { row: runRow(opts.userId, id)!, replayed: false };
  });
}

/** The prepared review is readable only by the owner and bound session; chat cards load it by run id. */
export function reviewOf(userId: string, runId: string): ChatReview | null {
  const row = runRow(userId, runId);
  if (!row || !row.review_enc || row.payload_pruned) return null;
  return unseal<ChatReview>(row.review_enc, { userId, toolId: row.tool_id, runId: row.id });
}

export function preparedInput(userId: string, runId: string): Json | null {
  const row = runRow(userId, runId);
  if (!row || !row.input_enc || row.payload_pruned) return null;
  return unseal<Json>(row.input_enc, { userId, toolId: row.tool_id, runId: row.id });
}

export function setApprovalId(userId: string, runId: string, approvalId: string): void {
  db.prepare("UPDATE custom_tool_runs SET approval_id = ? WHERE user_id = ? AND id = ? AND state = 'prepared'").run(approvalId, userId, runId);
}

export function expireRun(userId: string, runId: string): void {
  const row = runRow(userId, runId);
  if (!row || row.state !== "prepared") return;
  db.prepare(
    `UPDATE custom_tool_runs SET state = 'expired', input_enc = NULL, review_enc = NULL, token_hash = NULL, approval_id = NULL, payload_pruned = 1, finished_at = ?, expires_at = ?
     WHERE user_id = ? AND id = ? AND state = 'prepared'`,
  ).run(Date.now(), Date.now(), userId, runId);
}

export function denyRun(userId: string, runId: string, state: "denied" | "expired" = "denied"): void {
  db.prepare(
    `UPDATE custom_tool_runs SET state = ?, input_enc = NULL, review_enc = NULL, token_hash = NULL, approval_id = NULL, payload_pruned = 1, finished_at = ?, expires_at = ?
     WHERE user_id = ? AND id = ? AND state = 'prepared'`,
  ).run(state, Date.now(), Date.now(), userId, runId);
}

export function cancelRun(userId: string, runId: string): RunView | null {
  const row = runRow(userId, runId);
  if (!row) return null;
  if (row.state === "prepared") {
    denyRun(userId, runId, "denied");
  }
  // A running row settles in the executor; the caller may poll.
  return runView(runRow(userId, runId)!, true);
}

export interface ClaimInput {
  userId: string;
  runId: string;
  requestHash: string;
  sessionHash: string;
}

export interface ClaimResult {
  row: RunRow;
  release: () => void;
}

/**
 * Claims a prepared run for execution in one transaction: state, rate window, counters, operation
 * reservation and the running transition. Any failure rolls all of it back, and no dispatch happens.
 */
export function claimRun(
  input: ClaimInput,
  assertReady: () => void,
  reserve: () => { release: () => void },
  now = Date.now(),
): ClaimResult {
  return tx(() => {
    const previous = runRow(input.userId, input.runId);
    if (!previous) throw notFound();
    if (previous.state !== "prepared") throw new AppError({ code: "conflict", message: "This request is no longer waiting for approval.", details: { reason: "run_not_prepared" } });
    if (previous.session_hash !== input.sessionHash) throw new AppError({ code: "forbidden", message: "This approval belongs to another session.", details: { reason: "approval_session" } });
    if (previous.request_hash !== input.requestHash) throw new AppError({ code: "conflict", message: "The reviewed request changed.", details: { reason: "definition_changed" } });
    if (previous.expires_at <= now) {
      expireRun(input.userId, input.runId);
      throw new AppError({ code: "conflict", status: 410, message: "This approval expired. Review the request again.", details: { reason: "approval_expired" } });
    }
    assertReady();
    const windowStart = Math.floor(now / 60_000) * 60_000;
    const current = db.prepare("SELECT attempts FROM custom_tool_rate_windows WHERE user_id = ? AND window_start = ?").get(input.userId, windowStart) as { attempts: number } | undefined;
    if ((current?.attempts ?? 0) >= CUSTOM_LIMITS.attemptsPerMinute) throw rateLimited();
    // Fixed hard caps independent of policy: two active executions per account, four per process.
    const accountRunning = db.prepare("SELECT COUNT(*) AS n FROM custom_tool_runs WHERE user_id = ? AND state = 'running'").get(input.userId) as { n: number };
    if (accountRunning.n >= 2) throw rateLimited("Two custom tool executions are already running. Wait for one to finish.");
    const processRunning = db.prepare("SELECT COUNT(*) AS n FROM custom_tool_runs WHERE state = 'running'").get() as { n: number };
    if (processRunning.n >= 4) throw rateLimited("The server is running its maximum custom tool executions. Try again shortly.");
    const lease = reserve();
    db.prepare(
      `INSERT INTO custom_tool_rate_windows (user_id, window_start, attempts) VALUES (?, ?, 1)
       ON CONFLICT (user_id, window_start) DO UPDATE SET attempts = attempts + 1`,
    ).run(input.userId, windowStart);
    db.prepare(
      `INSERT INTO custom_tool_counters (user_id, tool_id, attempts) VALUES (?, ?, 1)
       ON CONFLICT (user_id, tool_id) DO UPDATE SET attempts = attempts + 1`,
    ).run(input.userId, previous.tool_id);
    const changed = db.prepare("UPDATE custom_tool_runs SET state = 'running', started_at = ?, input_enc = NULL, review_enc = NULL, token_hash = NULL, approval_id = NULL WHERE user_id = ? AND id = ? AND state = 'prepared'")
      .run(now, input.userId, input.runId);
    if (Number(changed.changes) !== 1) throw new AppError({ code: "conflict", message: "This request was already handled.", details: { reason: "run_not_prepared" } });
    return { row: runRow(input.userId, input.runId)!, release: lease.release };
  });
}

export interface FinishInput {
  userId: string;
  runId: string;
  state: "succeeded" | "failed" | "cancelled" | "unknown";
  result: Json | null;
  errorCode: RunErrorCode | null;
  outputBytes: number;
  httpStatus: number | null;
  dispatched: boolean;
  durationMs: number;
}

function bumpCounter(userId: string, toolId: string, state: FinishInput["state"]): void {
  if (state === "unknown") {
    db.prepare("INSERT INTO custom_tool_counters (user_id, tool_id, unknown) VALUES (?, ?, 1) ON CONFLICT (user_id, tool_id) DO UPDATE SET unknown = unknown + 1").run(userId, toolId);
    return;
  }
  const column = state === "succeeded" ? "succeeded" : state === "cancelled" ? "cancelled" : "failed";
  db.prepare(`INSERT INTO custom_tool_counters (user_id, tool_id, ${column}) VALUES (?, ?, 1) ON CONFLICT (user_id, tool_id) DO UPDATE SET ${column} = ${column} + 1`).run(userId, toolId);
}

/** Terminal transition and its counter happen together; an already-terminal run is never counted twice. */
export function finishRun(input: FinishInput, now = Date.now()): RunRow {
  return tx(() => {
    const row = runRow(input.userId, input.runId);
    if (!row) throw notFound();
    if (row.state === "running") {
      const resultEnc = input.state === "succeeded" ? seal(input.userId, row.tool_id, input.result, row.id) : null;
      const changed = db.prepare(
        `UPDATE custom_tool_runs SET state = ?, result_enc = ?, error_code = ?, output_bytes = ?, http_status = ?, dispatched = ?, duration_ms = ?, finished_at = ?, expires_at = ?,
           input_enc = NULL, review_enc = NULL, token_hash = NULL, approval_id = NULL
         WHERE user_id = ? AND id = ? AND state = 'running'`,
      ).run(input.state, resultEnc, input.errorCode, input.outputBytes, input.httpStatus, input.dispatched ? 1 : 0, input.durationMs, now, now + CUSTOM_LIMITS.runTtlMs, input.userId, input.runId);
      if (Number(changed.changes) === 1) bumpCounter(input.userId, row.tool_id, input.state);
    }
    return runRow(input.userId, input.runId)!;
  });
}

export function markUnknown(userId: string, runId: string, dispatched: boolean): void {
  const row = runRow(userId, runId);
  if (!row || row.state !== "running") return;
  const changed = db.prepare(
    `UPDATE custom_tool_runs SET state = 'unknown', error_code = 'outcome_unknown', dispatched = ?, finished_at = ?, expires_at = ?,
       input_enc = NULL, review_enc = NULL, token_hash = NULL, approval_id = NULL WHERE user_id = ? AND id = ? AND state = 'running'`,
  ).run(dispatched ? 1 : 0, Date.now(), Date.now() + CUSTOM_LIMITS.runTtlMs, userId, runId);
  if (Number(changed.changes) === 1) bumpCounter(userId, row.tool_id, "unknown");
}

/** Restart never resumes work: running rows become an honest unknown outcome, once. */
export function settleOnStartup(): void {
  const rows = db.prepare("SELECT user_id, id, dispatched FROM custom_tool_runs WHERE state = 'running'").all() as unknown as Array<{ user_id: string; id: string; dispatched: number }>;
  for (const row of rows) markUnknown(row.user_id, row.id, row.dispatched === 1);
  // No approval survives a restart: the in-memory capability and the original request context are gone.
  db.prepare("UPDATE custom_tool_runs SET state = 'expired', input_enc = NULL, review_enc = NULL, token_hash = NULL, approval_id = NULL, payload_pruned = 1 WHERE state = 'prepared'")
    .run();
  db.prepare("DELETE FROM custom_tool_rate_windows WHERE window_start < ?").run(Date.now() - 2 * 60_000);
}

function expirePrepared(userId: string, toolId: string): void {
  db.prepare(
    `UPDATE custom_tool_runs SET state = 'expired', input_enc = NULL, review_enc = NULL, token_hash = NULL, approval_id = NULL, payload_pruned = 1, finished_at = ?
     WHERE user_id = ? AND tool_id = ? AND state = 'prepared'`,
  ).run(Date.now(), userId, toolId);
}

/** Bounded retention: per tool, latest 20 terminal runs; older than 7 days are pruned except the latest. */
export function prune(userId: string, now = Date.now()): void {
  const tools = db.prepare("SELECT id FROM custom_tools WHERE user_id = ?").all(userId) as unknown as Array<{ id: string }>;
  for (const { id } of tools) {
    const rows = db.prepare(
      "SELECT id, state, created_at, result_enc, payload_pruned FROM custom_tool_runs WHERE user_id = ? AND tool_id = ? AND state IN ('succeeded','failed','cancelled','unknown','denied','expired') ORDER BY created_at DESC, id DESC",
    ).all(userId, id) as unknown as Array<{ id: string; state: string; created_at: number; result_enc: string | null; payload_pruned: number }>;
    rows.forEach((row, index) => {
      if (row.state === "denied" || row.state === "expired") {
        // Not an admitted execution and never shown: keep only the short idempotency window.
        if (row.created_at < now - CUSTOM_LIMITS.dedupeTtlMs) db.prepare("DELETE FROM custom_tool_runs WHERE user_id = ? AND id = ?").run(userId, row.id);
        return;
      }
      const keep = index === 0;
      if (keep) return;
      const terminal = row.state !== "denied" && row.state !== "expired";
      const expired = row.created_at < now - CUSTOM_LIMITS.runTtlMs;
      if (!terminal || !expired || index >= CUSTOM_LIMITS.visibleRuns) {
        if (terminal && (index >= CUSTOM_LIMITS.visibleRuns || expired)) {
          const tombstoneLimit = db.prepare("SELECT COUNT(*) AS n FROM custom_tool_runs WHERE user_id = ? AND payload_pruned = 1").get(userId) as { n: number };
          if (row.created_at >= now - CUSTOM_LIMITS.dedupeTtlMs && tombstoneLimit.n < CUSTOM_LIMITS.tombstones) {
            db.prepare("UPDATE custom_tool_runs SET result_enc = NULL, input_enc = NULL, review_enc = NULL, token_hash = NULL, payload_pruned = 1 WHERE user_id = ? AND id = ?")
              .run(userId, row.id);
          } else if (row.created_at < now - CUSTOM_LIMITS.dedupeTtlMs) {
            db.prepare("DELETE FROM custom_tool_runs WHERE user_id = ? AND id = ?").run(userId, row.id);
          }
        }
      }
    });
  }
  db.prepare("UPDATE custom_tool_runs SET state = 'expired', input_enc = NULL, review_enc = NULL, token_hash = NULL, approval_id = NULL, payload_pruned = 1 WHERE state = 'prepared' AND expires_at < ?")
    .run(now);
  db.prepare("DELETE FROM custom_tool_rate_windows WHERE window_start < ?").run(now - 2 * 60_000);
}

/** Deterministic execution identity helpers. */
export function testExecutionKey(sessionHash: string, requestId: string): string {
  return `test:${sessionHash}:${requestId}`;
}
export function chatExecutionKey(logicalReplyId: string, toolCallId: string): string {
  return `chat:${logicalReplyId}:${toolCallId}`;
}

export function makeRunToken(): { token: string; hash: string } {
  const token = randomToken();
  return { token, hash: sha256(token) };
}

export function tokenMatches(hash: string | null, token: string): boolean {
  return !!hash && sha256(token) === hash;
}

export function reviewForResponse(row: RunRow, review: ChatReview, token: string): TestReview {
  return { ...review, runId: row.id, toolId: row.tool_id, revision: row.revision, token };
}

export function keyMatchesRevision(row: ToolRow, key: string): boolean {
  const parsed = parseToolKey(key);
  return !!parsed && parsed.revision === row.revision && toolKeyFor(row.base_key, row.revision) === key;
}

/** Review headers never contain a secret value, only a secret name. */
export const reviewHeadersOf = (headers: ReviewHeader[]): ReviewHeader[] => headers;
