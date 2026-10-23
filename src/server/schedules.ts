import { generateId, readUIMessageStream, type UIMessage } from "ai";
import { Hono } from "hono";
import { z } from "zod";
import type { Schedule, ScheduleSpec } from "../shared/types.js";
import type { AppEnv } from "./auth.js";
import { turnStream } from "./chat.js";
import { newId } from "./crypto.js";
import { db } from "./db.js";
import { appendMessage, currentBranch, ensureThread, getThread, updateThread } from "./threads.js";

// Scheduled prompts run on the server with nobody watching: append the prompt to the schedule's thread,
// run one turn, and persist both messages in the client's history format so the thread opens normally.

const RUN_TIMEOUT_MS = 10 * 60_000;
const MIN_INTERVAL_MIN = 15;
// Each schedule runs unattended, possibly on a server-wide provider key. Bound what one account can queue.
const MAX_SCHEDULES = 50;

interface Row {
  id: string;
  user_id: string;
  thread_id: string | null;
  title: string;
  prompt: string;
  model_ref: string;
  spec_json: string;
  enabled: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_status: Schedule["lastStatus"];
  last_error: string | null;
}

const toSchedule = (r: Row): Schedule => ({
  id: r.id,
  threadId: r.thread_id,
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
    // Convert the local wall time to UTC with the offset that applies on that day (DST changes it).
    const guess = day.getTime() - offset * 60_000;
    const at = day.getTime() - offsetMinutes(spec.timeZone, guess) * 60_000;
    if (at > after) return at;
  }
  return null;
}

const running = new Set<string>();

export async function runSchedule(row: Row): Promise<void> {
  if (running.has(row.id)) return;
  running.add(row.id);
  const startedAt = Date.now();
  db.prepare("UPDATE schedules SET last_status = 'running', last_error = NULL, next_run_at = ? WHERE id = ?").run(
    nextRun(JSON.parse(row.spec_json) as ScheduleSpec, startedAt),
    row.id,
  );
  try {
    let threadId = row.thread_id;
    if (!threadId || !getThread(row.user_id, threadId)) {
      threadId = newId("thr");
      ensureThread(row.user_id, threadId);
      updateThread(row.user_id, threadId, { title: row.title });
      db.prepare("UPDATE schedules SET thread_id = ? WHERE id = ?").run(threadId, row.id);
    }
    const history = currentBranch(row.user_id, threadId);
    const userMessage: UIMessage = { id: generateId(), role: "user", parts: [{ type: "text", text: row.prompt }], metadata: { custom: { scheduleId: row.id } } };
    appendMessage(row.user_id, threadId, { id: userMessage.id, parent_id: history.at(-1)?.id ?? null, format: "ai-sdk/v6", content: withoutId(userMessage) });

    const stream = await turnStream({
      userId: row.user_id,
      threadId,
      modelRef: row.model_ref,
      uiMessages: [...history, userMessage],
      signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
    });
    let assistant: UIMessage | undefined;
    for await (const message of readUIMessageStream({ stream })) assistant = message;
    if (!assistant) throw new Error("The model returned nothing.");
    const failed = assistant.parts.length === 0;
    appendMessage(row.user_id, threadId, { id: assistant.id || generateId(), parent_id: userMessage.id, format: "ai-sdk/v6", content: withoutId(assistant) });
    db.prepare("UPDATE schedules SET last_run_at = ?, last_status = ?, last_error = ? WHERE id = ?").run(
      startedAt,
      failed ? "error" : "ok",
      failed ? "Empty response" : null,
      row.id,
    );
  } catch (error) {
    db.prepare("UPDATE schedules SET last_run_at = ?, last_status = 'error', last_error = ? WHERE id = ?").run(startedAt, String((error as Error).message).slice(0, 500), row.id);
  } finally {
    running.delete(row.id);
  }
}

const withoutId = ({ id: _id, ...rest }: UIMessage) => rest;

async function tick() {
  const due = db.prepare("SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?").all(Date.now()) as unknown as Row[];
  // One at a time keeps a burst of schedules from hammering a provider.
  for (const row of due) await runSchedule(row);
}

let ticking = false;
setInterval(() => {
  if (ticking) return;
  ticking = true;
  void tick().finally(() => (ticking = false));
}, 30_000).unref();

const specSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("daily"),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    weekdays: z.array(z.number().int().min(0).max(6)).max(7),
    timeZone: z.string().refine((tz) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, "Unknown time zone"),
  }),
  z.object({ kind: z.literal("interval"), minutes: z.number().int().min(MIN_INTERVAL_MIN).max(60 * 24 * 31) }),
]);

const input = z.object({
  title: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(20_000),
  modelRef: z.string().min(3),
  spec: specSchema,
  enabled: z.boolean().default(true),
});

const getRow = (userId: string, id: string) => db.prepare("SELECT * FROM schedules WHERE id = ? AND user_id = ?").get(id, userId) as Row | undefined;

export const scheduleRoutes = new Hono<AppEnv>()
  .get("/schedules", (c) => {
    const rows = db.prepare("SELECT * FROM schedules WHERE user_id = ? ORDER BY created_at").all(c.get("user").id) as unknown as Row[];
    return c.json(rows.map(toSchedule));
  })
  .post("/schedules", async (c) => {
    const body = input.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues[0]?.message }, 400);
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM schedules WHERE user_id = ?").get(c.get("user").id) as { n: number };
    if (n >= MAX_SCHEDULES) return c.json({ error: `You have the maximum of ${MAX_SCHEDULES} scheduled prompts. Delete one first.` }, 409);
    const id = newId("sch");
    const { title, prompt, modelRef, spec, enabled } = body.data;
    db.prepare(
      "INSERT INTO schedules (id, user_id, title, prompt, model_ref, spec_json, enabled, next_run_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(id, c.get("user").id, title, prompt, modelRef, JSON.stringify(spec), enabled ? 1 : 0, nextRun(spec, Date.now()), Date.now());
    return c.json(toSchedule(getRow(c.get("user").id, id)!));
  })
  .put("/schedules/:id", async (c) => {
    const prev = getRow(c.get("user").id, c.req.param("id"));
    if (!prev) return c.json({ error: "Not found" }, 404);
    const body = input.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues[0]?.message }, 400);
    const { title, prompt, modelRef, spec, enabled } = body.data;
    db.prepare("UPDATE schedules SET title = ?, prompt = ?, model_ref = ?, spec_json = ?, enabled = ?, next_run_at = ? WHERE id = ?").run(
      title,
      prompt,
      modelRef,
      JSON.stringify(spec),
      enabled ? 1 : 0,
      nextRun(spec, Date.now()),
      prev.id,
    );
    return c.json(toSchedule(getRow(c.get("user").id, prev.id)!));
  })
  .post("/schedules/:id/run", (c) => {
    const row = getRow(c.get("user").id, c.req.param("id"));
    if (!row) return c.json({ error: "Not found" }, 404);
    void runSchedule(row);
    return c.json({ ok: true });
  })
  .delete("/schedules/:id", (c) => {
    db.prepare("DELETE FROM schedules WHERE id = ? AND user_id = ?").run(c.req.param("id"), c.get("user").id);
    return c.json({ ok: true });
  });
