import type { FinishReason, GenerationSummary, GenerationState } from "../shared/generation.js";
import { canContinue, generationOf } from "../shared/generation.js";
import type { AssistantMetadata, TokenUsage } from "../shared/types.js";
import { resolveAssistantForTurn } from "./assistant-presets.js";
import { newId } from "./crypto.js";
import { db, tx } from "./db.js";
import { AppError } from "./errors.js";
import { assertStorage, RUN_RECEIPT_BYTES } from "./quota.js";
import { addUsage, normalizeUsage, ZERO_USAGE } from "./usage.js";
import type { ResolvedRunConfig } from "../shared/assistant-presets.js";
import { emitChatTurnCompleted, emitChatTurnFailed } from "./outgoing-webhooks/events.js";

/**
 * Generation receipts: one row per assistant message a provider produced, recorded before upstream and
 * projected onto history as the only trusted finish state. A receipt is a ledger, not a resumable run:
 * startup marks open rows interrupted and never bills or resumes them.
 */

export interface RunRow {
  id: string;
  thread_id: string;
  user_message_id: string;
  assistant_message_id: string;
  config_json: string;
  state: GenerationState;
  finish_reason: FinishReason | null;
  usage_json: string;
  cost: number;
  context_tokens: number | null;
  duration_ms: number;
  created_at: number;
  updated_at: number;
}

const MAX_SEGMENTS = 100;
const MAX_USAGE_JSON = 2 * 1024;

const parseUsage = (json: string): TokenUsage => {
  try {
    const raw = JSON.parse(json) as Partial<TokenUsage>;
    return {
      input: Number(raw.input) || 0,
      output: Number(raw.output) || 0,
      reasoning: Number(raw.reasoning) || 0,
      cacheRead: Number(raw.cacheRead) || 0,
      cacheWrite: Number(raw.cacheWrite) || 0,
    };
  } catch {
    return { ...ZERO_USAGE };
  }
};

const parseConfig = (json: string): ResolvedRunConfig | null => {
  try {
    return JSON.parse(json) as ResolvedRunConfig;
  } catch {
    return null;
  }
};

function rowOf(threadId: string, assistantMessageId: string): RunRow | undefined {
  return db.prepare("SELECT * FROM generation_runs WHERE thread_id = ? AND assistant_message_id = ?").get(threadId, assistantMessageId) as unknown as RunRow | undefined;
}

/**
 * Allocates the receipt before any provider request. Throws a quota error when even the fixed
 * reservation does not fit, so a reply never starts that could not record its number.
 */
export function beginRun(input: {
  userId: string;
  threadId: string;
  userMessageId: string;
  assistantMessageId: string;
  config: ResolvedRunConfig;
}): RunRow {
  const configJson = JSON.stringify(input.config);
  assertStorage(input.userId, RUN_RECEIPT_BYTES + Buffer.byteLength(configJson));
  const now = Date.now();
  const id = newId("run");
  db.prepare(
    `INSERT INTO generation_runs (id, thread_id, user_message_id, assistant_message_id, config_json, state, finish_reason, usage_json, cost, context_tokens, duration_ms, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'running', NULL, '{}', 0, NULL, 0, ?, ?)`,
  ).run(id, input.threadId, input.userMessageId, input.assistantMessageId, configJson, now, now);
  return rowOf(input.threadId, input.assistantMessageId)!;
}

/** A tool-result/approval continuation reuses its logical reply's receipt. */
export function resolveRunForToolResult(threadId: string, assistantMessageId: string): RunRow | undefined {
  const row = rowOf(threadId, assistantMessageId);
  return row && (row.state === "waiting" || row.state === "running") ? row : undefined;
}

/** Marks a waiting receipt running again when its browser/tool continuation request starts. */
export function resumeRun(row: RunRow): void {
  if (row.state !== "waiting") return;
  db.prepare("UPDATE generation_runs SET state = 'running', updated_at = ? WHERE id = ?").run(Date.now(), row.id);
}

export interface SegmentInput {
  usage: TokenUsage;
  cost: number;
  contextTokens?: number;
}

/**
 * Records one provider stream invocation exactly once. Retries of the same logical request segment are
 * deduped by the server-chosen id, so a reconnecting client cannot bill it twice.
 */
