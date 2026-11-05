import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { Hono } from "hono";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-webhooks-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "webhooks-test-secret-only-not-for-production";
process.env.OKAYCHAT_STORAGE_LIMIT = "10000000";
writeFileSync(path.join(dataDir, "models-dev.json"), JSON.stringify({ data: {}, fetchedAt: Date.now() }));

const { db, tx } = await import("./db.js");
const { api } = await import("./routes.js");
const { handleAppError } = await import("./errors.js");
const { sha256, decrypt } = await import("./crypto.js");
const { writePolicy } = await import("./permissions/store.js");
const { endRun, interruptOpenRuns } = await import("./generation-runs.js");
const { emitArchiveFinished } = await import("./outgoing-webhooks/events.js");
const { signDelivery, verifyDelivery } = await import("./outgoing-webhooks/signatures.js");
const store = await import("./outgoing-webhooks/store.js");
const worker = await import("./outgoing-webhooks/worker.js");
const { runOutgoingWebhookMaintenance } = await import("./outgoing-webhooks/maintenance.js");
const { createChannel, postHumanMessage, editHumanMessage, deleteHumanMessage, postRequestHash } = await import("./channels/store.js");

const app = new Hono().onError(handleAppError).route("/api", api);
after(() => {
  worker.resetOutgoingWebhookWorkerForTests();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const users = ["alice", "bob", "carol"] as const;
beforeEach(() => {
  worker.resetOutgoingWebhookWorkerForTests();
  db.exec(`
    DELETE FROM outgoing_webhook_deliveries;
    DELETE FROM outgoing_webhook_test_preparations;
    DELETE FROM outgoing_webhook_rate_windows;
    DELETE FROM outgoing_webhook_endpoints;
    DELETE FROM permission_policies;
    DELETE FROM channel_messages;
    DELETE FROM channel_members;
    DELETE FROM channel_create_keys;
    DELETE FROM channels;
    DELETE FROM outgoing_webhook_rate_windows;
    DELETE FROM generation_runs;
    DELETE FROM threads;
  `);
  for (const user of users) {
    db.prepare("INSERT OR IGNORE INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, 'unused', 'user', 1)").run(user, `${user}@example.test`, user);
    db.prepare("INSERT OR IGNORE INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(`${user}-session`), user, Date.now() + 600_000);
  }
});
afterEach(() => {
  worker.resetOutgoingWebhookWorkerForTests();
});

const call = (path: string, init: { method?: string; json?: unknown; user?: string } = {}) =>
  app.request(`http://app/api${path}`, {
    method: init.method ?? "GET",
    headers: { cookie: `okaychat_session=${init.user ?? "alice"}-session`, ...(init.json !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });

async function createEndpoint(over: Record<string, unknown> = {}, user = "alice") {
  const response = await call("/webhooks", {
    method: "POST",
    user,
    json: {
      name: "Build alerts",
      url: "https://example.com/hooks/okaychat",
      subscriptions: ["chat.turn.completed"],
      channelIds: [],
      includeMessageText: false,
      ...over,
    },
  });
  assert.equal(response.status, 201, await response.clone().text());
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  return response.json() as Promise<{ endpoint: { id: string; revision: number; enabled: boolean }; signingSecret: string }>;
}

async function enable(id: string, revision: number, user = "alice") {
  const response = await call(`/webhooks/${id}`, { method: "PATCH", user, json: { revision, enabled: true } });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as { endpoint: { revision: number } };
}

function endpointBody(endpointId: string, deliveryId: string): Record<string, unknown> {
  const row = db.prepare("SELECT body_enc FROM outgoing_webhook_deliveries WHERE endpoint_id = ? AND id = ?").get(endpointId, deliveryId) as { body_enc: string | null } | undefined;
  assert.ok(row?.body_enc, "delivery has a stored body");
  return JSON.parse(decrypt(row.body_enc)) as Record<string, unknown>;
}

test("endpoint creation is disabled, secrets are shown once, and lists expose hostnames only", async () => {
  const created = await createEndpoint({
    name: "  Deploy  ",
    headers: { Authorization: "Bearer super-secret-value" },
    includeMessageText: false,
  });
  assert.equal(created.endpoint.enabled, false);
  assert.ok(created.signingSecret.startsWith("okc_wh_v1_"));
  const detail = await call(`/webhooks/${created.endpoint.id}`);
  const body = (await detail.json()) as { endpoint: Record<string, unknown> };
  assert.equal(body.endpoint.name, "Deploy");
  assert.equal(body.endpoint.enabled, false);
  assert.equal(body.endpoint.url, "https://example.com/hooks/okaychat");
  assert.deepEqual(body.endpoint.headerNames, ["Authorization"]);
  assert.equal(body.endpoint.hasSigningSecret, true);
  assert.ok(!JSON.stringify(body).includes("super-secret-value"));
  assert.ok(!JSON.stringify(body).includes(created.signingSecret));

  const list = (await (await call("/webhooks")).json()) as { items: Array<Record<string, unknown>> };
  assert.equal(list.items[0]!.hostname, "example.com");
  assert.equal("url" in list.items[0]!, false);
  assert.equal("headers" in list.items[0]!, false);

  const enabled = await call("/webhooks", { method: "POST", json: { name: "x", url: "https://example.com/a", subscriptions: [], channelIds: [], includeMessageText: false, enabled: true } });
  assert.equal(enabled.status, 400);
  assert.equal((await call(`/webhooks/${created.endpoint.id}`, { user: "bob" })).status, 404);
  assert.equal((await call(`/webhooks/${created.endpoint.id}`, { method: "DELETE", user: "bob", json: { revision: 1 } })).status, 404);
});

test("destinations and headers are strict and never echoed", async () => {
  const bad = [
    { url: "http://example.com/hook" },
    { url: "https://example.com:8443/hook" },
    { url: "https://user:pass@example.com/hook" },
    { url: "https://localhost/hook" },
    { url: "https://127.0.0.1/hook" },
    { url: "https://example.com/hook#fragment" },
  ];
  for (const over of bad) {
    const response = await call("/webhooks", {
      method: "POST",
      json: { name: "x", subscriptions: [], channelIds: [], includeMessageText: false, ...over },
    });
    assert.ok(response.status >= 400, JSON.stringify(over));
    const text = await response.text();
    assert.ok(!text.includes("user:pass"));
  }
  for (const headers of [{ Host: "x" }, { "X-Okaychat-Signature": "x" }, { Cookie: "a=b" }, { "Bad Header": "x" }, { Authorization: "a\nb" }, { A: "1", a: "2" }]) {
    const response = await call("/webhooks", {
      method: "POST",
      json: { name: "x", url: "https://example.com/hook", subscriptions: [], channelIds: [], includeMessageText: false, headers },
    });
    assert.equal(response.status, 400, JSON.stringify(headers));
  }
});

test("feature denial blocks creation but cleanup disable and reads still work", async () => {
  const created = await createEndpoint();
  writePolicy({ kind: "user", id: "alice" }, null, { version: 1, features: { outgoingWebhooks: false } }, null);
  assert.equal((await call("/webhooks", { method: "POST", json: { name: "x", url: "https://example.com/b", subscriptions: [], channelIds: [], includeMessageText: false } })).status, 403);
  assert.equal((await call("/webhooks")).status, 200);
  const disabled = await call(`/webhooks/${created.endpoint.id}`, { method: "PATCH", json: { revision: 1, enabled: false } });
  assert.equal(disabled.status, 200);
  assert.equal((await call(`/webhooks/${created.endpoint.id}`, { method: "DELETE", json: { revision: 2 } })).status, 200);
});

test("HMAC is over timestamp + delivery id + exact raw body bytes", () => {
  const secret = "okc_wh_v1_testsecret";
  const body = Buffer.from('{"specVersion":1,"eventId":"whe_vector","deliveryId":"whd_vector","sequence":"7","occurredAt":1700000000000,"type":"webhook.test","data":{"testId":"wht_vector","sample":true}}', "utf8");
  const signature = signDelivery(secret, 1_700_000_000, "whd_vector", body);
  assert.equal(signature, "709e0bbb6588a6672cc6f61c6816ece514c8d1bc4d61175ae84e0c9cc560e09a");
  assert.equal(verifyDelivery(secret, 1_700_000_000, "whd_vector", body, signature), true);
  assert.equal(verifyDelivery(secret, 1_700_000_001, "whd_vector", body, signature), false);
  assert.equal(verifyDelivery(secret, 1_700_000_000, "whd_other", body, signature), false);
  const mutated = Buffer.from(body);
  mutated[0] = 0x7b;
  mutated[1] = 0x20;
  assert.equal(verifyDelivery(secret, 1_700_000_000, "whd_vector", mutated, signature), false);
  assert.equal(verifyDelivery(secret, 1_700_000_000, "whd_vector", Buffer.from('{"x":1}', "utf8"), signature), false);
});

test("a completed interactive turn emits one metadata-only event without text by default", async () => {
  const thread = "thr_turn";
  db.prepare("INSERT INTO threads (id, user_id, title, created_at, updated_at) VALUES (?, 'alice', 'Private title', 1, 1)").run(thread);
  const config = JSON.stringify({ version: 1, requestKind: "send", turnOrigin: "interactive", modelRef: "test/model", sampling: {}, instructions: "", toolPolicy: { mode: "inherit", builtins: [], mcpTools: [] }, knowledgeIds: [], assistantName: null, assistantIcon: null, assistantRevision: null, webSearch: true, deepResearch: false });
  const runId = "run_1";
  db.prepare("INSERT INTO generation_runs (id, thread_id, user_message_id, assistant_message_id, config_json, state, created_at, updated_at) VALUES (?, ?, 'm1', 'a1', ?, 'running', 1, 1)").run(runId, thread, config);
  const created = await createEndpoint({ subscriptions: ["chat.turn.completed"] });
  await enable(created.endpoint.id, 1);

  endRun(runId, { state: "finished", finishReason: "stop", durationMs: 10 }, { answerText: "private answer" });
  endRun(runId, { state: "finished", finishReason: "stop", durationMs: 10 }, { answerText: "private answer" });
  const rows = db.prepare("SELECT id FROM outgoing_webhook_deliveries WHERE endpoint_id = ?").all(created.endpoint.id) as Array<{ id: string }>;
  assert.equal(rows.length, 1, "a repeated terminal write does not duplicate the event");
  const envelope = endpointBody(created.endpoint.id, rows[0]!.id);
  assert.deepEqual(Object.keys(envelope).sort(), ["data", "deliveryId", "eventId", "occurredAt", "sequence", "specVersion", "type"]);
  assert.equal(envelope.type, "chat.turn.completed");
  assert.equal(typeof envelope.sequence, "string");
  const data = envelope.data as Record<string, unknown>;
  assert.deepEqual(Object.keys(data).sort(), ["assistantMessageId", "finishReason", "runId", "threadId"]);
  assert.equal("text" in data, false);
  const serialized = JSON.stringify(envelope);
  assert.ok(!serialized.includes("private answer"));
  assert.ok(!serialized.includes("Private title"));
  assert.ok(!serialized.includes("test/model"));
  assert.equal((await call(`/webhooks/${created.endpoint.id}/deliveries`)).status, 200);
});

test("text is opt-in, bounded to 8192 UTF-8 bytes without splitting a code point", async () => {
  const thread = "thr_text";
  db.prepare("INSERT INTO threads (id, user_id, created_at, updated_at) VALUES (?, 'alice', 1, 1)").run(thread);
  const config = JSON.stringify({ version: 1, requestKind: "send", turnOrigin: "interactive", modelRef: "test/model", sampling: {}, instructions: "", toolPolicy: { mode: "inherit", builtins: [], mcpTools: [] }, knowledgeIds: [], assistantName: null, assistantIcon: null, assistantRevision: null, webSearch: true, deepResearch: false });
  const created = await createEndpoint({ subscriptions: ["chat.turn.completed"], includeMessageText: true });
  await enable(created.endpoint.id, 1);
  db.prepare("INSERT INTO generation_runs (id, thread_id, user_message_id, assistant_message_id, config_json, state, created_at, updated_at) VALUES ('run_text', ?, 'm1', 'a1', ?, 'running', 1, 1)").run(thread, config);
  const long = "é".repeat(5_000);
  endRun("run_text", { state: "finished", finishReason: "length", durationMs: 1 }, { answerText: long });
  const row = db.prepare("SELECT id FROM outgoing_webhook_deliveries WHERE endpoint_id = ?").get(created.endpoint.id) as { id: string };
  const data = endpointBody(created.endpoint.id, row.id).data as { text: { value: string; truncated: boolean } };
  assert.equal(data.text.truncated, true);
  assert.ok(Buffer.byteLength(data.text.value, "utf8") <= 8_192);
  assert.equal(data.text.value.includes("\uFFFD"), false);
  assert.equal([...data.text.value].every((char) => char === "é"), true);
  assert.ok(Buffer.byteLength(JSON.stringify(endpointBody(created.endpoint.id, row.id)), "utf8") <= 12_288);
});

test("worker succeeds, retries with bounded jitter, and allows one manual retry", async () => {
  const created = await createEndpoint({ subscriptions: ["archive.export.finished"] });
  await enable(created.endpoint.id, 1);
  tx(() => emitArchiveFinished({ userId: "alice", kind: "export", jobId: "arc_1", outcome: "completed", chatCount: 2, failureCode: null }));
  const delivery = db.prepare("SELECT id FROM outgoing_webhook_deliveries WHERE endpoint_id = ?").get(created.endpoint.id) as { id: string };

  const calls: string[] = [];
  const failure = async () => {
    calls.push("call");
    return { outcome: "failed" as const, httpStatus: 500, errorCode: "http_retryable" as const, durationMs: 4 };
  };
  await worker.runOutgoingWebhookPumpForTests({ transport: failure });
  let row = db.prepare("SELECT * FROM outgoing_webhook_deliveries WHERE id = ?").get(delivery.id) as { status: string; attempts: number; next_attempt_at: number; last_error_code: string; version: number };
  assert.equal(row.status, "backoff");
  assert.equal(row.attempts, 1);
  assert.ok(row.next_attempt_at - Date.now() >= 14_000 && row.next_attempt_at - Date.now() <= 31_000);
  assert.equal(row.last_error_code, "http_retryable");

  db.prepare("UPDATE outgoing_webhook_deliveries SET next_attempt_at = 0 WHERE id = ?").run(delivery.id);
  await worker.runOutgoingWebhookPumpForTests({
    transport: async () => ({ outcome: "failed", httpStatus: 302, errorCode: "redirect", durationMs: 1 }),
  });
  row = db.prepare("SELECT * FROM outgoing_webhook_deliveries WHERE id = ?").get(delivery.id) as typeof row;
  assert.equal(row.status, "dead");
  assert.equal(row.attempts, 2);
  assert.equal(row.last_error_code, "redirect");

  const detail = store.getDelivery("alice", created.endpoint.id, delivery.id);
  assert.equal(detail.canRetry, true);
  assert.ok(detail.body);
  const bodyBeforeRetry = detail.body;
  const success = async () => ({ outcome: "succeeded" as const, httpStatus: 204, errorCode: null, durationMs: 2 });
  // Set the next attempt's transport before the retry: the retry's after-commit wake starts a pump at once.
  await worker.runOutgoingWebhookPumpForTests({ transport: success });
  const retried = store.retryDelivery("alice", created.endpoint.id, delivery.id, 2, detail.version);
  await worker.runOutgoingWebhookPumpForTests({ transport: success });
  row = db.prepare("SELECT * FROM outgoing_webhook_deliveries WHERE id = ?").get(delivery.id) as typeof row;
  assert.equal(row.status, "succeeded");
  assert.equal(row.attempts, 3);
  assert.equal(retried.deliveryId, delivery.id);
  assert.equal(store.getDelivery("alice", created.endpoint.id, delivery.id).body, bodyBeforeRetry);
});

test("a failed manual attempt never restarts automatic retries", async () => {
  const created = await createEndpoint({ subscriptions: ["archive.export.finished"] });
  await enable(created.endpoint.id, 1);
  tx(() => emitArchiveFinished({ userId: "alice", kind: "export", jobId: "manual", outcome: "completed", chatCount: 1, failureCode: null }));
  const { id } = db.prepare("SELECT id FROM outgoing_webhook_deliveries").get() as { id: string };
  const now = Date.now();
  const first = store.claimDelivery(id, now);
  assert.ok(first && first !== "throttled");
  store.settleDelivery({ deliveryId: id, attemptNumber: 1, expectedVersion: first.row.version, outcome: "failed", httpStatus: 400, errorCode: "http_permanent", durationMs: 1 });
  store.retryDelivery("alice", created.endpoint.id, id, 2, store.getDelivery("alice", created.endpoint.id, id).version);
  const manual = store.claimDelivery(id, Date.now());
  assert.ok(manual && manual !== "throttled");
  assert.equal(store.settleDelivery({ deliveryId: id, attemptNumber: 2, expectedVersion: manual.row.version, outcome: "failed", httpStatus: 500, errorCode: "http_retryable", durationMs: 1 }), "dead");
  assert.equal(store.getDelivery("alice", created.endpoint.id, id).attemptLog.at(-1)?.manual, true);
});

test("restart never extends an exhausted automatic budget or repeats an uncertain manual attempt", async () => {
  const created = await createEndpoint({ subscriptions: ["archive.export.finished"] });
  await enable(created.endpoint.id, 1);
  for (const jobId of ["automatic", "manual", "remaining"]) {
    tx(() => emitArchiveFinished({ userId: "alice", kind: "export", jobId, outcome: "completed", chatCount: 1, failureCode: null }));
  }
  const rows = db.prepare("SELECT id FROM outgoing_webhook_deliveries ORDER BY sequence").all() as Array<{ id: string }>;
  const now = Date.now();
  for (const [index, row] of rows.entries()) {
    const claimed = store.claimDelivery(row.id, now);
    assert.ok(claimed && claimed !== "throttled");
    db.prepare("UPDATE outgoing_webhook_deliveries SET attempts = ?, attempts_json = ? WHERE id = ?")
      .run(index === 0 ? 6 : 2, JSON.stringify([{ number: index === 0 ? 6 : 2, outcome: "uncertain", ...(index === 1 ? { manual: true } : {}) }]), row.id);
  }
  store.recoverSendingDeliveries(now);
  assert.deepEqual(rows.map((row) => store.getDelivery("alice", created.endpoint.id, row.id).status), ["dead", "dead", "backoff"]);
  assert.deepEqual(rows.map((row) => store.getDelivery("alice", created.endpoint.id, row.id).attempts), [6, 2, 2]);
  assert.equal(store.getDelivery("alice", created.endpoint.id, rows[2]!.id).nextAttemptAt, now + 30_000);
});

test("a test preview redacts credentials, sends one attempt, and is never automatically retried", async () => {
  const created = await createEndpoint({ subscriptions: [], headers: { Authorization: "Bearer nope" } });
  const prepared = await call(`/webhooks/${created.endpoint.id}/test/prepare`, { method: "POST", json: { revision: 1 } });
  assert.equal(prepared.status, 200, await prepared.clone().text());
  const prep = (await prepared.json()) as { preparationId: string; expiresAt: number; preview: { headers: Record<string, string>; body: string; bodySha256: string; maxAttempts: number } };
  assert.equal(prep.preview.headers.Authorization, "[redacted]");
  assert.equal(prep.preview.headers["X-Okaychat-Signature"], "v1=<hex hmac>");
  assert.equal(prep.preview.maxAttempts, 1);
  assert.ok(prep.preview.body.includes('"sample":true'));
  assert.equal(prep.preview.body.includes("Build alerts"), false);
  assert.equal(sha256(prep.preview.body), prep.preview.bodySha256);

  const first = await call(`/webhooks/${created.endpoint.id}/test/send`, { method: "POST", json: { revision: 1, preparationId: prep.preparationId } });
  assert.equal(first.status, 202);
  const firstId = ((await first.json()) as { deliveryId: string }).deliveryId;
  const second = await call(`/webhooks/${created.endpoint.id}/test/send`, { method: "POST", json: { revision: 1, preparationId: prep.preparationId } });
  assert.equal(second.status, 202);
  assert.equal(((await second.json()) as { deliveryId: string }).deliveryId, firstId);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM outgoing_webhook_deliveries WHERE endpoint_id = ?").get(created.endpoint.id) as { n: number }).n, 1);

  let calls = 0;
  await worker.runOutgoingWebhookPumpForTests({
    transport: async () => {
      calls++;
      return { outcome: "failed", httpStatus: 500, errorCode: "http_retryable", durationMs: 1 };
    },
  });
  assert.equal(calls, 1);
  const row = db.prepare("SELECT status, attempts, is_test FROM outgoing_webhook_deliveries WHERE id = ?").get(firstId) as { status: string; attempts: number; is_test: number };
  assert.equal(row.status, "dead");
  assert.equal(row.attempts, 1);
  assert.equal(row.is_test, 1);
  const endpoint = db.prepare("SELECT consecutive_failures, failed_attempts FROM outgoing_webhook_endpoints WHERE id = ?").get(created.endpoint.id) as { consecutive_failures: number; failed_attempts: number };
  assert.equal(endpoint.consecutive_failures, 0);
  assert.equal(endpoint.failed_attempts, 0);
});

test("revision changes cancel queued work and pending tests", async () => {
  const created = await createEndpoint({ subscriptions: ["archive.export.finished"] });
  await enable(created.endpoint.id, 1);
  tx(() => emitArchiveFinished({ userId: "alice", kind: "export", jobId: "arc_2", outcome: "completed", chatCount: 1, failureCode: null }));
  assert.equal((await call(`/webhooks/${created.endpoint.id}/test/prepare`, { method: "POST", json: { revision: 2 } })).status, 200);
  const response = await call(`/webhooks/${created.endpoint.id}`, { method: "PATCH", json: { revision: 2, name: "Renamed" } });
  assert.equal(response.status, 200);
  const rows = db.prepare("SELECT status FROM outgoing_webhook_deliveries WHERE endpoint_id = ?").all(created.endpoint.id) as Array<{ status: string }>;
  assert.equal(rows[0]!.status, "cancelled");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM outgoing_webhook_test_preparations WHERE endpoint_id = ? AND consumed_at IS NULL").get(created.endpoint.id) as { n: number }).n, 0);
  assert.equal((await call(`/webhooks/${created.endpoint.id}/test/prepare`, { method: "POST", json: { revision: 3 } })).status, 200);
});

test("channel events exclude DMs, honor the owner's room selection, and scrub stale text", async () => {
  const room = createChannel("alice", {
    clientId: "room-1",
    name: "Deploys",
    description: "",
    icon: "hash",
    visibility: "private",
    groupIds: [],
    aiJson: null,
    requestHash: "hash-room",
  }).value;
  db.prepare("INSERT INTO channel_members (channel_id, user_id, role, read_seq, notify_mode, joined_at) VALUES (?, 'bob', 'member', 0, 'mentions', 1)").run(room.id);
  const created = await createEndpoint({ subscriptions: ["channel.message.created", "channel.mention", "channel.message.edited", "channel.message.deleted"], channelIds: [room.id], includeMessageText: true });
  await enable(created.endpoint.id, 1);
  const input = { clientId: "c1", body: "hello room", mentions: [], requestHash: postRequestHash({ body: "hello room" }) };
  const posted = postHumanMessage("bob", room.id, input, () => null).value;
  let rows = db.prepare("SELECT id, event_type, body_enc FROM outgoing_webhook_deliveries WHERE endpoint_id = ? ORDER BY sequence").all(created.endpoint.id) as Array<{ id: string; event_type: string; body_enc: string | null }>;
  assert.deepEqual(rows.map((row) => row.event_type), ["channel.message.created"]);
  const first = JSON.parse(decrypt(rows[0]!.body_enc!)) as { data: { text: { value: string } } };
  assert.equal(first.data.text.value, "hello room");

  editHumanMessage("bob", room.id, posted.messageId, 1, "edited room", []);
  rows = db.prepare("SELECT id, event_type, body_enc, status FROM outgoing_webhook_deliveries WHERE endpoint_id = ? ORDER BY sequence").all(created.endpoint.id) as Array<{ id: string; event_type: string; body_enc: string | null; status: string }>;
  assert.equal(rows[0]!.status, "cancelled");
  assert.equal(rows[0]!.body_enc, null);
  assert.equal(rows[1]!.event_type, "channel.message.edited");

  deleteHumanMessage("bob", room.id, posted.messageId, 2, { moderator: false, reason: "" });
  rows = db.prepare("SELECT id, event_type, body_enc, status FROM outgoing_webhook_deliveries WHERE endpoint_id = ? ORDER BY sequence").all(created.endpoint.id) as Array<{ id: string; event_type: string; body_enc: string | null; status: string }>;
  assert.equal(rows.at(-1)!.event_type, "channel.message.deleted");
  assert.equal(rows.at(-1)!.body_enc !== null, true);
  const deleted = JSON.parse(decrypt(rows.at(-1)!.body_enc!)) as { data: Record<string, unknown> };
  assert.equal("text" in deleted.data, false);
  assert.equal(deleted.data.revision, 3);

  // A direct message never produces an event even when the endpoint selects every room it owns.
  db.prepare("INSERT INTO channels (id, owner_id, name, description, icon, visibility, kind, revision, next_seq, created_at, updated_at) VALUES ('dm_1','alice','DM','','hash','private','dm',1,1,1,1)").run();
  db.prepare("INSERT INTO channel_members (channel_id, user_id, role, read_seq, notify_mode, joined_at) VALUES ('dm_1','alice','owner',0,'mentions',1),('dm_1','bob','member',0,'mentions',1)").run();
  const before = (db.prepare("SELECT COUNT(*) AS n FROM outgoing_webhook_deliveries WHERE endpoint_id = ?").get(created.endpoint.id) as { n: number }).n;
  postHumanMessage("bob", "dm_1", { clientId: "d1", body: "secret dm", mentions: [], requestHash: postRequestHash({ body: "secret dm" }) }, () => null);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM outgoing_webhook_deliveries WHERE endpoint_id = ?").get(created.endpoint.id) as { n: number }).n, before);
});

test("maintenance expires old deliveries, clears bodies, and hides text after opt-out", async () => {
  const created = await createEndpoint({ subscriptions: ["archive.export.finished"] });
  await enable(created.endpoint.id, 1);
  tx(() => emitArchiveFinished({ userId: "alice", kind: "export", jobId: "arc_old", outcome: "completed", chatCount: 1, failureCode: null }));
  const row = db.prepare("SELECT id FROM outgoing_webhook_deliveries WHERE endpoint_id = ?").get(created.endpoint.id) as { id: string };
  db.prepare("UPDATE outgoing_webhook_deliveries SET created_at = ? WHERE id = ?").run(Date.now() - 25 * 60 * 60 * 1000, row.id);
  runOutgoingWebhookMaintenance();
  const stored = db.prepare("SELECT status, last_error_code, body_enc FROM outgoing_webhook_deliveries WHERE id = ?").get(row.id) as { status: string; last_error_code: string; body_enc: string | null };
  assert.equal(stored.status, "dead");
  assert.equal(stored.last_error_code, "expired");
  assert.equal(stored.body_enc, null);
  assert.equal(store.getDelivery("alice", created.endpoint.id, row.id).bodyUnavailableReason, "expired");
});

test("a rolled-back source transaction admits no delivery", async () => {
  const created = await createEndpoint({ subscriptions: ["archive.export.finished"] });
  await enable(created.endpoint.id, 1);
  assert.throws(() => tx(() => {
    emitArchiveFinished({ userId: "alice", kind: "export", jobId: "arc_rollback", outcome: "completed", chatCount: 1, failureCode: null });
    throw new Error("rollback");
  }));
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM outgoing_webhook_deliveries").get() as { n: number }).n, 0);
});

test("turning text off hides and scrubs an older stored body", async () => {
  const thread = "thr_optout";
  db.prepare("INSERT INTO threads (id, user_id, created_at, updated_at) VALUES (?, 'alice', 1, 1)").run(thread);
  const config = JSON.stringify({ version: 1, requestKind: "send", turnOrigin: "interactive", modelRef: "m", sampling: {}, instructions: "", toolPolicy: { mode: "inherit", builtins: [], mcpTools: [] }, knowledgeIds: [], assistantName: null, assistantIcon: null, assistantRevision: null, webSearch: true, deepResearch: false });
  const created = await createEndpoint({ subscriptions: ["chat.turn.completed"], includeMessageText: true });
  await enable(created.endpoint.id, 1);
  db.prepare("INSERT INTO generation_runs (id, thread_id, user_message_id, assistant_message_id, config_json, state, created_at, updated_at) VALUES ('run_optout', ?, 'm1', 'a1', ?, 'running', 1, 1)").run(thread, config);
  endRun("run_optout", { state: "finished", finishReason: "stop", durationMs: 1 }, { answerText: "private text" });
  const row = db.prepare("SELECT id FROM outgoing_webhook_deliveries WHERE endpoint_id = ?").get(created.endpoint.id) as { id: string };
  assert.ok(store.getDelivery("alice", created.endpoint.id, row.id).body);
  const response = await call(`/webhooks/${created.endpoint.id}`, { method: "PATCH", json: { revision: 2, includeMessageText: false } });
  assert.equal(response.status, 200);
  const detail = store.getDelivery("alice", created.endpoint.id, row.id);
  assert.equal(detail.body, null);
  assert.equal(detail.bodyUnavailableReason, "text_disabled");
});

test("startup interrupts open interactive receipts once and leaves legacy receipts silent", async () => {
  const thread = "thr_interrupted";
  db.prepare("INSERT INTO threads (id, user_id, created_at, updated_at) VALUES (?, 'alice', 1, 1)").run(thread);
  const interactive = JSON.stringify({ version: 1, requestKind: "send", turnOrigin: "interactive", modelRef: "m", sampling: {}, instructions: "", toolPolicy: { mode: "inherit", builtins: [], mcpTools: [] }, knowledgeIds: [], assistantName: null, assistantIcon: null, assistantRevision: null, webSearch: true, deepResearch: false });
  const legacy = JSON.stringify({ version: 1, requestKind: "send", modelRef: "m", sampling: {}, instructions: "", toolPolicy: { mode: "inherit", builtins: [], mcpTools: [] }, knowledgeIds: [], assistantName: null, assistantIcon: null, assistantRevision: null, webSearch: true, deepResearch: false });
  db.prepare("INSERT INTO generation_runs (id, thread_id, user_message_id, assistant_message_id, config_json, state, created_at, updated_at) VALUES ('run_open', ?, 'm1', 'a1', ?, 'running', 1, 1)").run(thread, interactive);
  db.prepare("INSERT INTO generation_runs (id, thread_id, user_message_id, assistant_message_id, config_json, state, created_at, updated_at) VALUES ('run_legacy', ?, 'm2', 'a2', ?, 'waiting', 1, 1)").run(thread, legacy);
  const created = await createEndpoint({ subscriptions: ["chat.turn.failed"] });
  await enable(created.endpoint.id, 1);
  interruptOpenRuns();
  interruptOpenRuns();
  const rows = db.prepare("SELECT event_type, body_enc FROM outgoing_webhook_deliveries WHERE endpoint_id = ?").all(created.endpoint.id) as Array<{ event_type: string; body_enc: string }>;
  assert.equal(rows.length, 1);
  const data = (JSON.parse(decrypt(rows[0]!.body_enc)) as { data: Record<string, unknown> }).data;
  assert.equal(data.failureCode, "interrupted");
  assert.equal("text" in data, false);
});

test("admin visibility is metadata only and can disable an endpoint with an audit reason", async () => {
  db.prepare("INSERT OR IGNORE INTO users (id,email,name,password_hash,role,created_at) VALUES ('admin','admin@example.test','Admin','unused','admin',1)").run();
  db.prepare("INSERT OR IGNORE INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)").run(sha256("admin-session"), "admin", Date.now() + 600_000);
  const created = await createEndpoint({ name: "Private name", subscriptions: ["archive.export.finished"] });
  const page = await call("/admin/webhooks?limit=50", { user: "admin" });
  assert.equal(page.status, 200);
  const body = (await page.json()) as { items: Array<Record<string, unknown>>; totals: Record<string, unknown> };
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0]!.endpointId, created.endpoint.id);
  assert.equal(body.items[0]!.ownerId, "alice");
  assert.equal("name" in body.items[0]!, false);
  assert.equal("hostname" in body.items[0]!, false);
  assert.equal("url" in body.items[0]!, false);
  assert.equal(typeof body.totals.active, "number");

  const disabled = await call(`/admin/webhooks/${created.endpoint.id}/disable`, {
    method: "POST",
    user: "admin",
    json: { revision: 1, reason: "Queue abuse during review" },
  });
  assert.equal(disabled.status, 200, await disabled.clone().text());
  assert.equal((db.prepare("SELECT enabled, revision, auto_disabled_at FROM outgoing_webhook_endpoints WHERE id = ?").get(created.endpoint.id) as { enabled: number; revision: number; auto_disabled_at: number | null }).enabled, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM permission_audit WHERE summary_json LIKE ?").get(`%${created.endpoint.id}%`) as { n: number }).n, 1);
  assert.equal((await call(`/webhooks/${created.endpoint.id}`, { method: "PATCH", user: "alice", json: { revision: 2, enabled: true } })).status, 200);
});

test("a chat that used shared knowledge never exports, even while its collections stay readable", async () => {
  const config = JSON.stringify({ version: 1, requestKind: "send", turnOrigin: "interactive", modelRef: "m", sampling: {}, instructions: "", toolPolicy: { mode: "inherit", builtins: [], mcpTools: [] }, knowledgeIds: [], assistantName: null, assistantIcon: null, assistantRevision: null, webSearch: true, deepResearch: false });
  for (const thread of ["thr_restricted", "thr_later"]) {
    db.prepare("INSERT INTO threads (id, user_id, title, created_at, updated_at) VALUES (?, 'alice', 't', 1, 1)").run(thread);
  }
  db.prepare("INSERT INTO generation_runs (id, thread_id, user_message_id, assistant_message_id, config_json, state, created_at, updated_at) VALUES ('run_r', 'thr_restricted', 'm1', 'a1', ?, 'running', 1, 1)").run(config);
  db.prepare("INSERT INTO generation_runs (id, thread_id, user_message_id, assistant_message_id, config_json, state, created_at, updated_at) VALUES ('run_l', 'thr_later', 'm2', 'a2', ?, 'running', 1, 1)").run(config);
  const created = await createEndpoint({ subscriptions: ["chat.turn.completed"], includeMessageText: true });
  await enable(created.endpoint.id, 1);

  // Bob publishes the collection to everyone, so Alice's dependency stays readable throughout.
  db.prepare("INSERT OR IGNORE INTO knowledge_collections (id, user_id, name, visibility, created_at, updated_at) VALUES ('kc_shared', 'bob', 'Team', 'shared', 1, 1)").run();
  db.prepare("INSERT INTO knowledge_thread_dependencies (thread_id, collection_id, created_at) VALUES ('thr_restricted', 'kc_shared', 1)").run();
  endRun("run_r", { state: "finished", finishReason: "stop", durationMs: 1 }, { answerText: "team secret" });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM outgoing_webhook_deliveries WHERE endpoint_id = ?").get(created.endpoint.id) as { n: number }).n, 0);

  // Admitted before the chat attached shared knowledge: the claim-time recheck cancels it unsent.
  endRun("run_l", { state: "finished", finishReason: "stop", durationMs: 1 }, { answerText: "later" });
  const row = db.prepare("SELECT id FROM outgoing_webhook_deliveries WHERE endpoint_id = ?").get(created.endpoint.id) as { id: string };
  db.prepare("INSERT INTO knowledge_thread_dependencies (thread_id, collection_id, created_at) VALUES ('thr_later', 'kc_shared', 1)").run();
  assert.equal(store.claimDelivery(row.id, Date.now()), null);
  assert.deepEqual({ ...db.prepare("SELECT status, last_error_code FROM outgoing_webhook_deliveries WHERE id = ?").get(row.id) }, { status: "cancelled", last_error_code: "source_revoked" });
});

test("a group room stops exporting once its owner leaves the room's groups", async () => {
  const room = createChannel("alice", {
    clientId: "room-g",
    name: "Group room",
    description: "",
    icon: "hash",
    visibility: "private",
    groupIds: [],
    aiJson: null,
    requestHash: "hash-room-g",
  }).value;
  const created = await createEndpoint({ subscriptions: ["channel.message.created"], channelIds: [room.id], includeMessageText: true });
  await enable(created.endpoint.id, 1);
  postHumanMessage("alice", room.id, { clientId: "g1", body: "before", mentions: [], requestHash: postRequestHash({ body: "before" }) }, () => null);
  const row = db.prepare("SELECT id FROM outgoing_webhook_deliveries WHERE endpoint_id = ?").get(created.endpoint.id) as { id: string };
  // The room becomes group-scoped with no group the owner belongs to: reads close, so does the export.
  db.prepare("UPDATE channels SET visibility = 'group' WHERE id = ?").run(room.id);
  assert.equal(store.claimDelivery(row.id, Date.now()), null);
  assert.deepEqual({ ...db.prepare("SELECT status, last_error_code FROM outgoing_webhook_deliveries WHERE id = ?").get(row.id) }, { status: "cancelled", last_error_code: "source_revoked" });
  const saved = await call(`/webhooks/${created.endpoint.id}`, { method: "PATCH", json: { revision: 2, channelIds: [room.id] } });
  assert.equal(saved.status, 400, "an ineligible room cannot be selected");
});
