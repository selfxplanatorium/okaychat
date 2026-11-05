import { randomBytes } from "node:crypto";
import { db } from "../db.js";
import { AppError } from "../errors.js";
import { sessionAlive } from "../auth.js";
import { featureAllowed } from "../permissions/guard.js";
import { channelActivitySettings } from "../settings.js";
import { CHANNEL_ACTIVITY_LIMITS, channelTypingScopeKey, type ChannelActivityFrame, type ChannelActivitySettings, type ChannelPresenceState } from "../../shared/channel-activity.js";
import { channelEligibility, channelRow, liveUser, memberRow, notFound, type ChannelRow } from "./access.js";
import { activityNow } from "./activity-clock.js";
import { onChannelActivitySettingsChange } from "./activity-hooks.js";
import { chargeConnectionActivityRate, pruneActivityRates } from "./activity-rate.js";
import { onChannelRevocation } from "./revocation.js";

/**
 * Process-local presence and typing.
 *
 * Nothing here is durable: restarting the server shows everyone as offline, which is the honest
 * answer. Every projection is recomputed from the live account/room/membership state so a revoked
 * account cannot receive a cached roster, and no activity path writes SQL. The only inputs are the
 * authenticated stream and the two explicit account preferences.
 */

const L = CHANNEL_ACTIVITY_LIMITS;

interface Connection {
  id: string;
  userId: string;
  sessionHash: string;
  /** Monotonic time of the last accepted activity POST; null until the first one. */
  activityAt: number | null;
  activityState: "active" | "idle" | null;
  watch: { channelId: string; rootId: string | null } | null;
  watchRevision: number;
  typing: { channelId: string; rootId: string | null; expiresAt: number } | null;
  acceptedSeq: number;
  dirty: boolean;
  /** A window that may not be coalesced: watch bootstrap, clear, or a fresh call to look at. */
  forceSnapshot: boolean;
  clearPending: boolean;
  lastFrameAt: number;
  lastSnapshotAt: number;
  blocked: boolean;
  closed: boolean;
  waiters: Set<() => void>;
}

interface Grace {
  id: string;
  userId: string;
  sessionHash: string;
  state: "online" | "away";
  validUntil: number;
  expiresAt: number;
}

interface Roster {
  channel: ChannelRow;
  members: Set<string>;
  ordered: string[];
  at: number;
}

export interface ChannelActivityStream {
  connectionId: string;
  /** Monotonic time the next output is due, or null when nothing is scheduled. */
  nextDueAt: () => number | null;
  /** The serialized frame to write now, or null when nothing is due. Never returns when blocked. */
  takeFrame: () => string | null;
  waitForWake: (timeoutMs: number, signal: AbortSignal) => Promise<void>;
  release: () => void;
}

const ROSTER_TTL = 30_000;
const PREFERENCE_TTL = 5_000;
const FEATURE_TTL = 5_000;
const CACHE_IDLE = 120_000;

const connections = new Map<string, Connection>();
const byUser = new Map<string, Set<string>>();
const channelWatchers = new Map<string, Set<string>>();
const typingByScope = new Map<string, Set<string>>();
const grace = new Map<string, Grace>();
const graceByUser = new Map<string, Set<string>>();
const rosters = new Map<string, Roster>();
const preferences = new Map<string, { value: ChannelActivitySettings; at: number }>();
const features = new Map<string, { allowed: boolean; at: number }>();
const lastPresence = new Map<string, ChannelPresenceState>();

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let lastHousekeeping = 0;
let initialized = false;

export function activityConnectionId(): string {
  return randomBytes(32).toString("base64url");
}

function connectionNotFound(): AppError {
  return new AppError({ code: "not_found", message: "That connection is not active." });
}

function touch<T extends { at: number }>(map: Map<string, T>, key: string, value: T): void {
  if (map.size >= 1_024 && !map.has(key)) {
    for (const [existing, entry] of map) if (activityNow() - entry.at > CACHE_IDLE) map.delete(existing);
    if (map.size >= 1_024) return; // A bounded cache misses instead of evicting something live.
  }
  map.set(key, value);
}

