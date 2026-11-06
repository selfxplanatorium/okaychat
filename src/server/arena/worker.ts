import { streamText } from "ai";
import { ARENA_LIMITS, type ArenaSide, type BattleView } from "../../shared/arena.js";
import { resolveReasoningEffort } from "../../shared/reasoning.js";
import { db, tx } from "../db.js";
import { createModel } from "../llm.js";
import { estimateTokens } from "../compaction.js";
import { resolvePrompt } from "../prompt-policy.js";
import { assertModelAllowed } from "../permissions/guard.js";
import { holdLease, reserveOperation } from "../permissions/limits.js";
import { reserveTurn } from "../turn-slots.js";
import { admitCreditRoot, type CreditPermit } from "../credits/store.js";
import { creditSignal, endCreditRoot } from "../credits/admission.js";
import { arenaUnavailable, eligibleTargets, guardTarget, registerPersonalModel, samplePair, type ArenaTarget } from "./models.js";
import { assertBattleCapacity, createBattle, expireContents, finishBattle, finishPane, getBattle, normalizeStart, startHash } from "./store.js";

interface Job { userId: string; controller: AbortController; cancelled: boolean; attached: boolean; wake?: () => void; pending: Uint8Array[]; bytes: number; timer?: ReturnType<typeof setTimeout>; closed: boolean }
const jobs = new Map<string, Job>();
let deadlines = { run: ARENA_LIMITS.deadlineMs as number, attach: 15_000 };
/** In-process test seam, never read from a request or environment configuration. */
export function setArenaTestDeadlines(value?: { run: number; attach: number }): void { deadlines = value ?? { run: ARENA_LIMITS.deadlineMs, attach: 15_000 }; }
const encoder = new TextEncoder();
function frame(type: string, data: unknown): Uint8Array { return encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); }
function emit(job: Job, type: string, data: unknown): void {
  if (job.closed) return;
  const bytes = frame(type, data);
  job.bytes += bytes.byteLength;
  if (job.bytes > 64 * 1024) { job.controller.abort(); return; }
  job.pending.push(bytes); job.wake?.();

}
export function battleByMutation(userId: string, mutationId: string): BattleView | null {
  const row = db.prepare("SELECT id FROM arena_battles WHERE user_id=? AND mutation_id=?").get(userId, mutationId) as { id: string } | undefined;
  return row ? getBattle(userId, row.id) : null;
}
export async function startBattle(userId: string, input: unknown): Promise<{ battle: BattleView; created: boolean }> {
  const start = normalizeStart(input);
  const old = db.prepare("SELECT id,request_hash FROM arena_battles WHERE user_id=? AND mutation_id=?").get(userId, start.mutationId) as { id: string; request_hash: string } | undefined;
  if (old) { if (old.request_hash !== startHash(start)) throw arenaUnavailable("arena_start_conflict"); return { battle: getBattle(userId, old.id), created: false }; }
  const pool = await eligibleTargets(userId, start.mode, start.poolRefs);
  if (pool.length < 2) throw arenaUnavailable("arena_pool_small");
  const targets = samplePair(pool);
  const system = resolvePrompt("arenaAnswer", { userId, modelRef: "" });
  for (const t of targets) {
    const policy = assertModelAllowed(userId, t.model.ref);
    if (estimateTokens({ system, prompt: start.prompt }) >= Math.min(t.model.context, policy.limits.contextTokens ?? Infinity) - 1) throw arenaUnavailable("arena_context", 400);
    guardTarget(userId, t, start.mode);
  }
  const replay = db.prepare("SELECT id,request_hash FROM arena_battles WHERE user_id=? AND mutation_id=?").get(userId, start.mutationId) as { id: string; request_hash: string } | undefined;
  if (replay) { if (replay.request_hash !== startHash(start)) throw arenaUnavailable("arena_start_conflict"); return { battle: getBattle(userId, replay.id), created: false }; }
  expireContents();
  const snapshots = targets.map(t => ({ ref: t.model.ref, label: t.model.name, fingerprint: t.fingerprint, effort: t.model.reasoning ? resolveReasoningEffort(t.model, null, "none") : "none", system, priceKnown: !!t.model.cost }));
  assertBattleCapacity(userId, start.prompt, snapshots);
  const releases: Array<() => void> = [];
  let permit: CreditPermit | undefined;
  try {
    for (let i = 0; i < 2; i++) { const release = reserveTurn(userId); if (!release) throw arenaUnavailable("arena_concurrency"); releases.push(release); }
    const leases = tx(() => targets.map(t => reserveOperation({ userId, modelRef: t.model.ref }, "llm.call", { kind: "turn" })));
    const controller = new AbortController();
    for (const lease of leases) releases.push(holdLease(lease, () => controller.abort()));
    permit = admitCreditRoot(userId, "arena");
    const assignments = targets.map((t, index) => ({ personalModelId: registerPersonalModel(userId, t.model.ref, t.model.name, t.fingerprint), ...(t.publicId ? { publicModelId: t.publicId } : {}), snapshot: snapshots[index]! }));
    const result = createBattle(userId, start, [assignments[0]!, assignments[1]!], permit);
    if (!result.created) { await endCreditRoot(permit); releases.forEach(release => release()); return result; }
    const id = result.battle.id;
    const job: Job = { userId, controller, cancelled: false, attached: false, pending: [], bytes: 0, closed: false };
    job.timer = setTimeout(() => controller.abort(), deadlines.attach); job.timer.unref?.();
    jobs.set(id, job);
    const ownedPermit = permit;
    void execute(id, job, targets, system, start.prompt, start.mode, ownedPermit, releases).catch(() => {});
    return result;
  } catch (error) {
    try { if (permit) await endCreditRoot(permit); } finally { releases.forEach(release => release()); }
    throw error;
  }
}
async function execute(id: string, job: Job, targets: readonly [ArenaTarget, ArenaTarget], system: string, prompt: string, mode: "personal" | "public", permit: CreditPermit, releases: Array<() => void>): Promise<void> {
  const deadline = AbortSignal.timeout(deadlines.run);
  const signal = creditSignal(permit, AbortSignal.any([job.controller.signal, deadline]));
  const heartbeat = setInterval(() => emit(job, "heartbeat", {}), 5000); heartbeat.unref?.();
  try {
    // Construct both handles before dispatching either; all paid invocations share the root capability.
    const handles = targets.map(t => createModel(t.model, t.conn, { userId: job.userId, creditPermit: permit, usageContext: { kind: "arena", arenaBattleId: id, arenaSide: t === targets[0] ? "A" : "B" }, effort: t.model.reasoning ? resolveReasoningEffort(t.model, null, "none") : "none", guard: () => {
      if (getBattle(job.userId, id).state !== "running") throw arenaUnavailable("arena_not_ready");
      guardTarget(job.userId, t, mode);
    }, responseBounds: { maxBytes: 8 * 1024 * 1024, maxRecordBytes: 256 * 1024 } }));
    await Promise.allSettled(handles.map(async (handle, index) => {
      const side: ArenaSide = index === 0 ? "A" : "B", target = targets[index]!;
      const paneAbort = new AbortController();
      let text = "", finish = "error", failed = false, batch = "";
      const flush = () => { if (batch) { emit(job, "text", { side, delta: batch }); batch = ""; } };
      const timer = setInterval(flush, 50); timer.unref?.();
      try {
        const policy = assertModelAllowed(job.userId, target.model.ref);
        const result = streamText({ model: handle.model, providerOptions: handle.providerOptions, system, prompt, onError: () => {}, maxRetries: 0, maxOutputTokens: Math.min(4096, target.model.maxOutput || 4096, policy.limits.outputTokens ?? 4096), abortSignal: AbortSignal.any([signal, paneAbort.signal]) });
        for await (const part of result.fullStream) {
          if (part.type === "text-delta") {
            if (Buffer.byteLength(text) + Buffer.byteLength(part.text) > ARENA_LIMITS.outputBytes) { failed = true; paneAbort.abort(); break; }
            text += part.text;
            // Byte-bounded final-text frames only; reasoning and provider metadata never enter this protocol.
            for (const ch of part.text) { batch += ch; if (Buffer.byteLength(batch) >= 4096) flush(); }
          } else if (part.type === "error" || part.type === "abort") failed = true;
          else if (part.type === "finish") finish = part.finishReason;
        }
        if (signal.aborted || paneAbort.signal.aborted) failed = true;
      } catch { failed = true; }
      finally {
        clearInterval(timer); flush();
        const receipt = db.prepare("SELECT id FROM token_credit_requests WHERE user_id=? AND json_extract(context_json,'$.arenaBattleId')=? AND json_extract(context_json,'$.arenaSide')=? ORDER BY created_at DESC,id DESC LIMIT 1").get(job.userId, id, side) as { id: string } | undefined;
        finishPane(job.userId, id, side, { text, finish: failed ? "error" : finish, receiptId: receipt?.id });
        const pane = getBattle(job.userId, id).panes[index]!;
        emit(job, "pane", { side, state: pane.state, ...(pane.finish ? { finish: pane.finish } : {}), ...(pane.errorCode ? { errorCode: pane.errorCode } : {}) });
      }
    }));
  } catch {
    for (const side of ["A", "B"] as const) { try { finishPane(job.userId, id, side, { text: "", finish: "error" }); } catch { /* Account deletion may have removed the battle. */ } }
  } finally {
    try { await endCreditRoot(permit); }
    finally {
      releases.forEach(release => release());
      clearInterval(heartbeat); clearTimeout(job.timer);
      try {
        // Any unexpected drain failure must leave a terminal, unvoteable pair.
        for (const side of ["A", "B"] as const) finishPane(job.userId, id, side, { text: "", finish: "error" });
        finishBattle(job.userId, id, job.cancelled);
        const battle = getBattle(job.userId, id);
        emit(job, "battle", { state: battle.state, canVote: battle.canVote });
      } catch { /* No transcript or provider errors in logs. */ }
      job.closed = true; job.wake?.(); jobs.delete(id);
    }
  }
}
export function stopBattle(userId: string, id: string): BattleView {
  const view = getBattle(userId, id), job = jobs.get(id);
  if (view.state === "running" && job?.userId === userId) { job.cancelled = true; job.controller.abort(); }
  return view;
}
export function abortArenaUser(userId: string): void { for (const job of jobs.values()) if (job.userId === userId) { job.cancelled = true; job.controller.abort(); } }
export function attachBattle(userId: string, id: string): ReadableStream<Uint8Array> {
  const battle = getBattle(userId, id), job = jobs.get(id);
  if (job?.attached) throw arenaUnavailable("arena_stream_attached");
  if (job) {
    job.attached = true; clearTimeout(job.timer);
    // Completed pane text is already in the stored snapshot; do not replay its earlier deltas.
    job.pending = job.pending.filter(value => {
      const raw = new TextDecoder().decode(value);
      if (!raw.startsWith("event: text")) return true;
      const data = JSON.parse(raw.split("\n").find(line => line.startsWith("data: "))!.slice(6)) as { side: ArenaSide };
      return battle.panes.some(p => p.side === data.side && p.state === "running");
    });
    job.bytes = job.pending.reduce((n, value) => n + value.byteLength, 0);
  }
  // A bounded snapshot may exceed one delta buffer. Pull it in 8 KiB chunks, then consume the
  // independent <=64 KiB producer queue. Slow/detached consumers cannot grow that queue.
  const snapshot = frame("snapshot", { battle });
  let offset = 0, idle: ReturnType<typeof setTimeout> | undefined;
  const arm = () => { clearTimeout(idle); if (job && !job.closed) { idle = setTimeout(() => job.controller.abort(), 15_000); idle.unref?.(); } };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset < snapshot.byteLength) {
        const end = Math.min(offset + 8192, snapshot.byteLength);
        controller.enqueue(snapshot.subarray(offset, end)); offset = end; arm(); return;
      }
      while (job && !job.pending.length && !job.closed) await new Promise<void>(resolve => { job.wake = resolve; });
      const value = job?.pending.shift();
      if (value && job) { job.bytes -= value.byteLength; controller.enqueue(value); arm(); }
      else { clearTimeout(idle); controller.close(); }
    },
    cancel() { clearTimeout(idle); if (job && !job.closed) { job.cancelled = true; job.controller.abort(); job.wake?.(); } },
  }, { highWaterMark: 8192, size: chunk => chunk.byteLength });
}
