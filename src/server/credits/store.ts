import { AppError } from "../errors.js";
import { randomUUID } from "node:crypto";
import { CREDIT_ORIGINS, MAX_TOKEN_CREDIT, type CreditOrigin, type CreditSnapshot, type TokenCreditAuditEntry, type TokenCreditBalance } from "../../shared/token-credits.js";
import type { TokenUsage } from "../../shared/types.js";
import { db, tx } from "../db.js";
import { recordUsage, type UsageKind } from "../usage.js";

export class CreditError extends AppError {
  constructor(code: "token_credit_exhausted" | "token_credit_usage_unknown" | "token_credit_busy" | "token_credit_unmetered" | "conflict" | "validation" | "forbidden" | "not_found", message?: string, details?: Record<string, unknown>) {
    super({ code, ...(message ? { message } : {}), ...(details ? { details } : {}), ...(code.startsWith("token_credit_") && code !== "token_credit_busy" ? { recovery: "contact_admin" as const } : {}) });
  }
}

interface Account {
  user_id: string; credit_tokens: number | null; consumed_tokens: number; unknown_requests: number;
  period: number; period_started_at: number; version: number;
}
declare const permitBrand: unique symbol;
export interface CreditPermit { readonly [permitBrand]: true }
interface Root { id: string; userId: string; period: number; origin: CreditOrigin }
const permits = new WeakMap<CreditPermit, Root>();

