import { createHmac, timingSafeEqual } from "node:crypto";
import { db, afterCommit } from "../db.js";
import { env } from "../env.js";
import { AppError } from "../errors.js";
import { featureAllowed } from "../permissions/guard.js";
import { channelEligibility, channelRow, memberRow } from "./access.js";
import { CHANNEL_LIMITS, type ChannelEvent, type ChannelEventKind } from "../../shared/channels.js";

/**
 * Durable channel invalidations. The database is always the source of truth: an event says "this id
 * changed", never what its body is. SSE only wakes a pump; replay is a bounded scan of `channel_events`.
 */

const cursorKey = createHmac("sha256", env.secret).update("okaychat:channel-event-cursor:v1").digest();

interface CursorPayload {
  v: 1;
  epoch: string;
  seq: string;
  userId: string;
}

export function eventState(): { epoch: string; floor: bigint } {
  const row = db.prepare("SELECT epoch, floor_id FROM channel_event_state WHERE singleton = 1").get() as { epoch: string; floor_id: number | bigint } | undefined;
  return { epoch: row?.epoch ?? "missing", floor: BigInt(row?.floor_id ?? 0) };
}

export function encodeCursor(payload: CursorPayload): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", cursorKey).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export interface EventCursor {
  epoch: string;
  seq: bigint;
  userId: string;
}

export function decodeCursor(value: string | undefined): EventCursor | null {
  if (!value) return null;
  if (value.length > 512) throw cursorInvalid();
  const dot = value.lastIndexOf(".");
  if (dot <= 0) throw cursorInvalid();
  const body = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  const expected = createHmac("sha256", cursorKey).update(body).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw cursorInvalid();
  let payload: CursorPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as CursorPayload;
  } catch {
    throw cursorInvalid();
  }
  if (payload.v !== 1 || typeof payload.epoch !== "string" || typeof payload.userId !== "string" || !/^\d{1,20}$/.test(payload.seq)) throw cursorInvalid();
  const seq = BigInt(payload.seq);
  if (seq < 0n || seq > 9_007_199_254_740_991n * 16n) throw cursorInvalid();
  return { epoch: payload.epoch, seq, userId: payload.userId };
}

function cursorInvalid(): AppError {
  return new AppError({ code: "validation", status: 400, message: "That channel cursor is not valid.", details: { reason: "cursor_invalid" } });
}

export function cursorFor(userId: string, seq: bigint): string {
  return encodeCursor({ v: 1, epoch: eventState().epoch, seq: seq.toString(), userId });
}

export function latestEventId(): bigint {
  const statement = db.prepare("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'channel_events'), 0) AS id");
  statement.setReadBigInts(true);
  return (statement.get() as { id: bigint }).id;
}

/** A cursor a client can use immediately, after one synchronous read. */
export function currentCursor(userId: string): string {
  return cursorFor(userId, latestEventId());
}

export interface RawEvent {
  id: bigint;
  channel_id: string | null;
  target_user_id: string | null;
  kind: ChannelEventKind;
  entity_id: string | null;
  version: number | null;
  created_at: number;
}

export function readEvents(after: bigint, limit: number): RawEvent[] {
  const statement = db.prepare(
    `SELECT id, channel_id, target_user_id, kind, entity_id, version, created_at
     FROM channel_events WHERE id > ? ORDER BY id LIMIT ?`,
  );
  statement.setReadBigInts(true);
  const rows = statement.all(after, limit) as unknown as Array<Omit<RawEvent, "version" | "created_at"> & { version: bigint | null; created_at: bigint }>;
  // Only the event id needs BigInt arithmetic; the other integers fit the wire type.
  return rows.map((row) => ({ ...row, version: row.version === null ? null : Number(row.version), created_at: Number(row.created_at) }));
}

/** Every frame is re-authorized against the live account, feature, room, and group state. */
export function eventVisible(userId: string, row: RawEvent): boolean {
  if (row.target_user_id && row.target_user_id !== userId) return false;
  if (!row.channel_id) return true; // A generic sync carries no private metadata.
  if (!featureAllowed(userId, "channels")) return false;
  const channel = channelRow(row.channel_id);
  if (!channel) return false;
  if (!channelEligibility(userId, channel)) return false;
  return !!memberRow(row.channel_id, userId);
}

export function projectEvent(row: RawEvent): ChannelEvent {
  return {
    type: row.kind,
    ...(row.channel_id ? { channelId: row.channel_id } : {}),
    ...(row.entity_id ? { entityId: row.entity_id } : {}),
    ...(row.version !== null ? { version: row.version } : {}),
  };
}

