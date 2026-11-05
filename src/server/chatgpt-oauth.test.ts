import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, before, describe, it } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
process.env.OKAYCHAT_SECRET = "test-protocol-secret-with-at-least-32-characters";
const {
  AGENT_NAME, AUTHORIZE_URL, BOOTSTRAP_CLIENT_ID, INFERENCE_SCOPES, ISSUER, JWKS_URL, RESOURCE,
  REVOKE_URL, SCOPES, TOKEN_URL, OAuthError, authorizationUrl, exchangeCode, hasInferenceScopes,
  loopbackRedirect, newPkceSet, oauthDeps, parseCallback, parseTokenResponse, refreshTokens,
  resetOAuthCaches, revokeRefreshToken, verifyIdToken,
} = await import("./chatgpt-oauth.js");

const now = 1_800_000_000_000;
let publicJwk: Record<string, unknown>;
let privateKey: CryptoKey;

before(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "fixture-key", use: "sig", alg: "RS256" };
});

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  oauthDeps.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return calls;
}

function json(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) } });
}

function discovery() {
  return { issuer: ISSUER, authorization_endpoint: AUTHORIZE_URL, token_endpoint: TOKEN_URL, jwks_uri: JWKS_URL, revocation_endpoint: REVOKE_URL, id_token_signing_alg_values_supported: ["RS256"] };
}

afterEach(() => {
  oauthDeps.fetch = (input, init) => globalThis.fetch(input, init);
  oauthDeps.now = () => Date.now();
  oauthDeps.random = (size) => Buffer.from(Array.from({ length: size }, (_, i) => i));
  resetOAuthCaches();
});

