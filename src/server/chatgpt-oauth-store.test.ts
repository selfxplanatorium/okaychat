import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
const dir = mkdtempSync(path.join(tmpdir(), "okaychat-siwc-store-"));
process.env.OKAYCHAT_DATA_DIR = dir;
process.env.OKAYCHAT_SECRET = "test-siwc-secret-with-at-least-32-characters";
const { db } = await import("./db.js");
const store = await import("./chatgpt-oauth-store.js");
const { oauthDeps, resetOAuthCaches } = await import("./chatgpt-oauth.js");
const originalFetch = oauthDeps.fetch;
for (const id of ["a", "b"]) db.prepare("INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES (?,?,?,'x','user',0)").run(id, `${id}@example.test`, id);
after(() => { oauthDeps.fetch = originalFetch; db.close(); rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => { db.exec("DELETE FROM chatgpt_registrations; DELETE FROM provider_connections"); resetOAuthCaches(); });
function connect(user = "a", id = "reg", expires = Date.now() + 600_000) {
  const tokens = { accessToken: "opaque", refreshToken: "refresh-one", tokenType: "Bearer", scopes: ["resource.invoke", "chatgpt.tokens.use.direct"], receivedAt: Date.now(), expiresIn: 600, accessExpiresAt: expires };
  db.prepare("INSERT INTO chatgpt_registrations(id,user_id,client_id,identity_enc,credentials_enc,state,active,access_expires_at,connected_at,updated_at) VALUES (?,?,?,?,?,'ready',1,?,0,0)").run(id, user, `client-${id}`, store.seal(user, id, { issuer: "https://auth.openai.com", subject: "subject" }), store.seal(user, id, tokens), expires);
}
test("host identity is stable and private per user; ciphertext cannot cross row bindings", () => {
  assert.equal(store.hostId("a"), store.hostId("a"));
  assert.notEqual(store.hostId("a"), store.hostId("b"));
  const encrypted = store.seal("a", "reg", { secret: "sentinel" });
  assert.ok(!encrypted.includes("sentinel"));
  assert.throws(() => store.unseal("b", "reg", encrypted));
  assert.throws(() => store.unseal("a", "other", encrypted));
});
test("legacy image auth alone never authorizes chat; personal switch is enforced", () => {
  assert.equal(store.chatgptConnected("a"), false);
  connect(); assert.equal(store.chatgptConnected("a"), true);
  db.prepare("INSERT INTO provider_connections(user_id,provider_id,enabled,created_at) VALUES ('a','chatgpt',0,0)").run();
  assert.equal(store.chatgptConnected("a"), false);
});
test("activation invalidates old model handles and does not change another user", async () => {
  connect(); connect("b", "other");
  const pin = store.chatgptPin("a");
  store.activate("a", "reg");
  await assert.rejects(store.chatgptAccess("a", { pin }));
  assert.equal((await store.chatgptAccess("b", { pin: store.chatgptPin("b") })).token, "opaque");
});
test("20 expired callers share one rotating refresh and version; refresh does not change generation", async () => {
  connect("a", "reg", 0);
  let count = 0;
  oauthDeps.fetch = async (_url, init) => {
    count++; assert.equal(new URLSearchParams(String(init.body)).get("refresh_token"), "refresh-one");
    await new Promise(resolve => setTimeout(resolve, 10));
    return Response.json({ access_token: "replacement", refresh_token: "refresh-two", token_type: "Bearer", scope: "resource.invoke chatgpt.tokens.use.direct", expires_in: 3600 });
  };
  const pin = store.chatgptPin("a");
  const results = await Promise.all(Array.from({ length: 20 }, () => store.chatgptAccess("a", { pin })));
  assert.equal(count, 1); assert.ok(results.every(result => result.token === "replacement" && result.version === 1));
  assert.deepEqual(store.chatgptPin("a"), pin);
  await store.chatgptAccess("a", { pin, rejectedVersion: 0 }); assert.equal(count, 1);
});
test("a 429 refresh is temporary and does not force a reconnect", async () => {
  connect("a", "reg", 0);
  let count = 0;
  oauthDeps.fetch = async () => { count++; return Response.json({ error: "rate_limited" }, { status: 429 }); };
  const pin = store.chatgptPin("a");
  await assert.rejects(store.chatgptAccess("a", { pin }));
  const row = db.prepare("SELECT state, refresh_state, token_version FROM chatgpt_registrations WHERE id='reg'").get() as { state: string; refresh_state: string; token_version: number };
  assert.deepEqual({ ...row }, { state: "ready", refresh_state: "idle", token_version: 0 });
  await assert.rejects(store.chatgptAccess("a", { pin }));
  assert.equal(count, 2, "the next request can try the same rotating token again");
});

test("ambiguous refresh is durable and cannot resend rotating credentials", async () => {
  connect("a", "reg", 0); let count = 0;
  oauthDeps.fetch = async () => { count++; throw new Error("network sentinel"); };
  const pin = store.chatgptPin("a");
  await assert.rejects(store.chatgptAccess("a", { pin }));
  await assert.rejects(store.chatgptAccess("a", { pin }));
  assert.equal(count, 1); assert.equal(store.ownRegistration("a", "reg")?.refresh_state, "uncertain");
});
test("an aborted waiter does not cancel a shared refresh or receive credentials", async () => {
  connect("a", "reg", 0);
  let release!: () => void;
  oauthDeps.fetch = async () => { await new Promise<void>(resolve => { release = resolve; }); return Response.json({ access_token: "new", refresh_token: "rotated", token_type: "Bearer", scope: "resource.invoke chatgpt.tokens.use.direct", expires_in: 3600 }); };
  const pin = store.chatgptPin("a"), controller = new AbortController();
  const cancelled = store.chatgptAccess("a", { pin, signal: controller.signal });
  const other = store.chatgptAccess("a", { pin });
  controller.abort(); await assert.rejects(cancelled); release();
  assert.equal((await other).token, "new");
});
