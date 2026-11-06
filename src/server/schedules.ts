import { admitCreditRoot, type CreditPermit } from "./credits/store.js";
import { endCreditRoot, assertMeteredService } from "./credits/admission.js";
import { agentMetadata } from "./n8n/provenance.js";
import { deleteSession } from "./n8n/store.js";
import { generateId, readUIMessageStream, type UIMessage } from "ai";
import { Hono } from "hono";
import { z } from "zod";
import type { Schedule, ScheduleSpec } from "../shared/types.js";
import type { AppEnv } from "./auth.js";
import { reserveTurn, turnStream } from "./chat.js";
import { markBusy, threadBusy } from "./thread-runs.js";
import { newId } from "./crypto.js";
import { db, tx } from "./db.js";
import { AppError } from "./errors.js";
import { getProject } from "./projects.js";
import { describeBoundaryError } from "./provider-errors.js";
import { appendMessage, currentBranch, ensureThread, getThread, updateThread } from "./threads.js";
import { assertFeature, assertModelAllowed, featureAllowed } from "./permissions/guard.js";
import { notify } from "./notifications.js";
import { isRestrictedKnowledgeThread } from "./knowledge/thread-policy.js";
import { emitScheduleCompleted, emitScheduleFailed } from "./outgoing-webhooks/events.js";
import type { FailureCode } from "../shared/outgoing-webhooks.js";
import { generationOf } from "../shared/generation.js";

// Scheduled prompts run on the server with nobody watching: append the prompt to the schedule's thread (or a new
// one per run), run one turn, and persist both messages in the client's history format so the thread opens normally.

const RUN_TIMEOUT_MS = 10 * 60_000;
const MIN_INTERVAL_MIN = 15;
// Each schedule runs unattended, possibly on a server-wide provider key. Bound what one account can queue.
const MAX_SCHEDULES = 50;

interface Row {
  id: string;
  user_id: string;
  thread_id: string | null;
  thread_mode: Schedule["threadMode"];
  thread_attached: number;
  project_id: string | null;
  title: string;
  prompt: string;
  model_ref: string;
  spec_json: string;
  enabled: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_status: Schedule["lastStatus"];
  last_error: string | null;
  webhook_invocation_id: string | null;
  webhook_started_at: number | null;
}

const toSchedule = (r: Row): Schedule => ({
  id: r.id,
  threadMode: r.thread_mode,
  threadId: r.thread_id,
  threadAttached: !!r.thread_attached,
  projectId: r.project_id,
  title: r.title,
  prompt: r.prompt,
  modelRef: r.model_ref,
  spec: JSON.parse(r.spec_json) as ScheduleSpec,
  enabled: !!r.enabled,
  nextRunAt: r.next_run_at,
  lastRunAt: r.last_run_at,
  lastStatus: r.last_status,
  lastError: r.last_error,
});

/** Minutes east of UTC for `timeZone` at `at`. */
function offsetMinutes(timeZone: string, at: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" })
      .formatToParts(new Date(at))
      .map((p) => [p.type, Number(p.value)]),
  );
  return (Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!) - Math.floor(at / 60_000) * 60_000) / 60_000;
}

/** The next run strictly after `after`. */
export function nextRun(spec: ScheduleSpec, after: number): number | null {
  if (spec.kind === "interval") return after + Math.max(MIN_INTERVAL_MIN, spec.minutes) * 60_000;
  const [hh, mm] = spec.time.split(":").map(Number) as [number, number];
  const offset = offsetMinutes(spec.timeZone, after);
  const local = new Date(after + offset * 60_000);
  for (let d = 0; d <= 7; d++) {
    const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + d, hh, mm));
    if (spec.weekdays.length && !spec.weekdays.includes(day.getUTCDay())) continue;
    const at = wallTimeToUtc(spec.timeZone, day.getTime());
    if (at > after) return at;
  }
  return null;
}

/**
 * The UTC instant of a local wall time (given as a UTC-labelled timestamp). Tries the zone's offsets
 * before and after any change that day: a repeated time (autumn) takes its first occurrence, and a
 * skipped time (the spring gap) moves forward by the gap, never back before it.
 */
