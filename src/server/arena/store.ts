import { z } from "zod";
import { ARENA_LIMITS, type ArenaChoice, type ArenaMode, type ArenaSide, type ArenaBattleState, type ArenaPaneState, type ArenaErrorCode, type BattleView, type BlindPane, type RevealedPane } from "../../shared/arena.js";
import type { TokenUsage } from "../../shared/types.js";
import { db, tx } from "../db.js";
import { encrypt, decrypt, newId, domainHmac } from "../crypto.js";
import { AppError } from "../errors.js";
import { assertStorage } from "../quota.js";
import { assertCreditPermit, type CreditPermit } from "../credits/store.js";

const startSchema = z.strictObject({ mutationId: z.string().min(1).max(100), prompt: z.string().trim().min(1).max(20_000), mode: z.enum(["personal", "public"]), poolRefs: z.array(z.string().min(1).max(500)).min(2).max(100).optional() });
export function normalizeStart(input: unknown) {
  const parsed = startSchema.parse(input);
  if (parsed.poolRefs && new Set(parsed.poolRefs).size !== parsed.poolRefs.length) fail("arena_invalid");
  return { ...parsed, ...(parsed.poolRefs ? { poolRefs: [...parsed.poolRefs].sort() } : {}) };
}
export function startHash(input: ReturnType<typeof normalizeStart>): string {
  return domainHmac("arena:start:v1", JSON.stringify([input.prompt, input.mode, input.poolRefs ?? null]));
}
function fail(reason: ArenaErrorCode): never {
  throw new AppError({ code: reason === "arena_not_found" ? "not_found" : reason === "arena_invalid" ? "validation" : "conflict", message: "Arena request unavailable.", details: { reason } });
}
interface BattleRow { id: string; user_id: string; request_hash: string; mode: ArenaMode; state: ArenaBattleState; created_at: number; content_expires_at: number }
interface ContentRow { prompt_enc: string; answer_a_enc: string; answer_b_enc: string }
interface PaneRow { side: ArenaSide; personal_model_id: string; state: ArenaPaneState; finish_reason: string | null; error_code: ArenaErrorCode | null; launch_snapshot_enc: string | null; usage_json: string | null; receipt_id: string | null; cost: number | null; cost_state: "unknown" | "estimated" | "reported" }
interface VoteRow { choice: ArenaChoice; created_at: number }
export interface LaunchSnapshot { ref: string; label: string; fingerprint: string; effort: string; system: string; priceKnown: boolean }
export interface ArenaAssignment { personalModelId: string; publicModelId?: string; snapshot: LaunchSnapshot }
function owned(userId: string, id: string): BattleRow {
  const row = db.prepare("SELECT * FROM arena_battles WHERE id=? AND user_id=?").get(id, userId) as unknown as BattleRow | undefined;
  if (!row) fail("arena_not_found");
  return row;
}
function panes(id: string): [PaneRow, PaneRow] {
  const rows = db.prepare("SELECT * FROM arena_panes WHERE battle_id=? ORDER BY side").all(id) as unknown as PaneRow[];
  if (rows.length !== 2 || rows[0]?.side !== "A" || rows[1]?.side !== "B") throw new Error("Invalid Arena assignments");
  return [rows[0], rows[1]];
}
function vote(id: string): VoteRow | undefined { return db.prepare("SELECT choice,created_at FROM arena_votes WHERE battle_id=?").get(id) as unknown as VoteRow | undefined; }
function content(id: string): ContentRow | undefined { return db.prepare("SELECT * FROM arena_contents WHERE battle_id=?").get(id) as unknown as ContentRow | undefined; }
function ready(row: BattleRow, pair: readonly PaneRow[], now: number): boolean {
  return row.state === "ready" && row.content_expires_at > now && !!content(row.id) && pair.every(p => p.state === "done" && p.usage_json !== null && !!p.receipt_id && !!db.prepare(
    "SELECT 1 FROM token_credit_requests WHERE id=? AND user_id=? AND state='reported' AND json_extract(context_json,'$.arenaBattleId')=? AND json_extract(context_json,'$.arenaSide')=?"
  ).get(p.receipt_id, row.user_id, row.id, p.side));
}

