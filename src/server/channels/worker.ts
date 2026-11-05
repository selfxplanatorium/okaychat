import { streamText } from "ai";
import { db, tx } from "../db.js";
import { decrypt } from "../crypto.js";
import { AppError } from "../errors.js";
import { describeBoundaryError } from "../provider-errors.js";
import { resolveModel } from "../catalog/providers.js";
import { createModel } from "../llm.js";
import { reserveTurn } from "../chat.js";
import { holdLease, reserveOperation } from "../permissions/limits.js";
import { onPermissionChange } from "../permissions/audit.js";
import { featureAllowed } from "../permissions/guard.js";
import { addUsage, costOf, normalizeUsage, recordUsage, ZERO_USAGE } from "../usage.js";
import { CHANNEL_LIMITS, type ChannelRunProjection } from "../../shared/channels.js";
import type { ReasoningEffort, TokenUsage } from "../../shared/types.js";
import { channelAccess, channelRow, notFound, requireChannelsFeature } from "./access.js";
import { buildSnapshot, prepareChannelPrompt, storedBinding, trimSnapshot, type ChannelInputSnapshot } from "./ai.js";
import { insertSync } from "./events.js";
import { cancelQueuedRun, checkpointRun, markRunRunning, runRow, settleRun, type ChannelRunRowFull } from "./store.js";
import { notifyAiFinished } from "./notifications.js";
import { onChannelRevocation } from "./revocation.js";

/**
 * Explicit channel AI replies. One in-process FIFO, two executing slots, no external broker. Work is
 * never re-dispatched after a restart: init marks open rows interrupted and keeps the last checkpoint.
 */

const MAX_ACTIVE = CHANNEL_LIMITS.aiActive;
const MAX_QUEUE = CHANNEL_LIMITS.aiQueue;
const queue: string[] = [];
const active = new Map<string, AbortController>();
interface LiveSnapshot {
  channelId: string;
  text: string;
  usage: TokenUsage;
  cost: number;
  sawUsage: boolean;
}
/** Latest durable in-memory progress, so a hard room delete can settle observed usage first. */
const live = new Map<string, LiveSnapshot>();
let initialized = false;

export function channelQueueDepth(): number {
  return queue.length;
}

export function channelActiveCount(): number {
  return active.size;
}

export function enqueueChannelRun(runId: string): void {
  if (queue.includes(runId) || active.has(runId)) return;
  const run = runRow(runId);
  if (!run || run.state !== "queued") return;
  if (queue.length >= MAX_QUEUE) {
    settleAndBill(run, { state: "failed", finishReason: null, errorCode: "rate_limited", body: "" });
    return;
  }
  queue.push(runId);
  void pump();
}

async function pump(): Promise<void> {
  while (active.size < MAX_ACTIVE && queue.length) {
    const id = queue.shift()!;
    if (active.has(id)) continue;
    const controller = new AbortController();
    active.set(id, controller);
    void runOne(id, controller).catch(() => {}).finally(() => {
      active.delete(id);
      void pump();
    });
  }
}

function safeRunId(runId: string): ChannelRunRowFull | undefined {
  return runRow(runId);
}

