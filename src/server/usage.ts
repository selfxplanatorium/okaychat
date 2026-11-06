import type { LanguageModelUsage } from "ai";
import type { GoWindow, ModelCost, TokenUsage, UsageRow } from "../shared/types.js";
import { db } from "./db.js";

export function normalizeUsage(usage: LanguageModelUsage | undefined): TokenUsage {
  const input = usage?.inputTokens ?? 0;
  // Some backends report cached > input. Clamp so cost never goes negative.
  const cacheRead = Math.min(usage?.inputTokenDetails?.cacheReadTokens ?? 0, input);
  const cacheWrite = Math.min(usage?.inputTokenDetails?.cacheWriteTokens ?? 0, input - cacheRead);
  return {
    input,
    output: usage?.outputTokens ?? 0,
    reasoning: usage?.outputTokenDetails?.reasoningTokens ?? 0,
    cacheRead,
    cacheWrite,
  };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

export const ZERO_USAGE: TokenUsage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };

/** Dollar cost of one request. Prices are per 1M tokens; tiers apply by that request's input size. */
export function costOf(cost: ModelCost | undefined, usage: TokenUsage): number {
  if (!cost) return 0;
  const tier = [...(cost.tiers ?? [])].sort((a, b) => b.above - a.above).find((t) => usage.input > t.above);
  const price = tier ?? cost;
  const cacheReadPrice = price.cacheRead ?? cost.cacheRead ?? price.input;
  const cacheWritePrice = price.cacheWrite ?? cost.cacheWrite ?? price.input;
  const fresh = Math.max(0, usage.input - usage.cacheRead - usage.cacheWrite);
  return (
    (fresh * price.input + usage.cacheRead * cacheReadPrice + usage.cacheWrite * cacheWritePrice + usage.output * price.output) /
    1_000_000
  );
}

export type UsageKind =
  | "chat"
  | "compaction"
  | "title"
  | "subagent"
  | "memory"
  | "research"
  | "evaluation"
  | "evaluation_judge"
  | "channel"
  | "api"
  | "translation"
  | "video"
  | "arena";

export function recordUsage(entry: {
  userId: string;
  threadId?: string;
  providerId: string;
  modelId: string;
  kind: UsageKind;
  usage: TokenUsage;
  cost: number;
  creditRequestId?: string;
  /** A channel reply records the room and the run, so a settled ledger row is unique per run. */
  channelId?: string;
  channelRunId?: string;
  /** External API requests carry both ids; the unique request id dedupes settlement retries. */
  apiKeyId?: string;
  apiRequestId?: string;
  videoJobId?: string;
  arenaBattleId?: string;
  arenaSide?: "A" | "B";
  costState?: "unknown" | "estimated" | "reported";
}) {
  // An API ledger row is never ambiguous: it names both its key and its request. Other kinds carry
  // neither, so a bearer request cannot be disguised as a chat.
  if (entry.kind === "api" ? !entry.apiKeyId || !entry.apiRequestId : !!entry.apiKeyId || !!entry.apiRequestId) {
    throw new Error("API usage ids do not match the usage kind.");
  }
  if (entry.kind === "arena" ? !entry.arenaBattleId || !entry.arenaSide || !!entry.threadId : !!entry.arenaBattleId || !!entry.arenaSide) throw new Error("Invalid Arena usage linkage");
  if (entry.kind === "video" ? !entry.videoJobId : entry.videoJobId !== undefined) throw new Error("Video usage id does not match kind.");
  if (entry.kind === "video" && Object.values(entry.usage).some(n => n !== 0)) throw new Error("Video usage must have zero tokens.");
  if (entry.videoJobId) {
    const previous = db.prepare("SELECT user_id, thread_id, provider_id, model_id, kind, cost, cost_state FROM usage WHERE video_job_id = ?").get(entry.videoJobId);
    if (previous) {
      if (previous.user_id !== entry.userId || previous.thread_id !== (entry.threadId ?? null) || previous.provider_id !== entry.providerId || previous.model_id !== entry.modelId || previous.kind !== "video" || previous.cost !== entry.cost || previous.cost_state !== (entry.costState ?? "estimated")) throw new Error("Conflicting video settlement.");
      return;
    }
  }
  db.prepare(
    `INSERT INTO usage (user_id, thread_id, provider_id, model_id, kind, input_tokens, output_tokens, reasoning_tokens,
       cache_read_tokens, cache_write_tokens, cost, created_at, channel_id, channel_run_id, api_key_id, api_request_id, video_job_id, cost_state, credit_request_id, arena_battle_id, arena_side)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.userId,
    entry.threadId ?? null,
    entry.providerId,
    entry.modelId,
    entry.kind,
    entry.usage.input,
    entry.usage.output,
    entry.usage.reasoning,
    entry.usage.cacheRead,
    entry.usage.cacheWrite,
    entry.cost,
    Date.now(),
    entry.channelId ?? null,
    entry.channelRunId ?? null,
    entry.apiKeyId ?? null,
    entry.apiRequestId ?? null,
    entry.videoJobId ?? null,
    entry.costState ?? "estimated",
    entry.creditRequestId ?? null,
    entry.arenaBattleId ?? null,
    entry.arenaSide ?? null,
  );
}

// A missing battle/vote fails closed, including content purge and account lifecycle races.
const VISIBLE = "(arena_battle_id IS NULL OR EXISTS (SELECT 1 FROM arena_votes v JOIN arena_battles b ON b.id=v.battle_id WHERE v.battle_id=usage.arena_battle_id AND b.user_id=usage.user_id AND v.voter_id=usage.user_id))";
export function hiddenArenaRequests(userId: string, sinceMs: number): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM token_credit_requests r WHERE r.user_id=? AND r.created_at>=? AND r.kind='arena' AND r.dispatched_at IS NOT NULL AND r.state IN ('open','reported','unknown')
    AND NOT EXISTS (SELECT 1 FROM arena_votes v JOIN arena_battles b ON b.id=v.battle_id WHERE v.battle_id=json_extract(r.context_json,'$.arenaBattleId') AND b.user_id=r.user_id AND v.voter_id=r.user_id)`).get(userId, sinceMs) as { n: number }).n;
}
const GROUPS = {
  day: "strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime')",
  model: "provider_id || '/' || model_id",
  provider: "provider_id",
  kind: "kind",
} as const;