export function ensureCreditAccount(userId: string, now = Date.now()): void {
  db.prepare("INSERT OR IGNORE INTO token_credit_accounts(user_id,credit_tokens,period_started_at) VALUES (?,NULL,?)").run(userId, now);
}
function account(userId: string): Account {
  ensureCreditAccount(userId);
  return db.prepare("SELECT * FROM token_credit_accounts WHERE user_id=?").get(userId) as unknown as Account;
}
function snapshot(a: Account): CreditSnapshot {
  return {
    creditTokens: a.credit_tokens, consumedTokens: a.consumed_tokens,
    remainingTokens: a.credit_tokens === null ? null : Math.max(0, a.credit_tokens - a.consumed_tokens),
    unknownRequests: a.unknown_requests, period: a.period, periodStartedAt: a.period_started_at,
    resetPolicy: "manual", version: a.version,
    status: a.credit_tokens === null ? "unlimited" : a.unknown_requests > 0 ? "usage_unknown" : a.consumed_tokens >= a.credit_tokens ? "exhausted" : "available",
  };
}
export function getCreditBalance(userId: string): TokenCreditBalance {
  return { ...snapshot(account(userId)), activeOperations: activeCount(userId), asOf: Date.now() };
}
function activeCount(userId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM token_credit_roots WHERE user_id=? AND state='active'").get(userId) as { n: number }).n;
}
export function admitCreditRoot(userId: string, origin: CreditOrigin): CreditPermit {
  if (!CREDIT_ORIGINS.includes(origin)) throw new CreditError("validation");
  const root = tx(() => {
    const a = account(userId);
    if (a.credit_tokens !== null) {
      if (a.unknown_requests) throw new CreditError("token_credit_usage_unknown");
      if (a.consumed_tokens >= a.credit_tokens) throw new CreditError("token_credit_exhausted", "Your token allowance is exhausted. Contact your administrator to increase or reset it.");
      if (activeCount(userId)) throw new CreditError("token_credit_busy");
    }
    const id = randomUUID();
    db.prepare("INSERT INTO token_credit_roots(id,user_id,period,origin,exclusive,state,started_at) VALUES (?,?,?,?,?,'active',?)").run(id, userId, a.period, origin, a.credit_tokens === null ? 0 : 1, Date.now());
    return { id, userId, period: a.period, origin };
  });
  const permit = Object.freeze({}) as CreditPermit;
  permits.set(permit, root);
  return permit;
}
function liveRoot(permit: CreditPermit, userId?: string): Root {
  const root = permits.get(permit);
  if (!root || (userId !== undefined && root.userId !== userId)) throw new CreditError("forbidden", "Invalid credit capability.");
  const row = db.prepare("SELECT period FROM token_credit_roots WHERE id=? AND user_id=? AND state='active'").get(root.id, root.userId);
  if (!row || row.period !== root.period) throw new CreditError("forbidden", "Closed credit capability.");
  return root;
}
export function assertCreditPermit(permit: CreditPermit, userId: string): void { liveRoot(permit, userId); }
export function closeCreditRoot(permit: CreditPermit): void {
  const root = permits.get(permit);
  if (!root) throw new CreditError("forbidden");
  tx(() => {
    // A failed settlement must keep the spending slot held until recovery or a successful retry.
    if (db.prepare("SELECT 1 FROM token_credit_requests WHERE root_id=? AND state='open'").get(root.id)) throw new CreditError("token_credit_busy", "Credit requests are still open.");
    db.prepare("UPDATE token_credit_roots SET state='finished',finished_at=? WHERE id=? AND state='active'").run(Date.now(), root.id);
  });
}
export interface CreditContext {
  threadId?: string; channelId?: string; channelRunId?: string; apiKeyId?: string; apiRequestId?: string;
  runId?: string; segmentId?: string; evaluationRunId?: string; evaluationCaseId?: string;
}
const contextKeys = new Set(["threadId", "channelId", "channelRunId", "apiKeyId", "apiRequestId", "runId", "segmentId", "evaluationRunId", "evaluationCaseId"]);
const kinds: readonly UsageKind[] = ["chat", "compaction", "title", "subagent", "memory", "research", "evaluation", "evaluation_judge", "channel", "api", "translation"];
export function beginCreditRequest(permit: CreditPermit, entry: { providerId: string; modelId: string; kind: UsageKind; context?: CreditContext }): string {
  return tx(() => {
    const root = liveRoot(permit);
    const a = account(root.userId);
    if (a.period !== root.period) throw new CreditError("forbidden");
    if (a.credit_tokens !== null && a.unknown_requests) throw new CreditError("token_credit_usage_unknown");
    if (!kinds.includes(entry.kind) || ![entry.providerId, entry.modelId].every(s => typeof s === "string" && s.length > 0 && s.length <= 500)) throw new CreditError("validation");
    const context = entry.context ?? {};
    if (root.origin === "temporary" && context.threadId !== undefined) throw new CreditError("validation", "Temporary operations cannot retain a thread identifier.");
    if (Object.entries(context).some(([k, v]) => !contextKeys.has(k) || typeof v !== "string" || !v.length || v.length > 500 || /[\u0000-\u001f]/u.test(v))) throw new CreditError("validation");
    const json = JSON.stringify(context);
    if (Buffer.byteLength(json) > 2048) throw new CreditError("validation");
    const id = randomUUID();
    db.prepare("INSERT INTO token_credit_requests(id,root_id,user_id,period,provider_id,model_id,kind,state,context_json,created_at) VALUES (?,?,?,?,?,?,?,'open',?,?)").run(id, root.id, root.userId, root.period, entry.providerId, entry.modelId, entry.kind, json, Date.now());
    return id;
  });
}
export function markCreditDispatched(requestId: string): void {
  tx(() => {
    const r = db.prepare("SELECT r.*,a.credit_tokens,a.unknown_requests FROM token_credit_requests r JOIN token_credit_roots o ON o.id=r.root_id JOIN token_credit_accounts a ON a.user_id=r.user_id AND a.period=r.period WHERE r.id=? AND r.state='open' AND o.state='active'").get(requestId);
    if (!r) throw new CreditError("forbidden");
    if (r.credit_tokens !== null && Number(r.unknown_requests) > 0) throw new CreditError("token_credit_usage_unknown");
    db.prepare("UPDATE token_credit_requests SET dispatched_at=COALESCE(dispatched_at,?) WHERE id=?").run(Date.now(), requestId);
  });
}
export function validCreditUsage(usage: TokenUsage | undefined): TokenUsage | undefined {
  if (!usage || !Number.isSafeInteger(usage.input) || usage.input < 0 || !Number.isSafeInteger(usage.output) || usage.output < 0 || !Number.isSafeInteger(usage.input + usage.output)) return;
  const detail = (n: number) => Number.isSafeInteger(n) && n >= 0 ? n : 0;
  const cacheRead = Math.min(detail(usage.cacheRead), usage.input);
  return { input: usage.input, output: usage.output, reasoning: Math.min(detail(usage.reasoning), usage.output), cacheRead, cacheWrite: Math.min(detail(usage.cacheWrite), usage.input - cacheRead) };
}
type Settlement = { state: "reported"; usage: TokenUsage; cost: number } | { state: "unknown" | "rejected" | "not_dispatched"; errorCode?: string };
interface RequestRow { id: string; root_id: string; user_id: string; period: number; provider_id: string; model_id: string; kind: UsageKind; context_json: string; state: string; dispatched_at: number | null }
export function settleCreditRequest(requestId: string, settlement: Settlement): void {
  tx(() => {
    const r = db.prepare("SELECT * FROM token_credit_requests WHERE id=?").get(requestId) as unknown as RequestRow | undefined;
    if (!r) throw new CreditError("not_found");
    if (r.state !== "open") return;
    if (settlement.state === "reported" && r.dispatched_at === null) throw new CreditError("validation");
    const usage = settlement.state === "reported" ? validCreditUsage(settlement.usage) : undefined;
    const state = settlement.state === "reported" && !usage ? "unknown" : settlement.state;
    if (state === "not_dispatched" && r.dispatched_at !== null) throw new CreditError("validation");
    const debit = usage ? usage.input + usage.output : 0;
    const error = settlement.state === "reported" ? null : settlement.errorCode ?? null;
    if (error !== null && !/^[a-z_]{1,80}$/u.test(error)) throw new CreditError("validation");
    db.prepare("UPDATE token_credit_requests SET state=?,settled_at=?,debit_tokens=?,usage_json=?,error_code=? WHERE id=? AND state='open'").run(state, Date.now(), debit, usage ? JSON.stringify(usage) : null, error, requestId);
    const update = db.prepare("UPDATE token_credit_accounts SET consumed_tokens=consumed_tokens+?,unknown_requests=unknown_requests+? WHERE user_id=? AND period=?").run(debit, state === "unknown" ? 1 : 0, r.user_id, r.period);
    if (update.changes !== 1) throw new Error("Credit period changed during settlement.");
    if (usage) {
      if (settlement.state !== "reported" || !Number.isFinite(settlement.cost) || settlement.cost < 0) throw new CreditError("validation");
      const c = JSON.parse(r.context_json) as CreditContext;
      recordUsage({ userId: r.user_id, providerId: r.provider_id, modelId: r.model_id, kind: r.kind, usage, cost: settlement.state === "reported" ? settlement.cost : 0, creditRequestId: requestId, threadId: c.threadId, channelId: c.channelId, channelRunId: c.channelRunId, apiKeyId: c.apiKeyId, apiRequestId: c.apiRequestId });
    }
  });
}