async function runOne(runId: string, controller: AbortController): Promise<void> {
  const initial = safeRunId(runId);
  if (!initial || initial.state !== "queued") return;
  if (Date.now() - initial.created_at > CHANNEL_LIMITS.aiQueueTtlMs) {
    settleAndBill(initial, { state: "failed", finishReason: null, errorCode: "timeout", body: "" });
    return;
  }
  const requesterId = initial.requester_id;
  if (!requesterId) {
    settleAndBill(initial, { state: "failed", finishReason: null, errorCode: "forbidden", body: "" });
    return;
  }
  const channel = channelRow(initial.channel_id);
  if (!channel || channel.archived_at !== null) {
    settleAndBill(initial, { state: "failed", finishReason: null, errorCode: "conflict", body: "" });
    return;
  }
  const access = channelAccess(requesterId, channel.id);
  if (!access || !access.member || !access.eligible) {
    settleAndBill(initial, { state: "failed", finishReason: null, errorCode: "forbidden", body: "" });
    return;
  }
  try {
    requireChannelsFeature(requesterId);
  } catch (error) {
    settleAndBill(initial, { state: "failed", finishReason: null, errorCode: (error as AppError).code ?? "forbidden", body: "" });
    return;
  }
  const source = db.prepare("SELECT id, deleted_at FROM channel_messages WHERE channel_id = ? AND id = ?").get(channel.id, initial.source_id) as
    | { id: string; deleted_at: number | null }
    | undefined;
  if (!source || source.deleted_at !== null) {
    settleAndBill(initial, { state: "failed", finishReason: null, errorCode: "not_found", body: "" });
    return;
  }
  const binding = storedBinding(channel.ai_json);
  if (!binding) {
    settleAndBill(initial, { state: "failed", finishReason: null, errorCode: "validation", body: "" });
    return;
  }

  let resolved: Awaited<ReturnType<typeof resolveModel>>;
  try {
    resolved = await resolveModel(requesterId, initial.model_ref);
  } catch (error) {
    settleAndBill(initial, { state: "failed", finishReason: null, errorCode: describeBoundaryError(error, { kind: "background" }).code, body: "" });
    return;
  }
  const requester = db.prepare("SELECT 1 FROM users WHERE id = ?").get(requesterId);
  if (!requester || runRow(runId)?.state !== "queued") return;

  const releaseTurn = reserveTurn(requesterId);
  if (!releaseTurn) {
    settleAndBill(initial, { state: "failed", finishReason: null, errorCode: "rate_limited", body: "" });
    return;
  }
  let releaseLease: (() => void) | null = null;
  try {
    const lease = reserveOperation({ userId: requesterId, modelRef: initial.model_ref }, "llm.call", { kind: "turn" });
    releaseLease = holdLease(lease, () => controller.abort(new AppError({ code: "aborted", message: "The operation lease expired." })));
  } catch (error) {
    releaseTurn();
    settleAndBill(initial, { state: "failed", finishReason: null, errorCode: describeBoundaryError(error, { kind: "background" }).code, body: "" });
    return;
  }

  try {
    if (!markRunRunning(runId)) return;
    const running = runRow(runId);
    if (!running) return;
    if (!running.input_enc) {
      settleAndBill(running, { state: "failed", finishReason: null, errorCode: "validation", body: "" });
      return;
    }
    let snapshot: ChannelInputSnapshot;
    try {
      const decoded = JSON.parse(decrypt(running.input_enc)) as { v?: number; snapshot?: ChannelInputSnapshot };
      if (decoded.v !== 1 || !decoded.snapshot) throw new Error("Unsupported channel input");
      snapshot = decoded.snapshot;
    } catch {
      settleAndBill(running, { state: "failed", finishReason: null, errorCode: "validation", body: "" });
      return;
    }
    const guard = () => {
      const current = runRow(runId);
      if (!current || current.state !== "running") throw new AppError({ code: "aborted", message: "This reply was stopped." });
      const liveChannel = channelRow(channel.id);
      if (!liveChannel || liveChannel.archived_at !== null) throw new AppError({ code: "conflict", message: "This room was archived." });
      const live = channelAccess(requesterId, channel.id);
      if (!live || !live.member || !live.eligible) throw new AppError({ code: "forbidden", message: "You no longer have access to this room." });
      if (!featureAllowed(requesterId, "channels")) throw new AppError({ code: "forbidden", message: "Team channels are disabled for this account." });
      if (liveChannel.ai_json !== channel.ai_json) throw new AppError({ code: "conflict", message: "This room's AI binding changed." });
    };
    let prepared: ReturnType<typeof prepareChannelPrompt>;
    let handle: ReturnType<typeof createModel>;
    try {
      prepared = prepareChannelPrompt({
        userId: requesterId,
        modelRef: running.model_ref,
        channel: channelRow(channel.id)!,
        binding,
        snapshot: trimSnapshot(snapshot),
        modelContext: resolved.model.context,
        modelMaxOutput: resolved.model.maxOutput,
      });
      guard();
      handle = createModel(resolved.model, resolved.conn, { userId: requesterId, effort: binding.reasoningEffort as ReasoningEffort | undefined, guard });
    } catch (error) {
      const wire = describeBoundaryError(error, { kind: "background", model: resolved.model.ref, provider: resolved.model.providerId });
      settleAndBill(running, { state: "failed", finishReason: null, errorCode: wire.code, body: "" });
      return;
    }
    // Cache marking is the same per-account affinity as private chats; the system parts are the first
    // two messages, so a later room request can reuse the stable policy prefix.
    const messages = handle.markCache(prepared.system, prepared.messages);
    const deadline = AbortSignal.timeout(CHANNEL_LIMITS.aiDeadlineMs);
    const signal = AbortSignal.any([controller.signal, deadline]);
    let text = "";
    let textBytes = 0;
    let lastCheckpointAt = Date.now();
    let lastCheckpointBytes = 0;
    let checkpointCount = 0;
    let outputLimit = false;
    let usage: TokenUsage = ZERO_USAGE;
    let cost = 0;
    let sawUsage = false;
    live.set(runId, { channelId: channel.id, text: "", usage, cost, sawUsage });
    let result: ReturnType<typeof streamText>;
    try {
      result = streamText({
        model: handle.model,
        messages,
        allowSystemInMessages: true,
        providerOptions: handle.providerOptions,
        maxRetries: 0,
        maxOutputTokens: prepared.outputAllowance,
        abortSignal: signal,
        ...(binding.sampling?.temperature !== undefined ? { temperature: binding.sampling.temperature } : {}),
        ...(binding.sampling?.topP !== undefined ? { topP: binding.sampling.topP } : {}),
        onStepEnd: (step) => {
          const stepUsage = normalizeUsage(step.usage);
          usage = addUsage(usage, stepUsage);
          cost += costOf(resolved.model.cost, stepUsage);
          sawUsage ||= Object.values(stepUsage).some((value) => value > 0);
          const state = live.get(runId);
          if (state) { state.usage = usage; state.cost = cost; state.sawUsage = sawUsage; }
        },
      });
      for await (const part of result.fullStream) {
        guard();
        if (part.type === "text-delta") {
          text += part.text;
          const state = live.get(runId);
          if (state) state.text = text;
          textBytes = Buffer.byteLength(text, "utf8");
          if (textBytes > CHANNEL_LIMITS.aiOutputBytes) {
            text = truncateUtf8(text, CHANNEL_LIMITS.aiOutputBytes);
            outputLimit = true;
            break;
          }
          const now = Date.now();
          if (checkpointCount < 240 && (textBytes - lastCheckpointBytes >= 1024 || now - lastCheckpointAt >= 500)) {
            checkpointRun(runId, text);
            checkpointCount++;
            lastCheckpointAt = now;
            lastCheckpointBytes = textBytes;
          }
        } else if (part.type === "error") {
          throw part.error instanceof Error ? part.error : new Error("Channel provider failed");
        }
      }
      if (outputLimit) {
        checkpointRun(runId, text);
        settleAndBill(runRow(runId)!, { state: "finished", finishReason: "output_limit", errorCode: null, body: text, ...(sawUsage ? { usage, cost } : {}) });
        return;
      }
      const finish = await Promise.resolve(result.finishReason).catch(() => undefined);
      const total = await Promise.resolve(result.totalUsage).catch(() => undefined);
      if (total) {
        usage = normalizeUsage(total);
        cost = costOf(resolved.model.cost, usage);
        sawUsage ||= Object.values(usage).some((value) => value > 0);
      }
      const reason = finish === "length" ? "length" : finish === "stop" ? "stop" : finish ?? "unknown";
      settleAndBill(runRow(runId)!, { state: "finished", finishReason: reason, errorCode: null, body: text, ...(sawUsage ? { usage, cost } : {}) });
    } catch (error) {
      const current = runRow(runId);
      if (!current) return;
      if (controller.signal.aborted || deadline.aborted) {
        if (Date.now() - (current.started_at ?? Date.now()) >= CHANNEL_LIMITS.aiDeadlineMs) {
          settleAndBill(current, { state: "failed", finishReason: null, errorCode: "timeout", body: text, ...(sawUsage ? { usage, cost } : {}) });
        } else {
          settleAndBill(current, { state: "cancelled", finishReason: null, errorCode: null, body: text, ...(sawUsage ? { usage, cost } : {}) });
        }
        return;
      }
      const wire = describeBoundaryError(error, { kind: "background", model: resolved.model.ref, provider: resolved.model.providerId });
      settleAndBill(current, { state: "failed", finishReason: null, errorCode: wire.code, body: text, ...(sawUsage ? { usage, cost } : {}) });
    }
  } finally {
    releaseLease?.();
    releaseTurn();
  }
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let out = "";
  for (const char of text) {
    if (Buffer.byteLength(out + char, "utf8") > maxBytes) break;
    out += char;
  }
  return out;
}

