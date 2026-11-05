import { generateText, type LanguageModel } from "ai";
import {
  EVAL_CASE_TIMEOUT_MS,
  EVAL_JUDGE_BUDGET_MICROS,
  EVAL_MAX_CONCURRENCY,
  EVAL_MAX_OUTPUT_BYTES,
  EVAL_MIN_CONCURRENCY,
  truncateUtf8,
  utf8ByteLength,
  type EvalCaseSnapshot,
  type EvalStopReason,
  type EvalTarget,
} from "../../shared/evaluations.js";
import { FINISH_REASONS } from "../../shared/generation.js";
import { resolveModel } from "../catalog/providers.js";
import { AppError } from "../errors.js";
import { createModel, type ModelHandle } from "../llm.js";
import { featureAllowed } from "../permissions/guard.js";
import { resolvePrompt } from "../prompt-policy.js";
import { wrapUntrusted } from "../prompt-injection.js";
import { describeProviderError } from "../provider-errors.js";
import { costOf, normalizeUsage, recordUsage } from "../usage.js";
import { judgeCase } from "./judge.js";
import {
  bumpJudgeCounters,
  caseSnapshot,
  doneResultsWithOutput,
  failRunAsInterrupted,
  firstFailedResult,
  judgeScoreCost,
  markResultRunning,
  pendingResults,
  recountRun,
  runById,
  runIdsInterrupted,
  runJudgeConfig,
  runTarget,
  runUsageTotals,
  saveJudgeScore,
  setRunJudgeState,
  settleResultFailure,
  settleResultSuccess,
  skipRemaining,
  updateRunState,
  type ResultRow,
  type RunRow,
} from "./store.js";

// In-process evaluation worker. No timer and no resume: a run is a user action, so a restart fails it
// honestly instead of silently spending again. Generation and judging share two execution slots.

const EVAL_MAX_EXECUTING_RUNS = 2;
const queue: string[] = [];
const active = new Map<string, { controller: AbortController; phase: "generation" | "judge" }>();

type ModelFactory = (modelRef: string) => LanguageModel;
let modelFactory: ModelFactory | null = null;

/** Test seam: worker tests never touch the network. Production leaves this null. */
export function setEvaluationModelFactoryForTests(factory: ModelFactory | null): void {
  modelFactory = factory;
}

export function enqueueRun(_userId: string, runId: string): void {
  if (!queue.includes(runId) && !active.has(runId)) queue.push(runId);
  pump();
}

/** A judge pass waits in the same queue as generation; pump decides by the row's phase. */
export function enqueueJudge(userId: string, runId: string): void {
  enqueueRun(userId, runId);
}

export function pump(): void {
  while (active.size < EVAL_MAX_EXECUTING_RUNS && queue.length) {
    const runId = queue.shift()!;
    if (active.has(runId)) continue;
    const row = runById(runId);
    if (!row) continue;
    if (row.state === "queued") void startRun(runId);
    else if (row.judge_state === "queued") void startJudge(runId);
  }
}

export function cancelRunJob(_userId: string, runId: string): "generation" | "judge" | null {
  const index = queue.indexOf(runId);
  if (index >= 0) queue.splice(index, 1);
  const job = active.get(runId);
  if (!job) return null;
  job.controller.abort();
  return job.phase;
}

/** Called once from index.ts after interruptOpenRuns(). Never starts work. */
export function initEvaluations(): void {
  for (const runId of runIdsInterrupted()) failRunAsInterrupted(runId);
}

interface StopState {
  reason: EvalStopReason | null;
  error: AppError | null;
}

const normalizeFinish = (value: string): string | null => ((FINISH_REASONS as readonly string[]).includes(value) ? value : null);

const abortableDelay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });

async function handleFor(userId: string, target: EvalTarget | { modelRef: string; effort: EvalTarget["effort"] }) {
  const { model, conn } = await resolveModel(userId, target.modelRef);
  const handle = createModel(model, conn, { userId, ...(target.effort ? { effort: target.effort } : {}) });
  return { model, handle: modelFactory ? { ...handle, model: modelFactory(model.ref) } : handle };
}