function wallTimeToUtc(timeZone: string, wall: number): number {
  const offsets = new Set([offsetMinutes(timeZone, wall - 14 * 3_600_000), offsetMinutes(timeZone, wall + 14 * 3_600_000)]);
  const candidates = [...offsets].map((offset) => wall - offset * 60_000);
  const valid = candidates.filter((at) => at + offsetMinutes(timeZone, at) * 60_000 === wall);
  return valid.length ? Math.min(...valid) : Math.max(...candidates);
}

const running = new Set<string>();
/** Flipped by `reconcileScheduleInvocations`; the module timer never runs before it. */
let scheduleReconciled = false;

/**
 * Runs one schedule. It takes one of the account's turn slots (the same limit as interactive chat)
 * unless the caller already reserved it; without a free slot the run stays due for the next tick.
 */
export async function runSchedule(row: Row, reserved?: () => void): Promise<void> {
  if (running.has(row.id)) return reserved?.();
  // Pickup re-checks the feature and the schedule's own model, so a revoke after creation stops future
  // runs without a provider call. The record stays, the failure is safe, and the next due time is normal
  // (never a rapid retry).
  if (!featureAllowed({ userId: row.user_id, modelRef: row.model_ref }, "schedules")) {
    recordSkipped(row, "Scheduled prompts are disabled for this account.");
    return reserved?.();
  }
  // A restricted chat never becomes an unattended turn, even if the schedule predates the transition.
  if (row.thread_id && isRestrictedKnowledgeThread(row.thread_id)) {
    recordSkipped(row, "This schedule's chat uses shared knowledge.");
    return reserved?.();
  }
  try {
    assertModelAllowed(row.user_id, row.model_ref);
  } catch {
    recordSkipped(row, "This schedule's model is not allowed for this account.");
    return reserved?.();
  }
  // Admission comes before any thread or prompt is written, so a refused occurrence leaves no history.
  let creditPermit: CreditPermit;
  try {
    const agent = row.model_ref.startsWith("n8n/");
    if (agent) assertMeteredService(row.user_id, "agent");
    creditPermit = admitCreditRoot(row.user_id, agent ? "unmetered" : "schedule");
  } catch (error) {
    recordSkipped(row, error instanceof Error ? error.message : "Token allowance unavailable.");
    return reserved?.();
  }
  const release = reserved ?? reserveTurn(row.user_id);
  if (!release) { await endCreditRoot(creditPermit); return; }
  running.add(row.id);
  const startedAt = Date.now();
  // A server-generated invocation id is the source identity for an outgoing schedule event. It is
  // allocated only after slot and permission checks, and cleared in the same terminal transaction.
  const invocationId = newId("srun");
  db.prepare(
    "UPDATE schedules SET last_status = 'running', last_error = NULL, next_run_at = ?, webhook_invocation_id = ?, webhook_started_at = ? WHERE id = ?",
  ).run(nextRun(JSON.parse(row.spec_json) as ScheduleSpec, startedAt), invocationId, startedAt, row.id);
  let runFailure: FailureCode = "run_error";
  let terminal = false;
  let releaseThread: (() => void) | undefined;
  // The failure notice names the chat the run landed in, when it still exists.
  let threadId = row.thread_mode === "same" ? row.thread_id : null;
  try {
    if (threadId && !getThread(row.user_id, threadId)) {
      // A chat the user picked is theirs to delete; recreating it would surprise them.
      if (row.thread_attached) {
        db.prepare("UPDATE schedules SET enabled = 0, next_run_at = NULL, thread_id = NULL, thread_attached = 0 WHERE id = ?").run(row.id);
        throw new AppError({ code: "not_found", message: "Its chat was deleted, so the schedule was turned off." });
      }
      threadId = null;
    }
    if (!threadId) {
      threadId = newId("thr");
      ensureThread(row.user_id, threadId, row.project_id);
      updateThread(row.user_id, threadId, { title: row.thread_mode === "new" ? `${row.title} · ${runLabel(row, startedAt)}` : row.title });
      db.prepare("UPDATE schedules SET thread_id = ? WHERE id = ?").run(threadId, row.id);
    }
    // Edits to this chat's messages wait until the run has stored its reply.
    releaseThread = markBusy(threadId);
    const history = row.thread_mode === "new" ? [] : currentBranch(row.user_id, threadId);
    const userMessage: UIMessage = { id: generateId(), role: "user", parts: [{ type: "text", text: row.prompt }], metadata: { custom: { scheduleId: row.id } } };
    appendMessage(row.user_id, threadId, { id: userMessage.id, parent_id: history.at(-1)?.id ?? null, format: "ai-sdk/v6", content: withoutId(userMessage) });

    const stream = await turnStream({
      creditPermit,
      userId: row.user_id,
      threadId,
      modelRef: row.model_ref,
      keepThreadModel: !!row.thread_attached,
      uiMessages: [...history, userMessage],
      // Nobody can answer an approval in a scheduled run, so a gated call is denied instead of waiting.
      unattended: true,
      turnOrigin: "schedule",
      signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
    });
    let assistant: UIMessage | undefined;
    for await (const message of readUIMessageStream({ stream })) assistant = message;
    if (!assistant) {
      runFailure = "empty_response";
      throw new AppError({ code: "tool_failed", message: "The model returned nothing." });
    }
    const agent = agentMetadata(assistant);
    const receipt = generationOf(assistant.metadata);
    const failed =
      assistant.parts.length === 0 ||
      (agent?.usageMode === "agent" && agent?.agent?.outcome !== "ok") ||
      (receipt !== undefined && receipt.state !== "finished");
    const text = visibleAnswerText(assistant);
    if (failed) runFailure = text ? "run_error" : "empty_response";
    // appendMessage creates a missing thread; a chat deleted during the run must stay deleted.
    if (!getThread(row.user_id, threadId)) {
      runFailure = "run_error";
      throw new AppError({ code: "not_found", message: "Its chat was deleted while the run was replying." });
    }
    const assistantId = assistant.id || generateId();
    const targetThreadId = threadId;
    // Reply, terminal status, and the event admission share one transaction: a rollback leaves no event.
    tx(() => {
      appendMessage(row.user_id, targetThreadId, { id: assistantId, parent_id: userMessage.id, format: "ai-sdk/v6", content: withoutId(assistant) });
      db.prepare(
        "UPDATE schedules SET last_run_at = ?, last_status = ?, last_error = ?, webhook_invocation_id = NULL, webhook_started_at = NULL WHERE id = ?",
      ).run(startedAt, failed ? "error" : "ok", failed ? (text ? "The run did not finish cleanly." : "Empty response") : null, row.id);
      if (failed) {
        emitScheduleFailed({
          userId: row.user_id,
          scheduleId: row.id,
          invocationId,
          startedAt,
          threadId: targetThreadId,
          assistantMessageId: assistantId,
          failureCode: runFailure,
        });
      } else {
        emitScheduleCompleted({
          userId: row.user_id,
          scheduleId: row.id,
          invocationId,
          startedAt,
          threadId: targetThreadId,
          assistantMessageId: assistantId,
          text,
        });
      }
    });
    // A later notification/cleanup failure must not rewrite a completed run into a second terminal outcome.
    terminal = true;
    // A notice explains the run to an account that had no tab open; it never carries the prompt or reply.
    const stored = threadId ? getThread(row.user_id, threadId) : null;
    try {
      notify({
        userId: row.user_id,
        kind: "schedule",
        level: failed ? "error" : "success",
        titleKey: failed ? "schedule.error" : "schedule.ok",
        bodyKey: failed ? "schedule.errorBody" : "schedule.okBody",
        params: failed
          ? { title: row.title, error: "The model returned nothing." }
          : { title: row.title, thread: stored?.title ?? "" },
        threadId: stored ? threadId : null,
        actionPath: stored ? `/c/${threadId}` : "/scheduled",
        sourceKey: `schedule:${row.id}:${startedAt}`,
      });
    } catch {
      // A notice must never fail a run.
    }
  } catch (error) {
    const failure = describeBoundaryError(error, { log: true, kind: "background", model: row.model_ref });
    const timedOut = [error, (error as { cause?: unknown }).cause].some(
      (candidate) => candidate instanceof Error && (candidate.name === "TimeoutError" || candidate.name === "AbortError"),
    );
    if (runFailure === "run_error" && timedOut) runFailure = "timeout";
    if (!terminal) {
      // The failure status and its metadata-only event commit together; no prompt, error sentence, or
      // partial answer is exported. A busy/due skip never reaches this point and emits nothing.
      tx(() => {
        db.prepare(
          "UPDATE schedules SET last_run_at = ?, last_status = 'error', last_error = ?, webhook_invocation_id = NULL, webhook_started_at = NULL WHERE id = ?",
        ).run(startedAt, failure.message.slice(0, 500), row.id);
        emitScheduleFailed({
          userId: row.user_id,
          scheduleId: row.id,
          invocationId,
          startedAt,
          threadId: threadId && getThread(row.user_id, threadId) ? threadId : null,
          assistantMessageId: null,
          failureCode: runFailure,
        });
      });
    }
    try {
      notify({
        userId: row.user_id,
        kind: "schedule",
        level: "error",
        titleKey: "schedule.error",
        bodyKey: "schedule.errorBody",
        params: { title: row.title, error: failure.message.slice(0, 200) },
        threadId: threadId && getThread(row.user_id, threadId) ? threadId : null,
        actionPath: threadId && getThread(row.user_id, threadId) ? `/c/${threadId}` : "/scheduled",
        sourceKey: `schedule:${row.id}:${startedAt}`,
      });
    } catch {
      // A notice must never fail a run.
    }
  } finally {
    await endCreditRoot(creditPermit);
    releaseThread?.();
    running.delete(row.id);
    release();
  }
}

