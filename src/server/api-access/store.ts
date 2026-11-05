import {
  API_FAILURE_CODES,
  API_LIMITS,
  type ApiFailureCode,
  type ApiKeyAuditPage,
  type ApiKeyAuditRow,
  type ApiRequestPage,
  type ApiRequestState,
  type ApiRequestSummary,
  type ApiUsageDays,
  type ApiUsageGroup,
  type ApiUsageResponse,
} from "../../shared/api-access.js";
import type { TokenUsage } from "../../shared/types.js";
import { db, tx } from "../db.js";
import { costOf } from "../usage.js";
import { recordUsage } from "../usage.js";
import { statusOf } from "./keys.js";

// External API receipts, telemetry aggregation, and transactional ledger settlement
// (docs/implementation/api-access.md). Requests, audit, rate, and usage rows are bounded operational
// metadata: they never store prompts, bodies, IPs, user agents, or provider prose.

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH = 500;

const FAILURE_SET = new Set<string>(API_FAILURE_CODES);
const failureCode = (value: string | null | undefined): ApiFailureCode | null =>
  typeof value === "string" && FAILURE_SET.has(value) ? (value as ApiFailureCode) : null;

interface RequestRow {
  id: string;
  user_id: string;
  key_id: string;
  model_ref: string;
  stream: number;
  started_at: number;
  dispatched_at: number | null;
  finished_at: number | null;
  state: ApiRequestState;
  http_status: number | null;
  error_code: string | null;
  finish_reason: "stop" | "length" | "content_filter" | null;
  usage_state: "reported" | "unknown";
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost: number;
  usage_recorded: number;
}

const REQUEST_COLUMNS = `id, user_id, key_id, model_ref, stream, started_at, dispatched_at, finished_at, state,
  http_status, error_code, finish_reason, usage_state, input_tokens, output_tokens, reasoning_tokens,
  cache_read_tokens, cache_write_tokens, cost, usage_recorded`;

const toRequestSummary = (row: RequestRow): ApiRequestSummary => {
  const reported = row.usage_state === "reported";
  return {
    id: row.id,
    keyId: row.key_id,
    modelRef: row.model_ref,
    stream: row.stream === 1,
    startedAt: row.started_at,
    dispatchedAt: row.dispatched_at,
    finishedAt: row.finished_at,
    state: row.state,
    httpStatus: row.http_status,
    errorCode: failureCode(row.error_code),
    finishReason: row.finish_reason,
    usageState: row.usage_state,
    usage: reported
      ? {
          input: row.input_tokens,
          output: row.output_tokens,
          reasoning: row.reasoning_tokens,
          cacheRead: row.cache_read_tokens,
          cacheWrite: row.cache_write_tokens,
        }
      : null,
    cost: reported ? row.cost : null,
  };
};

// Telemetry floor ---------------------------------------------------------------------------------------

function storedFloor(userId: string): number | null {
  const row = db.prepare("SELECT since_at FROM api_telemetry_floors WHERE user_id = ?").get(userId) as { since_at: number } | undefined;
  return row?.since_at ?? null;
}

function raiseFloor(userId: string, at: number): void {
  db.prepare(
    `INSERT INTO api_telemetry_floors (user_id, since_at) VALUES (?, ?)
     ON CONFLICT (user_id) DO UPDATE SET since_at = MAX(since_at, excluded.since_at)`,
  ).run(userId, at);
}

/** The oldest request detail still trustworthy: the 30-day age floor or the cap-pruned floor. */
export function telemetryFloor(userId: string, now = Date.now()): number {
  return Math.max(now - API_LIMITS.telemetryDays * DAY_MS, storedFloor(userId) ?? 0);
}

// Retention ---------------------------------------------------------------------------------------------

/**
 * Bounded retention: requests older than 30 days or beyond 10,000 rows (oldest terminal rows first, never
 * an active one), audit older than 90 days, and stale minute windows. A cap deletion raises the account
 * telemetry floor so the usage panel can say its detail view is truncated.
 */
