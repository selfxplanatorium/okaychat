import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { Hono } from "hono";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-channels-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "channels-test-secret-only-not-for-production";

const { db } = await import("../db.js");
const { sha256 } = await import("../crypto.js");
const { api } = await import("../routes.js");

const app = new Hono().route("/api", api);
const call = (url: string, init: { method?: string; json?: unknown; user?: string } = {}) =>
  app.request(`http://app/api${url}`, {
    method: init.method ?? "GET",
    headers: { cookie: `okaychat_session=${init.user ?? "alice"}`, ...(init.json !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });

const createRoom = async (input: Record<string, unknown>, user = "alice") => {
  const response = await call("/channels", { method: "POST", json: { clientId: crypto.randomUUID(), ...input }, user });
  return { response, body: (await response.json()) as { channel: { id: string; revision: number } } };
};

before(() => {
  for (const [id, name] of [["alice", "Alice"], ["bob", "Bob"], ["carol", "Carol"], ["root", "Root"]]) {
    db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, 'unused', ?, 1)").run(
      id,
      `${id}@example.test`,
      name,
      id === "root" ? "admin" : "user",
    );
    db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(id), id, Date.now() + 3_600_000);
  }
  db.prepare("INSERT INTO user_groups (id, name, created_at, prompt_order) VALUES ('g1', 'Group one', 1, 10)").run();
  db.prepare("INSERT INTO user_group_members (group_id, user_id) VALUES ('g1', 'bob'), ('g1', 'alice')").run();
});

beforeEach(() => { db.exec("DELETE FROM channel_rate_windows; UPDATE channel_ai_runs SET state = 'cancelled' WHERE state IN ('queued','running'); INSERT OR IGNORE INTO user_group_members (group_id,user_id) VALUES ('g1','bob')"); });

after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("public rooms are discoverable, joinable, searchable, and counted as unread", async () => {
  const { response, body } = await createRoom({ name: "General", visibility: "public" });
  assert.equal(response.status, 201);
  const roomId = body.channel.id;

  const discover = (await (await call("/channels?scope=discover", { user: "bob" })).json()) as { items: Array<{ id: string }> };
  assert.ok(discover.items.some((item) => item.id === roomId));

  assert.equal((await call(`/channels/${roomId}/join`, { method: "POST", json: {}, user: "bob" })).status, 200);

  const clientId = crypto.randomUUID();
  const posted = await call(`/channels/${roomId}/messages`, {
    method: "POST",
    json: { clientId, body: "Hello @Bob", mentions: [{ userId: "bob", start: 6, end: 10 }] },
  });
  assert.equal(posted.status, 201);
  const first = (await posted.json()) as { message: { id: string } };

  const sync = (await (await call("/channels/sync", { user: "bob" })).json()) as {
    items: Array<{ id: string; unread: number; mentionsUnread: number; membership: { readSeq: number } | null }>;
  };
  const joined = sync.items.find((item) => item.id === roomId)!;
  assert.equal(joined.unread, 1);
  assert.equal(joined.mentionsUnread, 1);

  const search = (await (await call(`/channels/search?q=Hello&channelId=${roomId}`, { user: "bob" })).json()) as { items: Array<{ messageId: string }> };
  assert.equal(search.items.length, 1);

  const read = (await (await call(`/channels/${roomId}/read`, { method: "POST", json: { throughSeq: 1 }, user: "bob" })).json()) as {
    unread: number;
    mentionsUnread: number;
  };
  assert.equal(read.unread, 0);
  assert.equal(read.mentionsUnread, 0);

  // Replaying the same client id returns the stored projection instead of a second message.
  const replay = await call(`/channels/${roomId}/messages`, {
    method: "POST",
    json: { clientId, body: "Hello @Bob", mentions: [{ userId: "bob", start: 6, end: 10 }] },
  });
  assert.equal(replay.status, 200);
  assert.equal(((await replay.json()) as { message: { id: string } }).message.id, first.message.id);
});