/** Inserts one invalidation in the caller's transaction; waking subscribers waits for the commit. */
export function insertEvent(input: {
  channelId?: string | null;
  targetUserId?: string | null;
  kind: ChannelEventKind;
  entityId?: string | null;
  version?: number | null;
}): void {
  db.prepare(
    `INSERT INTO channel_events (channel_id, target_user_id, kind, entity_id, version, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(input.channelId ?? null, input.targetUserId ?? null, input.kind, input.entityId ?? null, input.version ?? null, Date.now());
  afterCommit(wakeEvents);
}

/** A global invalidation: every connected client re-reads its membership list. */
export function insertSync(): void {
  insertEvent({ kind: "sync" });
}

// ---------------------------------------------------------------------------------------------------
// Wake bus. Commits only resolve waiters; they never carry bodies or room ids.
// ---------------------------------------------------------------------------------------------------

const waiters = new Set<() => void>();
let wakeGeneration = 0;

export function wakeEvents(): void {
  wakeGeneration++;
  if (!waiters.size) return;
  const pending = [...waiters];
  waiters.clear();
  for (const resolve of pending) resolve();
}

/** Read before a scan and again before waiting; a commit in between means scan again at once. */
export const eventWakeGeneration = (): number => wakeGeneration;

export function waitForEvents(timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      waiters.delete(finish);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    waiters.add(finish);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

// ---------------------------------------------------------------------------------------------------
// Bounded stream slots. Two per account, 256 process-wide; a hidden tab may poll instead.
// ---------------------------------------------------------------------------------------------------

const MAX_STREAMS_PER_ACCOUNT = 2;
const MAX_STREAMS = 256;
const accountStreams = new Map<string, number>();
let streamCount = 0;

export function acquireStream(userId: string): () => void {
  const mine = accountStreams.get(userId) ?? 0;
  if (mine >= MAX_STREAMS_PER_ACCOUNT || streamCount >= MAX_STREAMS) {
    throw new AppError({
      code: "rate_limited",
      status: 429,
      message: "Too many live channel connections. Another tab can use polling.",
      retryAfterMs: 5_000,
    });
  }
  accountStreams.set(userId, mine + 1);
  streamCount++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    streamCount--;
    const left = (accountStreams.get(userId) ?? 1) - 1;
    if (left > 0) accountStreams.set(userId, left);
    else accountStreams.delete(userId);
  };
}

export function streamCounts(): { process: number; accounts: number } {
  return { process: streamCount, accounts: accountStreams.size };
}

// ---------------------------------------------------------------------------------------------------
// Polling / replay
// ---------------------------------------------------------------------------------------------------

export type ChangesResult =
  | { reset: true; reason: "history_expired" }
  | { events: Array<{ cursor: string; event: ChannelEvent }>; cursor: string; hasMore: boolean; reset: false };

/**
 * Advances a cursor through at most 1,000 raw rows while emitting at most 200 visible events. The
 * returned cursor always covers every scanned row, including ones the caller may not see, so it makes
 * progress and reveals no room id.
 */
export function scanChanges(userId: string, cursorValue: string, limit = CHANNEL_LIMITS.eventPage): ChangesResult {
  const cursor = decodeCursor(cursorValue);
  if (!cursor || cursor.userId !== userId) throw cursorInvalid();
  const state = eventState();
  if (cursor.epoch === state.epoch && cursor.seq > latestEventId()) throw cursorInvalid();
  if (cursor.epoch !== state.epoch || cursor.seq < state.floor) return { reset: true, reason: "history_expired" };
  const rows = readEvents(cursor.seq, CHANNEL_LIMITS.eventScan);
  if (!rows.length) return { events: [], cursor: cursorFor(userId, cursor.seq), hasMore: false, reset: false };
  const events: Array<{ cursor: string; event: ChannelEvent }> = [];
  let scanned = cursor.seq;
  for (const row of rows) {
    if (events.length >= limit) break;
    scanned = row.id;
    if (!eventVisible(userId, row)) continue;
    events.push({ cursor: cursorFor(userId, row.id), event: projectEvent(row) });
  }
  const hasMore = rows.length === CHANNEL_LIMITS.eventScan || (rows.length > 0 && scanned < rows[rows.length - 1]!.id);
  return { events, cursor: cursorFor(userId, scanned), hasMore, reset: false };
}

/** True when a supplied cursor is structurally valid, belongs to the user, and is still replayable. */
export function isReplayable(userId: string, cursor: EventCursor): "ok" | "reset" {
  const state = eventState();
  return cursor.epoch === state.epoch && cursor.seq >= state.floor ? "ok" : "reset";
}
