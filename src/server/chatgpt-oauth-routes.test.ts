import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { Hono } from "hono";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
const dir = mkdtempSync(path.join(tmpdir(), "okaychat-siwc-routes-"));
process.env.OKAYCHAT_DATA_DIR = dir;
process.env.OKAYCHAT_SECRET = "test-routes-secret-with-at-least-32-characters";
process.env.OKAYCHAT_PUBLIC_URL = "https://okaychat.example:8443";
process.env.OKAYCHAT_CHATGPT_OAUTH_ENABLED = "true";
const { db } = await import("./db.js");
const { sha256 } = await import("./crypto.js");
const { chatgptRoutes, chatgptHelperRoutes, canonicalOrigin } = await import("./chatgpt-oauth-routes.js");
const { oauthDeps, ISSUER, AUTHORIZE_URL, TOKEN_URL, JWKS_URL, REVOKE_URL } = await import("./chatgpt-oauth.js");
const app = new Hono().route("/api/chatgpt/helper", chatgptHelperRoutes).route("/api/chatgpt", chatgptRoutes);
const origin = "https://okaychat.example:8443";
for (const id of ["a", "b"]) {
  db.prepare("INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES (?,?,?,'x','user',0)").run(id, `${id}@example.test`, id);
  db.prepare("INSERT INTO sessions VALUES (?,?,?)").run(sha256(`session-${id}`), id, Date.now() + 600_000);
}
const realFetch = oauthDeps.fetch;
after(() => { oauthDeps.fetch = realFetch; db.close(); rmSync(dir, { recursive: true, force: true }); });
async function request(url: string, method = "GET", body?: unknown, user = "a", csrf?: string, customOrigin = origin) {
  return app.request(url, { method, headers: { Cookie: `okaychat_session=session-${user}`, Origin: customOrigin, "Content-Type": "application/json", ...(csrf ? { "X-CSRF-Token": csrf } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
async function helper(action: string, capability: string, body: unknown, headers: Record<string,string> = {}) {
  return app.request(`/api/chatgpt/helper/${action}`, { method: "POST", headers: { Authorization: `Bearer ${capability}`, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}
test("canonical deployment rejects forged origins, credentials, paths and fragments", () => {
  assert.equal(canonicalOrigin(origin), origin);
  for (const bad of ["http://a.test", "https://a.test/path", "https://u:p@a.test", "https://a.test/#fragment", "https://a.test/?query"]) assert.equal(canonicalOrigin(bad), null);
});
test("owned session-bound single-use handoff; forged state does not consume and concurrent callback exchanges once", async () => {
  const status = await request("/api/chatgpt/status");
  assert.equal(status.headers.get("cache-control"), "no-store");
  assert.equal(status.headers.get("referrer-policy"), "no-referrer");
  const csrf = (await status.json()).csrfToken as string;
  assert.equal((await request("/api/chatgpt/login", "POST", { intent: "connect" })).status, 403);
  assert.equal((await request("/api/chatgpt/login", "POST", { intent: "connect" }, "a", csrf, "https://evil.test")).status, 403);
  const start = await request("/api/chatgpt/login", "POST", { intent: "connect" }, "a", csrf);
  assert.equal(start.status, 201);
  const login = await start.json();
  assert.equal((await request(`/api/chatgpt/login/${login.attemptId}`, "GET", undefined, "b")).status, 404);
  const launch = await request(login.launchDownloadUrl);
  const data = await launch.json();
  assert.equal((await request(login.launchDownloadUrl)).status, 409);
  const pair = await generateKeyPair("RS256");
  const key = { ...await exportJWK(pair.publicKey), kid: "route-key", alg: "RS256" };
  let nonce = "", exchanges = 0;
  oauthDeps.fetch = async (url) => {
    if (url.includes("openid-configuration")) return Response.json({ issuer: ISSUER, authorization_endpoint: AUTHORIZE_URL, token_endpoint: TOKEN_URL, jwks_uri: JWKS_URL, revocation_endpoint: REVOKE_URL });
    if (url === JWKS_URL) return Response.json({ keys: [key] });
    if (url === TOKEN_URL) { exchanges++; return Response.json({ access_token: "SECRET-ACCESS", refresh_token: "SECRET-REFRESH", token_type: "Bearer", expires_in: 3600, scope: "resource.invoke chatgpt.tokens.use.direct", id_token: await new SignJWT({ nonce }).setProtectedHeader({ alg: "RS256", kid: "route-key" }).setIssuer(ISSUER).setSubject("subject").setAudience("issued-client").setExpirationTime("5m").sign(pair.privateKey) }); }
    return new Response(null, { status: 200 });
  };
  const input = { attemptId: login.attemptId, helperSecret: "h".repeat(43), port: 43123 };
  assert.equal((await helper("prepare", data.helperCapability, input, { Origin: origin })).status, 403);
  const prepared = await helper("prepare", data.helperCapability, input);
  assert.equal(prepared.status, 200);
  const authorization = new URL((await prepared.json()).authorizationUrl);
  nonce = authorization.searchParams.get("nonce")!;
  assert.equal((await helper("prepare", data.helperCapability, input)).status, 409);
  const callback = `http://127.0.0.1:43123/auth/callback?code=SECRET-CODE&client_id=issued-client&state=`;
  const completion = { attemptId: login.attemptId, helperSecret: input.helperSecret, callbackUrl: callback + "wrong" };
  assert.equal((await helper("complete", data.helperCapability, completion)).status, 400);
  assert.equal(exchanges, 0);
  completion.callbackUrl = callback + authorization.searchParams.get("state");
  const responses = await Promise.all([helper("complete", data.helperCapability, completion), helper("complete", data.helperCapability, completion)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200,409]); assert.equal(exchanges, 1);
  const output = JSON.stringify(await (await request("/api/chatgpt/status")).json());
  for (const secret of ["SECRET-ACCESS", "SECRET-REFRESH", "SECRET-CODE", nonce, data.helperCapability]) assert.ok(!output.includes(secret));
  assert.equal((await app.request("/api/chatgpt/status")).status, 401);
});