/** Only this allowlisted projection is suitable for an owner transport. No spread of database rows. */
export function getBattle(userId: string, id: string, now = Date.now()): BattleView {
  const row = owned(userId, id), pair = panes(id), storedVote = vote(id);
  const c = row.content_expires_at > now ? content(id) : undefined;
  const common = { id: row.id, mode: row.mode, state: row.state === "ready" && !c ? "expired" as const : row.state, createdAt: row.created_at, contentExpiresAt: row.content_expires_at, canVote: ready(row, pair, now), ...(c ? { prompt: decrypt(c.prompt_enc) } : {}) };
  const blind = (p: PaneRow): BlindPane => {
    const answer = c ? (p.side === "A" ? c.answer_a_enc : c.answer_b_enc) : "";
    return { side: p.side, state: p.state, text: answer ? decrypt(answer) : "",
      ...(p.finish_reason === "stop" || p.finish_reason === "length" ? { finish: p.finish_reason } : {}),
      ...(p.error_code ? { errorCode: p.error_code } : {}) };
  };
  if (!storedVote) return { ...common, visibility: "blind", panes: [blind(pair[0]), blind(pair[1])] };
  const reveal = (p: PaneRow): RevealedPane => {
    const registry = db.prepare("SELECT model_ref,label FROM arena_models WHERE id=?").get(p.personal_model_id) as { model_ref: string; label: string };
    const snapshot = p.launch_snapshot_enc ? JSON.parse(decrypt(p.launch_snapshot_enc)) as LaunchSnapshot : null;
    return { ...blind(p), model: { key: p.personal_model_id, ref: snapshot?.ref ?? registry.model_ref, label: snapshot?.label ?? registry.label, available: false }, effort: snapshot?.effort ?? "unknown", usage: p.usage_json ? JSON.parse(p.usage_json) as TokenUsage : null, cost: p.cost, costState: p.cost_state, finishReason: p.finish_reason };
  };
  return { ...common, visibility: "revealed", canVote: false, panes: [reveal(pair[0]), reveal(pair[1])], vote: { choice: storedVote.choice, createdAt: storedVote.created_at } };
}

/** Read-only preflight before turn/credit admission; creation repeats these checks transactionally. */
export function assertBattleCapacity(userId: string, prompt: string, snapshots: readonly LaunchSnapshot[]): void {
  const count = db.prepare("SELECT COUNT(*) AS n FROM arena_contents c JOIN arena_battles b ON b.id=c.battle_id WHERE b.user_id=?").get(userId) as { n: number };
  if (count.n >= ARENA_LIMITS.maxContents || db.prepare("SELECT 1 FROM arena_battles WHERE user_id=? AND state='running'").get(userId)) fail("arena_capacity");
  const bytes = Buffer.byteLength(encrypt(prompt)) + snapshots.reduce((n, snapshot) => n + Buffer.byteLength(encrypt(JSON.stringify(snapshot))), 0)
    + 2 * ARENA_LIMITS.paneReservation + ARENA_LIMITS.metadataReservation;
  assertStorage(userId, bytes);
}