/** Settlement and its one usage ledger row happen in the same transaction. */
function settleAndBill(
  run: ChannelRunRowFull,
  input: { state: "finished" | "cancelled" | "failed" | "interrupted"; finishReason: string | null; errorCode: string | null; body: string; usage?: TokenUsage; cost?: number },
): void {
  live.delete(run.id);
  const outcome: { settled: ReturnType<typeof settleRun> } = { settled: null };
  tx(() => {
    outcome.settled = settleRun(run.id, {
      state: input.state,
      finishReason: input.finishReason,
      errorCode: input.errorCode,
      body: input.body,
      ...(input.usage ? { usageJson: JSON.stringify(input.usage), cost: input.cost ?? 0, usageRecorded: true } : { usageRecorded: false }),
    });
    if (outcome.settled && input.usage && run.requester_id) {
      const slash = run.model_ref.indexOf("/");
      recordUsage({
        userId: run.requester_id,
        providerId: slash > 0 ? run.model_ref.slice(0, slash) : run.model_ref,
        modelId: slash > 0 ? run.model_ref.slice(slash + 1) : run.model_ref,
        kind: "channel",
        channelId: run.channel_id,
        channelRunId: run.id,
        usage: input.usage,
        cost: input.cost ?? 0,
      });
    }
  });
  if (outcome.settled) {
    const channel = channelRow(run.channel_id);
    if (channel) notifyAiFinished(channel, outcome.settled.messageId, outcome.settled.seq, run.id, run.requester_id);
  }
}