export function pruneApiTelemetry(userId: string, now = Date.now()): void {
  const ageCutoff = now - API_LIMITS.requestRetentionDays * DAY_MS;
  db.prepare("DELETE FROM api_requests WHERE rowid IN (SELECT rowid FROM api_requests WHERE user_id = ? AND started_at < ? LIMIT ?)")
    .run(userId, ageCutoff, BATCH);
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM api_requests WHERE user_id = ?").get(userId) as { n: number };
  if (n > API_LIMITS.requestRetentionRows) {
    const excess = Math.min(BATCH, n - API_LIMITS.requestRetentionRows);
    const pruned = db
      .prepare(
        `SELECT id, started_at FROM api_requests
         WHERE user_id = ? AND state NOT IN ('admitted','running')
         ORDER BY started_at ASC, id ASC LIMIT ?`,
      )
      .all(userId, excess) as Array<{ id: string; started_at: number }>;
    for (const row of pruned) {
      db.prepare("DELETE FROM api_requests WHERE id = ? AND user_id = ?").run(row.id, userId);
      raiseFloor(userId, row.started_at + 1);
    }
  }
  db.prepare("DELETE FROM api_rate_windows WHERE rowid IN (SELECT rowid FROM api_rate_windows WHERE user_id = ? AND window_start < ? LIMIT ?)")
    .run(userId, now - 3 * 60_000, BATCH);
}

/** Startup interruption: open receipts never resume or bill again. */
export function interruptOpenApiRequests(now = Date.now()): number {
  const result = db
    .prepare(
      `UPDATE api_requests SET state = 'interrupted', error_code = 'interrupted', finished_at = ?
       WHERE state IN ('admitted','running')`,
    )
    .run(now);
  return Number(result.changes);
}

// Receipts ----------------------------------------------------------------------------------------------

export function openApiRequest(input: { id: string; userId: string; keyId: string; modelRef: string; stream: boolean; now?: number }): void {
  db.prepare(
    `INSERT INTO api_requests (id, user_id, key_id, model_ref, stream, started_at, state)
     VALUES (?, ?, ?, ?, ?, ?, 'admitted')`,
  ).run(input.id, input.userId, input.keyId, input.modelRef, input.stream ? 1 : 0, input.now ?? Date.now());
}

export function markApiDispatched(id: string, userId: string, now = Date.now()): void {
  db.prepare("UPDATE api_requests SET state = 'running', dispatched_at = ? WHERE id = ? AND user_id = ? AND state = 'admitted'").run(now, id, userId);
}

export interface Settlement {
  state: Extract<ApiRequestState, "succeeded" | "failed" | "cancelled" | "interrupted">;
  httpStatus: number | null;
  errorCode: string | null;
  finishReason: "stop" | "length" | "content_filter" | null;
  usage?: TokenUsage | null;
  cost?: number;
  now?: number;
}

/**
 * Settles one receipt and inserts its ledger row in the same transaction. The conditional transition makes
 * duplicate callbacks and abort races no-ops: a terminal result is never replaced. Usage is recorded only
 * when the provider actually reported it.
 */
export function settleApiRequest(input: {
  id: string;
  userId: string;
  keyId: string;
  providerId: string;
  modelId: string;
  settlement: Settlement;
}): boolean {
  const { settlement } = input;
  const now = settlement.now ?? Date.now();
  return tx(() => {
    const changed = db
      .prepare(
        `UPDATE api_requests SET state = ?, finished_at = ?, http_status = ?, error_code = ?, finish_reason = ?,
           usage_state = ?, input_tokens = ?, output_tokens = ?, reasoning_tokens = ?, cache_read_tokens = ?,
           cache_write_tokens = ?, cost = ?, usage_recorded = ?
         WHERE id = ? AND user_id = ? AND state IN ('admitted','running')`,
      )
      .run(
        settlement.state,
        now,
        settlement.httpStatus,
        settlement.errorCode,
        settlement.finishReason,
        settlement.usage ? "reported" : "unknown",
        settlement.usage?.input ?? 0,
        settlement.usage?.output ?? 0,
        settlement.usage?.reasoning ?? 0,
        settlement.usage?.cacheRead ?? 0,
        settlement.usage?.cacheWrite ?? 0,
        settlement.cost ?? 0,
        settlement.usage ? 1 : 0,
        input.id,
        input.userId,
      );
    if (Number(changed.changes) === 0) return false;
    if (settlement.usage) {
      // The unique api_request_id index makes a repeated insert impossible even outside this guard.
      const existing = db.prepare("SELECT 1 FROM usage WHERE api_request_id = ?").get(input.id);
      if (!existing) {
        recordUsage({
          userId: input.userId,
          providerId: input.providerId,
          modelId: input.modelId,
          kind: "api",
          usage: settlement.usage,
          cost: settlement.cost ?? 0,
          apiKeyId: input.keyId,
          apiRequestId: input.id,
        });
      }
    }
    return true;
  });
}