function failBeforeStart(runId: string, error: unknown): void {
  const mapped = describeProviderError(error, { log: false });
  skipRemaining(runId, mapped.code === "aborted" ? null : mapped.code);
  updateRunState(runId, { state: "failed", stopReason: "error", errorCode: mapped.code, errorMessage: bounded(mapped.message), endedAt: Date.now() });
  active.delete(runId);
  pump();
}

const bounded = (text: string) => text.slice(0, 400);

async function startRun(runId: string): Promise<void> {
  const row = runById(runId);
  if (!row || row.state !== "queued") return;
  const userId = row.user_id;
  const target = runTarget(row);
  const controller = new AbortController();
  active.set(runId, { controller, phase: "generation" });
  let setup: Awaited<ReturnType<typeof handleFor>>;
  try {
    setup = await handleFor(userId, target);
  } catch (error) {
    failBeforeStart(runId, error);
    return;
  }
  // A cancel can land while the model resolves. Never overwrite its state or dispatch a case.
  const fresh = runById(runId);
  if (!fresh || fresh.state !== "queued" || controller.signal.aborted) {
    if (fresh?.state === "cancelling") finalize(runId, { reason: "cancelled", error: null });
    active.delete(runId);
    pump();
    return;
  }
  updateRunState(runId, { state: "running", stopReason: null, errorCode: null, errorMessage: null, startedAt: Date.now(), endedAt: null });
  const stop: StopState = { reason: null, error: null };
  try {
    const cases = pendingResults(runId);
    await pool(cases, clampConcurrency(row.concurrency), async (result) => {
      await runCase({
        runId,
        userId,
        row,
        result,
        target,
        model: setup.model,
        handle: setup.handle,
        signal: controller.signal,
        stop,
      });
    }, () => controller.signal.aborted || stop.reason !== null);
  } catch (error) {
    stop.reason = "error";
    stop.error = describeProviderError(error, { log: false });
  } finally {
    finalize(runId, stop);
    active.delete(runId);
    pump();
  }
}

function clampConcurrency(value: number): number {
  return Math.max(EVAL_MIN_CONCURRENCY, Math.min(EVAL_MAX_CONCURRENCY, Number.isInteger(value) ? value : EVAL_MIN_CONCURRENCY));
}

async function pool<T>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<void>, shouldStop: () => boolean): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      if (shouldStop()) return;
      const index = next++;
      if (index >= items.length) return;
      await worker(items[index]!);
    }
  });
  await Promise.all(runners);
}

interface CaseJob {
  runId: string;
  userId: string;
  row: RunRow;
  result: ResultRow;
  target: EvalTarget;
  model: Awaited<ReturnType<typeof handleFor>>["model"];
  handle: ModelHandle;
  signal: AbortSignal;
  stop: StopState;
}