// ---------------------------------------------------------------------------------------------------
// Cancellation and revocation
// ---------------------------------------------------------------------------------------------------

export function cancelChannelRun(runId: string): boolean {
  const run = runRow(runId);
  if (!run || (run.state !== "queued" && run.state !== "running")) return false;
  if (run.state === "queued") {
    const index = queue.indexOf(runId);
    if (index >= 0) queue.splice(index, 1);
    if (cancelQueuedRun(runId, run.requester_id)) return true;
  }
  const controller = active.get(runId);
  if (controller) {
    controller.abort(new AppError({ code: "aborted", message: "This reply was stopped." }));
    return true;
  }
  return false;
}

export function cancelRunsForSource(channelId: string, sourceId: string): void {
  const rows = db.prepare("SELECT id FROM channel_ai_runs WHERE channel_id = ? AND source_id = ? AND state IN ('queued', 'running')").all(channelId, sourceId) as Array<{ id: string }>;
  for (const row of rows) cancelChannelRun(row.id);
}

export function abortChannelRuns(channelId: string): void {
  const rows = db.prepare("SELECT id FROM channel_ai_runs WHERE channel_id = ? AND state IN ('queued', 'running')").all(channelId) as Array<{ id: string }>;
  for (const row of rows) cancelChannelRun(row.id);
}

/**
 * Hard room deletion: cancel every run and settle the latest observed usage/partial body before the
 * room's run rows cascade away. A queued run never started and is terminal without a call.
 */
export function settleRunsForDeletion(channelId: string): void {
  const rows = db.prepare("SELECT id FROM channel_ai_runs WHERE channel_id = ? AND state IN ('queued', 'running')").all(channelId) as Array<{ id: string }>;
  for (const row of rows) {
    const run = runRow(row.id);
    if (!run) continue;
    if (run.state === "queued") {
      const index = queue.indexOf(run.id);
      if (index >= 0) queue.splice(index, 1);
      cancelQueuedRun(run.id, run.requester_id);
      continue;
    }
    const snapshot = live.get(run.id);
    active.get(run.id)?.abort(new AppError({ code: "aborted", message: "This room was deleted." }));
    active.delete(run.id);
    if (snapshot) {
      settleAndBill(run, {
        state: "cancelled",
        finishReason: null,
        errorCode: null,
        body: snapshot.text,
        ...(snapshot.sawUsage ? { usage: snapshot.usage, cost: snapshot.cost } : {}),
      });
    } else {
      settleAndBill(run, { state: "cancelled", finishReason: null, errorCode: null, body: "" });
    }
  }
}