export function costFor(modelRefCost: Parameters<typeof costOf>[0], usage: TokenUsage | null): number {
  return usage ? costOf(modelRefCost, usage) : 0;
}

// Management reads --------------------------------------------------------------------------------------

export function apiRequestsPage(userId: string, options: { keyId?: string; before?: string; limit: number }): ApiRequestPage {
  const limit = Math.min(100, Math.max(1, options.limit));
  const cursor = options.before ? decodeRequestCursor(options.before) : null;
  const clauses = ["user_id = ?"];
  const values: Array<string | number> = [userId];
  if (options.keyId) {
    clauses.push("key_id = ?");
    values.push(options.keyId);
  }
  if (cursor) {
    clauses.push("(started_at < ? OR (started_at = ? AND id < ?))");
    values.push(cursor[0], cursor[0], cursor[1]);
  }
  const rows = db
    .prepare(`SELECT ${REQUEST_COLUMNS} FROM api_requests WHERE ${clauses.join(" AND ")} ORDER BY started_at DESC, id DESC LIMIT ?`)
    .all(...values, limit + 1) as unknown as RequestRow[];
  const page = rows.slice(0, limit);
  const next = rows.length > limit ? encodeRequestCursor([page.at(-1)!.started_at, page.at(-1)!.id]) : null;
  return { rows: page.map(toRequestSummary), nextCursor: next };
}

export function encodeRequestCursor(value: [number, string]): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeRequestCursor(value: string): [number, string] | null {
  if (value.length > 200) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [startedAt, id] = parsed;
    if (typeof startedAt !== "number" || !Number.isSafeInteger(startedAt) || typeof id !== "string" || !id || id.length > 200) return null;
    return [startedAt, id];
  } catch {
    return null;
  }
}

export function apiAuditPage(userId: string, options: { before?: number; limit: number }): ApiKeyAuditPage {
  const limit = Math.min(100, Math.max(1, options.limit));
  const rows = db
    .prepare(
      `SELECT id, key_id, event, created_at FROM api_key_audit
       WHERE user_id = ? ${options.before ? "AND id < ?" : ""} ORDER BY id DESC LIMIT ?`,
    )
    .all(...(options.before ? [userId, options.before, limit + 1] : [userId, limit + 1])) as Array<{
    id: number;
    key_id: string;
    event: ApiKeyAuditRow["event"];
    created_at: number;
  }>;
  const page = rows.slice(0, limit);
  return {
    rows: page.map((row) => ({ id: row.id, keyId: row.key_id, event: row.event, createdAt: row.created_at })),
    nextCursor: rows.length > limit ? page.at(-1)!.id : null,
  };
}

interface UsageAggregateRow {
  key: string | null;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  requests: number;
}

const GROUPS: Record<ApiUsageResponse["groupBy"], string> = {
  // UTC days here, unlike the account-wide local-day grouping.
  day: "strftime('%Y-%m-%d', created_at / 1000, 'unixepoch')",
  model: "provider_id || '/' || model_id",
  key: "COALESCE(api_key_id, '')",
};

const emptyUsage = (): TokenUsage => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });

const addUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  reasoning: a.reasoning + b.reasoning,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
});