/** A permission failure leaves a normal record and the next regular due time, never an immediate retry. */
function recordSkipped(row: Row, message: string) {
  const next = nextRun(JSON.parse(row.spec_json) as ScheduleSpec, Date.now());
  db.prepare("UPDATE schedules SET last_run_at = ?, last_status = 'error', last_error = ?, next_run_at = ? WHERE id = ?").run(
    Date.now(),
    message,
    next,
    row.id,
  );
  // The reason explains an outage, not a model result, so this stays a notice even with the feature off.
  try {
    notify({
      userId: row.user_id,
      kind: "schedule",
      level: "error",
      titleKey: "schedule.skipped",
      bodyKey: "schedule.skippedBody",
      params: { title: row.title, reason: message },
      actionPath: "/scheduled",
      sourceKey: `schedule:${row.id}:skip:${next ?? Date.now()}`,
    });
  } catch {
    // A notice must never fail a run.
  }
}

const withoutId = ({ id: _id, ...rest }: UIMessage) => rest;

/** Visible answer text only: reasoning, tool calls, and file parts never leave as webhook text. */
const visibleAnswerText = (message: UIMessage): string =>
  message.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");

/** Distinguishes the chats of a "new chat per run" schedule: the date, plus the time when it can run more than daily. */
function runLabel(row: Row, at: number): string {
  const spec = JSON.parse(row.spec_json) as ScheduleSpec;
  const options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", timeZone: spec.timeZone };
  if (spec.kind === "interval") Object.assign(options, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return new Intl.DateTimeFormat("en-US", options).format(new Date(at));
}

/** A run waits while someone is mid-turn in its chat, since that turn's messages are not stored yet. */
const blocked = (row: Row) => row.thread_mode === "same" && !!row.thread_id && threadBusy(row.thread_id);

/**
 * Startup: a session that was running when the process died publishes one interrupted failure and
 * clears its invocation in the same transaction. A legacy running row (no invocation id) emits nothing.
 * Must run before the first scheduling tick.
 */
export function reconcileScheduleInvocations(): void {
  const rows = db
    .prepare(
      `SELECT id, user_id, thread_id, webhook_invocation_id, webhook_started_at FROM schedules
       WHERE webhook_invocation_id IS NOT NULL LIMIT 1000`,
    )
    .all() as Array<{ id: string; user_id: string; thread_id: string | null; webhook_invocation_id: string; webhook_started_at: number | null }>;
  for (const row of rows) {
    tx(() => {
      const current = db
        .prepare("SELECT webhook_invocation_id, webhook_started_at, thread_id FROM schedules WHERE id = ? AND user_id = ?")
        .get(row.id, row.user_id) as { webhook_invocation_id: string | null; webhook_started_at: number | null; thread_id: string | null } | undefined;
      if (!current?.webhook_invocation_id) return;
      const startedAt = current.webhook_started_at ?? row.webhook_started_at ?? Date.now();
      emitScheduleFailed({
        userId: row.user_id,
        scheduleId: row.id,
        invocationId: current.webhook_invocation_id,
        startedAt,
        threadId: current.thread_id && getThread(row.user_id, current.thread_id) ? current.thread_id : null,
        assistantMessageId: null,
        failureCode: "interrupted",
      });
      db.prepare(
        "UPDATE schedules SET last_run_at = ?, last_status = 'error', last_error = 'Interrupted by a server restart.', webhook_invocation_id = NULL, webhook_started_at = NULL WHERE id = ?",
      ).run(startedAt, row.id);
    });
  }
  scheduleReconciled = true;
}

async function tick() {
  // Startup reconciliation must publish interrupted invocations before a new run can start.
  if (!scheduleReconciled) return;
  const due = db.prepare("SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?").all(Date.now()) as unknown as Row[];
  // One at a time keeps a burst of schedules from hammering a provider. Blocked runs stay due and retry next tick.
  for (const { id } of due) {
    // Earlier runs can take minutes; a schedule deleted, disabled, or edited meanwhile uses its current row.
    const row = db.prepare("SELECT * FROM schedules WHERE id = ? AND enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?").get(id, Date.now()) as Row | undefined;
    if (row && !blocked(row)) await runSchedule(row);
  }
}

let ticking = false;
setInterval(() => {
  if (ticking) return;
  ticking = true;
  void tick().finally(() => (ticking = false));
}, 30_000).unref();

const timeZone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, "Unknown time zone");

const specSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("daily"),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    weekdays: z.array(z.number().int().min(0).max(6)).max(7),
    timeZone,
  }),
  z.object({ kind: z.literal("interval"), minutes: z.number().int().min(MIN_INTERVAL_MIN).max(60 * 24 * 31), timeZone: timeZone.optional() }),
]);

const input = z.object({
  title: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(20_000),
  modelRef: z.string().min(3),
  spec: specSchema,
  enabled: z.boolean().default(true),
  threadMode: z.enum(["same", "new"]).default("same"),
  /** An existing chat for "same" mode. Null lets the schedule create (or keep) its own. */
  threadId: z.string().max(200).nullable().default(null),
  projectId: z.string().max(200).nullable().default(null),
});

type Input = z.infer<typeof input>;
type Target = { thread_mode: Input["threadMode"]; thread_id: string | null; thread_attached: number; project_id: string | null };

/** Where runs land. Returns an error message when a picked chat or project is not the user's. */
function target(userId: string, body: Input, prev?: Row): Target | string {
  const project_id = body.projectId && getProject(userId, body.projectId) ? body.projectId : null;
  if (body.projectId && !project_id) return "Project not found";
  if (body.threadMode === "new") return { thread_mode: "new", thread_id: prev?.thread_mode === "new" ? prev.thread_id : null, thread_attached: 0, project_id };
  if (body.threadId) {
    if (isRestrictedKnowledgeThread(body.threadId)) return "Choose a chat that does not use shared knowledge.";
    if (body.threadId === prev?.thread_id) return { thread_mode: "same", thread_id: prev.thread_id, thread_attached: prev.thread_attached, project_id };
    const chosen = getThread(userId, body.threadId);
    if (!chosen) return "Chat not found";
    if (chosen.compareGroupId) return "Choose a regular chat for this schedule.";
    // A restricted chat cannot hand its history to an unattended run or a new chat.
    if (isRestrictedKnowledgeThread(body.threadId)) return "Choose a chat that does not use shared knowledge.";
    return { thread_mode: "same", thread_id: body.threadId, thread_attached: 1, project_id };
  }
  // Keep the chat this schedule created; a picked chat or the latest per-run chat is let go.
  const own = prev?.thread_mode === "same" && !prev.thread_attached ? prev.thread_id : null;
  return { thread_mode: "same", thread_id: own, thread_attached: 0, project_id };
}