export function recordSegmentOnce(runId: string, segmentId: string, segment: SegmentInput): { usage: TokenUsage; cost: number; contextTokens: number | null } {
  return tx(() => {
    const row = db.prepare("SELECT * FROM generation_runs WHERE id = ?").get(runId) as unknown as RunRow | undefined;
    if (!row) throw new AppError({ code: "not_found", message: "Generation receipt not found." });
    const count = (db.prepare("SELECT COUNT(*) AS n FROM generation_segments WHERE run_id = ?").get(runId) as { n: number }).n;
    if (count >= MAX_SEGMENTS) {
      // The fixed reservation covers this many records; refusing here is safer than growing without bound.
      throw new AppError({ code: "validation", message: "This reply used too many provider requests to record." });
    }
    const inserted = db
      .prepare("INSERT OR IGNORE INTO generation_segments (run_id, id, usage_json, cost) VALUES (?, ?, ?, ?)")
      .run(runId, segmentId, JSON.stringify(segment.usage), segment.cost);
    if (!inserted.changes) {
      return { usage: parseUsage(row.usage_json), cost: row.cost, contextTokens: row.context_tokens };
    }
    const usage = addUsage(parseUsage(row.usage_json), segment.usage);
    const cost = row.cost + segment.cost;
    const usageJson = JSON.stringify(usage);
    const contextTokens = segment.contextTokens ?? row.context_tokens;
    db.prepare("UPDATE generation_runs SET usage_json = ?, cost = ?, context_tokens = ?, updated_at = ? WHERE id = ?").run(
      usageJson.length <= MAX_USAGE_JSON ? usageJson : JSON.stringify(usage),
      cost,
      contextTokens,
      Date.now(),
      runId,
    );
    return { usage, cost, contextTokens };
  });
}

export interface EndRunInput {
  state: GenerationState;
  finishReason: FinishReason | null;
  durationMs: number;
}

/** Terminal transition. A receipt that already ended is never rewritten by a late abort or error. */
export function endRun(runId: string, end: EndRunInput, options: { answerText?: string } = {}): GenerationState {
  return tx(() => {
    const row = db
      .prepare("SELECT r.*, t.user_id FROM generation_runs r JOIN threads t ON t.id = r.thread_id WHERE r.id = ?")
      .get(runId) as (RunRow & { user_id: string }) | undefined;
    if (!row) return end.state;
    const terminal: GenerationState[] = ["finished", "aborted", "error", "interrupted"];
    const wasTerminal = terminal.includes(row.state);
    if (wasTerminal && row.state !== end.state) return row.state;
    db.prepare("UPDATE generation_runs SET state = ?, finish_reason = ?, duration_ms = ?, updated_at = ? WHERE id = ?").run(
      end.state,
      end.finishReason,
      Math.max(0, Math.round(end.durationMs)),
      Date.now(),
      runId,
    );
    // Only the first transition out of a running/waiting receipt is a source event. A repeated terminal
    // write (a late abort, a retried request) must not duplicate the delivery.
    if (!wasTerminal) {
      const config = parseConfig(row.config_json);
      if (config?.turnOrigin === "interactive") {
        if (end.state === "finished") {
          emitChatTurnCompleted({
            userId: row.user_id,
            threadId: row.thread_id,
            runId: row.id,
            assistantMessageId: row.assistant_message_id,
            finishReason: end.finishReason,
            text: options.answerText,
          });
        } else if (end.state === "error" || end.state === "interrupted") {
          emitChatTurnFailed({
            userId: row.user_id,
            threadId: row.thread_id,
            runId: row.id,
            assistantMessageId: row.assistant_message_id,
            failureCode: end.state === "interrupted" ? "interrupted" : "generation_error",
          });
        }
      }
    }
    return end.state;
  });
}

/** The SDK's final reason, normalized. `onStepEnd` is not a logical completion and must not be used. */
export function normalizeFinishReason(reason: string | undefined): FinishReason {
  switch (reason) {
    case "stop":
    case "length":
    case "tool-calls":
    case "content-filter":
    case "error":
    case "other":
      return reason;
    default:
      return "unknown";
  }
}