/** Preference reads are cached for a few seconds; the settings write hook clears the entry at once. */
function share(userId: string): ChannelActivitySettings {
  const cached = preferences.get(userId);
  const now = activityNow();
  if (cached && now - cached.at < PREFERENCE_TTL) return cached.value;
  const value = channelActivitySettings(userId);
  touch(preferences, userId, { value, at: now });
  return value;
}

function featureOn(userId: string): boolean {
  const cached = features.get(userId);
  const now = activityNow();
  if (cached && now - cached.at < FEATURE_TTL) return cached.allowed;
  const allowed = liveUser(userId) && featureAllowed(userId, "channels");
  touch(features, userId, { allowed, at: now });
  return allowed;
}

function roster(channelId: string): Roster | null {
  const now = activityNow();
  const cached = rosters.get(channelId);
  if (cached && now - cached.at < ROSTER_TTL) return cached;
  const channel = channelRow(channelId);
  if (!channel) {
    rosters.delete(channelId);
    return null;
  }
  const rows = db
    .prepare(
      `SELECT m.user_id AS id FROM channel_members m
       JOIN users u ON u.id = m.user_id
       WHERE m.channel_id = ?
         AND (? <> 'group' OR EXISTS (
           SELECT 1 FROM channel_groups cg JOIN user_group_members cgm ON cgm.group_id = cg.group_id
           WHERE cg.channel_id = m.channel_id AND cgm.user_id = m.user_id
         ))
       ORDER BY m.user_id LIMIT ?`,
    )
    .all(channelId, channel.visibility, L.maxPresenceEntries) as Array<{ id: string }>;
  const ordered = rows.map((row) => row.id);
  const next: Roster = { channel, members: new Set(ordered), ordered, at: now };
  rosters.set(channelId, next);
  return next;
}