test("private rooms never appear in discover, search, or a nonmember read", async () => {
  const { body } = await createRoom({ name: "Secret", visibility: "private" });
  const roomId = body.channel.id;
  const discover = (await (await call("/channels?scope=discover", { user: "carol" })).json()) as { items: Array<{ id: string }> };
  assert.ok(!discover.items.some((item) => item.id === roomId));
  assert.equal((await call(`/channels/${roomId}`, { user: "carol" })).status, 404);
  assert.equal((await call(`/channels/${roomId}/messages`, { user: "carol" })).status, 404);
  assert.equal((await call(`/channels/${roomId}/join`, { method: "POST", json: {}, user: "carol" })).status, 404);
  // The owner sees it.
  assert.equal((await call(`/channels/${roomId}`)).status, 200);
});

test("group rooms follow live group membership and close on group removal", async () => {
  const { response, body } = await createRoom({ name: "Group room", visibility: "group", groupIds: ["g1"] });
  assert.equal(response.status, 201);
  const roomId = body.channel.id;
  assert.equal((await call(`/channels/${roomId}/join`, { method: "POST", json: {}, user: "bob" })).status, 200);
  assert.equal((await call(`/channels/${roomId}/messages`, { user: "bob" })).status, 200);
  assert.equal((await call(`/channels/${roomId}`, { user: "carol" })).status, 404);

  db.prepare("DELETE FROM user_group_members WHERE group_id = 'g1' AND user_id = 'bob'").run();
  // Eligibility is checked on every read, so a stale session cannot keep reading the room.
  assert.equal((await call(`/channels/${roomId}/messages`, { user: "bob" })).status, 404);
  assert.equal((await call(`/channels/${roomId}`, { user: "bob" })).status, 404);
});

test("admin moderation is separate from room membership and requires a reason", async () => {
  const { body } = await createRoom({ name: "Moderated", visibility: "private" });
  const roomId = body.channel.id;
  assert.equal((await call("/admin/channels", { user: "carol" })).status, 403);
  assert.equal((await call(`/admin/channels/${roomId}/messages`, { user: "root" })).status, 400);
  assert.equal((await call(`/admin/channels/${roomId}/messages?reason=cleanup`, { user: "root" })).status, 200);
  // Inspection did not fabricate membership.
  assert.equal((await call(`/channels/${roomId}`, { user: "root" })).status, 404);
});

test("a tampered event cursor is rejected and a fresh sync cursor is usable", async () => {
  const sync = (await (await call("/channels/sync")).json()) as { cursor: string };
  assert.equal((await call(`/channels/changes?cursor=${encodeURIComponent(sync.cursor)}`)).status, 200);
  assert.equal((await call("/channels/changes?cursor=not-a-cursor")).status, 400);
  const tampered = `${sync.cursor.slice(0, -2)}aa`;
  assert.equal((await call(`/channels/changes?cursor=${encodeURIComponent(tampered)}`)).status, 400);
});

test("a tombstoned quote is unavailable and deleting a room removes replies cleanly", async () => {
  const { body } = await createRoom({ name: "Quotes", visibility: "public" });
  const roomId = body.channel.id;
  const first = (await (await call(`/channels/${roomId}/messages`, {
    method: "POST",
    json: { clientId: crypto.randomUUID(), body: "Original" },
  })).json()) as { message: { id: string; revision: number; seq: number } };
  const second = (await (await call(`/channels/${roomId}/messages`, {
    method: "POST",
    json: { clientId: crypto.randomUUID(), body: "Reply", replyTo: first.message.id },
  })).json()) as { message: { id: string } };

  assert.equal(
    (await call(`/channels/${roomId}/messages/${first.message.id}`, { method: "DELETE", json: { revision: first.message.revision } })).status,
    200,
  );
  const reply = (await (await call(`/channels/${roomId}/messages/${second.message.id}`)).json()) as {
    message: { body: string; replyTo: { deleted: boolean; excerpt: string } | null };
  };
  assert.equal(reply.message.body, "Reply");
  assert.equal(reply.message.replyTo?.deleted, true);
  assert.equal(reply.message.replyTo?.excerpt, "");

  const detail = (await (await call(`/channels/${roomId}`)).json()) as { channel: { revision: number } };
  assert.equal((await call(`/channels/${roomId}`, { method: "DELETE", json: { revision: detail.channel.revision } })).status, 200);
  assert.equal((await call(`/channels/${roomId}/messages`)).status, 404);
});