export function usageSummary(userId: string, groupBy: keyof typeof GROUPS, sinceMs: number): UsageRow[] {
  return db
    .prepare(
      `SELECT ${GROUPS[groupBy]} AS key, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
         SUM(reasoning_tokens) AS reasoning, SUM(cache_read_tokens) AS cacheRead, SUM(cache_write_tokens) AS cacheWrite,
         SUM(cost) AS cost, COUNT(*) AS requests, COALESCE(SUM(CASE WHEN cost_state = 'unknown' THEN 1 ELSE 0 END),0) AS unknownCostRequests
       FROM usage WHERE user_id = ? AND created_at >= ? AND ${VISIBLE} GROUP BY key ORDER BY ${groupBy === "day" ? "key" : "cost DESC"}`,
    )
    .all(userId, sinceMs) as unknown as UsageRow[];
}

/** OpenCode Go meters spend in rolling 5 h / week / month windows (20% / 50% / 100% of the monthly cap). */
export function goWindows(userId: string): GoWindow[] {
  const spent = (ms: number) =>
    (
      db
        .prepare(`SELECT COALESCE(SUM(cost), 0) AS c FROM usage WHERE user_id = ? AND provider_id = 'opencode-go' AND created_at >= ? AND ${VISIBLE}`)
        .get(userId, Date.now() - ms) as { c: number }
    ).c;
  const hour = 3_600_000;
  return [
    { label: "5 hours", spent: spent(5 * hour) },
    { label: "Week", spent: spent(7 * 24 * hour) },
    { label: "Month", spent: spent(30 * 24 * hour) },
  ];
}

export function threadUsage(userId: string, threadId: string): UsageRow {
  return db
    .prepare(
      `SELECT 'thread' AS key, COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output,
         COALESCE(SUM(reasoning_tokens),0) AS reasoning, COALESCE(SUM(cache_read_tokens),0) AS cacheRead,
         COALESCE(SUM(cache_write_tokens),0) AS cacheWrite, COALESCE(SUM(cost),0) AS cost, COUNT(*) AS requests, COALESCE(SUM(CASE WHEN cost_state = 'unknown' THEN 1 ELSE 0 END),0) AS unknownCostRequests
       FROM usage WHERE user_id = ? AND thread_id = ?`,
    )
    .get(userId, threadId) as unknown as UsageRow;
}
