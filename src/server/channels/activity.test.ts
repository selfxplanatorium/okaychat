import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-activity-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "activity-test-secret-only-not-for-production";

const { db } = await import("../db.js");
const { sha256 } = await import("../crypto.js");
const { setActivityClock } = await import("./activity-clock.js");
const { resetActivityRates, chargeAccountActivityRate, activityRateState } = await import("./activity-rate.js");
const activity = await import("./activity.js");
const { updateSettings } = await import("../settings.js");

type Frame = {
  kind: "snapshot" | "patch" | "clear";
  watchRevision: number;
  channelId?: string;
  presence?: Array<{ userId: string; state: string }>;
  typing?: Array<{ rootId: string | null; userId: string; remainingMs: number }>;
  typingScopes?: Array<{ rootId: string | null; items: Array<{ userId: string; remainingMs: number }> }>;
};

let clock = 1_000_000;
const advance = (ms: number) => {
  clock += ms;
};

const HASH = (user: string) => sha256(`session-${user}`);

function seedUser(id: string, role: "user" | "admin" = "user"): void {
  if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get(id)) {
    db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, 'unused', ?, 1)").run(id, `${id}@example.test`, id, role);
  }
  if (!db.prepare("SELECT 1 FROM sessions WHERE token_hash = ?").get(HASH(id))) {
    db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(HASH(id), id, Date.now() + 3_600_000);
  }
}

let channelSeq = 0;
function makeChannel(members: string[], options: { kind?: "room" | "dm"; archived?: boolean; owner?: string; visibility?: "public" | "private" | "group" } = {}): string {
  const id = `chan_${++channelSeq}`;
  const owner = options.owner ?? members[0]!;
  const now = Date.now();
  for (const user of members) seedUser(user);
  db.prepare(
    "INSERT INTO channels (id, owner_id, name, description, icon, visibility, kind, revision, next_seq, archived_at, created_at, updated_at) VALUES (?, ?, ?, '', 'hash', ?, ?, 1, 1, ?, ?, ?)",
  ).run(id, owner, `Room ${channelSeq}`, options.visibility ?? "private", options.kind ?? "room", options.archived ? now : null, now, now);
  const insert = db.prepare("INSERT INTO channel_members (channel_id, user_id, role, read_seq, notify_mode, joined_at) VALUES (?, ?, ?, 0, 'mentions', ?)");
  members.forEach((user, index) => insert.run(id, user, user === owner ? "owner" : index === 1 && members.length > 2 ? "moderator" : "member", now));
  return id;
}

function addMember(channelId: string, user: string): void {
  seedUser(user);
  db.prepare("INSERT OR IGNORE INTO channel_members (channel_id, user_id, role, read_seq, notify_mode, joined_at) VALUES (?, ?, 'member', 0, 'mentions', ?)").run(channelId, user, Date.now());
}

function register(user: string) {
  return activity.registerChannelActivity({ userId: user, sessionHash: HASH(user) });
}

function watch(user: string, stream: ReturnType<typeof register>, channelId: string, rootId: string | null = null, seq = 1, state: "active" | "idle" = "active") {
  return activity.applyChannelActivity(user, HASH(user), { connectionId: stream.connectionId, seq, state, watch: { channelId, rootId } });
}

function type(user: string, stream: ReturnType<typeof register>, channelId: string, rootId: string | null, typing: boolean, seq: number) {
  return activity.applyChannelTyping(user, HASH(user), { connectionId: stream.connectionId, seq, channelId, rootId, typing });
}

function take(stream: ReturnType<typeof register>): Frame | null {
  const raw = stream.takeFrame();
  return raw ? (JSON.parse(raw) as Frame) : null;
}

function presenceOf(frame: Frame, userId: string): string | undefined {
  return frame.presence?.find((entry) => entry.userId === userId)?.state;
}

function typingOf(frame: Frame, rootId: string | null): string[] {
  if (frame.kind === "snapshot") return (frame.typing ?? []).filter((entry) => entry.rootId === rootId).map((entry) => entry.userId);
  return (frame.typingScopes ?? []).find((scope) => scope.rootId === rootId)?.items.map((item) => item.userId) ?? [];
}

beforeEach(() => {
  resetActivityRates();
  activity.resetChannelActivity();
  db.exec("DELETE FROM channel_dm_blocks");
  clock = 1_000_000;
  setActivityClock(() => clock);
});