/** The viewer's blocked accounts, either direction. One query per projection, never per pair. */
function blockedFor(userId: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT blocked_id AS id FROM channel_dm_blocks WHERE blocker_id = ?
       UNION SELECT blocker_id AS id FROM channel_dm_blocks WHERE blocked_id = ?`,
    )
    .all(userId, userId) as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

function presenceOf(conn: Connection, now: number): "online" | "away" | null {
  if (conn.activityAt === null) return null;
  const age = now - conn.activityAt;
  if (age > L.activityLeaseMs) return null;
  if (conn.activityState === "active" && age <= L.activeHoldMs) return "online";
  return "away";
}

function gracePresence(entry: Grace, now: number): "online" | "away" | null {
  if (now >= entry.expiresAt || now >= entry.validUntil) return null;
  // Logout can happen after the stream has already closed, with no live connection to revoke.
  if (!sessionAlive(entry.sessionHash) || !featureOn(entry.userId)) return null;
  return entry.state;
}

function accountPresence(userId: string, now: number): ChannelPresenceState {
  let away = false;
  for (const id of byUser.get(userId) ?? []) {
    const conn = connections.get(id);
    if (!conn) continue;
    const state = presenceOf(conn, now);
    if (state === "online") return "online";
    if (state === "away") away = true;
  }
  for (const id of graceByUser.get(userId) ?? []) {
    const entry = grace.get(id);
    if (!entry) continue;
    const state = gracePresence(entry, now);
    if (state === "online") return "online";
    if (state === "away") away = true;
  }
  return away ? "away" : "offline";
}

function wake(conn: Connection): void {
  if (!conn.waiters.size) return;
  const waiting = [...conn.waiters];
  conn.waiters.clear();
  for (const resolve of waiting) resolve();
}

function markDirty(conn: Connection | undefined): void {
  if (!conn || conn.closed) return;
  conn.dirty = true;
  wake(conn);
}

function markSubjectWatchers(userId: string, now = activityNow()): void {
  for (const [channelId, watchers] of channelWatchers) {
    const current = roster(channelId);
    if (!current?.members.has(userId)) continue;
    for (const id of watchers) markDirty(connections.get(id));
  }
  const state = accountPresence(userId, now);
  lastPresence.set(userId, state);
}

function markScopeWatchers(channelId: string, rootId: string | null): void {
  for (const id of channelWatchers.get(channelId) ?? []) {
    const conn = connections.get(id);
    if (!conn?.watch) continue;
    if (rootId !== null && conn.watch.rootId !== rootId) continue;
    markDirty(conn);
  }
}

function markAllWatchers(): void {
  for (const watchers of channelWatchers.values()) {
    for (const id of watchers) markDirty(connections.get(id));
  }
}

function addToIndex(map: Map<string, Set<string>>, key: string, id: string): void {
  const set = map.get(key);
  if (set) set.add(id);
  else map.set(key, new Set([id]));
}

function removeFromIndex(map: Map<string, Set<string>>, key: string, id: string): void {
  const set = map.get(key);
  if (!set) return;
  set.delete(id);
  if (!set.size) map.delete(key);
}

/** Typing must name the watched scope, so losing the watch ends this connection's typing too. */
function dropWatch(conn: Connection): void {
  clearTyping(conn);
  if (conn.watch) removeFromIndex(channelWatchers, conn.watch.channelId, conn.id);
  conn.watch = null;
}

function setWatch(conn: Connection, watch: { channelId: string; rootId: string | null } | null): void {
  const previous = conn.watch;
  if (previous?.channelId === watch?.channelId && previous?.rootId === watch?.rootId) return;
  clearTyping(conn);
  if (previous) removeFromIndex(channelWatchers, previous.channelId, conn.id);
  conn.watch = watch;
  conn.watchRevision++;
  conn.forceSnapshot = true;
  conn.lastSnapshotAt = 0;
  if (watch) addToIndex(channelWatchers, watch.channelId, conn.id);
  markDirty(conn);
}

function clearTyping(conn: Connection): void {
  const typing = conn.typing;
  if (!typing) return;
  conn.typing = null;
  removeFromIndex(typingByScope, channelTypingScopeKey(typing.channelId, typing.rootId), conn.id);
  markScopeWatchers(typing.channelId, typing.rootId);
}

function addGrace(conn: Connection): void {
  // A session that ended (logout, revocation) must not keep the account online for the grace window.
  if (!sessionAlive(conn.sessionHash)) return;
  const now = activityNow();
  const state = presenceOf(conn, now);
  if (!state || !share(conn.userId).sharePresence) return;
  const validUntil = state === "online" && conn.activityAt !== null ? conn.activityAt + L.activeHoldMs : (conn.activityAt ?? now) + L.activityLeaseMs;
  const entries = graceByUser.get(conn.userId);
  if (entries && entries.size >= L.maxGracePerAccount) {
    const oldest = [...entries].map((id) => grace.get(id)).filter((entry): entry is Grace => !!entry).sort((a, b) => a.expiresAt - b.expiresAt)[0];
    if (oldest) removeGrace(oldest);
  }
  if (grace.size >= L.maxGraceEntries) {
    // Evict the oldest retained grace, never an existing stream slot.
    const oldest = [...grace.values()].sort((a, b) => a.expiresAt - b.expiresAt)[0];
    if (oldest) removeGrace(oldest);
  }
  const entry: Grace = {
    id: `grace_${randomBytes(8).toString("base64url")}`,
    userId: conn.userId,
    sessionHash: conn.sessionHash,
    state,
    validUntil: Math.min(validUntil, now + L.graceMs),
    expiresAt: now + L.graceMs,
  };
  grace.set(entry.id, entry);
  addToIndex(graceByUser, conn.userId, entry.id);
  markSubjectWatchers(conn.userId, now);
}

function removeGrace(entry: Grace): void {
  grace.delete(entry.id);
  removeFromIndex(graceByUser, entry.userId, entry.id);
}

function removeConnection(conn: Connection, options: { grace: boolean }): void {
  if (conn.closed) return;
  conn.closed = true;
  clearTyping(conn);
  dropWatch(conn);
  conn.dirty = false;
  connections.delete(conn.id);
  removeFromIndex(byUser, conn.userId, conn.id);
  wake(conn);
  if (options.grace) addGrace(conn);
  else {
    for (const id of [...(graceByUser.get(conn.userId) ?? [])]) {
      const entry = grace.get(id);
      if (entry && entry.sessionHash === conn.sessionHash) removeGrace(entry);
    }
  }
  markSubjectWatchers(conn.userId);
  maybeStopSweep();
}

/** True while the account still has a live feature-enabled session for this connection. */
function stillAuthorized(conn: Connection): boolean {
  return sessionAlive(conn.sessionHash) && featureOn(conn.userId);
}

function boundConnection(connectionId: string, userId: string, sessionHash: string): Connection {
  const conn = connections.get(connectionId);
  if (!conn || conn.closed || conn.userId !== userId || conn.sessionHash !== sessionHash) throw connectionNotFound();
  if (!stillAuthorized(conn)) {
    removeConnection(conn, { grace: false });
    throw connectionNotFound();
  }
  return conn;
}

/** Registers a live stream. No presence is contributed until the first accepted activity POST. */
export function registerChannelActivity(input: { userId: string; sessionHash: string }): ChannelActivityStream {
  ensureInitialized();
  if (connections.size >= 256) throw new AppError({ code: "rate_limited", status: 429, message: "Too many live channel connections.", retryAfterMs: 5_000 });
  const conn: Connection = {
    id: activityConnectionId(),
    userId: input.userId,
    sessionHash: input.sessionHash,
    activityAt: null,
    activityState: null,
    watch: null,
    watchRevision: 0,
    typing: null,
    acceptedSeq: 0,
    dirty: false,
    forceSnapshot: false,
    clearPending: false,
    // Monotonic time starts near zero at boot; zero here would delay the first frame by the frame cap.
    lastFrameAt: Number.NEGATIVE_INFINITY,
    lastSnapshotAt: 0,
    blocked: false,
    closed: false,
    waiters: new Set(),
  };
  connections.set(conn.id, conn);
  addToIndex(byUser, conn.userId, conn.id);
  ensureSweep();
  return {
    connectionId: conn.id,
    nextDueAt: () => nextDueAt(conn),
    takeFrame: () => takeFrame(conn),
    waitForWake: (timeoutMs, signal) => waitForWake(conn, timeoutMs, signal),
    release: () => removeConnection(conn, { grace: true }),
  };
}

/** Ends an account's activity without waiting for grace (revocation, logout, settings disable). */
export function revokeChannelActivity(userId: string): void {
  for (const id of [...(byUser.get(userId) ?? [])]) {
    const conn = connections.get(id);
    if (conn) removeConnection(conn, { grace: false });
  }
  for (const id of [...(graceByUser.get(userId) ?? [])]) {
    const entry = grace.get(id);
    if (entry) removeGrace(entry);
  }
  preferences.delete(userId);
  features.delete(userId);
  markSubjectWatchers(userId);
}

function watchContext(conn: Connection, now: number): Roster | null {
  const watch = conn.watch;
  if (!watch) return null;
  if (!featureOn(conn.userId)) return null;
  const current = roster(watch.channelId);
  if (!current) return null;
  if (!current.members.has(conn.userId)) return null;
  if (!channelEligibility(conn.userId, current.channel)) return null;
  if (!memberRow(watch.channelId, conn.userId)) return null;
  if (watch.rootId && !liveRoot(watch.channelId, watch.rootId)) return null;
  void now;
  return current;
}

function liveRoot(channelId: string, rootId: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM channel_messages WHERE channel_id = ? AND id = ? AND thread_root IS NULL AND deleted_at IS NULL")
    .get(channelId, rootId);
}

function typingItems(conn: Connection, ctx: Roster, rootId: string | null, blocked: Set<string>, now: number): Array<{ userId: string; remainingMs: number }> {
  const expires = new Map<string, number>();
  const channelId = conn.watch!.channelId;
  for (const id of typingByScope.get(channelTypingScopeKey(channelId, rootId)) ?? []) {
    const author = connections.get(id);
    if (!author?.typing || author.closed) continue;
    if (author.typing.expiresAt <= now) continue;
    if (!ctx.members.has(author.userId)) continue;
    if (blocked.has(author.userId)) continue;
    if (!share(author.userId).shareTyping) continue;
    if (presenceOf(author, now) !== "online") continue;
    const current = expires.get(author.userId) ?? 0;
    if (author.typing.expiresAt > current) expires.set(author.userId, author.typing.expiresAt);
  }
  return [...expires.entries()]
    .map(([userId, at]) => ({ userId, remainingMs: Math.min(L.typingLeaseMs, Math.max(1, at - now)) }))
    .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
}

function project(conn: Connection, ctx: Roster): ChannelActivityFrame | null {
  const watch = conn.watch;
  if (!watch) return null;
  const now = activityNow();
  const blocked = blockedFor(conn.userId);
  const presence = ctx.ordered.map((userId) => ({
    userId,
    state: blocked.has(userId) || !featureOn(userId)
      ? ("offline" as const)
      : share(userId).sharePresence
        ? accountPresence(userId, now)
        : ("offline" as const),
  }));
  const roots: Array<string | null> = watch.rootId ? [null, watch.rootId] : [null];
  const snapshot = conn.forceSnapshot || conn.lastSnapshotAt === 0 || now - conn.lastSnapshotAt >= L.snapshotMs;
  if (snapshot) {
    const typing: Array<{ rootId: string | null; userId: string; remainingMs: number }> = [];
    for (const rootId of roots) {
      for (const item of typingItems(conn, ctx, rootId, blocked, now)) typing.push({ rootId, ...item });
    }
    return {
      v: 1,
      kind: "snapshot",
      watchRevision: conn.watchRevision,
      channelId: watch.channelId,
      presence,
      typing: typing.slice(0, L.maxTypingEntries),
    };
  }
  return {
    v: 1,
    kind: "patch",
    watchRevision: conn.watchRevision,
    channelId: watch.channelId,
    presence,
    typingScopes: roots.map((rootId) => ({ rootId, items: typingItems(conn, ctx, rootId, blocked, now) })),
  };
}

function clearFrame(conn: Connection): string {
  return JSON.stringify({ v: 1, kind: "clear", watchRevision: conn.watchRevision } satisfies ChannelActivityFrame);
}

function nextDueAt(conn: Connection): number | null {
  if (conn.closed || conn.blocked) return null;
  const now = activityNow();
  if (conn.clearPending) return now;
  if (!conn.watch) return null;
  // A periodic snapshot still respects the frame cap, or takeFrame refuses it and the pump spins.
  let due = conn.lastSnapshotAt === 0 ? now : Math.max(conn.lastSnapshotAt + L.snapshotMs, conn.lastFrameAt + L.outputCoalesceMs);
  if (conn.forceSnapshot) due = Math.max(now, conn.lastFrameAt + L.outputCoalesceMs);
  if (conn.dirty) due = Math.min(due, Math.max(now, conn.lastFrameAt + L.outputCoalesceMs));
  return due;
}

function takeFrame(conn: Connection): string | null {
  if (conn.closed || conn.blocked) return null;
  const now = activityNow();
  if (conn.clearPending) {
    conn.clearPending = false;
    conn.dirty = false;
    dropWatch(conn);
    conn.forceSnapshot = false;
    conn.lastSnapshotAt = now;
    return clearFrame(conn);
  }
  if (!conn.watch) {
    conn.dirty = false;
    return null;
  }
  const due = nextDueAt(conn);
  if (due === null || now < due) return null;
  if (now < conn.lastFrameAt + L.outputCoalesceMs && !conn.forceSnapshot && conn.lastSnapshotAt !== 0) return null;
  const ctx = watchContext(conn, now);
  if (!ctx) {
    // Access or the open root vanished: an identifier-free clear is the only safe output.
    conn.clearPending = false;
    conn.dirty = false;
    conn.forceSnapshot = false;
    dropWatch(conn);
    conn.lastSnapshotAt = now;
    return clearFrame(conn);
  }
  const frame = project(conn, ctx);
  if (!frame) return null;
  const body = JSON.stringify(frame);
  conn.dirty = false;
  conn.lastFrameAt = now;
  if (frame.kind === "snapshot") conn.lastSnapshotAt = now;
  conn.forceSnapshot = false;
  if (Buffer.byteLength(body, "utf8") > L.maxFrameBytes) {
    // One oversized state is a hard bound, not a retry loop: stop ephemeral output, keep durable.
    conn.blocked = true;
    dropWatch(conn);
    return clearFrame(conn);
  }
  return body;
}

function waitForWake(conn: Connection, timeoutMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || conn.closed) {
      resolve();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      conn.waiters.delete(finish);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, Math.max(0, timeoutMs));
    timer.unref?.();
    conn.waiters.add(finish);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function resolveWatch(userId: string, watch: { channelId: string; rootId: string | null } | null): { channelId: string; rootId: string | null } | null {
  if (!watch) return null;
  const channel = channelRow(watch.channelId);
  const member = channel ? memberRow(watch.channelId, userId) : null;
  if (!channel || !member || !channelEligibility(userId, channel)) throw notFound();
  let rootId = watch.rootId;
  if (channel.kind === "dm" && rootId !== null) throw notFound();
  // An archived room keeps presence but exposes no thread scope and accepts no typing.
  if (channel.archived_at !== null) rootId = null;
  else if (rootId !== null && !liveRoot(watch.channelId, rootId)) throw notFound();
  return { channelId: watch.channelId, rootId };
}

export interface ActivityInput {
  connectionId: string;
  seq: number;
  state: "active" | "idle";
  watch: { channelId: string; rootId: string | null } | null;
}

/** Whole-connection activity/watch state. The caller has already charged the account window. */
export function applyChannelActivity(userId: string, sessionHash: string, input: ActivityInput): { acceptedSeq: number; watchRevision: number } {
  const conn = boundConnection(input.connectionId, userId, sessionHash);
  chargeConnectionActivityRate(conn.id, "activity");
  if (input.seq <= conn.acceptedSeq) return { acceptedSeq: conn.acceptedSeq, watchRevision: conn.watchRevision };
  const watch = resolveWatch(userId, input.watch);
  const now = activityNow();
  const transitioned = conn.activityState !== input.state || conn.activityAt === null;
  conn.acceptedSeq = input.seq;
  conn.activityAt = now;
  conn.activityState = input.state;
  setWatch(conn, watch);
  markSubjectWatchers(userId, now);
  if (transitioned && conn.watch) markScopeWatchers(conn.watch.channelId, conn.watch.rootId);
  return { acceptedSeq: conn.acceptedSeq, watchRevision: conn.watchRevision };
}

export interface TypingInput {
  connectionId: string;
  seq: number;
  channelId: string;
  rootId: string | null;
  typing: boolean;
}

export function applyChannelTyping(userId: string, sessionHash: string, input: TypingInput): { acceptedSeq: number } {
  const conn = boundConnection(input.connectionId, userId, sessionHash);
  chargeConnectionActivityRate(conn.id, "typing");
  if (input.seq <= conn.acceptedSeq) return { acceptedSeq: conn.acceptedSeq };
  const scope = conn.watch;
  // A typing request must name the scope this connection is watching; anything else is the same
  // uniform 404 as a guessed room, and mutates nothing (including the sequence).
  if (!scope || scope.channelId !== input.channelId || scope.rootId !== input.rootId) throw notFound();
  const channel = channelRow(input.channelId);
  if (!channel || !memberRow(input.channelId, userId) || !channelEligibility(userId, channel)) throw notFound();
  conn.acceptedSeq = input.seq;
  if (!input.typing) {
    clearTyping(conn);
    return { acceptedSeq: conn.acceptedSeq };
  }
  if (channel.archived_at !== null) throw new AppError({ code: "conflict", status: 409, message: "This room is archived.", details: { reason: "archived" } });
  if (!share(userId).shareTyping) {
    clearTyping(conn);
    return { acceptedSeq: conn.acceptedSeq };
  }
  if (presenceOf(conn, activityNow()) !== "online") {
    clearTyping(conn);
    return { acceptedSeq: conn.acceptedSeq };
  }
  const now = activityNow();
  conn.typing = { channelId: input.channelId, rootId: input.rootId, expiresAt: now + L.typingLeaseMs };
  addToIndex(typingByScope, channelTypingScopeKey(input.channelId, input.rootId), conn.id);
  markScopeWatchers(input.channelId, input.rootId);
  return { acceptedSeq: conn.acceptedSeq };
}

// ---------------------------------------------------------------------------------------------------
// After-commit hooks. A rollback never reaches these, so no ephemeral side effect survives one.
// ---------------------------------------------------------------------------------------------------

/** A successful human post stops its author's typing in the resolved scope only. */
export function clearChannelActivityAfterPost(channelId: string, rootId: string | null, userId: string): void {
  let changed = false;
  for (const id of typingByScope.get(channelTypingScopeKey(channelId, rootId)) ?? []) {
    const conn = connections.get(id);
    if (!conn || conn.userId !== userId) continue;
    conn.typing = null;
    removeFromIndex(typingByScope, channelTypingScopeKey(channelId, rootId), id);
    changed = true;
  }
  if (changed) markScopeWatchers(channelId, rootId);
}

/** Root tombstone, room archive, deletion, or membership change in one room. */
export function clearChannelActivityForChannel(channelId: string, rootId?: string | null): void {
  rosters.delete(channelId);
  const scopes = rootId === undefined ? [null, ...allTypingRoots(channelId)] : [rootId];
  for (const scopeRoot of scopes) {
    for (const id of [...(typingByScope.get(channelTypingScopeKey(channelId, scopeRoot)) ?? [])]) {
      const conn = connections.get(id);
      if (!conn) continue;
      conn.typing = null;
      removeFromIndex(typingByScope, channelTypingScopeKey(channelId, scopeRoot), id);
    }
    markScopeWatchers(channelId, scopeRoot);
  }
  for (const id of channelWatchers.get(channelId) ?? []) {
    const conn = connections.get(id);
    if (!conn) continue;
    if (rootId !== undefined && conn.watch?.rootId !== rootId) {
      markDirty(conn);
      continue;
    }
    conn.forceSnapshot = true;
    conn.lastSnapshotAt = 0;
    markDirty(conn);
  }
}

function allTypingRoots(channelId: string): Array<string | null> {
  const roots: Array<string | null> = [];
  const prefix = `${channelId}\u0000`;
  for (const key of typingByScope.keys()) {
    if (!key.startsWith(prefix)) continue;
    const root = key.slice(prefix.length);
    roots.push(root === "" ? null : root);
  }
  return roots;
}

/** Membership removal for one account: it can no longer type or be projected as present. */
export function clearChannelActivityForMember(channelId: string, userId: string): void {
  rosters.delete(channelId);
  for (const [key, ids] of [...typingByScope]) {
    for (const id of [...ids]) {
      const conn = connections.get(id);
      if (conn?.userId !== userId) continue;
      conn.typing = null;
      removeFromIndex(typingByScope, key, id);
    }
  }
  for (const conn of connectionsFor(userId)) {
    if (conn.watch?.channelId !== channelId) continue;
    conn.forceSnapshot = true;
    conn.lastSnapshotAt = 0;
  }
  markAllWatchers();
}

/** Blocking or unblocking suppresses status for that pair in every shared room and DM. */
export function channelActivityBlocksChanged(): void {
  markAllWatchers();
}

/** Group/audience/permission/session changes: rebuild every roster and re-authorize live streams. */
export function invalidateChannelActivity(): void {
  rosters.clear();
  preferences.clear();
  features.clear();
  for (const conn of [...connections.values()]) {
    if (!stillAuthorized(conn)) {
      removeConnection(conn, { grace: false });
      continue;
    }
    if (conn.watch) {
      conn.forceSnapshot = true;
      conn.lastSnapshotAt = 0;
      markDirty(conn);
    }
  }
  for (const entry of [...grace.values()]) {
    if (!sessionAlive(entry.sessionHash) || !featureOn(entry.userId)) removeGrace(entry);
  }
  markAllWatchers();
}

/** Preference write: disable removes contributions at once; re-enabling waits for fresh input. */
function preferencesChanged(userId: string): void {
  const previous = preferences.get(userId)?.value ?? null;
  preferences.delete(userId);
  const next = share(userId);
  // Toggling either direction needs a fresh activity update: a retained contribution must never
  // resurrect an old status when sharing is switched back on.
  if (previous?.sharePresence !== next.sharePresence) {
    for (const conn of connectionsFor(userId)) {
      conn.activityAt = null;
      conn.activityState = null;
    }
    for (const id of [...(graceByUser.get(userId) ?? [])]) {
      const entry = grace.get(id);
      if (entry) removeGrace(entry);
    }
  }
  if (!next.shareTyping) {
    for (const conn of connectionsFor(userId)) clearTyping(conn);
  }
  markSubjectWatchers(userId);
}

function connectionsFor(userId: string): Connection[] {
  const out: Connection[] = [];
  for (const id of byUser.get(userId) ?? []) {
    const conn = connections.get(id);
    if (conn) out.push(conn);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// One unref'ed sweep exists only while something is registered.
// ---------------------------------------------------------------------------------------------------

function sweep(): void {
  const now = activityNow();
  let changedSubjects = false;
  for (const entry of [...grace.values()]) {
    if (now >= entry.expiresAt || now >= entry.validUntil || !sessionAlive(entry.sessionHash) || !featureOn(entry.userId)) {
      removeGrace(entry);
      changedSubjects = true;
    }
  }
  for (const conn of [...connections.values()]) {
    if (!stillAuthorized(conn)) {
      removeConnection(conn, { grace: false });
      changedSubjects = true;
      continue;
    }
    if (conn.typing && conn.typing.expiresAt <= now) {
      const { channelId, rootId } = conn.typing;
      clearTyping(conn);
      markScopeWatchers(channelId, rootId);
    }
    if (conn.watch) {
      const current = roster(conn.watch.channelId);
      if (!current || !current.members.has(conn.userId)) {
        conn.clearPending = true;
        wake(conn);
      }
    }
  }
  for (const [userId] of byUser) {
    const state = accountPresence(userId, now);
    if ((lastPresence.get(userId) ?? "offline") !== state) {
      lastPresence.set(userId, state);
      changedSubjects = true;
    }
  }
  if (changedSubjects) {
    for (const userId of new Set([...byUser.keys(), ...graceByUser.keys()])) markSubjectWatchers(userId, now);
  }
  if (now - lastHousekeeping >= 30_000) {
    lastHousekeeping = now;
    for (const [key, entry] of preferences) if (now - entry.at > CACHE_IDLE) preferences.delete(key);
    for (const [key, entry] of features) if (now - entry.at > CACHE_IDLE) features.delete(key);
    pruneActivityRates();
  }
  maybeStopSweep();
}

/** Exposed for deterministic tests; the one-second timer calls the same function. */
export function sweepChannelActivity(): void {
  sweep();
}

function ensureSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweep, 1_000);
  sweepTimer.unref?.();
}

function maybeStopSweep(): void {
  if (connections.size || grace.size) return;
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  lastPresence.clear();
}

/** Subscribes to cross-feature revocation and preference writes exactly once. */
export function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;
  onChannelRevocation(() => invalidateChannelActivity());
  onChannelActivitySettingsChange((userId) => preferencesChanged(userId));
}

/** Called from server startup; tests get the same wiring lazily on first registration. */
export function initChannelActivity(): void {
  ensureInitialized();
}

/** Test/diagnostic counts; no identifiers leave the process. */
export function channelActivityState(): {
  connections: number;
  watches: number;
  typing: number;
  grace: number;
  rosters: number;
  sweep: boolean;
} {
  return {
    connections: connections.size,
    watches: channelWatchers.size,
    typing: typingByScope.size,
    grace: grace.size,
    rosters: rosters.size,
    sweep: sweepTimer !== null,
  };
}

/** Test seam: drops all ephemeral state without a restart. */
export function resetChannelActivity(): void {
  for (const conn of [...connections.values()]) removeConnection(conn, { grace: false });
  for (const entry of [...grace.values()]) removeGrace(entry);
  connections.clear();
  byUser.clear();
  channelWatchers.clear();
  typingByScope.clear();
  rosters.clear();
  preferences.clear();
  features.clear();
  lastPresence.clear();
  pruneActivityRates();
  maybeStopSweep();
}