test("event polling advances through visible invalidations and hides other rooms", async () => {
  const sync = (await (await call("/channels/sync")).json()) as { items: Array<{ id: string; visibility: string }> };
  const roomId = sync.items.find((room) => room.visibility === "private")!.id;
  const bobCursor = ((await (await call("/channels/sync", { user: "bob" })).json()) as { cursor: string }).cursor;
  const aliceCursor = ((await (await call("/channels/sync")).json()) as { cursor: string }).cursor;
  await call(`/channels/${roomId}/messages`, { method: "POST", json: { clientId: crypto.randomUUID(), body: "private event" } });
  const bob = (await (await call(`/channels/changes?cursor=${encodeURIComponent(bobCursor)}`, { user: "bob" })).json()) as {
    events: Array<{ event: { channelId?: string } }>;
    cursor: string;
  };
  // Bob is not a member: nothing about the private room reaches him, but his cursor still advanced.
  assert.ok(!bob.events.some((frame) => frame.event.channelId === roomId));
  assert.notEqual(bob.cursor, bobCursor);
  const alice = (await (await call(`/channels/changes?cursor=${encodeURIComponent(aliceCursor)}`)).json()) as { events: Array<{ event: { channelId?: string } }> };
  assert.ok(alice.events.some((frame) => frame.event.channelId === roomId));
});

test("a plain member cannot stop someone else's reply by deleting messages", async () => {
  const { tx } = await import("../db.js");
  const { channelRow } = await import("./access.js");
  const { createRunInTx, runRow } = await import("./store.js");
  // Carol owns the room; Alice is a plain member.
  const { body } = await createRoom({ name: "Runs", visibility: "public" }, "carol");
  const roomId = body.channel.id;
  for (const user of ["bob", "alice"]) assert.equal((await call(`/channels/${roomId}/join`, { method: "POST", json: {}, user })).status, 200);
  const source = (await (await call(`/channels/${roomId}/messages`, {
    method: "POST",
    json: { clientId: crypto.randomUUID(), body: "Question" },
    user: "bob",
  })).json()) as { message: { id: string; seq: number; revision: number } };
  const run = tx(() =>
    createRunInTx("bob", channelRow(roomId)!, { messageId: source.message.id, seq: source.message.seq }, {
      clientId: crypto.randomUUID(),
      requestHash: "h",
      modelRef: "test/model",
      configJson: "{}",
      inputEnc: "x",
      reservedBytes: 0,
    }),
  );
  const del = (messageId: string, revision: number, user: string) =>
    call(`/channels/${roomId}/messages/${messageId}`, { method: "DELETE", json: { revision }, user });

  assert.equal((await del(source.message.id, source.message.revision, "alice")).status, 403);
  assert.equal(runRow(run.runId)!.state, "queued");
  assert.equal((await del(run.messageId, 1, "alice")).status, 403);
  assert.equal(runRow(run.runId)!.state, "queued");
  assert.equal((await call(`/channels/${roomId}/ai-runs/${run.runId}/cancel`, { method: "POST", json: {}, user: "alice" })).status, 403);
  assert.equal(runRow(run.runId)!.state, "queued");

  // The author's own tombstone still stops replies to it.
  assert.equal((await del(source.message.id, source.message.revision, "bob")).status, 200);
  assert.equal(runRow(run.runId)!.state, "cancelled");
});

test("an administrator can transfer room ownership", async () => {
  const { body } = await createRoom({ name: "Handover", visibility: "public" }, "bob");
  const roomId = body.channel.id;
  assert.equal((await call(`/channels/${roomId}/join`, { method: "POST", json: {}, user: "carol" })).status, 200);
  const { revision } = ((await (await call(`/channels/${roomId}`, { user: "bob" })).json()) as { channel: { revision: number } }).channel;
  const moved = await call(`/admin/channels/${roomId}/moderate`, {
    method: "POST",
    json: { action: "transfer", targetId: "carol", revision, reason: "owner left" },
    user: "root",
  });
  assert.equal(moved.status, 200);
  const roles = db.prepare("SELECT user_id, role FROM channel_members WHERE channel_id = ? ORDER BY user_id").all(roomId) as Array<{ user_id: string; role: string }>;
  assert.deepEqual(roles.map((row) => [row.user_id, row.role]), [["bob", "moderator"], ["carol", "owner"]]);
  assert.equal((db.prepare("SELECT owner_id FROM channels WHERE id = ?").get(roomId) as { owner_id: string }).owner_id, "carol");
});