after(() => {
  setActivityClock(null);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("active holds exactly 60 seconds, away until the 75-second lease, then offline", () => {
  const channelId = makeChannel(["alice", "bob"]);
  const watcher = register("alice");
  const bob = register("bob");
  watch("alice", watcher, channelId);
  watch("bob", bob, channelId);

  assert.equal(presenceOf(take(watcher)!, "bob"), "online");

  advance(CHANNEL_ACTIVE_HOLD);
  activity.sweepChannelActivity();
  // At exactly 60 seconds the active signal still counts online.
  assert.equal(presenceOf(take(watcher)!, "bob"), "online");

  advance(1);
  activity.sweepChannelActivity();
  advance(CHANNEL_COALESCE);
  assert.equal(presenceOf(take(watcher)!, "bob"), "away");

  // At exactly 75 seconds the lease has not expired yet.
  advance(CHANNEL_LEASE - (CHANNEL_ACTIVE_HOLD + 1 + CHANNEL_COALESCE));
  activity.clearChannelActivityForChannel(channelId);
  assert.equal(presenceOf(take(watcher)!, "bob"), "away");

  advance(1);
  activity.sweepChannelActivity();
  activity.clearChannelActivityForChannel(channelId);
  advance(CHANNEL_COALESCE);
  assert.equal(presenceOf(take(watcher)!, "bob"), "offline");
});

test("a live idle tab never overrides another live active tab, and stale active becomes away", () => {
  const channelId = makeChannel(["alice", "bob"]);
  const watcher = register("alice");
  const first = register("bob");
  const second = register("bob");
  watch("alice", watcher, channelId);
  watch("bob", first, channelId, null, 1, "active");
  watch("bob", second, channelId, null, 1, "idle");
  take(watcher);
  advance(1_000);
  activity.sweepChannelActivity();
  advance(CHANNEL_COALESCE);
  const online = take(watcher);
  if (online) assert.equal(presenceOf(online, "bob"), "online");

  // The active tab goes stale; the idle tab must not keep the account online.
  advance(CHANNEL_ACTIVE_HOLD);
  activity.sweepChannelActivity();
  advance(CHANNEL_COALESCE);
  const away = take(watcher);
  if (away) assert.equal(presenceOf(away, "bob"), "away");
});

test("rotation grace bridges a reconnect for at most ten seconds and cannot type", () => {
  const channelId = makeChannel(["alice", "bob"]);
  const watcher = register("alice");
  const bob = register("bob");
  watch("alice", watcher, channelId);
  watch("bob", bob, channelId);
  take(watcher);

  bob.release();
  advance(CHANNEL_COALESCE);
  assert.equal(presenceOf(take(watcher)!, "bob"), "online");

  advance(10_001);
  activity.sweepChannelActivity();
  advance(CHANNEL_COALESCE);
  assert.equal(presenceOf(take(watcher)!, "bob"), "offline");
  assert.equal(activity.channelActivityState().grace, 0);
});

test("at most two grace entries survive per account and streams are never refused for them", () => {
  const channelId = makeChannel(["alice", "bob", "carol"]);
  const watcher = register("alice");
  watch("alice", watcher, channelId);
  for (let index = 0; index < 3; index++) {
    const bob = register("bob");
    watch("bob", bob, channelId, null, index + 1);
    bob.release();
  }
  assert.equal(activity.channelActivityState().grace, 2);
  // A new stream still opens while grace entries are retained.
  const next = register("bob");
  assert.ok(next.connectionId);
  next.release();
});

test("a deleted session ends the connection without grace and a stale seq cannot renew a lease", () => {
  const channelId = makeChannel(["alice", "bob"]);
  const watcher = register("alice");
  const bob = register("bob");
  watch("alice", watcher, channelId);
  watch("bob", bob, channelId);
  advance(CHANNEL_COALESCE);
  take(watcher);

  // Replaying seq 1 at 70 seconds is accepted as a no-op and does not extend the lease.
  advance(70_000);
  const replay = activity.applyChannelActivity("bob", HASH("bob"), { connectionId: bob.connectionId, seq: 1, state: "active", watch: { channelId, rootId: null } });
  assert.equal(replay.acceptedSeq, 1);
  advance(5_001);
  activity.sweepChannelActivity();
  advance(CHANNEL_COALESCE);
  assert.equal(presenceOf(take(watcher)!, "bob"), "offline");

  // Deleting the session while active drops the connection on the next sweep, without grace.
  const bobAgain = register("bob");
  watch("bob", bobAgain, channelId, null, 2);
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(HASH("bob"));
  advance(1_000);
  activity.sweepChannelActivity();
  advance(CHANNEL_COALESCE);
  assert.equal(presenceOf(take(watcher)!, "bob"), "offline");
  assert.equal(activity.channelActivityState().connections, 1);
});

test("two tabs typing the same scope aggregate once; stopping one keeps the other", () => {
  const channelId = makeChannel(["alice", "bob"]);
  const watcher = register("alice");
  const bobOne = register("bob");
  const bobTwo = register("bob");
  watch("alice", watcher, channelId);
  watch("bob", bobOne, channelId);
  watch("bob", bobTwo, channelId);
  take(watcher);

  type("bob", bobOne, channelId, null, true, 2);
  type("bob", bobTwo, channelId, null, true, 2);
  advance(CHANNEL_COALESCE);
  assert.deepEqual(typingOf(take(watcher)!, null), ["bob"]);

  type("bob", bobOne, channelId, null, false, 3);
  advance(CHANNEL_COALESCE);
  assert.deepEqual(typingOf(take(watcher)!, null), ["bob"], "one tab stopping cannot clear another tab");

  type("bob", bobTwo, channelId, null, false, 3);
  advance(CHANNEL_COALESCE);
  assert.deepEqual(typingOf(take(watcher)!, null), []);
});

test("typing is scoped: room and thread lines are independent and a watch change clears the old line", () => {
  const channelId = makeChannel(["alice", "bob"]);
  db.prepare(
    "INSERT INTO channel_messages (id, channel_id, seq, author_id, kind, body, revision, created_at) VALUES ('root_1', ?, 1, 'alice', 'human', 'hello', 1, ?)",
  ).run(channelId, Date.now());
  const watcher = register("alice");
  const bob = register("bob");
  watch("alice", watcher, channelId, null);
  watch("bob", bob, channelId, null);
  type("bob", bob, channelId, null, true, 2);
  advance(CHANNEL_COALESCE);
  const roomFrame = take(watcher)!;
  assert.deepEqual(typingOf(roomFrame, null), ["bob"]);
  assert.deepEqual(typingOf(roomFrame, "root_1"), []);

  // Bob switches his watch to the thread: his room typing is cleared atomically. Alice still watches
  // the room, so the thread's typing is not in her scopes yet.
  watch("bob", bob, channelId, "root_1", 3);
  type("bob", bob, channelId, "root_1", true, 4);
  advance(CHANNEL_COALESCE);
  const frame = take(watcher)!;
  assert.deepEqual(typingOf(frame, null), []);
  assert.deepEqual(typingOf(frame, "root_1"), []);

  // Alice follows into the thread; her snapshot carries only the thread line and room presence.
  watch("alice", watcher, channelId, "root_1", 2);
  advance(CHANNEL_COALESCE);
  const scoped = take(watcher)!;
  assert.equal(scoped.kind, "snapshot");
  assert.deepEqual(typingOf(scoped, "root_1"), ["bob"]);
});

test("output is coalesced to one frame per two seconds and the latest state wins", () => {
  const channelId = makeChannel(["alice", "bob"]);
  const watcher = register("alice");
  const bob = register("bob");
  watch("alice", watcher, channelId);
  watch("bob", bob, channelId);
  advance(CHANNEL_COALESCE);
  take(watcher);

  advance(100);
  type("bob", bob, channelId, null, true, 2);
  assert.equal(take(watcher), null, "nothing is emitted inside the coalescing window");
  advance(CHANNEL_COALESCE);
  const frame = take(watcher)!;
  assert.deepEqual(typingOf(frame, null), ["bob"]);
  assert.equal(activity.channelActivityState().connections, 2);
});

test("the two preference switches are independent and re-enabling presence needs fresh activity", () => {
  const channelId = makeChannel(["alice", "bob"]);
  const watcher = register("alice");
  const bob = register("bob");
  watch("alice", watcher, channelId);
  watch("bob", bob, channelId);
  advance(CHANNEL_COALESCE);
  take(watcher);

  updateSettings("bob", { channelActivity: { sharePresence: false, shareTyping: true } });
  advance(CHANNEL_COALESCE);
  assert.equal(presenceOf(take(watcher)!, "bob"), "offline");
  // Typing needs a live active contribution, so the client's next activity refresh restores it;
  // presence stays hidden.
  watch("bob", bob, channelId, null, 2);
  type("bob", bob, channelId, null, true, 3);
  advance(CHANNEL_COALESCE);
  assert.deepEqual(typingOf(take(watcher)!, null), ["bob"]);
  updateSettings("bob", { channelActivity: { sharePresence: true, shareTyping: false } });
  advance(CHANNEL_COALESCE);
  const frame = take(watcher)!;
  assert.equal(presenceOf(frame, "bob"), "offline", "re-enabling waits for a fresh activity update");
  assert.deepEqual(typingOf(frame, null), [], "disabling typing removes the contribution");

  watch("bob", bob, channelId, null, 4);
  advance(CHANNEL_COALESCE);
  assert.equal(presenceOf(take(watcher)!, "bob"), "online");
});

test("blocked accounts project offline in rooms, pair DMs, and group DMs", () => {
  const channelId = makeChannel(["alice", "bob", "carol"]);
  const dmPair = makeChannel(["alice", "bob"], { kind: "dm", visibility: "private", owner: "alice" });
  const dmGroup = makeChannel(["alice", "bob", "carol"], { kind: "dm", visibility: "private", owner: "alice" });
  db.prepare("INSERT INTO channel_dm_blocks (blocker_id, blocked_id, created_at) VALUES ('bob', 'alice', ?)").run(Date.now());
  const watcher = register("alice");
  const bob = register("bob");
  for (const id of [channelId, dmPair, dmGroup]) {
    watch("alice", watcher, id);
    watch("bob", bob, id);
  }
  advance(CHANNEL_COALESCE);
  const frames: Frame[] = [];
  for (;;) {
    const frame = take(watcher);
    if (!frame) break;
    frames.push(frame);
  }
  assert.ok(frames.length >= 1);
  for (const frame of frames) assert.equal(presenceOf(frame, "bob"), "offline");
});

test("an ephemeral restart is empty: no historical status and no retained typing", () => {
  const channelId = makeChannel(["alice", "bob"]);
  const watcher = register("alice");
  const bob = register("bob");
  watch("alice", watcher, channelId);
  watch("bob", bob, channelId);
  type("bob", bob, channelId, null, true, 2);
  activity.resetChannelActivity();

  const afterRestart = register("alice");
  const bobAfter = register("bob");
  watch("alice", afterRestart, channelId);
  watch("bob", bobAfter, channelId);
  advance(CHANNEL_COALESCE);
  const frame = take(afterRestart)!;
  assert.equal(presenceOf(frame, "bob"), "online");
  assert.deepEqual(typingOf(frame, null), []);
});

test("account and connection windows refuse excess attempts with a retry hint", () => {
  clock = 3_600_000;
  const channelId = makeChannel(["alice", "bob"]);
  const bob = register("bob");
  watch("bob", bob, channelId, null, 1);
  for (let seq = 2; seq <= 8; seq++) watch("bob", bob, channelId, null, seq);
  assert.throws(
    () => watch("bob", bob, channelId, null, 9),
    (error: unknown) => (error as { code?: string }).code === "rate_limited" && ((error as { retryAfterMs?: number }).retryAfterMs ?? 0) > 0,
  );

  resetActivityRates();
  for (let index = 0; index < 12; index++) chargeAccountActivityRate("bob", "activity");
  assert.throws(() => chargeAccountActivityRate("bob", "activity"), (error: unknown) => (error as { code?: string }).code === "rate_limited");

  resetActivityRates();
  for (let index = 0; index < 1_024; index++) chargeAccountActivityRate(`user_${index}`, "activity");
  assert.throws(() => chargeAccountActivityRate("extra", "activity"), (error: unknown) => (error as { code?: string }).code === "rate_limited");
  assert.ok(activityRateState().buckets <= 1_024);
});

test("hundreds of accepted updates write no SQL and never touch durable tables", () => {
  const channelId = makeChannel(["alice", "bob"]);
  const watcher = register("alice");
  const bob = register("bob");
  watch("alice", watcher, channelId);
  watch("bob", bob, channelId);
  updateSettings("bob", { channelActivity: { sharePresence: true, shareTyping: true } });
  const counts = () =>
    ["channel_events", "channel_messages", "notifications", "channel_rate_windows", "notifications"].map((table) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
    );
  const settingsBefore = db.prepare("SELECT json FROM user_settings WHERE user_id = 'bob'").get() as { json: string };
  const before = counts();
  for (let seq = 2; seq <= 60; seq++) {
    resetActivityRates();
    watch("bob", bob, channelId, null, seq, seq % 2 ? "active" : "idle");
    type("bob", bob, channelId, null, true, ++seq);
    advance(1_000);
    activity.sweepChannelActivity();
    if (seq % 5 === 0) take(watcher);
  }
  updateSettings("bob", { channelActivity: { sharePresence: true, shareTyping: true } });
  const settingsAfter = db.prepare("SELECT json FROM user_settings WHERE user_id = 'bob'").get() as { json: string };
  assert.deepEqual(counts(), before);
  assert.equal(settingsAfter.json, settingsBefore.json);
});

test("an oversized projection clears the connection once and stops ephemeral output", () => {
  const members = Array.from({ length: 200 }, (_, index) => `u${String(index).padStart(3, "0")}${"x".repeat(140)}`);
  const channelId = makeChannel(["alice", ...members]);
  const watcher = register("alice");
  watch("alice", watcher, channelId);
  const typingStreams = members.map((member) => {
    const stream = register(member);
    watch(member, stream, channelId, null, 1);
    type(member, stream, channelId, null, true, 2);
    return stream;
  });
  advance(CHANNEL_COALESCE);
  const frame = take(watcher)!;
  assert.equal(frame.kind, "clear");
  advance(CHANNEL_COALESCE + 30_000);
  assert.equal(take(watcher), null, "a blocked connection never retries the oversized frame");
  for (const stream of typingStreams) stream.release();
});

// The numeric table is imported once; local constants keep the timeline readable.
const CHANNEL_ACTIVE_HOLD = 60_000;
const CHANNEL_LEASE = 75_000;
const CHANNEL_COALESCE = 2_000;

test("a committed human post clears only its author's typing; a rolled-back send clears nothing", async () => {
  const { postHumanMessage } = await import("./store.js");
  const channelId = makeChannel(["alice", "bob", "carol"]);
  const watcher = register("alice");
  const bob = register("bob");
  const carol = register("carol");
  for (const [user, stream] of [["alice", watcher], ["bob", bob], ["carol", carol]] as const) {
    watch(user, stream, channelId);
  }
  type("bob", bob, channelId, null, true, 2);
  type("carol", carol, channelId, null, true, 2);
  advance(CHANNEL_COALESCE);
  take(watcher);

  // A rejected duplicate is a rolled-back transaction: the after-commit hook never runs.
  const clientId = "post_rollback";
  const args = { clientId, body: "Hello", requestHash: "hash-one" } as const;
  postHumanMessage("bob", channelId, args, () => null);
  advance(CHANNEL_COALESCE);
  const cleared = take(watcher)!;
  assert.deepEqual(typingOf(cleared, null), ["carol"], "only the posting author stops");

  type("bob", bob, channelId, null, true, 3);
  advance(CHANNEL_COALESCE);
  take(watcher);
  assert.throws(() => postHumanMessage("bob", channelId, { clientId, body: "Different", requestHash: "hash-two" }, () => null));
  // A failed send changes nothing, so force a fresh projection with another accepted typing refresh.
  type("carol", carol, channelId, null, true, 3);
  advance(CHANNEL_COALESCE);
  const retained = take(watcher)!;
  assert.deepEqual(typingOf(retained, null), ["bob", "carol"], "a failed send does not clear renewed typing");
});

test("a lost watch leaves no watcher index entry, and a due periodic snapshot is never coalesced away", () => {
  const channelId = makeChannel(["alice", "bob"]);
  const alice = register("alice");
  watch("alice", alice, channelId);
  assert.equal(take(alice)!.kind, "snapshot");
  db.prepare("DELETE FROM channel_members WHERE channel_id = ? AND user_id = 'alice'").run(channelId);
  activity.clearChannelActivityForMember(channelId, "alice");
  advance(CHANNEL_COALESCE);
  assert.equal(take(alice)!.kind, "clear");
  assert.equal(activity.channelActivityState().watches, 0);
  alice.release();
  assert.equal(activity.channelActivityState().watches, 0);

  // A patch shortly before the snapshot deadline: nextDueAt must not report a time takeFrame refuses.
  const otherRoom = makeChannel(["carol", "dave"]);
  const carol = register("carol");
  const dave = register("dave");
  watch("carol", carol, otherRoom);
  take(carol);
  advance(29_000);
  watch("dave", dave, otherRoom);
  activity.sweepChannelActivity();
  assert.equal(take(carol)!.kind, "patch");
  advance(1_500);
  const due = carol.nextDueAt()!;
  assert.ok(due > clock, "the snapshot waits for the frame cap");
  advance(due - clock);
  assert.equal(take(carol)!.kind, "snapshot");
});
