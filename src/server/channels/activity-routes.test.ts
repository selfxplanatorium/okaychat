import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { Hono } from "hono";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-activity-routes-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "activity-routes-test-secret-only-not-for-production";

const { db } = await import("../db.js");
const { sha256 } = await import("../crypto.js");
const { api } = await import("../routes.js");
const { registerChannelActivity, resetChannelActivity } = await import("./activity.js");
const { resetActivityRates } = await import("./activity-rate.js");
const { makeCall, seedUsers } = await import("./test-support.js");

const app = new Hono().route("/api", api);
const call = makeCall(app);

/** Mirrors the real session cookie: the server binds a connection to this token's hash. */
const sessionHash = (token: string) => sha256(token);

function register(user = "alice", token = user) {
  return registerChannelActivity({ userId: user, sessionHash: sessionHash(token) });
}

before(() => {
  seedUsers(db, [
    ["alice", "Alice"],
    ["bob", "Bob"],
    ["carol", "Carol"],
    ["root", "Root", "admin"],
  ]);
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('alice2', 'alice2@example.test', 'Alice two', 'unused', 'user', 1)").run();
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, 'alice', ?)").run(sessionHash("alice2"), Date.now() + 3_600_000);
  db.prepare("INSERT INTO user_groups (id, name, created_at, prompt_order) VALUES ('ag1', 'Activity group', 1, 10)").run();
  db.prepare("INSERT INTO user_group_members (group_id, user_id) VALUES ('ag1', 'bob'), ('ag1', 'alice')").run();
});

beforeEach(() => {
  resetChannelActivity();
  resetActivityRates();
});

after(() => {
  resetChannelActivity();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

let roomSeq = 0;

/** Rooms are seeded directly: the durable create/membership windows are not what this suite tests. */
function seedRoom(
  members: string[],
  options: { kind?: "room" | "dm"; visibility?: "public" | "private" | "group"; owner?: string; archived?: boolean; groupId?: string; invite?: string } = {},
): string {
  const id = `act_${++roomSeq}`;
  const owner = options.owner ?? members[0]!;
  const now = Date.now();
  for (const member of members) {
    if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get(member)) {
      db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, 'unused', 'user', 1)").run(member, `${member}@example.test`, member);
    }
    if (!db.prepare("SELECT 1 FROM sessions WHERE token_hash = ?").get(sessionHash(member))) {
      db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sessionHash(member), member, Date.now() + 3_600_000);
    }
  }
  db.prepare(
    "INSERT INTO channels (id, owner_id, name, description, icon, visibility, kind, revision, next_seq, archived_at, created_at, updated_at) VALUES (?, ?, ?, '', 'hash', ?, ?, 1, 1, ?, ?, ?)",
  ).run(id, owner, `Activity ${roomSeq}`, options.visibility ?? "private", options.kind ?? "room", options.archived ? now : null, now, now);
  const insert = db.prepare("INSERT INTO channel_members (channel_id, user_id, role, read_seq, notify_mode, joined_at) VALUES (?, ?, ?, 0, 'mentions', ?)");
  members.forEach((member, index) => insert.run(id, member, member === owner ? "owner" : index === 1 && members.length > 2 ? "moderator" : "member", now));
  if (options.groupId) db.prepare("INSERT INTO channel_groups (channel_id, group_id) VALUES (?, ?)").run(id, options.groupId);
  if (options.invite) db.prepare("INSERT INTO channel_invites (channel_id, user_id, created_at) VALUES (?, ?, ?)").run(id, options.invite, now);
  return id;
}

test("activity routes require a session, the channels feature and a bound connection", async () => {
  const channelId = seedRoom(["alice", "bob"]);
  const conn = register();
  const body = { connectionId: conn.connectionId, seq: 1, state: "active", watch: { channelId, rootId: null } };

  const anonymous = await app.request("http://app/api/channels/activity", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(anonymous.status, 401);

  assert.equal((await call("/channels/activity", { method: "POST", json: body, user: "bob" })).status, 404);
  assert.equal((await call("/channels/activity", { method: "POST", json: { ...body, connectionId: "a".repeat(43) }, user: "alice" })).status, 404);
  // Same account, different session: the connection id is not an alternative credential.
  assert.equal((await call("/channels/activity", { method: "POST", json: body, user: "alice2" })).status, 404);
  const accepted = await call("/channels/activity", { method: "POST", json: body, user: "alice" });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { acceptedSeq: 1, watchRevision: 1 });

  // Feature denial is the account's own 403, not a room lookup.
  db.prepare("INSERT INTO permission_policies (subject_kind, subject_id, model_ref, document, updated_at) VALUES ('everyone', '', '', ?, 1)").run(
    JSON.stringify({ version: 1, features: { channels: false } }),
  );
  try {
    const denied = await call("/channels/activity", { method: "POST", json: { ...body, seq: 2 }, user: "alice" });
    assert.equal(denied.status, 403);
  } finally {
    db.exec("DELETE FROM permission_policies");
  }
});