export interface CreditMutation {
  action: "set" | "clear" | "reset"; creditTokens?: number | null; expectedVersion: number;
  mutationId: string; reason: string; acknowledgeUnknown?: boolean;
}
export function mutateCreditAccount(actorId: string, userId: string, mutation: CreditMutation): TokenCreditBalance {
  return tx(() => {
    if (db.prepare("SELECT role FROM users WHERE id=?").get(actorId)?.role !== "admin") throw new CreditError("forbidden");
    if (!db.prepare("SELECT 1 FROM users WHERE id=?").get(userId)) throw new CreditError("not_found");
    const reason = mutation.reason.replace(/[\u0000-\u001f\u007f]/gu, "").trim();
    if (!reason || [...reason].length > 500 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(mutation.mutationId) || !Number.isSafeInteger(mutation.expectedVersion) || mutation.expectedVersion < 1) throw new CreditError("validation");
    if (!["set", "clear", "reset"].includes(mutation.action)) throw new CreditError("validation");
    const credit = mutation.action === "clear" ? null : mutation.creditTokens;
    if (mutation.action === "set" && (typeof credit !== "number" || !Number.isSafeInteger(credit) || credit < 0 || credit > MAX_TOKEN_CREDIT)) throw new CreditError("validation");
    const previous = db.prepare("SELECT * FROM token_credit_audit WHERE user_id=? AND mutation_id=?").get(userId, mutation.mutationId);
    if (previous) {
      const before = JSON.parse(String(previous.before_json)) as CreditSnapshot;
      const after = JSON.parse(String(previous.after_json)) as CreditSnapshot;
      if (previous.action !== mutation.action || previous.reason !== reason || before.version !== mutation.expectedVersion || (mutation.action !== "reset" && after.creditTokens !== credit) || (mutation.action === "reset" && before.unknownRequests > 0 && mutation.acknowledgeUnknown !== true)) throw new CreditError("conflict");
      return { ...after, activeOperations: activeCount(userId), asOf: Date.now() };
    }
    const a = account(userId);
    if (a.version !== mutation.expectedVersion) throw new CreditError("conflict");
    if (activeCount(userId)) throw new CreditError("token_credit_busy");
    if (mutation.action === "reset" && a.unknown_requests > 0 && mutation.acknowledgeUnknown !== true) throw new CreditError("validation");
    if (mutation.action !== "reset" && a.credit_tokens === credit) return getCreditBalance(userId);
    const before = snapshot(a);
    if (mutation.action === "reset") db.prepare("UPDATE token_credit_accounts SET consumed_tokens=0,unknown_requests=0,period=period+1,period_started_at=?,version=version+1 WHERE user_id=? AND version=?").run(Date.now(), userId, mutation.expectedVersion);
    else db.prepare("UPDATE token_credit_accounts SET credit_tokens=?,version=version+1 WHERE user_id=? AND version=?").run(credit!, userId, mutation.expectedVersion);
    const after = snapshot(account(userId));
    db.prepare("INSERT INTO token_credit_audit(user_id,actor_id,mutation_id,action,before_json,after_json,reason,created_at) VALUES (?,?,?,?,?,?,?,?)").run(userId, actorId, mutation.mutationId, mutation.action, JSON.stringify(before), JSON.stringify(after), reason, Date.now());
    return getCreditBalance(userId);
  });
}
export function listCreditAudit(userId: string, before = Number.MAX_SAFE_INTEGER, limit = 50): { rows: TokenCreditAuditEntry[]; nextCursor: number | null } {
  if (!Number.isSafeInteger(before) || before < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new CreditError("validation");
  const raw = db.prepare("SELECT * FROM token_credit_audit WHERE user_id=? AND id<? ORDER BY id DESC LIMIT ?").all(userId, before, limit + 1);
  const rows = raw.slice(0, limit).map(r => ({ id: Number(r.id), actorId: r.actor_id as string | null, action: r.action as TokenCreditAuditEntry["action"], before: JSON.parse(String(r.before_json)) as CreditSnapshot, after: JSON.parse(String(r.after_json)) as CreditSnapshot, reason: String(r.reason), createdAt: Number(r.created_at) }));
  return { rows, nextCursor: raw.length > limit ? rows.at(-1)!.id : null };
}