/** Caller preflights eligibility and reserves both turn leases, then admits one credit root. No dispatch here. */
export function createBattle(userId: string, input: unknown, assignments: readonly [ArenaAssignment, ArenaAssignment], permit: CreditPermit, now = Date.now()): { battle: BattleView; created: boolean } {
  const start = normalizeStart(input), hash = startHash(start);
  return tx(() => {
    const old = db.prepare("SELECT id,request_hash FROM arena_battles WHERE user_id=? AND mutation_id=?").get(userId, start.mutationId) as { id: string; request_hash: string } | undefined;
    if (old) { if (old.request_hash !== hash) fail("arena_start_conflict"); return { battle: getBattle(userId, old.id, now), created: false }; }
    assertCreditPermit(permit, userId);
    if (assignments[0].personalModelId === assignments[1].personalModelId || assignments[0].snapshot.ref === assignments[1].snapshot.ref) fail("arena_invalid");
    const snapshots = assignments.map(a => encrypt(JSON.stringify(a.snapshot)));
    for (const a of assignments) {
      const personal = db.prepare("SELECT 1 FROM arena_models WHERE id=? AND user_id=? AND scope='personal' AND model_ref=? AND fingerprint=?").get(a.personalModelId, userId, a.snapshot.ref, a.snapshot.fingerprint);
      if (!personal) fail("arena_invalid");
      if (start.poolRefs && !start.poolRefs.includes(a.snapshot.ref)) fail("arena_invalid");
      if (start.mode === "public" && (!a.publicModelId || !db.prepare("SELECT 1 FROM arena_models WHERE id=? AND scope='public' AND model_ref=? AND fingerprint=?").get(a.publicModelId, a.snapshot.ref, a.snapshot.fingerprint))) fail("arena_invalid");
    }
    const count = db.prepare("SELECT COUNT(*) AS n FROM arena_contents c JOIN arena_battles b ON b.id=c.battle_id WHERE b.user_id=?").get(userId) as { n: number };
    if (count.n >= ARENA_LIMITS.maxContents || db.prepare("SELECT 1 FROM arena_battles WHERE user_id=? AND state='running'").get(userId)) fail("arena_capacity");
    const prompt = encrypt(start.prompt);
    const reservation = Buffer.byteLength(prompt) + snapshots.reduce((n, s) => n + Buffer.byteLength(s), 0) + 2 * ARENA_LIMITS.paneReservation + ARENA_LIMITS.metadataReservation;
    assertStorage(userId, reservation);
    const id = newId("arb");
    db.prepare("INSERT INTO arena_battles(id,user_id,mutation_id,request_hash,mode,state,created_at,content_expires_at) VALUES (?,?,?,?,?,'running',?,?)").run(id, userId, start.mutationId, hash, start.mode, now, now + ARENA_LIMITS.retentionMs);
    assignments.forEach((a, i) => db.prepare("INSERT INTO arena_panes(battle_id,side,personal_model_id,public_model_id,launch_snapshot_enc,state) VALUES (?,?,?,?,?,'running')").run(id, i === 0 ? "A" : "B", a.personalModelId, start.mode === "public" ? a.publicModelId! : null, snapshots[i]!));
    db.prepare("INSERT INTO arena_contents VALUES (?,?,?,?,?,?)").run(id, prompt, "", "", reservation, now);
    return { battle: getBattle(userId, id, now), created: true };
  });
}

/** Replay is checked before live feature/expiry checks; caller supplies the account feature decision. */
export function castVote(userId: string, id: string, choice: ArenaChoice, featureAllowed: boolean, now = Date.now()): { battle: BattleView; ratingRevision: number } {
  z.enum(["A", "B", "tie", "both_bad"]).parse(choice);
  tx(() => {
    const row = owned(userId, id), old = vote(id);
    if (old) { if (old.choice !== choice) fail("arena_vote_locked"); return; }
    if (!featureAllowed) throw new AppError({ code: "forbidden", message: "Arena is disabled for this account." });
    if (!ready(row, panes(id), now)) fail("arena_not_ready");
    db.prepare("INSERT INTO arena_votes(battle_id,voter_id,choice,created_at) VALUES (?,?,?,?)").run(id, userId, choice, now);
    const result = db.prepare("UPDATE arena_battles SET state='voted',voted_at=? WHERE id=? AND state='ready'").run(now, id);
    if (result.changes !== 1) fail("arena_not_ready");
    bumpRatingRevision();
  });
  return { battle: getBattle(userId, id, now), ratingRevision: ratingRevision() };
}
export function ratingRevision(): number { return (db.prepare("SELECT revision FROM arena_rating_meta WHERE id=1").get() as { revision: number }).revision; }
export function bumpRatingRevision(): void { db.prepare("UPDATE arena_rating_meta SET revision=revision+1 WHERE id=1").run(); }

