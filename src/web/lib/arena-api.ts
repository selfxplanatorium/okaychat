import type {
  ArenaChoice,
  ArenaMode,
  ArenaPaneState,
  ArenaSide,
  ArenaStart,
  BattleView,
  LeaderboardPage,
} from "@shared/arena";
import type { PlainMessageKey } from "@/i18n";
import { ApiError, api, responseError } from "@/lib/api";

/** The eligible pool and policy limits Arena can use for this account. Never a selected pair. */
export interface ArenaModelOption {
  ref: string;
  name: string;
  publicEligible: boolean;
}
export interface ArenaOptions {
  modes: { personal: boolean; public: boolean };
  models: ArenaModelOption[];
  limits: { maxPrompt: number; maxContents: number; concurrentPanes: number };
  disabledReason?: string;
}

export type ArenaLeaderboardSort = "rank" | "rating" | "battles" | "wins" | "winRate";
export type ArenaLeaderboardDirection = "asc" | "desc";
export type ArenaLeaderboardProvisional = "include" | "exclude";
export interface ArenaLeaderboardQuery {
  scope?: "mine" | "global";
  window: "all" | "30d";
  sort: ArenaLeaderboardSort;
  direction: ArenaLeaderboardDirection;
  q: string;
  provisional: ArenaLeaderboardProvisional;
  offset: number;
  limit: number;
}

export const getArenaOptions = () => api<ArenaOptions>("/arena/options");

const MODE_PREFIX = "okaychat:arena:mode:";

/** Mode is a device preference, scoped to the account. The prompt and pool never persist. */
export function readArenaMode(accountId: string): ArenaMode | null {
  try {
    const stored = localStorage.getItem(`${MODE_PREFIX}${accountId}`);
    return stored === "personal" || stored === "public" ? stored : null;
  } catch {
    return null;
  }
}

export function writeArenaMode(accountId: string, mode: ArenaMode): void {
  try {
    localStorage.setItem(`${MODE_PREFIX}${accountId}`, mode);
  } catch {
    // It is only a preference; blocked storage leaves Personal selected.
  }
}

export const startArenaBattle = (input: ArenaStart) =>
  api<{ battle: BattleView }>("/arena/battles", { method: "POST", json: input });

export const getArenaBattle = (id: string) =>
  api<{ battle: BattleView }>(`/arena/battles/${encodeURIComponent(id)}`);

export const findArenaBattleByMutation = (mutationId: string) =>
  api<{ battle: BattleView | null }>(`/arena/battles?mutationId=${encodeURIComponent(mutationId)}`);

export const stopArenaBattle = (id: string) =>
  api<{ battle: BattleView }>(`/arena/battles/${encodeURIComponent(id)}/stop`, { method: "POST", json: {} });

export const voteArenaBattle = (id: string, choice: ArenaChoice) =>
  api<{ battle: BattleView; vote: { choice: ArenaChoice; createdAt: number }; ratingRevision: number }>(
    `/arena/battles/${encodeURIComponent(id)}/vote`,
    { method: "POST", json: { choice } },
  );

export const discardArenaContent = (id: string) =>
  api<{ ok: true }>(`/arena/battles/${encodeURIComponent(id)}/content`, { method: "DELETE" });

function leaderboardPath(query: ArenaLeaderboardQuery, publicBoard: boolean) {
  const params = new URLSearchParams();
  if (!publicBoard && query.scope) params.set("scope", query.scope);
  params.set("window", query.window);
  params.set("sort", query.sort);
  params.set("direction", query.direction);
  if (query.q) params.set("q", query.q);
  params.set("provisional", query.provisional);
  params.set("offset", String(query.offset));
  params.set("limit", String(query.limit));
  return `${publicBoard ? "/public" : ""}/arena/leaderboard?${params.toString()}`;
}

export const getArenaLeaderboard = (query: ArenaLeaderboardQuery, publicBoard = false) =>
  api<LeaderboardPage>(leaderboardPath(query, publicBoard));

export const isArenaNetworkError = (error: unknown) => error instanceof ApiError && error.status === 0;

const ERROR_KEYS: Record<string, PlainMessageKey> = {
  token_credit_exhausted: "arena.errorCredits",
  token_credit_busy: "arena.errorCreditBusy",
  token_credit_usage_unknown: "arena.errorCreditUnknown",
  token_credit_unmetered: "arena.errorUnmetered",
  storage_quota: "arena.errorQuota",
  rate_limited: "arena.errorRate",
  network: "arena.errorNetwork",
  timeout: "arena.errorNetwork",
  aborted: "arena.errorNetwork",
  conflict: "arena.errorConflict",
  not_found: "arena.errorNotFound",
  forbidden: "arena.errorForbidden",
  validation: "arena.errorValidation",
  default: "arena.errorGeneric",
};

/** Map the safe wire code to authored Arena copy; provider prose never reaches this layer. */
export function arenaErrorKey(error: unknown): PlainMessageKey {
  const code = error instanceof ApiError ? error.code : "default";
  return ERROR_KEYS[code] ?? ERROR_KEYS.default!;
}

export interface ArenaStreamHandlers {
  onSnapshot: (battle: BattleView) => void;
  onText: (side: ArenaSide, delta: string) => void;
  onPane: (update: {
    side: ArenaSide;
    state: ArenaPaneState;
    finish?: "stop" | "length";
    errorCode?: string;
  }) => void;
  onState: (update: { state?: BattleView["state"]; canVote?: boolean }) => void;
  onError: (error: unknown) => void;
  onEnd?: () => void;
}