/** Account deletion: stop and settle that account's requests and every run in its rooms. */
export function abortChannelRunsForUser(userId: string): void {
  const rows = db
    .prepare(
      `SELECT DISTINCT r.channel_id AS channelId FROM channel_ai_runs r JOIN channels c ON c.id = r.channel_id
       WHERE (r.requester_id = ? OR c.owner_id = ?) AND r.state IN ('queued', 'running')`,
    )
    .all(userId, userId) as Array<{ channelId: string }>;
  for (const row of rows) settleRunsForDeletion(row.channelId);
  // Any run merely requested by the account in someone else's room was included above.
}

function runStillValid(run: ChannelRunRowFull): boolean {
  if (!run.requester_id) return false;
  const channel = channelRow(run.channel_id);
  if (!channel || channel.archived_at !== null) return false;
  const access = channelAccess(run.requester_id, channel.id);
  if (!access || !access.member || !access.eligible) return false;
  if (!featureAllowed(run.requester_id, "channels")) return false;
  try {
    const binding = storedBinding(channel.ai_json);
    if (!binding || binding.modelRef !== run.model_ref) return false;
  } catch {
    return false;
  }
  return true;
}

function abortRevoked(): void {
  for (const [runId, controller] of active) {
    const run = runRow(runId);
    if (!run || !runStillValid(run)) controller.abort(new AppError({ code: "forbidden", message: "Access to this room or model changed." }));
  }
  // Queue entries are rechecked at pump; a generic sync tells clients to reconcile memberships.
  insertSync();
}

/** Startup recovery and the one-time listeners. Called from index.ts before accepting AI jobs. */
export function initChannelWorker(): void {
  if (initialized) return;
  initialized = true;
  const interrupted = db.prepare("SELECT id FROM channel_ai_runs WHERE state IN ('queued', 'running')").all() as Array<{ id: string }>;
  if (interrupted.length) {
    tx(() => {
      for (const row of interrupted) {
        db.prepare("UPDATE channel_ai_runs SET state = 'interrupted', ended_at = ?, input_enc = NULL, reserved_bytes = 0 WHERE id = ?").run(Date.now(), row.id);
      }
      insertSync();
    });
  }
  onChannelRevocation(abortRevoked);
  onPermissionChange(() => abortRevoked());
  // Queued rows that outlived their admission window fail instead of waiting forever.
  const timer = setInterval(() => {
    for (const runId of [...queue]) {
      const run = runRow(runId);
      if (!run || run.state !== "queued" || Date.now() - run.created_at > CHANNEL_LIMITS.aiQueueTtlMs) {
        queue.splice(queue.indexOf(runId), 1);
        if (run) settleAndBill(run, { state: "failed", finishReason: null, errorCode: "timeout", body: "" });
      }
    }
  }, 15_000);
  timer.unref?.();
}

export function enqueueSourceSnapshot(channelId: string, sourceId: string, requesterId: string): ChannelInputSnapshot {
  const channel = channelRow(channelId);
  if (!channel) throw notFound();
  if (!db.prepare("SELECT 1 FROM channel_messages WHERE channel_id = ? AND id = ? AND deleted_at IS NULL").get(channelId, sourceId)) throw notFound();
  return trimSnapshot(buildSnapshot(channel, sourceId, requesterId));
}

/** A safe run projection helper for routes; never includes input, config, or usage cost. */
export function runState(runId: string): ChannelRunProjection | null {
  const run = runRow(runId);
  if (!run) return null;
  return {
    id: run.id,
    messageId: run.message_id,
    sourceId: run.source_id,
    state: run.state,
    outputVersion: run.output_version,
    finishReason: run.finish_reason,
    errorCode: run.error_code,
    requesterId: run.requester_id,
    createdAt: run.created_at,
    startedAt: run.started_at,
    endedAt: run.ended_at,
    usageReported: run.usage_json !== null,
  };
}