async function queuedReply(user = "alice") {
  const { tx } = await import("../db.js");
  const { channelRow } = await import("./access.js");
  const { createRunInTx } = await import("./store.js");
  const { body } = await createRoom({ name: "Settlement", visibility: "public" }, user);
  const id = body.channel.id;
  const posted = await call(`/channels/${id}/messages`, { method: "POST", user, json: { clientId: crypto.randomUUID(), body: "Question" } });
  const { message } = await posted.json() as { message: { id: string; seq: number } };
  const run = tx(() => createRunInTx(user, channelRow(id)!, { messageId: message.id, seq: message.seq }, {
    clientId: crypto.randomUUID(), requestHash: "test", modelRef: "test/model",
    configJson: JSON.stringify({ binding: { label: "Room assistant" } }), inputEnc: "unused", reservedBytes: 65536,
  }));
  return { id, run, source: message.id };
}

test("stale archive, deletion, and admin moderation leave replies queued", async () => {
  const { runRow } = await import("./store.js");
  const { id, run, source } = await queuedReply();
  for (const [url, method, json, user] of [
    [`/channels/${id}/archive`, "POST", { revision: 999, archived: true }, "alice"],
    [`/channels/${id}`, "DELETE", { revision: 999 }, "alice"],
    [`/admin/channels/${id}`, "DELETE", { revision: 999, reason: "cleanup" }, "root"],
    [`/admin/channels/${id}/moderate`, "POST", { action: "archive", revision: 999, reason: "cleanup" }, "root"],
    [`/admin/channels/${id}/moderate`, "POST", { action: "deleteMessage", targetId: source, revision: 999, reason: "cleanup" }, "root"],
  ] as const) {
    assert.equal((await call(url, { method, json, user })).status, 409, url);
    assert.equal(runRow(run.runId)!.state, "queued");
  }
  const projection = await (await call(`/channels/${id}/messages/${run.messageId}`)).json() as { message: { aiLabel: string } };
  assert.equal(projection.message.aiLabel, "Room assistant");
});

test("AI admission rejects stale membership, binding and archive state", async () => {
  const { tx } = await import("../db.js");
  const { channelRow } = await import("./access.js");
  const { createRunInTx } = await import("./store.js");
  const { id, run, source } = await queuedReply();
  db.prepare("UPDATE channel_ai_runs SET state = 'cancelled' WHERE id = ?").run(run.runId);
  const old = channelRow(id)!;
  const admit = () => tx(() => createRunInTx("bob", old, { messageId: source, seq: 1 }, {
    clientId: crypto.randomUUID(), requestHash: "test", modelRef: "test/model", configJson: "{}", inputEnc: "x", reservedBytes: 0,
  }));
  assert.throws(admit, /Room not found/);
  await call(`/channels/${id}/join`, { method: "POST", user: "bob", json: {} });
  db.prepare("UPDATE channels SET ai_json = '{}' WHERE id = ?").run(id);
  assert.throws(admit, /binding changed/);
  db.prepare("UPDATE channels SET ai_json = NULL, archived_at = 1 WHERE id = ?").run(id);
  assert.throws(admit, /archived/);
});

test("a stale group invitation reveals neither metadata nor notices", async () => {
  const { body } = await createRoom({ name: "Group secret", visibility: "group", groupIds: ["g1"] });
  const id = body.channel.id;
  await call(`/channels/${id}/invites`, { method: "POST", json: { userIds: ["bob"] } });
  const { listNotifications, unreadCount } = await import("../notifications.js");
  assert.ok(listNotifications("bob").items.some(n => n.channelId === id));
  const count = unreadCount("bob");
  db.prepare("DELETE FROM user_group_members WHERE group_id = 'g1' AND user_id = 'bob'").run();
  try {
    assert.equal((await call(`/channels/${id}`, { user: "bob" })).status, 404);
    assert.ok(!listNotifications("bob").items.some(n => n.channelId === id));
    assert.equal(unreadCount("bob"), count - 1);
  } finally {
    db.prepare("INSERT INTO user_group_members (group_id,user_id) VALUES ('g1','bob')").run();
  }
});