async function runCase(job: CaseJob): Promise<void> {
  const { runId, userId, result, target, stop } = job;
  const caseId = result.case_id;
  const snapshot = caseSnapshot(result);
  if (job.signal.aborted) {
    settleResultFailure(runId, caseId, { state: "skipped", errorCode: "aborted", errorMessage: null, latencyMs: null });
    return;
  }
  if (!featureAllowed(userId, "evaluations")) {
    stop.reason = "error";
    stop.error = new AppError({ code: "forbidden", message: "Your administrator disabled evaluations for this account." });
    settleResultFailure(runId, caseId, { state: "skipped", errorCode: "forbidden", errorMessage: stop.error.message, latencyMs: null });
    return;
  }
  const spent = runUsageTotals(runId);
  if (spent.cost * 1_000_000 >= job.row.budget_micros || spent.usage.input + spent.usage.output >= job.row.budget_tokens) {
    stop.reason = "budget";
    settleResultFailure(runId, caseId, { state: "skipped", errorCode: null, errorMessage: null, latencyMs: null });
    return;
  }
  markResultRunning(runId, caseId);
  const startedAt = Date.now();
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) markResultRunning(runId, caseId);
    const timeout = AbortSignal.timeout(EVAL_CASE_TIMEOUT_MS);
    const signal = AbortSignal.any([job.signal, timeout]);
    try {
      const resultText = await generateText({
        model: job.handle.model,
        providerOptions: job.handle.providerOptions,
        maxOutputTokens: target.sampling.maxOutputTokens ?? (job.model.maxOutput || undefined),
        maxRetries: 0,
        abortSignal: signal,
        // The cache-marked system parts stay in the message list, exactly as a chat turn sends them.
        allowSystemInMessages: true,
        messages: caseMessages(userId, target, snapshot, job.handle),
        ...(target.sampling.temperature !== undefined ? { temperature: target.sampling.temperature } : {}),
        ...(target.sampling.topP !== undefined ? { topP: target.sampling.topP } : {}),
      });
      const usage = normalizeUsage(resultText.totalUsage);
      const cost = costOf(job.model.cost, usage);
      const cut = truncateUtf8(resultText.text, EVAL_MAX_OUTPUT_BYTES);
      settleResultSuccess(runId, caseId, {
        output: cut.text,
        outputBytes: utf8ByteLength(cut.text),
        truncated: cut.truncated,
        finishReason: normalizeFinish(resultText.finishReason),
        usage,
        cost,
        latencyMs: Date.now() - startedAt,
      });
      recordUsage({
        userId,
        providerId: job.model.providerId,
        modelId: job.model.id,
        kind: "evaluation",
        usage,
        cost,
      });
      return;
    } catch (error) {
      const mapped = timeout.aborted && !job.signal.aborted
        ? new AppError({ code: "timeout", message: "The case took longer than two minutes.", cause: error })
        : describeProviderError(error, { log: false, model: job.model.ref, provider: job.model.providerId });
      if (mapped.code === "aborted" && job.signal.aborted) {
        settleResultFailure(runId, caseId, { state: "skipped", errorCode: "aborted", errorMessage: null, latencyMs: Date.now() - startedAt });
        return;
      }
      const live = runById(runId);
      if (mapped.code === "rate_limited" && attempt === 0 && live?.state !== "cancelling") {
        await abortableDelay(Math.min(mapped.retryAfterMs ?? 1_000, 5_000), job.signal);
        if (job.signal.aborted) {
          settleResultFailure(runId, caseId, { state: "skipped", errorCode: "aborted", errorMessage: null, latencyMs: Date.now() - startedAt });
          return;
        }
        continue;
      }
      settleResultFailure(runId, caseId, {
        state: "error",
        errorCode: mapped.code,
        errorMessage: bounded(mapped.message),
        latencyMs: Date.now() - startedAt,
      });
      if (mapped.code === "forbidden") {
        stop.reason = "error";
        stop.error = mapped;
      }
      return;
    }
  }
}

function caseMessages(userId: string, target: EvalTarget, snapshot: EvalCaseSnapshot, handle: ModelHandle) {
  const shared = resolvePrompt("evaluationCase", { userId, modelRef: target.modelRef });
  const assistant = target.instructions.trim()
    ? wrapUntrusted(target.instructions, { kind: "assistant", name: target.assistantName ?? "assistant" }).text
    : "";
  const caseInstructions = snapshot.instructions.trim();
  const second = [assistant, caseInstructions].filter(Boolean).join("\n\n");
  return handle.markCache([shared, second], [{ role: "user", content: snapshot.input }]);
}