test("strict bodies, CSRF protection and bounded requests never reach the registry", async () => {
  const channelId = seedRoom(["alice"]);
  const conn = register();
  const base = { connectionId: conn.connectionId, seq: 1, state: "active" as const, watch: { channelId, rootId: null } };

  for (const body of [
    { ...base, extra: true },
    { ...base, seq: 0 },
    { ...base, seq: 1.5 },
    { ...base, state: "busy" },
    { ...base, watch: { channelId } },
    { ...base, connectionId: "short" },
  ]) {
    assert.equal((await call("/channels/activity", { method: "POST", json: body, user: "alice" })).status, 400, JSON.stringify(body));
  }
  assert.equal((await call("/channels/activity", { method: "POST", json: { ...base, seq: Number.MAX_SAFE_INTEGER + 1 }, user: "alice" })).status, 400);

  const tooLarge = await call("/channels/activity", {
    method: "POST",
    body: JSON.stringify({ ...base, padding: "x".repeat(5_000) }),
    user: "alice",
    headers: { "content-type": "application/json" },
  });
  assert.ok([400, 413].includes(tooLarge.status));

  const { csrf } = await import("hono/csrf");
  const secured = new Hono().use("/api/*", csrf()).route("/api", api);
  const crossSite = await secured.request("http://app/api/channels/activity", {
    method: "POST",
    headers: { cookie: "okaychat_session=alice", "content-type": "text/plain", origin: "https://evil.example" },
    body: JSON.stringify(base),
  });
  assert.equal(crossSite.status, 403);
});

test("guessed, foreign, invited, group-ineligible and bad-root watches answer the same 404", async () => {
  const privateRoom = seedRoom(["alice"]);
  const invitedRoom = seedRoom(["alice"], { invite: "bob" });
  const groupRoom = seedRoom(["alice", "bob"], { visibility: "group", groupId: "ag1" });
  const dm = seedRoom(["alice", "bob"], { kind: "dm" });

  const conn = register("bob");
  const attempt = (channelId: string, rootId: string | null = null) =>
    call("/channels/activity", { method: "POST", json: { connectionId: conn.connectionId, seq: 1, state: "active", watch: { channelId, rootId } }, user: "bob" });

  for (const id of ["chan_missing", privateRoom, invitedRoom]) assert.equal((await attempt(id)).status, 404);
  // Presence in a DM is allowed; only a thread scope is refused.
  assert.equal((await attempt(dm)).status, 200);
  // A guess at a DM thread scope is refused even for a member, because DMs expose no thread UI.
  const dmConn = register("alice");
  const dmThread = await call("/channels/activity", {
    method: "POST",
    json: { connectionId: dmConn.connectionId, seq: 1, state: "active", watch: { channelId: dm, rootId: "root_missing" } },
    user: "alice",
  });
  assert.equal(dmThread.status, 404);

  // Eligible group member: allowed; losing the group closes the watch target.
  assert.equal((await attempt(groupRoom)).status, 200);
  db.prepare("DELETE FROM user_group_members WHERE group_id = 'ag1' AND user_id = 'bob'").run();
  resetChannelActivity();
  const afterRemoval = register("bob");
  const denied = await call("/channels/activity", {
    method: "POST",
    json: { connectionId: afterRemoval.connectionId, seq: 1, state: "active", watch: { channelId: groupRoom, rootId: null } },
    user: "bob",
  });
  assert.equal(denied.status, 404);
  db.prepare("INSERT OR IGNORE INTO user_group_members (group_id, user_id) VALUES ('ag1', 'bob')").run();
});

test("an admin without membership cannot watch; the same admin as a member can", async () => {
  const channelId = seedRoom(["alice"]);
  const conn = register("root");
  const body = { connectionId: conn.connectionId, seq: 1, state: "active", watch: { channelId, rootId: null } };
  assert.equal((await call("/channels/activity", { method: "POST", json: body, user: "root" })).status, 404);
  db.prepare("INSERT INTO channel_members (channel_id, user_id, role, read_seq, notify_mode, joined_at) VALUES (?, 'root', 'member', 0, 'mentions', ?)").run(channelId, Date.now());
  assert.equal((await call("/channels/activity", { method: "POST", json: body, user: "root" })).status, 200);
});