const summaryOf = (row: RunRow): GenerationSummary => {
  const config = parseConfig(row.config_json);
  const usage = parseUsage(row.usage_json);
  const hasUsage = Object.values(usage).some((value) => value > 0);
  return {
    runId: row.id,
    state: row.state,
    finishReason: row.finish_reason,
    ...(config?.continuationOf ? { continuationOf: config.continuationOf } : {}),
    ...(hasUsage ? { usage } : {}),
    ...(row.cost > 0 ? { cost: row.cost } : {}),
    ...(row.context_tokens !== null ? { contextTokens: row.context_tokens } : {}),
    ...(row.duration_ms > 0 ? { durationMs: row.duration_ms } : {}),
    assistantName: config?.assistantName ?? null,
    assistantIcon: config?.assistantIcon ?? null,
  };
};

/** The private history row's trusted projection. Never includes the config or instructions. */
export function projectGenerationMetadata(threadId: string, assistantMessageId: string): GenerationSummary | undefined {
  const row = rowOf(threadId, assistantMessageId);
  return row ? summaryOf(row) : undefined;
}

/** Every receipt of a chat, keyed by assistant message id, for one history read. */
export function projectGenerationsForThread(threadId: string): Map<string, GenerationSummary> {
  const rows = db.prepare("SELECT * FROM generation_runs WHERE thread_id = ?").all(threadId) as unknown as RunRow[];
  return new Map(rows.map((row) => [row.assistant_message_id, summaryOf(row)]));
}

/** Replaces whatever generation object a client sent with the stored receipt, or strips it. */
export function overlayGenerationMetadata(threadId: string, message: { id: string; content: unknown }): unknown {
  const content = message.content as { role?: unknown; parts?: unknown; metadata?: unknown };
  const projection = projectGenerationMetadata(threadId, message.id);
  if (content.role !== "assistant") return message.content;
  const metadata = typeof content.metadata === "object" && content.metadata !== null ? { ...(content.metadata as Record<string, unknown>) } : {};
  const custom = typeof metadata.custom === "object" && metadata.custom !== null ? { ...(metadata.custom as Record<string, unknown>) } : undefined;
  if (projection) {
    // assistant-ui reads unknown keys from `metadata.custom`; the raw AI SDK shape keeps them top level.
    if (custom) custom.generation = projection;
    metadata.generation = projection;
  } else {
    delete metadata.generation;
    if (custom) delete custom.generation;
  }
  return { ...content, metadata, ...(custom ? { custom } : {}) };
}

/** Threads with a receipt that has not reached a terminal state, including waiting tool results. */
export function generationBusy(threadId: string): boolean {
  return db.prepare("SELECT 1 FROM generation_runs WHERE thread_id = ? AND state IN ('running', 'waiting') LIMIT 1").get(threadId) !== undefined;
}

/** Startup: a previous process's open receipts are interrupted, never resumed or rebilled. */
export function interruptOpenRuns(): void {
  for (let batch = 0; batch < 20; batch++) {
    const rows = db
      .prepare("SELECT id, created_at FROM generation_runs WHERE state IN ('running', 'waiting') ORDER BY created_at LIMIT 500")
      .all() as Array<{ id: string; created_at: number }>;
    if (!rows.length) return;
    for (const row of rows) {
      // One guarded terminal transaction per receipt: only an interactive origin publishes the failure,
      // and a receipt whose source transaction already committed is never rewritten into a second outcome.
      endRun(row.id, { state: "interrupted", finishReason: null, durationMs: Math.max(0, Date.now() - row.created_at) });
    }
  }
}

const aborters = new Map<string, () => void>();

export function attachRunAbort(runId: string, abort: () => void): void {
  aborters.set(runId, abort);
}

export function detachRunAbort(runId: string): void {
  aborters.delete(runId);
}

export interface CancelResult {
  state: GenerationState;
}

/** Explicit cancellation of a waiting logical reply, even when no HTTP stream is open. */
export function cancelWaitingRun(userId: string, threadId: string, runId: string): CancelResult {
  const row = db
    .prepare("SELECT r.* FROM generation_runs r JOIN threads t ON t.id = r.thread_id WHERE r.id = ? AND r.thread_id = ? AND t.user_id = ?")
    .get(runId, threadId, userId) as unknown as RunRow | undefined;
  if (!row) throw new AppError({ code: "not_found", message: "Generation not found." });
  if (row.state !== "running" && row.state !== "waiting") return { state: row.state };
  aborters.get(runId)?.();
  const state = endRun(runId, { state: "aborted", finishReason: row.finish_reason, durationMs: Date.now() - row.created_at });
  return { state };
}