describe("ChatGPT OAuth protocol", () => {
  it("builds new and reconnect authorization URLs with exact fields and PKCE", () => {
    oauthDeps.random = (size) => Buffer.alloc(size, 7);
    const pkce = newPkceSet();
    assert.equal(pkce.verifier.length, 86);
    assert.equal(pkce.challenge, (awaitableSha256(pkce.verifier)));
    assert.equal(pkce.state.length, 43);
    assert.equal(pkce.nonce.length, 43);
    const redirectUri = loopbackRedirect(43123);
    assert.equal(redirectUri, "http://127.0.0.1:43123/auth/callback");
    const fresh = new URL(authorizationUrl({ hostId: "urn:uuid:host", redirectUri, pkce }));
    assert.equal(fresh.origin + fresh.pathname, AUTHORIZE_URL);
    assert.deepEqual(Object.fromEntries(fresh.searchParams), {
      client_id: BOOTSTRAP_CLIENT_ID, agent_name_hint: AGENT_NAME, ext_agent_host_id: "urn:uuid:host",
      response_type: "code", redirect_uri: redirectUri, scope: SCOPES.join(" "), resource: RESOURCE,
      state: pkce.state, nonce: pkce.nonce, code_challenge: pkce.challenge, code_challenge_method: "S256",
    });
    const reconnect = new URL(authorizationUrl({ clientId: "issued-client", hostId: "urn:uuid:host", redirectUri, pkce, consent: true }));
    assert.equal(reconnect.searchParams.get("client_id"), "issued-client");
    assert.equal(reconnect.searchParams.has("agent_name_hint"), false);
    assert.equal(reconnect.searchParams.get("prompt"), "consent");
    assert.equal(reconnect.searchParams.get("redirect_uri"), redirectUri);
  });

  it("accepts valid callbacks, ignores wrong state without consuming it, and rejects duplicate or malformed parameters", () => {
    const expected = { redirectUri: loopbackRedirect(4444), state: "s", clientId: "client" };
    const url = `${expected.redirectUri}?code=opaque&state=s&scope=untrusted`;
    assert.deepEqual(parseCallback(url, expected), { kind: "code", code: "opaque", clientId: "client" });
    assert.deepEqual(parseCallback(`${expected.redirectUri}?code=opaque&state=wrong`, expected), { kind: "state_mismatch" });
    assert.deepEqual(parseCallback(url, expected), { kind: "code", code: "opaque", clientId: "client" });
    for (const bad of [
      `${expected.redirectUri}?code=a&code=b&state=s`,
      `${expected.redirectUri}?code=a&state=s&state=s`,
      `${expected.redirectUri}?code=a&state=s&error=access_denied`,
      `${expected.redirectUri}?code=%ZZ&state=s`,
      `${expected.redirectUri}?code=a&state=s#fragment`,
      `${expected.redirectUri}?code=a&state=s&client_id=other`,
    ]) assert.throws(() => parseCallback(bad, expected), OAuthError);
    assert.deepEqual(parseCallback(`${expected.redirectUri}?error=access_denied&state=s`, expected), { kind: "denied", error: "access_denied" });
    assert.throws(() => parseCallback(`${expected.redirectUri}?code=x&state=s`, { redirectUri: expected.redirectUri, state: "s" }), OAuthError);
  });

  it("validates signed identity claims, nonce, subject, audience, azp and JWKS", async () => {
    oauthDeps.now = () => now;
    const calls = mockFetch((url) => url === JWKS_URL ? json({ keys: [publicJwk] }, 200, { "cache-control": "max-age=600" }) : json({}));
    const token = (claims: Record<string, unknown>, alg = "RS256") => new SignJWT(claims).setProtectedHeader({ alg, kid: "fixture-key" }).sign(privateKey);
    const base = { iss: ISSUER, aud: "client", sub: "subject-1", nonce: "nonce", exp: now / 1000 + 300, iat: now / 1000, email: " person@example.test ", name: "User\nName" };
    const good = await token(base);
    assert.deepEqual(await verifyIdToken(good, { clientId: "client", nonce: "nonce", subject: "subject-1" }), { issuer: ISSUER, subject: "subject-1", email: "person@example.test", name: "UserName" });
    assert.equal(calls.length, 1);
    for (const [claims, expected] of [
      [{ ...base, nonce: "wrong" }, { clientId: "client", nonce: "nonce" }],
      [{ ...base, sub: "wrong" }, { clientId: "client", subject: "subject-1" }],
      [{ ...base, aud: "other" }, { clientId: "client" }],
      [{ ...base, azp: "other" }, { clientId: "client" }],
      [{ ...base, aud: ["client", "other"] }, { clientId: "client" }],
      [{ ...base, exp: now / 1000 - 120 }, { clientId: "client" }],
      [{ ...base, nbf: now / 1000 + 120 }, { clientId: "client" }],
      [{ ...base, sub: "" }, { clientId: "client" }],
    ] as const) await assert.rejects(verifyIdToken(await token(claims), expected), OAuthError);
    const multi = await token({ ...base, aud: ["client", "other"], azp: "client" });
    assert.equal((await verifyIdToken(multi, { clientId: "client", nonce: "nonce" })).subject, "subject-1");
    const unsigned = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify(base)).toString("base64url")}.`;
    await assert.rejects(verifyIdToken(unsigned, { clientId: "client" }), OAuthError);
  });

  it("treats access tokens as opaque and derives expiry and scopes from the response", () => {
    oauthDeps.now = () => now;
    const parsed = parseTokenResponse({ access_token: "opaque.not-a-jwt", refresh_token: "refresh", id_token: "id", token_type: "bearer", expires_in: 900, scope: "openid  resource.invoke chatgpt.tokens.use.direct", earliest_refresh_at: 123, ignored: true }, true);
    assert.equal(parsed.accessToken, "opaque.not-a-jwt");
    assert.equal(parsed.receivedAt, now);
    assert.equal(parsed.accessExpiresAt, now + 840_000);
    assert.equal(parsed.earliestRefreshAtRaw, 123);
    assert.deepEqual(parsed.scopes, ["openid", "resource.invoke", "chatgpt.tokens.use.direct"]);
    assert.equal(hasInferenceScopes(parsed.scopes), true);
    assert.equal(hasInferenceScopes(["openid"]), false);
    assert.throws(() => parseTokenResponse({ access_token: "x", token_type: "Bearer", expires_in: 1, scope: "" }, true), OAuthError);
  });

  it("posts exact fixed forms for code exchange, refresh and revocation", async () => {
    oauthDeps.now = () => now;
    const calls = mockFetch((url) => url === TOKEN_URL ? json({ access_token: "opaque", refresh_token: "rotated", id_token: "signed.jwt", token_type: "Bearer", expires_in: 3600, scope: "openid resource.invoke chatgpt.tokens.use.direct" }) : url.includes("openid-configuration") ? json(discovery()) : new Response(null, { status: 200 }));
    const redirectUri = loopbackRedirect(4567);
    await exchangeCode({ clientId: "client", code: "code value", verifier: "verifier", redirectUri });
    await refreshTokens({ clientId: "client", refreshToken: "refresh value" });
    assert.equal(await revokeRefreshToken({ clientId: "client", refreshToken: "refresh value" }), "confirmed");
    const [exchange, refresh, revoke] = calls.filter((call) => call.init.method === "POST");
    assert.equal(exchange.url, TOKEN_URL);
    assert.equal(exchange.init.redirect, "error");
    assert.equal(new Headers(exchange.init.headers).get("content-type"), "application/x-www-form-urlencoded");
    assert.deepEqual(Object.fromEntries(new URLSearchParams(String(exchange.init.body))), { grant_type: "authorization_code", client_id: "client", code: "code value", code_verifier: "verifier", redirect_uri: redirectUri, resource: RESOURCE });
    assert.deepEqual(Object.fromEntries(new URLSearchParams(String(refresh.init.body))), { grant_type: "refresh_token", client_id: "client", refresh_token: "refresh value", resource: RESOURCE });
    assert.deepEqual(Object.fromEntries(new URLSearchParams(String(revoke.init.body))), { token: "refresh value", token_type_hint: "refresh_token", client_id: "client" });
    assert.equal(revoke.url, REVOKE_URL);
  });
});

function awaitableSha256(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}
