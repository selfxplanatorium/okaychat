import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { Hono } from "hono";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-api-access-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "api-access-test-secret-not-for-production";

const { db } = await import("../db.js");
const { requireUser } = await import("../auth.js");
const { handleAppError } = await import("../errors.js");
const { sha256 } = await import("../crypto.js");
const { apiKeyRoutes, inferenceRoutes, resetManagementLimits } = await import("./routes.js");
const keys = await import("./keys.js");
const limits = await import("./limits.js");
const store = await import("./store.js");
const protocol = await import("./protocol.js");
const schema = await import("./schema.js");
const { resetApiAuthGate } = await import("./auth.js");
const { storageUsed } = await import("../quota.js");

const management = new Hono().use(requireUser).route("/", apiKeyRoutes).onError(handleAppError);
const inference = new Hono().route("/v1", inferenceRoutes).onError(handleAppError);

const USERS = ["alice", "bob"];
for (const id of USERS) {
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    id,
    `${id}@example.test`,
    id,
    "unused",
    "user",
    Date.now(),
  );
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(id), id, Date.now() + 60_000);
}

after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const table of ["api_requests", "api_rate_windows", "api_key_audit", "api_telemetry_floors", "api_keys", "usage"]) {
    db.exec(`DELETE FROM ${table}`);
  }
  resetApiAuthGate();
  resetManagementLimits();
  limits.setApiLimitClock(null);
  keys.setApiKeyEntropy(null);
});