function finalize(runId: string, stop: StopState): void {
  let row = runById(runId);
  if (!row) return;
  let reason = stop.reason;
  if (row.state === "cancelling") reason = "cancelled";
  else if (reason === null) reason = row.failed_cases === row.total_cases && row.total_cases > 0 ? "error" : "completed";
  // Every case that never ran ends as skipped once the run stops for any reason other than success.
  if (reason !== "completed") skipRemaining(runId, stop.error?.code ?? (reason === "cancelled" ? "aborted" : null));
  recountRun(runId);
  row = runById(runId);
  if (!row) return;
  const state = reason === "completed" || reason === "budget" ? "done" : reason === "cancelled" ? "cancelled" : "failed";
  let errorCode: string | null = stop.error?.code ?? null;
  let errorMessage = stop.error ? bounded(stop.error.message) : null;
  if (reason === "error" && !errorCode) {
    const first = firstFailedResult(runId);
    errorCode = first?.code ?? "unknown";
    errorMessage = first?.message ?? "Every case failed.";
  }
  updateRunState(runId, {
    state,
    stopReason: reason,
    errorCode,
    errorMessage,
    endedAt: Date.now(),
  });
}

async function startJudge(runId: string): Promise<void> {
  const row = runById(runId);
  if (!row || row.judge_state !== "queued") return;
  const userId = row.user_id;
  const config = runJudgeConfig(row);
  if (!config) {
    setRunJudgeState(runId, "failed");
    return;
  }
  const controller = new AbortController();
  active.set(runId, { controller, phase: "judge" });
  let setup: Awaited<ReturnType<typeof handleFor>>;
  try {
    setup = await handleFor(userId, config);
  } catch {
    setRunJudgeState(runId, "failed");
    active.delete(runId);
    pump();
    return;
  }
  const freshJudge = runById(runId);
  if (!freshJudge || freshJudge.judge_state !== "queued" || controller.signal.aborted) {
    active.delete(runId);
    pump();
    return;
  }
  setRunJudgeState(runId, "running");
  let spent = judgeScoreCost(runId);
  let done = 0;
  let failed = 0;
  let cancelled = false;
  let denied = false;
  const targets = doneResultsWithOutput(runId);
  for (const target of targets) {
    if (controller.signal.aborted) {
      cancelled = true;
      break;
    }
    if (!featureAllowed(userId, "evaluations")) {
      denied = true;
      break;
    }
    if (spent * 1_000_000 >= EVAL_JUDGE_BUDGET_MICROS) break;
    const current = runById(runId);
    if (current?.judge_state !== "running") {
      cancelled = current?.judge_state === "cancelled";
      break;
    }
    const verdict = await judgeCase({
      userId,
      model: setup.model,
      handle: setup.handle,
      config,
      case: caseSnapshot(target),
      output: target.output,
      signal: controller.signal,
    });
    if (!verdict.ok) {
      if (verdict.error.code === "aborted" && controller.signal.aborted) {
        cancelled = true;
        break;
      }
      failed += 1;
      bumpJudgeCounters(runId, 0, 1);
      continue;
    }
    saveJudgeScore(runId, target.case_id, {
      score: verdict.score,
      rationale: verdict.rationale,
      modelRef: config.modelRef,
      rubricHash: config.rubricHash,
      usage: verdict.usage,
      cost: verdict.cost,
      scale: config.scale,
    });
    recordUsage({
      userId,
      providerId: setup.model.providerId,
      modelId: setup.model.id,
      kind: "evaluation_judge",
      usage: verdict.usage,
      cost: verdict.cost,
    });
    spent += verdict.cost;
    done += 1;
    bumpJudgeCounters(runId, 1, 0);
  }
  const live = runById(runId);
  if (live?.judge_state === "running") {
    setRunJudgeState(
      runId,
      cancelled ? "cancelled" : denied || (failed > 0 && failed >= targets.length && targets.length > 0) ? "failed" : "done",
    );
  }
  active.delete(runId);
  pump();
}

/** Read-only helper for tests and diagnostics: which runs this process is executing. */
export function activeEvaluationRuns(): Array<{ runId: string; phase: "generation" | "judge" }> {
  return [...active].map(([runId, job]) => ({ runId, phase: job.phase }));
}

/** Queue length for tests and diagnostics; no caller needs it in production. */
export function queuedEvaluationRuns(): number {
  return queue.length;
}