const getRow = (userId: string, id: string) => db.prepare("SELECT * FROM schedules WHERE id = ? AND user_id = ?").get(id, userId) as Row | undefined;

export const scheduleRoutes = new Hono<AppEnv>()
  .get("/schedules", (c) => {
    const rows = db.prepare("SELECT * FROM schedules WHERE user_id = ? ORDER BY created_at").all(c.get("user").id) as unknown as Row[];
    return c.json(rows.map(toSchedule));
  })
  .post("/schedules", async (c) => {
    assertFeature(c.get("user").id, "schedules");
    const body = input.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues[0]?.message }, 400);
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM schedules WHERE user_id = ?").get(c.get("user").id) as { n: number };
    if (n >= MAX_SCHEDULES) return c.json({ error: `You have the maximum of ${MAX_SCHEDULES} scheduled prompts. Delete one first.` }, 409);
    const to = target(c.get("user").id, body.data);
    if (typeof to === "string") return c.json({ error: to }, 400);
    const id = newId("sch");
    const { title, prompt, modelRef, spec, enabled } = body.data;
    db.prepare(
      `INSERT INTO schedules (id, user_id, title, prompt, model_ref, spec_json, enabled, next_run_at, thread_mode, thread_id, thread_attached, project_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, c.get("user").id, title, prompt, modelRef, JSON.stringify(spec), enabled ? 1 : 0, nextRun(spec, Date.now()), to.thread_mode, to.thread_id, to.thread_attached, to.project_id, Date.now());
    return c.json(toSchedule(getRow(c.get("user").id, id)!));
  })
  .put("/schedules/:id", async (c) => {
    assertFeature(c.get("user").id, "schedules");
    const prev = getRow(c.get("user").id, c.req.param("id"));
    if (!prev) return c.json({ error: "Not found" }, 404);
    const body = input.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues[0]?.message }, 400);
    const to = target(c.get("user").id, body.data, prev);
    if (typeof to === "string") return c.json({ error: to }, 400);
    const { title, prompt, modelRef, spec, enabled } = body.data;
    db.prepare(
      "UPDATE schedules SET title = ?, prompt = ?, model_ref = ?, spec_json = ?, enabled = ?, next_run_at = ?, thread_mode = ?, thread_id = ?, thread_attached = ?, project_id = ? WHERE id = ?",
    ).run(title, prompt, modelRef, JSON.stringify(spec), enabled ? 1 : 0, nextRun(spec, Date.now()), to.thread_mode, to.thread_id, to.thread_attached, to.project_id, prev.id);
    return c.json(toSchedule(getRow(c.get("user").id, prev.id)!));
  })
  .post("/schedules/:id/run", (c) => {
    assertFeature(c.get("user").id, "schedules");
    const row = getRow(c.get("user").id, c.req.param("id"));
    if (!row) return c.json({ error: "Not found" }, 404);
    if (blocked(row)) return c.json({ error: "Its chat is replying. Try again when it finishes." }, 409);
    const release = reserveTurn(row.user_id);
    if (!release) return c.json({ error: "Too many replies are running for this account. Try again when one finishes." }, 429);
    void runSchedule(row, release);
    return c.json({ ok: true });
  })
  .delete("/schedules/:id", (c) => {
    db.prepare("DELETE FROM schedules WHERE id = ? AND user_id = ?").run(c.req.param("id"), c.get("user").id);
    return c.json({ ok: true });
  });