test("event epochs reset even when their sequence exceeds the new log", async () => {
  const { encodeCursor } = await import("./events.js");
  const cursor = encodeCursor({ v: 1, epoch: "old-install", seq: "999999999", userId: "alice" });
  const response = await call(`/channels/changes?cursor=${cursor}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { reset: true, reason: "history_expired" });
});

test("SSE sends ready, heartbeat, revoked and releases its account slot", { timeout: 22000 }, async () => {
  const { streamCounts, wakeEvents } = await import("./events.js");
  const baseline = streamCounts().process;
  const response = await call("/channels/events");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control")!, /no-transform/);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const until = async (needle: string) => {
    while (!text.includes(needle)) {
      const part = await reader.read();
      assert.ok(!part.done, text);
      text += decoder.decode(part.value);
    }
  };
  try {
    await until("event: reset");
    assert.match(text, /event: ready/);
    await until(": heartbeat");
    db.prepare("UPDATE sessions SET expires_at = 0 WHERE user_id = 'alice'").run();
    wakeEvents();
    await until("event: revoked");
    while (!(await reader.read()).done) { /* drain */ }
    assert.equal(streamCounts().process, baseline);
  } finally {
    await reader.cancel();
    db.prepare("UPDATE sessions SET expires_at = ? WHERE user_id = 'alice'").run(Date.now() + 3600000);
  }
  const again = await call("/channels/events");
  await again.body!.cancel();
  assert.equal(streamCounts().process, baseline);
});

test("the worker settles a real SDK stream once, bills usage, and retains the frozen envelope", { timeout: 10000 }, async (t) => {
  const { saveConnection } = await import("../catalog/providers.js");
  const { channelActiveCount, initChannelWorker } = await import("./worker.js");
  initChannelWorker();
  saveConnection("root", "custom-room-test", { baseURL: "http://room.test/v1" });
  const requests: Array<{ messages: unknown[]; tools?: unknown[] }> = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "http://room.test/v1/models") return Response.json({ data: [{ id: "mock" }] });
    assert.equal(url, "http://room.test/v1/chat/completions");
    requests.push(JSON.parse(init!.body as string));
    const chunks = [
      { id: "r", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta: { role: "assistant", content: "Room answer" }, finish_reason: null }] },
      { id: "r", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ];
    return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  });
  const { response, body } = await createRoom({ name: "Worker room", visibility: "public", ai: { kind: "model", modelRef: "custom-room-test/mock" } }, "root");
  assert.equal(response.status, 201);
  const posted = await call(`/channels/${body.channel.id}/messages`, { method: "POST", user: "root", json: { clientId: crypto.randomUUID(), body: "Frozen question", requestAi: true } });
  assert.equal(posted.status, 202);
  const { runId } = await posted.json() as { runId: string };
  const { runRow } = await import("./store.js");
  while (channelActiveCount()) await new Promise(resolve => setTimeout(resolve, 10));
  const run = runRow(runId)!;
  assert.equal(run.state, "finished", JSON.stringify(run));
  assert.equal(run.input_enc, null);
  assert.equal(run.reserved_bytes, 0);
  assert.equal(run.usage_recorded, 1);
  assert.equal((db.prepare("SELECT count(*) AS n FROM usage WHERE channel_run_id = ?").get(runId) as { n: number }).n, 1);
  assert.equal((db.prepare("SELECT body FROM channel_messages WHERE id = ?").get(run.message_id) as { body: string }).body, "Room answer");
  assert.equal(requests.length, 1);
  assert.ok(!requests[0]!.tools?.length);
  assert.match(JSON.stringify(requests[0]!.messages), /channel_history/);
  assert.match(JSON.stringify(requests[0]!.messages), /Frozen question/);
});

test("revoking membership aborts an idle provider and records forbidden with its partial body", { timeout: 10000 }, async (t) => {
  const { saveConnection } = await import("../catalog/providers.js");
  const { channelActiveCount } = await import("./worker.js");
  const { runRow } = await import("./store.js");
  saveConnection("root", "custom-revoke-test", { baseURL: "http://revoke.test/v1" });
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/models")) return Response.json({ data: [{ id: "mock" }] });
    assert.equal(String(input), "http://revoke.test/v1/chat/completions");
    return new Response(new ReadableStream({ start(controller) {
      const chunk = { id: "r", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta: { role: "assistant", content: "a".repeat(1100) }, finish_reason: null }] };
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
      init!.signal!.addEventListener("abort", () => controller.error(init!.signal!.reason), { once: true });
    } }), { headers: { "Content-Type": "text/event-stream" } });
  });
  const { body } = await createRoom({ name: "Revoke worker", visibility: "public", ai: { kind: "model", modelRef: "custom-revoke-test/mock" } }, "root");
  const id = body.channel.id;
  await call(`/channels/${id}/join`, { method: "POST", user: "alice", json: {} });
  const { channel } = await (await call(`/channels/${id}`, { user: "root" })).json() as { channel: { revision: number } };
  assert.equal((await call(`/channels/${id}/transfer`, { method: "POST", user: "root", json: { revision: channel.revision, userId: "alice" } })).status, 200);
  const posted = await call(`/channels/${id}/messages`, { method: "POST", user: "root", json: { clientId: crypto.randomUUID(), body: "Answer", requestAi: true } });
  assert.equal(posted.status, 202);
  const { runId } = await posted.json() as { runId: string };
  const partial = () => (db.prepare("SELECT body FROM channel_messages WHERE id = ?").get(runRow(runId)!.message_id) as { body: string }).body;
  while (!partial()) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await call(`/channels/${id}/leave`, { method: "POST", user: "root", json: {} })).status, 200);
  while (channelActiveCount()) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(runRow(runId)!.state, "failed");
  assert.equal(runRow(runId)!.error_code, "forbidden");
  assert.equal(partial(), "a".repeat(1100));
  assert.equal(runRow(runId)!.input_enc, null);
});

test("invalid admin update reasons cannot mutate room metadata", async () => {
  const { body } = await createRoom({ name: "Audited", visibility: "public" });
  const response = await call(`/admin/channels/${body.channel.id}`, { method: "PATCH", user: "root", json: { revision: 1, name: "Unaudited", reason: "\n " } });
  assert.equal(response.status, 400);
  assert.equal((db.prepare("SELECT name FROM channels WHERE id = ?").get(body.channel.id) as { name: string }).name, "Audited");
});

test("pruning preserves the event high-water and resets expired replay cursors", async () => {
  const { insertSync, currentCursor, latestEventId, scanChanges, eventState } = await import("./events.js");
  const { runChannelMaintenance } = await import("./maintenance.js");
  const before = currentCursor("alice");
  insertSync();
  const high = latestEventId();
  const current = currentCursor("alice");
  db.prepare("UPDATE channel_events SET created_at = 0 WHERE id = ?").run(high);
  runChannelMaintenance();
  assert.equal(latestEventId(), high);
  assert.equal(eventState().floor, high);
  assert.deepEqual(scanChanges("alice", before), { reset: true, reason: "history_expired" });
  const atFloor = scanChanges("alice", current);
  assert.equal(atFloor.reset, false);
});

test("startup recovery retains partial output and releases encrypted input and reservations", async () => {
  const { runRow, interruptOpenRuns, markRunRunning, checkpointRun } = await import("./store.js");
  const { run } = await queuedReply();
  markRunRunning(run.runId);
  checkpointRun(run.runId, "Partial output");
  assert.equal(interruptOpenRuns(), 1);
  assert.equal(interruptOpenRuns(), 0);
  assert.equal(runRow(run.runId)!.state, "interrupted");
  assert.equal(runRow(run.runId)!.input_enc, null);
  assert.equal(runRow(run.runId)!.reserved_bytes, 0);
  assert.equal((db.prepare("SELECT body FROM channel_messages WHERE id = ?").get(run.messageId) as { body: string }).body, "Partial output");
});