/** The latest assistant message's receipt for a chat, for the client's Stop-pending control. */
export function latestOpenRun(threadId: string): { runId: string; state: GenerationState } | null {
  const row = db
    .prepare("SELECT id, state FROM generation_runs WHERE thread_id = ? AND state IN ('running', 'waiting') ORDER BY created_at DESC LIMIT 1")
    .get(threadId) as { id: string; state: GenerationState } | undefined;
  return row ? { runId: row.id, state: row.state } : null;
}

// ---------------------------------------------------------------------------------------------------
// Continuation admission
// ---------------------------------------------------------------------------------------------------

export interface ContinuationTarget {
  id: string;
  text: string;
  parentId: string | null;
}

/** The specific reasons Continue may be unavailable, all safe to show. */
export type ContinuationBlock =
  | "edited"
  | "waiting"
  | "notFinished"
  | "notLength"
  | "empty"
  | "child"
  | "syncRequired";

export interface ContinuationCheck {
  ok: boolean;
  block?: ContinuationBlock;
}

/**
 * Checks a stored continuation request before any upstream call. `messages` is the stored graph,
 * `target` the assistant leaf, and `requestMessageId` the new visible user message.
 */
export function checkContinuation(input: {
  threadId: string;
  target: { id: string; text: string; editedAt: number | null; everEdited: boolean; hasChildren: boolean };
  requestMessageId: string;
  requestText: string;
  requestParentId: string | null;
  expectedTargetId: string;
  continuationText: string;
}): ContinuationCheck {
  if (input.target.editedAt !== null || input.target.everEdited) return { ok: false, block: "edited" };
  if (input.requestText !== input.continuationText) return { ok: false, block: "notFinished" };
  if (input.requestParentId !== input.expectedTargetId || input.target.id !== input.expectedTargetId) return { ok: false, block: "notFinished" };
  if (!input.target.text.trim()) return { ok: false, block: "empty" };
  const receipt = projectGenerationMetadata(input.threadId, input.target.id);
  if (!receipt) return { ok: false, block: "notFinished" };
  if (receipt.state === "waiting" || receipt.state === "running") return { ok: false, block: "waiting" };
  if (!canContinue(receipt)) return { ok: false, block: receipt.finishReason === "length" ? "notFinished" : "notLength" };
  if (input.target.hasChildren) return { ok: false, block: "child" };
  return { ok: true };
}

/** True when this request is a continuation intent (protected against a double-click). */
export function isContinueRequest(config: unknown): config is ResolvedRunConfig {
  if (!config || typeof config !== "object") return false;
  return (config as { requestKind?: unknown }).requestKind === "continue";
}

/** Builds the immutable run config for this request from the chat's copied snapshot. */
export function resolveRunConfig(input: {
  userId: string;
  threadId: string;
  requestKind: ResolvedRunConfig["requestKind"];
  modelRef: string;
  effort?: ResolvedRunConfig["reasoningEffort"];
  sampling: ResolvedRunConfig["sampling"];
  assistant: ReturnType<typeof resolveAssistantForTurn>;
  knowledgeIds: string[];
  webSearch: boolean;
  deepResearch: boolean;
  continuationOf?: string;
  turnOrigin?: ResolvedRunConfig["turnOrigin"];
  temporaryConfig?: unknown;
}): ResolvedRunConfig {
  const snapshot = input.assistant.snapshot;
  return {
    version: 1,
    requestKind: input.requestKind,
    ...(input.continuationOf ? { continuationOf: input.continuationOf } : {}),
    ...(input.turnOrigin ? { turnOrigin: input.turnOrigin } : {}),
    modelRef: input.modelRef,
    ...(input.effort ? { reasoningEffort: input.effort } : {}),
    sampling: input.sampling,
    instructions: snapshot?.instructions ?? "",
    toolPolicy: snapshot?.tools ?? { mode: "inherit", builtins: [], mcpTools: [] },
    knowledgeIds: input.knowledgeIds,
    assistantName: snapshot?.name ?? null,
    assistantIcon: snapshot?.icon ?? null,
    assistantRevision: snapshot ? input.assistant.revision : null,
    webSearch: input.webSearch,
    deepResearch: input.deepResearch,
  };
}

/** Reads a stored receipt's assistant display name, for metadata on a history row. */
export const generationAssistant = (metadata: unknown): Pick<AssistantMetadata, "generation"> => {
  const generation = generationOf(metadata);
  return generation ? { generation } : {};
};