/** Ledger aggregates for API traffic in `[since, until)`, plus bounded request counters. */
export function apiUsage(userId: string, options: { days: ApiUsageDays; keyId?: string; groupBy: ApiUsageResponse["groupBy"]; now?: number }): ApiUsageResponse {
  const until = options.now ?? Date.now();
  const since = until - options.days * DAY_MS;
  const keyClause = options.keyId ? "AND api_key_id = ?" : "";
  const keyValues = options.keyId ? [options.keyId] : [];
  const rows = db
    .prepare(
      `SELECT ${GROUPS[options.groupBy]} AS key, COALESCE(SUM(input_tokens),0) AS input,
         COALESCE(SUM(output_tokens),0) AS output, COALESCE(SUM(reasoning_tokens),0) AS reasoning,
         COALESCE(SUM(cache_read_tokens),0) AS cacheRead, COALESCE(SUM(cache_write_tokens),0) AS cacheWrite,
         COALESCE(SUM(cost),0) AS cost, COUNT(*) AS requests
       FROM usage WHERE user_id = ? AND kind = 'api' AND created_at >= ? AND created_at < ? ${keyClause}
       GROUP BY key ORDER BY cost DESC, key ASC`,
    )
    .all(userId, since, until, ...keyValues) as unknown as UsageAggregateRow[];
  const groups: ApiUsageGroup[] = rows.map((row) => ({
    key: options.groupBy === "key" ? (row.key || null) : row.key,
    usage: { input: row.input, output: row.output, reasoning: row.reasoning, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite },
    cost: row.cost,
    meteredRequests: row.requests,
  }));
  let capped = groups;
  if (groups.length > 400) {
    const head = groups.slice(0, 399);
    const rest = groups.slice(399);
    const other = rest.reduce(
      (acc, group) => ({
        key: null,
        usage: addUsage(acc.usage, group.usage),
        cost: acc.cost + group.cost,
        meteredRequests: acc.meteredRequests + group.meteredRequests,
      }),
      { key: null, usage: emptyUsage(), cost: 0, meteredRequests: 0 } as ApiUsageGroup,
    );
    capped = [...head, other];
  }
  const totals = groups.reduce(
    (acc, group) => ({
      usage: addUsage(acc.usage, group.usage),
      cost: acc.cost + group.cost,
      meteredRequests: acc.meteredRequests + group.meteredRequests,
    }),
    { usage: emptyUsage(), cost: 0, meteredRequests: 0 },
  );
  const floor = telemetryFloor(userId, until);
  const from = Math.max(since, floor);
  const counts = db
    .prepare(
      `SELECT state, COUNT(*) AS n FROM api_requests
       WHERE user_id = ? AND started_at >= ? AND started_at < ? ${options.keyId ? "AND key_id = ?" : ""}
       GROUP BY state`,
    )
    .all(...[userId, from, until, ...keyValues]) as Array<{ state: ApiRequestState; n: number }>;
  const byState = Object.fromEntries(counts.map((row) => [row.state, row.n])) as Partial<Record<ApiRequestState, number>>;
  const unknown = db
    .prepare(
      `SELECT COUNT(*) AS n FROM api_requests WHERE user_id = ? AND started_at >= ? AND started_at < ?
       AND state NOT IN ('admitted','running') AND usage_state = 'unknown' ${options.keyId ? "AND key_id = ?" : ""}`,
    )
    .get(...[userId, from, until, ...keyValues]) as { n: number };
  return {
    since,
    until,
    groupBy: options.groupBy,
    rows: capped,
    totals,
    telemetrySince: floor,
    telemetryTruncated: floor > since,
    requests: {
      admitted: Object.values(byState).reduce((n, value) => n + (value ?? 0), 0),
      running: (byState.admitted ?? 0) + (byState.running ?? 0),
      succeeded: byState.succeeded ?? 0,
      failed: byState.failed ?? 0,
      cancelled: byState.cancelled ?? 0,
      interrupted: byState.interrupted ?? 0,
      unknownUsage: unknown.n,
    },
  };
}

/** The key status used by the settings page's own summary (shared with the store projection). */
export const keyStatus = statusOf;