test("typing needs the current watch scope, an active lease and a writable room", async () => {
  const channelId = seedRoom(["alice"]);
  const conn = register();
  const activityBody = { connectionId: conn.connectionId, seq: 1, state: "active", watch: { channelId, rootId: null } };
  assert.equal((await call("/channels/activity", { method: "POST", json: activityBody, user: "alice" })).status, 200);

  const typing = (input: Record<string, unknown>) => call("/channels/typing", { method: "POST", json: { connectionId: conn.connectionId, channelId, rootId: null, ...input }, user: "alice" });
  assert.equal((await typing({ seq: 2, typing: true })).status, 200);
  assert.deepEqual(await (await typing({ seq: 3, typing: false })).json(), { acceptedSeq: 3 });
  // A different scope is a uniform 404 and does not advance the sequence.
  assert.equal((await call("/channels/typing", { method: "POST", json: { connectionId: conn.connectionId, seq: 4, channelId, rootId: "other", typing: true }, user: "alice" })).status, 404);

  await call(`/channels/${channelId}/archive`, { method: "POST", json: { revision: 1, archived: true }, user: "alice" });
  const archived = await typing({ seq: 5, typing: true });
  assert.equal(archived.status, 409);
  assert.equal(((await archived.json()) as { code?: string }).code, "conflict");
});

test("well-formed attempts spend a bounded window and answer 429 with a retry hint", async () => {
  const channelId = seedRoom(["alice"]);
  const conn = register();
  for (let seq = 1; seq <= 8; seq++) {
    const response = await call("/channels/activity", {
      method: "POST",
      json: { connectionId: conn.connectionId, seq, state: "active", watch: { channelId, rootId: null } },
      user: "alice",
    });
    assert.equal(response.status, 200);
  }
  const limited = await call("/channels/activity", {
    method: "POST",
    json: { connectionId: conn.connectionId, seq: 9, state: "active", watch: { channelId, rootId: null } },
    user: "alice",
  });
  assert.equal(limited.status, 429);
  const wire = (await limited.json()) as { code?: string; retryAfterMs?: number };
  assert.equal(wire.code, "rate_limited");
  assert.ok((wire.retryAfterMs ?? 0) > 0);
});

test("the stream negotiates a capability only for opted-in clients", { timeout: 20_000 }, async () => {
  const readReady = async (url: string) => {
    const response = await app.request(`http://app/api${url}`, { headers: { cookie: "okaychat_session=bob" } });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    try {
      while (!text.includes("data: ")) {
        const part = await reader.read();
        assert.ok(!part.done);
        text += decoder.decode(part.value);
      }
    } finally {
      await reader.cancel();
    }
    const match = /data: (.+)\n/.exec(text);
    assert.ok(match, text);
    return JSON.parse(match[1]!) as { v: number; ephemeral?: { v: number; connectionId: string; activityLeaseMs: number; typingLeaseMs: number } };
  };

  const plain = await readReady("/channels/events");
  assert.deepEqual(plain, { v: 1 });
  const optedIn = await readReady("/channels/events?ephemeral=1");
  assert.equal(optedIn.v, 1);
  assert.equal(optedIn.ephemeral?.v, 1);
  assert.match(optedIn.ephemeral!.connectionId, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(optedIn.ephemeral!.activityLeaseMs, 75_000);
  assert.equal(optedIn.ephemeral!.typingLeaseMs, 6_000);
});

test("a watched stream sleeps between frames instead of starving the event loop", { timeout: 15_000 }, async () => {
  const channelId = seedRoom(["alice", "bob"]);
  const response = await call("/channels/events?ephemeral=1", { user: "alice" });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const pump = (async () => {
    for (;;) {
      const part = await reader.read();
      if (part.done) return;
      text += decoder.decode(part.value);
    }
  })();
  try {
    while (!text.includes("event: ready")) await new Promise((resolve) => setTimeout(resolve, 10));
    const connectionId = (JSON.parse(/event: ready\ndata: (.+)\n/.exec(text)![1]!) as { ephemeral: { connectionId: string } }).ephemeral.connectionId;
    const accepted = await call("/channels/activity", { method: "POST", json: { connectionId, seq: 1, state: "active", watch: { channelId, rootId: null } }, user: "alice" });
    assert.equal(accepted.status, 200);
    // With a watch the pump has a due time. A clock mix-up there made every wait zero, so timers never ran.
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    await new Promise((resolve) => setTimeout(resolve, 500));
    clearInterval(timer);
    assert.ok(ticks >= 10, `timers ran ${ticks} times`);
    assert.ok(text.includes("event: ephemeral"), text);
  } finally {
    await reader.cancel();
    await pump.catch(() => {});
  }
});