const manage = (url: string, method = "GET", body?: unknown, user = "alice", headers: Record<string, string> = {}) =>
  management.request(`http://app${url}`, {
    method,
    headers: { cookie: `okaychat_session=${user}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });

const create = async (user = "alice", body: Record<string, unknown> = {}) => {
  const response = await manage("/api-keys", "POST", { label: "Script", scopes: ["models:read", "chat:write"], expiresAt: null, ...body }, user);
  return { response, body: (await response.json()) as { key: Record<string, unknown>; secret: string; error?: string } };
};

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

test("token grammar, canonical base64url, domain hash, and dummy unknown-selector path", () => {
  const token = `okc_api_v1_${Buffer.alloc(12, 1).toString("base64url")}.${Buffer.alloc(32, 2).toString("base64url")}`;
  const parsed = keys.parseApiToken(token);
  assert.ok(parsed);
  assert.equal(parsed.selector.length, 27);
  assert.equal(parsed.hash.length, 32);
  assert.notEqual(parsed.hash.toString("hex"), sha256(token));
  assert.equal(keys.parseApiToken(token.replace(/.$/, "B")), null, "non-canonical secret bits are rejected");
  assert.equal(keys.parseApiToken(token.replace(token.slice(11, 27), token.slice(11, 26))), null);
  assert.equal(keys.parseApiToken(` ${token}`), null);
  assert.equal(keys.parseApiToken(token.slice(0, -1)), null);
  assert.equal(keys.authenticateApiToken(token), null, "an unknown selector still takes the fixed dummy comparison");
});

test("a created key is returned once, stored hashed, listed without a secret, and revoked idempotently", async () => {
  const { response, body } = await create();
  assert.equal(response.status, 201);
  assert.match(body.secret, /^okc_api_v1_[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(body.key.prefix, body.secret.slice(0, 27));
  assert.equal(body.key.status, "active");
  assert.equal(keys.authenticateApiToken(body.secret)?.principal.scopes.length, 2);

  const stored = db.prepare("SELECT secret_hash, label FROM api_keys WHERE id = ?").get(body.key.id as string) as { secret_hash: Uint8Array; label: string };
  assert.equal(stored.secret_hash.length, 32);
  assert.equal(Buffer.from(stored.secret_hash).includes(Buffer.from(body.secret)), false, "no plaintext is stored");

  const listed = (await (await manage("/api-keys")).json()) as { keys: Array<Record<string, unknown>>; enabled: boolean; limits: Record<string, number> };
  assert.equal(listed.enabled, true);
  assert.equal(listed.keys.length, 1);
  assert.equal("secret" in listed.keys[0]!, false);
  assert.equal("secret_hash" in listed.keys[0]!, false);
  assert.equal(listed.limits.activeKeys, 20);

  const first = await manage(`/api-keys/${body.key.id}`, "DELETE");
  assert.equal(first.status, 200);
  const firstBody = (await first.json()) as { key: { revokedAt: number; status: string } };
  assert.equal(firstBody.key.status, "revoked");
  const second = await manage(`/api-keys/${body.key.id}`, "DELETE");
  const secondBody = (await second.json()) as { key: { revokedAt: number } };
  assert.equal(secondBody.key.revokedAt, firstBody.key.revokedAt);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM api_key_audit WHERE key_id = ? AND event = 'revoked'").get(body.key.id) as { n: number }).n, 1);
  assert.equal(keys.authenticateApiToken(body.secret), null);
});

test("owner separation: foreign key ids are the same 404, and lists never cross accounts", async () => {
  const { body } = await create("alice");
  const foreign = await manage(`/api-keys/${body.key.id}`, "DELETE", undefined, "bob");
  const unknown = await manage("/api-keys/apk_missing", "DELETE", undefined, "bob");
  assert.equal(foreign.status, 404);
  assert.equal(unknown.status, 404);
  assert.deepEqual(await foreign.json(), await unknown.json());
  const bobList = (await (await manage("/api-keys", "GET", undefined, "bob")).json()) as { keys: unknown[] };
  assert.equal(bobList.keys.length, 0);
});

test("labels, scopes, expiry, and the active/total key limits are enforced", async () => {
  assert.equal((await create("alice", { label: "" })).response.status, 400);
  assert.equal((await create("alice", { label: "x".repeat(81) })).response.status, 400);
  assert.equal((await create("alice", { label: "line\nbreak" })).response.status, 400);
  assert.equal((await create("alice", { scopes: [] })).response.status, 400);
  assert.equal((await create("alice", { scopes: ["models:read", "models:read"] })).response.status, 400);
  assert.equal((await create("alice", { scopes: ["admin:everything"] })).response.status, 400);
  assert.equal((await create("alice", { expiresAt: Date.now() - 1 })).response.status, 400);
  assert.equal((await create("alice", { expiresAt: Date.now() + 367 * 86_400_000 })).response.status, 400);

  resetManagementLimits();
  for (let index = 0; index < 20; index++) {
    assert.equal((await create("alice", { label: `Key ${index}` })).response.status, 201);
  }
  resetManagementLimits();
  assert.equal((await create("alice", { label: "Over" })).response.status, 409);

  // A revoked key frees an active slot but remains a retained tombstone.
  const first = (await (await manage("/api-keys")).json()) as { keys: Array<{ id: string }> };
  assert.equal((await manage(`/api-keys/${first.keys[0]!.id}`, "DELETE")).status, 200);
  resetManagementLimits();
  assert.equal((await create("alice", { label: "Replacement" })).response.status, 201);
});

test("authentication accepts only a live bearer token, never a cookie", async () => {
  const { body } = await create();
  const models = () => inference.request("http://app/v1/models", { headers: bearer(body.secret) });
  assert.equal((await models()).status, 200);
  assert.equal((await inference.request("http://app/v1/models")).status, 401);
  assert.equal((await inference.request("http://app/v1/models", { headers: { cookie: "okaychat_session=alice" } })).status, 401);
  assert.equal((await inference.request("http://app/v1/models", { headers: { authorization: `Bearer ${body.secret}, Bearer ${body.secret}` } })).status, 401);
  assert.equal((await inference.request("http://app/v1/models", { headers: { authorization: `Basic ${body.secret}` } })).status, 401);
  assert.equal((await inference.request("http://app/v1/models", { headers: { authorization: `Bearer  ${body.secret}` } })).status, 401);
  assert.equal((await inference.request("http://app/v1/models?api_key=x")).status, 401);
  const unauthorized = await inference.request("http://app/v1/models");
  assert.equal(unauthorized.headers.get("www-authenticate"), 'Bearer realm="okaychat"');
  assert.equal(unauthorized.headers.get("cache-control"), "no-store");
  assert.equal(unauthorized.headers.get("x-request-id")?.startsWith("areq_"), true);

  // Expiry is exclusive and computed at authentication time.
  const expiring = await create("alice", { label: "Expiring", expiresAt: Date.now() + 60_000 });
  assert.ok(keys.authenticateApiToken(expiring.body.secret, Date.now()));
  assert.equal(keys.authenticateApiToken(expiring.body.secret, Date.now() + 60_000), null);
});

test("scopes are independent, and the missing scope is a 403", async () => {
  const readOnly = await create("alice", { label: "Read", scopes: ["models:read"] });
  assert.equal((await inference.request("http://app/v1/models", { headers: bearer(readOnly.body.secret) })).status, 200);
  const denied = await inference.request("http://app/v1/chat/completions", {
    method: "POST",
    headers: { ...bearer(readOnly.body.secret), "content-type": "application/json" },
    body: JSON.stringify({ model: "openai/gpt-x", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(denied.status, 403);
  assert.equal(((await denied.json()) as { error: { code: string } }).error.code, "insufficient_scope");

  const writeOnly = await create("alice", { label: "Write", scopes: ["chat:write"] });
  assert.equal((await inference.request("http://app/v1/models", { headers: bearer(writeOnly.body.secret) })).status, 403);
});

test("the inference router returns protocol JSON for unknown paths, wrong methods, and unknown models", async () => {
  const { body } = await create();
  const notFound = await inference.request("http://app/v1/responses", { headers: bearer(body.secret) });
  assert.equal(notFound.status, 404);
  const root = await inference.request("http://app/v1", { headers: bearer(body.secret) });
  assert.equal(root.status, 404);
  assert.equal(((await root.json()) as { error: { code: string } }).error.code, "not_found");
  const query = await inference.request("http://app/v1/models?key=value", { headers: bearer(body.secret) });
  assert.equal(query.status, 400);
  assert.equal(((await query.json()) as { error: { code: string } }).error.code, "invalid_request");
  const payload = (await notFound.json()) as { error: { code: string }; request_id: string };
  assert.equal(payload.error.code, "not_found");
  assert.ok(payload.request_id.startsWith("areq_"));
  assert.equal(notFound.headers.get("content-type")?.includes("application/json"), true);

  const wrongMethod = await inference.request("http://app/v1/models", { method: "POST", headers: bearer(body.secret) });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "GET");

  const unknown = await inference.request("http://app/v1/chat/completions", {
    method: "POST",
    headers: { ...bearer(body.secret), "content-type": "application/json" },
    body: JSON.stringify({ model: "nobody/model", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(unknown.status, 404);
  assert.equal(((await unknown.json()) as { error: { code: string } }).error.code, "model_not_found");

  const options = await inference.request("http://app/v1/chat/completions", { method: "OPTIONS", headers: bearer(body.secret) });
  assert.equal(options.status, 405);
  assert.equal(options.headers.get("allow"), "POST");
  assert.equal(options.headers.get("access-control-allow-origin"), null);
  const head = await inference.request("http://app/v1/models", { method: "HEAD" });
  assert.equal(head.status, 405);
  assert.equal(head.headers.get("allow"), "GET");
});

test("request bodies are bounded, UTF-8 decoded fatally, and strictly validated", async () => {
  const { body } = await create();
  const post = (payload: string, headers: Record<string, string> = {}) =>
    inference.request("http://app/v1/chat/completions", {
      method: "POST",
      headers: { ...bearer(body.secret), "content-type": "application/json", ...headers },
      body: payload,
    });

  assert.equal((await post("{}", { "content-type": "text/plain" })).status, 415);
  assert.equal((await post("{}", { "content-encoding": "gzip" })).status, 415);
  assert.equal((await post("not json")).status, 400);
  assert.equal((await post('{"model":"a/b","messages":[{"role":"user","content":"hi"}],"model":"c/d"}')).status, 400);
  assert.equal((await post('{"model":"a/b","messages":[{"role":"user","content":"hi"}],"tools":[]}')).status, 400);
  assert.equal((await post('{"model":"a/b","messages":[{"role":"tool","content":"hi"}]}')).status, 400);
  assert.equal((await post('{"model":"a/b","messages":[{"role":"user","content":["hi"]}]}')).status, 400);
  assert.equal((await post('{"model":"a/b","messages":[{"role":"assistant","content":"hi"}]}')).status, 400);
  assert.equal((await post('{"model":"a/b","messages":[{"role":"user","content":"hi"}],"n":2}')).status, 400);
  assert.equal((await post('{"model":"a/b","messages":[{"role":"user","content":"hi"}],"stream_options":{"include_usage":true}}')).status, 400);
  assert.equal((await post('{"model":"a/b","messages":[{"role":"user","content":"hi"}],"max_tokens":1,"max_completion_tokens":1}')).status, 400);
  assert.equal((await post('{"model":"a/b","messages":[{"role":"system","content":"s"},{"role":"user","content":"hi"},{"role":"system","content":"late"}]}')).status, 400);
  assert.equal((await post('{"model":"a/b","messages":[{"role":"user","content":"   "}]}')).status, 400);
  assert.equal((await post(JSON.stringify({ model: "a/b", messages: [{ role: "user", content: "x".repeat(300_000) }] }))).status, 400);

  const oversized = JSON.stringify({ model: "a/b", messages: [{ role: "user", content: "x" }], pad: "y".repeat(1_100_000) });
  assert.equal((await post(oversized)).status, 413);

  // Raw invalid UTF-8 is rejected, not replaced.
  const invalid = new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]);
  const response = await inference.request("http://app/v1/chat/completions", {
    method: "POST",
    headers: { ...bearer(body.secret), "content-type": "application/json" },
    body: invalid,
  });
  assert.equal(response.status, 400);
});

test("durable minute windows charge both buckets or neither", async () => {
  const created = await create();
  const keyId = created.body.key.id as string;
  const start = 1_800_000_000_000;
  for (let index = 0; index < 60; index++) limits.chargeApiRate("alice", keyId, start);
  assert.throws(() => limits.chargeApiRate("alice", keyId, start), (error: unknown) => error instanceof limits.ApiRateLimited);
  // The next minute starts a fresh window.
  limits.chargeApiRate("alice", keyId, start + 60_000);
  const rows = db.prepare("SELECT key_id, used FROM api_rate_windows WHERE user_id = 'alice' AND window_start = ? ORDER BY key_id").all(start) as Array<{ key_id: string; used: number }>;
  assert.deepEqual(rows.map((row) => ({ key_id: row.key_id, used: row.used })), [{ key_id: "", used: 60 }, { key_id: keyId, used: 60 }]);
});

test("concurrency slots cap per key, per account, and release exactly once", () => {
  const admissionA = limits.admitApiCall("alice", "key-a");
  const admissionB = limits.admitApiCall("alice", "key-a");
  assert.throws(() => limits.admitApiCall("alice", "key-a"), (error: unknown) => error instanceof limits.ApiConcurrentLimit);
  const admissionC = limits.admitApiCall("alice", "key-b");
  const admissionD = limits.admitApiCall("alice", "key-c");
  assert.throws(() => limits.admitApiCall("alice", "key-d"), (error: unknown) => error instanceof limits.ApiConcurrentLimit);
  admissionA.release();
  admissionA.release();
  admissionB.release();
  admissionC.release();
  admissionD.release();
  assert.equal(limits.liveApiCallCount(), 0);
  const again = limits.admitApiCall("alice", "key-d");
  again.release();
});

test("settlement dedupes the receipt and the ledger row, and unknown usage stays unknown", () => {
  const now = 1_800_000_000_000;
  store.openApiRequest({ id: "apr_one", userId: "alice", keyId: "key-a", modelRef: "openai/gpt-a", stream: false, now });
  store.markApiDispatched("apr_one", "alice", now + 1);
  const usage = { input: 10, output: 4, reasoning: 2, cacheRead: 3, cacheWrite: 0 };
  assert.equal(
    store.settleApiRequest({
      id: "apr_one",
      userId: "alice",
      keyId: "key-a",
      providerId: "openai",
      modelId: "gpt-a",
      settlement: { state: "succeeded", httpStatus: 200, errorCode: null, finishReason: "stop", usage, cost: 0.5, now: now + 2 },
    }),
    true,
  );
  assert.equal(
    store.settleApiRequest({
      id: "apr_one",
      userId: "alice",
      keyId: "key-a",
      providerId: "openai",
      modelId: "gpt-a",
      settlement: { state: "failed", httpStatus: 500, errorCode: "server_error", finishReason: null, usage: null, now: now + 3 },
    }),
    false,
  );
  const page = store.apiRequestsPage("alice", { limit: 50 });
  assert.equal(page.rows.length, 1);
  assert.equal(page.rows[0]!.state, "succeeded");
  assert.deepEqual(page.rows[0]!.usage, usage);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM usage WHERE api_request_id = 'apr_one'").get() as { n: number }).n, 1);

  store.openApiRequest({ id: "apr_two", userId: "alice", keyId: "key-a", modelRef: "openai/gpt-a", stream: true, now: now + 10 });
  store.settleApiRequest({
    id: "apr_two",
    userId: "alice",
    keyId: "key-a",
    providerId: "openai",
    modelId: "gpt-a",
    settlement: { state: "failed", httpStatus: 502, errorCode: "incomplete_response", finishReason: null, usage: null, now: now + 11 },
  });
  const second = store.apiRequestsPage("alice", { limit: 50 }).rows.find((row) => row.id === "apr_two")!;
  assert.equal(second.usageState, "unknown");
  assert.equal(second.usage, null);
  assert.equal(second.cost, null);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM usage WHERE api_request_id = 'apr_two'").get() as { n: number }).n, 0);
});

test("usage aggregates UTC days, models, and keys, and preserves totals past the group cap", () => {
  const now = Date.now() + 1_000;
  const day = new Date(Date.now()).toISOString().slice(0, 10);
  for (let index = 0; index < 3; index++) {
    store.openApiRequest({ id: `apr_u${index}`, userId: "alice", keyId: index === 2 ? "key-b" : "key-a", modelRef: index === 0 ? "openai/gpt-a" : "openai/gpt-b", stream: false, now: now - 1_000 });
    store.settleApiRequest({
      id: `apr_u${index}`,
      userId: "alice",
      keyId: index === 2 ? "key-b" : "key-a",
      providerId: "openai",
      modelId: index === 0 ? "gpt-a" : "gpt-b",
      settlement: { state: "succeeded", httpStatus: 200, errorCode: null, finishReason: "stop", usage: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0.1, now: now - 500 },
    });
  }
  const byModel = store.apiUsage("alice", { days: 7, groupBy: "model", now });
  assert.equal(byModel.rows.length, 2);
  assert.equal(byModel.totals.meteredRequests, 3);
  assert.equal(byModel.totals.usage.input, 30);
  assert.equal(byModel.groupBy, "model");
  const byKey = store.apiUsage("alice", { days: 7, groupBy: "key", now });
  assert.deepEqual(byKey.rows.map((row) => row.key).sort(), ["key-a", "key-b"]);
  const byDay = store.apiUsage("alice", { days: 7, groupBy: "day", now });
  assert.deepEqual(byDay.rows.map((row) => row.key), [day]);
  assert.equal(byDay.telemetryTruncated, false);
  assert.equal(byDay.requests.succeeded, 3);
  assert.equal(byDay.requests.unknownUsage, 0);
});

test("request pagination uses a validated keyset cursor and never skips equal timestamps", () => {
  const now = 1_800_000_000_000;
  for (let index = 0; index < 5; index++) {
    store.openApiRequest({ id: `apr_page${index}`, userId: "alice", keyId: "key-a", modelRef: "openai/gpt-a", stream: false, now });
  }
  const first = store.apiRequestsPage("alice", { limit: 2 });
  assert.equal(first.rows.length, 2);
  const second = store.apiRequestsPage("alice", { limit: 2, before: first.nextCursor! });
  const ids = [...first.rows, ...second.rows].map((row) => row.id);
  assert.equal(new Set(ids).size, 4);
  assert.equal(store.decodeRequestCursor("not-a-cursor"), null);
  assert.equal(store.decodeRequestCursor(Buffer.from(JSON.stringify([1, 2])).toString("base64url")), null);
});

test("audit rows paginate and keep one revoked event", async () => {
  const { body } = await create();
  await manage(`/api-keys/${body.key.id}`, "DELETE");
  await manage(`/api-keys/${body.key.id}`, "DELETE");
  const page = store.apiAuditPage("alice", { limit: 50 });
  assert.deepEqual(page.rows.map((row) => row.event), ["revoked", "created"]);
  const first = store.apiAuditPage("alice", { limit: 1 });
  assert.equal(first.rows.length, 1);
  assert.equal(typeof first.nextCursor, "number");
  assert.equal(store.apiAuditPage("alice", { limit: 1, before: first.nextCursor! }).rows.length, 1);
});

test("startup interruption marks open receipts and never re-dispatches them", () => {
  store.openApiRequest({ id: "apr_open", userId: "alice", keyId: "key-a", modelRef: "openai/gpt-a", stream: false });
  assert.equal(store.interruptOpenApiRequests(), 1);
  const row = store.apiRequestsPage("alice", { limit: 10 }).rows[0]!;
  assert.equal(row.state, "interrupted");
  assert.equal(row.errorCode, "interrupted");
  assert.equal(store.settleApiRequest({
    id: "apr_open",
    userId: "alice",
    keyId: "key-a",
    providerId: "openai",
    modelId: "gpt-a",
    settlement: { state: "succeeded", httpStatus: 200, errorCode: null, finishReason: "stop", usage: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 } },
  }), false);
});

test("recovery revokes every key and the account cascades its API rows", () => {
  return (async () => {
    const first = await create("alice");
    const second = await create("alice", { label: "Second" });
    assert.equal(keys.revokeAllApiKeys("alice", "password_revoked"), 2);
    assert.equal(keys.authenticateApiToken(first.body.secret), null);
    assert.equal(keys.authenticateApiToken(second.body.secret), null);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM api_key_audit WHERE event = 'password_revoked'").get() as { n: number }).n, 2);
    store.openApiRequest({ id: "apr_cascade", userId: "alice", keyId: first.body.key.id as string, modelRef: "openai/gpt-a", stream: false });
    db.prepare("DELETE FROM users WHERE id = 'alice'").run();
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM api_requests").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM api_keys").get() as { n: number }).n, 0);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('alice', 'alice@example.test', 'alice', 'unused', 'user', ?)").run(Date.now());
    db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256("alice"), "alice", Date.now() + 60_000);
  })();
});

test("the apiAccess feature gates creation and inference but not listing or revoke", async () => {
  const created = await create();
  assert.equal(created.response.status, 201);
  db.prepare(
    "INSERT INTO permission_policies (subject_kind, subject_id, model_ref, document, updated_at, updated_by) VALUES ('user', 'alice', '', ?, ?, NULL)",
  ).run(JSON.stringify({ version: 1, features: { apiAccess: false } }), Date.now());
  try {
    resetManagementLimits();
    assert.equal((await create("alice", { label: "Blocked" })).response.status, 403);
    const listed = (await (await manage("/api-keys")).json()) as { enabled: boolean; keys: unknown[] };
    assert.equal(listed.enabled, false);
    assert.equal(listed.keys.length, 1);
    const models = await inference.request("http://app/v1/models", { headers: bearer(created.body.secret) });
    assert.equal(models.status, 403);
    assert.equal(((await models.json()) as { error: { code: string } }).error.code, "permission_denied");
    assert.equal((await manage(`/api-keys/${created.body.key.id}`, "DELETE")).status, 200);
  } finally {
    db.prepare("DELETE FROM permission_policies WHERE subject_kind = 'user' AND subject_id = 'alice' AND model_ref = ''").run();
  }
});

test("key metadata reserves exactly 1 KiB and revocation keeps the reservation until purge", async () => {
  const before = storageUsed("alice");
  const created = await create();
  assert.equal(created.response.status, 201);
  assert.equal(storageUsed("alice"), before + 1024);
  await manage(`/api-keys/${created.body.key.id}`, "DELETE");
  assert.equal(storageUsed("alice"), before + 1024, "a revoked tombstone still counts");
  db.prepare("DELETE FROM api_keys WHERE id = ?").run(created.body.key.id);
  assert.equal(storageUsed("alice"), before);
});

test("protocol mapping, finish reasons, usage shape, and UTF-8 splitting", async () => {
  assert.equal(protocol.mapFinishReason("stop"), "stop");
  assert.equal(protocol.mapFinishReason("length"), "length");
  assert.equal(protocol.mapFinishReason("content-filter"), "content_filter");
  assert.throws(() => protocol.mapFinishReason("tool-calls"), (error: unknown) => error instanceof protocol.ApiProtocolFailure && error.code === "unsupported_output");
  assert.throws(() => protocol.mapFinishReason(undefined), (error: unknown) => error instanceof protocol.ApiProtocolFailure && error.code === "incomplete_response");
  assert.deepEqual(protocol.completionUsage({ input: 12, output: 3, reasoning: 1, cacheRead: 2, cacheWrite: 0 }), {
    prompt_tokens: 12,
    completion_tokens: 3,
    total_tokens: 15,
    prompt_tokens_details: { cached_tokens: 2 },
    completion_tokens_details: { reasoning_tokens: 1 },
  });
  assert.equal(protocol.completionId("apr_abcdef"), "chatcmpl-abcdef");

  const { splitUtf8 } = await import("./generate.js");
  const text = "a".repeat(5) + "😀".repeat(5_000) + "b";
  const pieces = splitUtf8(text, 8_192);
  assert.ok(pieces.every((piece) => Buffer.byteLength(piece, "utf8") <= 8_192));
  assert.equal(pieces.join(""), text);

  assert.equal(schema.validApiModel("openai/gpt-4.1"), "openai/gpt-4.1");
  assert.equal(schema.validApiModel("openai"), null);
  assert.equal(schema.validApiModel("/gpt"), null);
  assert.equal(schema.validApiModel("openai/gpt 4"), null);
  assert.equal(schema.acceptsJson("application/json; charset=utf-8"), true);
  assert.equal(schema.acceptsJson("application/json; charset=latin1"), false);
});