export function discardContent(userId: string, id: string): void {
  tx(() => {
    const row = owned(userId, id);
    if (row.state === "running") fail("arena_not_ready");
    db.prepare("DELETE FROM arena_contents WHERE battle_id=?").run(id);
    db.prepare("UPDATE arena_panes SET launch_snapshot_enc=NULL WHERE battle_id=?").run(id);
    db.prepare("UPDATE arena_battles SET state='expired' WHERE id=? AND state='ready'").run(id);
  });
}
export function expireContents(now = Date.now()): number {
  return tx(() => {
    const rows = db.prepare("SELECT id,user_id FROM arena_battles WHERE content_expires_at<=? AND state!='running' AND EXISTS(SELECT 1 FROM arena_contents WHERE battle_id=arena_battles.id) ORDER BY content_expires_at,id LIMIT 100").all(now) as Array<{ id: string; user_id: string }>;
    for (const row of rows) discardContent(row.user_id, row.id);
    return rows.length;
  });
}
export function interruptBattles(now = Date.now()): void {
  tx(() => {
    db.prepare("UPDATE arena_panes SET state='interrupted',error_code='arena_interrupted' WHERE state='running'").run();
    db.prepare("UPDATE arena_battles SET state='interrupted',ended_at=? WHERE state='running'").run(now);
  });
}

/** Settlement is read from the authoritative ledger, never a caller-provided usage estimate. */
export function finishPane(userId: string, id: string, side: ArenaSide, result: { text: string; finish: string; receiptId?: string }): void {
  tx(() => {
    const battle = owned(userId, id);
    if (battle.state !== "running") return;
    const pair = panes(id), pane = pair[side === "A" ? 0 : 1];
    if (pane.state !== "running") return;
    const bytes = Buffer.byteLength(result.text);
    if (bytes > ARENA_LIMITS.outputBytes) fail("arena_invalid");
    const receipt = result.receiptId ? db.prepare(`SELECT r.usage_json,u.cost FROM token_credit_requests r
      JOIN usage u ON u.credit_request_id=r.id WHERE r.id=? AND r.user_id=? AND r.state='reported'
      AND json_extract(r.context_json,'$.arenaBattleId')=? AND json_extract(r.context_json,'$.arenaSide')=?`).get(result.receiptId, userId, id, side) as { usage_json: string; cost: number } | undefined : undefined;
    const done = !!result.text.trim() && ["stop", "length"].includes(result.finish) && !!receipt;
    const snapshot = pane.launch_snapshot_enc ? JSON.parse(decrypt(pane.launch_snapshot_enc)) as LaunchSnapshot : null;
    db.prepare(`UPDATE arena_panes SET state=?,finish_reason=?,error_code=?,receipt_id=?,usage_json=?,cost=?,cost_state=? WHERE battle_id=? AND side=?`).run(
      done ? "done" : "failed", result.finish, done ? null : "arena_failed", result.receiptId ?? null,
      receipt?.usage_json ?? null, receipt && snapshot?.priceKnown ? receipt.cost : null,
      receipt && snapshot?.priceKnown ? "estimated" : "unknown", id, side);
    db.prepare(`UPDATE arena_contents SET ${side === "A" ? "answer_a_enc" : "answer_b_enc"}=?,updated_at=? WHERE battle_id=?`).run(result.text ? encrypt(result.text) : "", Date.now(), id);
  });
}
/** Call only after both drains and root settlement/release, never when the first pane completes. */
export function finishBattle(userId: string, id: string, cancelled = false, now = Date.now()): void {
  tx(() => {
    const row = owned(userId, id);
    if (row.state !== "running") return;
    const pair = panes(id);
    if (!cancelled && pair.some(p => p.state === "running")) fail("arena_not_ready");
    if (cancelled) db.prepare("UPDATE arena_panes SET state='cancelled' WHERE battle_id=? AND state='running'").run(id);
    db.prepare("UPDATE arena_battles SET state=?,ended_at=? WHERE id=? AND state='running'").run(cancelled ? "cancelled" : pair.every(p => p.state === "done") ? "ready" : "failed", now, id);
  });
}