/** One SSE frame is small; the server batches to 50 ms. These caps stop a broken stream from growing memory. */
const MAX_FRAME_BYTES = 512 * 1024;
const MAX_LINE_BYTES = 512 * 1024;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isBattle = (value: unknown): value is BattleView => {
  if (!isObject(value) || (value.visibility !== "blind" && value.visibility !== "revealed")) return false;
  if (typeof value.id !== "string" || !Array.isArray(value.panes) || value.panes.length !== 2) return false;
  return typeof value.state === "string" && typeof value.createdAt === "number";
};

const isSide = (value: unknown): value is ArenaSide => value === "A" || value === "B";

const panic = (message: string) => new Error(message);

/**
 * Reads the server-owned multiplexed battle stream. It never starts a run: attaching is a read, and a terminal
 * stream closes. Every frame is bounded before dispatch, and a malformed frame fails the reader rather than
 * leaking an upstream string into the UI.
 */
export async function subscribeArenaEvents(
  battleId: string,
  handlers: ArenaStreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`/api/arena/battles/${encodeURIComponent(battleId)}/events`, {
      credentials: "same-origin",
      headers: { Accept: "text/event-stream" },
      signal,
    });
  } catch (error) {
    if (signal.aborted) return;
    throw error;
  }
  if (!response.ok) throw await responseError(response, `/arena/battles/${battleId}/events`);
  if (!response.body) throw panic("Arena stream has no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  let dataLines: string[] = [];
  let dataBytes = 0;

  const dispatch = () => {
    const raw = dataLines.join("\n");
    const name = eventName;
    eventName = "";
    dataLines = [];
    dataBytes = 0;
    if (!raw) return;
    let payload: unknown;
    try {
      payload = JSON.parse(raw) as unknown;
    } catch {
      throw panic("Arena stream sent malformed JSON");
    }
    if (!isObject(payload)) return;

    if (name === "snapshot" || payload.type === "snapshot" || isBattle(payload)) {
      const battle = isBattle(payload) ? payload : isBattle(payload.battle) ? payload.battle : null;
      if (battle) handlers.onSnapshot(battle);
      return;
    }
    if (name === "text" || payload.type === "text" || (isSide(payload.side) && typeof payload.delta === "string")) {
      if (!isSide(payload.side) || typeof payload.delta !== "string") throw panic("Arena stream sent an invalid text frame");
      if (new TextEncoder().encode(payload.delta).byteLength > 8 * 1024) throw panic("Arena stream frame is too large");
      handlers.onText(payload.side, payload.delta);
      return;
    }
    if (name === "pane" || payload.type === "pane") {
      if (!isSide(payload.side) || typeof payload.state !== "string") throw panic("Arena stream sent an invalid pane frame");
      handlers.onPane({
        side: payload.side,
        state: payload.state as ArenaPaneState,
        ...(payload.finish === "stop" || payload.finish === "length" ? { finish: payload.finish } : {}),
        ...(typeof payload.errorCode === "string" ? { errorCode: payload.errorCode } : {}),
      });
      return;
    }
    if (name === "battle" || payload.type === "battle") {
      const state = typeof payload.state === "string" ? (payload.state as BattleView["state"]) : undefined;
      const canVote = typeof payload.canVote === "boolean" ? payload.canVote : undefined;
      if (state || canVote !== undefined) handlers.onState({ ...(state ? { state } : {}), ...(canVote !== undefined ? { canVote } : {}) });
    }
  };

  const line = (rawLine: string) => {
    const text = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!text) {
      dispatch();
      return;
    }
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    else if (field === "data") {
      dataLines.push(value);
      dataBytes += new TextEncoder().encode(value).byteLength;
      if (dataBytes > MAX_FRAME_BYTES) throw panic("Arena stream frame is too large");
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const rawLine = buffer.slice(0, newline);
        if (new TextEncoder().encode(rawLine).byteLength > MAX_LINE_BYTES) throw panic("Arena stream line is too large");
        buffer = buffer.slice(newline + 1);
        line(rawLine);
      }
      if (new TextEncoder().encode(buffer).byteLength > MAX_LINE_BYTES) throw panic("Arena stream line is too large");
    }
    buffer += decoder.decode();
    if (buffer) line(buffer);
    dispatch();
    handlers.onEnd?.();
  } catch (error) {
    // A failed frame ends the attachment, not just the parser: never leave the body half-read.
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

const PENDING_PREFIX = "okaychat:arena:mutation:";
export interface PendingArenaMutation {
  mutationId: string;
  at: number;
}

/** Only the opaque mutation id is kept; the prompt, pool, and assignments never touch browser storage. */
export function readPendingArenaMutation(accountId: string): PendingArenaMutation | null {
  try {
    const raw = localStorage.getItem(`${PENDING_PREFIX}${accountId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed) || typeof parsed.mutationId !== "string" || !parsed.mutationId) return null;
    return { mutationId: parsed.mutationId, at: typeof parsed.at === "number" ? parsed.at : 0 };
  } catch {
    return null;
  }
}

export function writePendingArenaMutation(accountId: string, mutationId: string): void {
  try {
    localStorage.setItem(`${PENDING_PREFIX}${accountId}`, JSON.stringify({ mutationId, at: Date.now() }));
  } catch {
    // Storage can be unavailable on locked-down browsers; recovery is best effort.
  }
}

export function clearPendingArenaMutation(accountId: string): void {
  try {
    localStorage.removeItem(`${PENDING_PREFIX}${accountId}`);
  } catch {
    // Same best-effort rule as writes.
  }
}
