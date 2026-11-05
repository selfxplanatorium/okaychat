import { createHash, randomBytes } from "node:crypto";
import { createLocalJWKSet, decodeProtectedHeader, errors as joseErrors, jwtVerify, type JSONWebKeySet } from "jose";
import { USER_AGENT } from "./env.js";

// Sign in with ChatGPT for open-source apps: dynamic public-client registration, PKCE, and a loopback
// redirect on the user's desktop. This module is the protocol only: no database, no Hono, no Codex CLI.
// Every endpoint is fixed here and never taken from a browser, helper, provider row, token response, or
// claim. See docs/implementation/codex-chat.md.

export const ISSUER = "https://auth.openai.com";
export const DISCOVERY_URL = "https://auth.openai.com/.well-known/openid-configuration";
export const AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
export const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
export const JWKS_URL = "https://auth.openai.com/.well-known/jwks.json";
export const REVOKE_URL = "https://auth.openai.com/api/accounts/oauth/revoke";
export const RESOURCE = "https://api.openai.com/v1";
export const SCOPES = ["openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"] as const;
/** Both are needed before any catalog or inference request; identity alone is `plan_disabled`. */
export const INFERENCE_SCOPES = ["chatgpt.tokens.use.direct", "resource.invoke"] as const;
export const BOOTSTRAP_CLIENT_ID = "dynamic_agent_client";
export const AGENT_NAME = "okaychat";
export const CALLBACK_PATH = "/auth/callback";

const CLOCK_SKEW_S = 60;
const MAX_CLIENT_ID = 512;
const MAX_CODE = 4096;
const MAX_TOKEN = 16 * 1024;
const TOKEN_BODY_CAP = 64 * 1024;
const DISCOVERY_CAP = 64 * 1024;
const JWKS_CAP = 256 * 1024;
const DAY_MS = 24 * 60 * 60_000;

/** Test seams. Production values are never replaced outside tests. */
export const oauthDeps = {
  fetch: (input: string, init: RequestInit) => globalThis.fetch(input, init),
  now: () => Date.now(),
  random: (size: number): Buffer => randomBytes(size),
};

/** A failure the routes turn into a stable code. `retryable` never means "resend the same code". */
export class OAuthError extends Error {
  constructor(
    readonly kind: "protocol" | "network" | "uncertain" | "terminal" | "configuration" | "temporary" | "invalid" | "denied" | "identity",
    /** Sanitized machine code from the authorization server, when one was given. */
    readonly upstreamCode?: string,
    readonly status?: number,
  ) {
    super(`ChatGPT sign-in failed (${kind}${upstreamCode ? `: ${upstreamCode}` : ""}${status ? `, HTTP ${status}` : ""}).`);
    this.name = "OAuthError";
  }
}

const b64url = (buf: Buffer) => buf.toString("base64url");
export const randomSecret = (bytes = 32) => b64url(oauthDeps.random(bytes));
export const pkceChallenge = (verifier: string) => b64url(createHash("sha256").update(verifier).digest());

export interface PkceSet {
  verifier: string;
  challenge: string;
  state: string;
  nonce: string;
}

/** 64 random bytes give an 86-character verifier; state and nonce are 32 bytes each. */
export function newPkceSet(): PkceSet {
  const verifier = randomSecret(64);
  return { verifier, challenge: pkceChallenge(verifier), state: randomSecret(32), nonce: randomSecret(32) };
}

export const loopbackRedirect = (port: number) => `http://127.0.0.1:${port}${CALLBACK_PATH}`;

export interface AuthorizationInput {
  /** The registration's issued client id for a reconnect; absent for a new registration. */
  clientId?: string;
  hostId: string;
  redirectUri: string;
  pkce: PkceSet;
  /** Only after an explicit "Enable plan usage" action. */
  consent?: boolean;
}

export function authorizationUrl(input: AuthorizationInput): string {
  const params = new URLSearchParams();
  params.set("client_id", input.clientId ?? BOOTSTRAP_CLIENT_ID);
  if (!input.clientId) params.set("agent_name_hint", AGENT_NAME);
  params.set("ext_agent_host_id", input.hostId);
  params.set("response_type", "code");
  params.set("redirect_uri", input.redirectUri);
  params.set("scope", SCOPES.join(" "));
  params.set("resource", RESOURCE);
  params.set("state", input.pkce.state);
  params.set("nonce", input.pkce.nonce);
  params.set("code_challenge", input.pkce.challenge);
  params.set("code_challenge_method", "S256");
  if (input.consent) params.set("prompt", "consent");
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export type CallbackResult =
  | { kind: "code"; code: string; clientId: string }
  | { kind: "denied"; error: string }
  /** Wrong state: the request is ignored and the pending attempt stays usable. */
  | { kind: "state_mismatch" };

const SENSITIVE = new Set(["code", "state", "client_id", "error", "error_description", "scope", "iss"]);

/**
 * Validates the loopback callback the helper forwards. The origin and path must match the saved redirect
 * exactly; duplicate sensitive parameters, mixed code and error, and malformed encoding are rejected.
 * Callback `scope` is ignored: only the token response grants permissions.
 */
export function parseCallback(callbackUrl: string, expected: { redirectUri: string; state: string; clientId?: string }): CallbackResult {
  if (typeof callbackUrl !== "string" || callbackUrl.length > 8 * 1024) throw new OAuthError("invalid");
  const queryAt = callbackUrl.indexOf("?");
  const base = queryAt === -1 ? callbackUrl : callbackUrl.slice(0, queryAt);
  if (base !== expected.redirectUri || callbackUrl.includes("#")) throw new OAuthError("invalid");
  const raw = queryAt === -1 ? "" : callbackUrl.slice(queryAt + 1);
  const values = new Map<string, string>();
  for (const pair of raw.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent((eq === -1 ? pair : pair.slice(0, eq)).replace(/\+/g, " "));
      value = decodeURIComponent((eq === -1 ? "" : pair.slice(eq + 1)).replace(/\+/g, " "));
    } catch {
      throw new OAuthError("invalid");
    }
    if (values.has(key) && SENSITIVE.has(key)) throw new OAuthError("invalid");
    values.set(key, value);
  }
  if (values.get("state") !== expected.state) return { kind: "state_mismatch" };
  const code = values.get("code");
  const error = values.get("error");
  if (code !== undefined && error !== undefined) throw new OAuthError("invalid");
  if (error !== undefined) return { kind: "denied", error: safeCode(error) ?? "unknown" };
  if (!code || code.length > MAX_CODE) throw new OAuthError("invalid");
  const issued = values.get("client_id");
  if (expected.clientId) {
    // A returning registration may omit client_id; when present it must be the saved one.
    if (issued !== undefined && issued !== expected.clientId) throw new OAuthError("identity");
    return { kind: "code", code, clientId: expected.clientId };
  }
  if (!issued || issued.length > MAX_CLIENT_ID || issued === BOOTSTRAP_CLIENT_ID || /[\s\x00-\x1f]/.test(issued)) throw new OAuthError("invalid");
  return { kind: "code", code, clientId: issued };
}

/** Machine codes only. An upstream description never leaves this module. */
export function safeCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : undefined;
}

interface BoundedResponse {
  status: number;
  headers: Headers;
  text: string;
}

/** HTTPS only, no redirects, a deadline, and a byte cap. The URL is always one of the constants above. */
async function boundedFetch(url: string, init: RequestInit, timeoutMs: number, cap: number, signal?: AbortSignal): Promise<BoundedResponse> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const res = await oauthDeps.fetch(url, {
    ...init,
    redirect: "error",
    signal: signal ? AbortSignal.any([deadline, signal]) : deadline,
    headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...(init.headers as Record<string, string> | undefined) },
  });
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > cap) {
          await reader.cancel().catch(() => {});
          throw new OAuthError("protocol", "response_too_large", res.status);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  return { status: res.status, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") };
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

// Discovery is fetched only to confirm the fixed endpoints still hold; a validated copy stays usable for
// 24 h when a later fetch fails, but nothing from it ever replaces a constant.
let discovered: { at: number } | null = null;
let discovering: Promise<void> | null = null;

export async function ensureDiscovery(): Promise<void> {
  if (discovered && oauthDeps.now() - discovered.at < DAY_MS) return;
  discovering ??= (async () => {
    try {
      const res = await boundedFetch(DISCOVERY_URL, { method: "GET" }, 5_000, DISCOVERY_CAP);
      const doc = record(parseJson(res.text));
      if (res.status !== 200 || !doc) throw new OAuthError("configuration", "discovery_unavailable", res.status);
      const matches =
        doc.issuer === ISSUER &&
        doc.authorization_endpoint === AUTHORIZE_URL &&
        doc.token_endpoint === TOKEN_URL &&
        doc.jwks_uri === JWKS_URL &&
        (doc.revocation_endpoint === undefined || doc.revocation_endpoint === REVOKE_URL) &&
        (!Array.isArray(doc.id_token_signing_alg_values_supported) || doc.id_token_signing_alg_values_supported.includes("RS256"));
      if (!matches) throw new OAuthError("configuration", "discovery_mismatch");
      discovered = { at: oauthDeps.now() };
    } catch (error) {
      // A copy validated earlier remains usable for its full day.
      if (discovered && oauthDeps.now() - discovered.at < DAY_MS) return;
      throw error instanceof OAuthError ? error : new OAuthError("configuration", "discovery_unavailable");
    } finally {
      discovering = null;
    }
  })();
  return discovering;
}

let jwks: { set: ReturnType<typeof createLocalJWKSet>; at: number; ttl: number } | null = null;
let jwksLoading: Promise<void> | null = null;
let lastJwksRefresh = 0;

async function loadJwks(): Promise<void> {
  jwksLoading ??= (async () => {
    try {
      const res = await boundedFetch(JWKS_URL, { method: "GET" }, 5_000, JWKS_CAP);
      const body = record(parseJson(res.text));
      if (res.status !== 200 || !body || !Array.isArray(body.keys)) throw new OAuthError("configuration", "jwks_unavailable", res.status);
      const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1] ?? 3600) * 1000;
      jwks = { set: createLocalJWKSet(body as unknown as JSONWebKeySet), at: oauthDeps.now(), ttl: Math.min(Math.max(maxAge, 0), DAY_MS) };
      lastJwksRefresh = oauthDeps.now();
    } finally {
      jwksLoading = null;
    }
  })();
  return jwksLoading;
}

/** Test hook: forget cached discovery and keys. */
export function resetOAuthCaches() {
  discovered = null;
  jwks = null;
  lastJwksRefresh = 0;
}

export interface VerifiedIdentity {
  issuer: string;
  subject: string;
  email?: string;
  name?: string;
}

const label = (value: unknown, max: number) =>
  typeof value === "string" && value.trim() ? value.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, max) : undefined;

/**
 * RS256 signature against the issuer's JWKS, exact issuer, audience containing the issued client,
 * `azp` consistency, exp/nbf with 60 s tolerance, a subject, and the attempt's nonce when one is expected.
 * Header-supplied key locations (jku, x5u, jwk, x5c) are refused, never fetched.
 */
export async function verifyIdToken(token: string, expected: { clientId: string; nonce?: string; subject?: string }): Promise<VerifiedIdentity> {
  if (typeof token !== "string" || token.length > MAX_TOKEN) throw new OAuthError("identity", "id_token_invalid");
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw new OAuthError("identity", "id_token_invalid");
  }
  if (header.alg !== "RS256" || "jku" in header || "x5u" in header || "jwk" in header || "x5c" in header) throw new OAuthError("identity", "id_token_alg");
  if (!jwks || oauthDeps.now() - jwks.at > jwks.ttl) await loadJwks();
  const verify = () =>
    jwtVerify(token, jwks!.set, {
      issuer: ISSUER,
      audience: expected.clientId,
      algorithms: ["RS256"],
      clockTolerance: CLOCK_SKEW_S,
      currentDate: new Date(oauthDeps.now()),
      requiredClaims: ["exp", "sub"],
    });
  let result: Awaited<ReturnType<typeof verify>>;
  try {
    result = await verify();
  } catch (error) {
    // One coalesced refresh for a key rollover, at most once a minute so forged kids cannot drive fetches.
    if (error instanceof joseErrors.JWKSNoMatchingKey && oauthDeps.now() - lastJwksRefresh > 60_000) {
      await loadJwks();
      try {
        result = await verify();
      } catch {
        throw new OAuthError("identity", "id_token_invalid");
      }
    } else throw new OAuthError("identity", "id_token_invalid");
  }
  const claims = result.payload;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.azp !== undefined && claims.azp !== expected.clientId) throw new OAuthError("identity", "id_token_azp");
  if (audiences.length > 1 && claims.azp === undefined) throw new OAuthError("identity", "id_token_azp");
  if (typeof claims.sub !== "string" || !claims.sub) throw new OAuthError("identity", "id_token_sub");
  if (expected.nonce !== undefined && claims.nonce !== expected.nonce) throw new OAuthError("identity", "id_token_nonce");
  if (expected.subject !== undefined && claims.sub !== expected.subject) throw new OAuthError("identity", "identity_mismatch");
  return {
    issuer: ISSUER,
    subject: claims.sub,
    ...(label(claims.email, 320) ? { email: label(claims.email, 320) } : {}),
    ...(label(claims.name, 100) ? { name: label(claims.name, 100) } : {}),
  };
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  tokenType: "Bearer";
  scopes: string[];
  receivedAt: number;
  expiresIn: number;
  accessExpiresAt: number;
  /** Documented without units, so it is kept as metadata and never scheduled by. */
  earliestRefreshAtRaw?: number;
}

const isToken = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_TOKEN;

/** Unknown fields are ignored; anything malformed fails closed. Access tokens stay opaque. */
export function parseTokenResponse(body: unknown, requireIdToken: boolean): TokenSet {
  const json = record(body);
  if (!json) throw new OAuthError("protocol", "token_response_invalid");
  const { access_token, refresh_token, id_token, token_type, expires_in, scope, earliest_refresh_at } = json;
  if (!isToken(access_token)) throw new OAuthError("protocol", "token_response_invalid");
  if (typeof token_type !== "string" || token_type.toLowerCase() !== "bearer") throw new OAuthError("protocol", "token_response_invalid");
  if (typeof expires_in !== "number" || !Number.isSafeInteger(expires_in) || expires_in <= 0 || expires_in > 31_536_000) throw new OAuthError("protocol", "token_response_invalid");
  if (typeof scope !== "string") throw new OAuthError("protocol", "token_response_invalid");
  if (requireIdToken && !isToken(id_token)) throw new OAuthError("protocol", "token_response_invalid");
  if (refresh_token !== undefined && !isToken(refresh_token)) throw new OAuthError("protocol", "token_response_invalid");
  if (id_token !== undefined && !isToken(id_token)) throw new OAuthError("protocol", "token_response_invalid");
  const receivedAt = oauthDeps.now();
  return {
    accessToken: access_token,
    ...(refresh_token ? { refreshToken: refresh_token as string } : {}),
    ...(id_token ? { idToken: id_token as string } : {}),
    tokenType: "Bearer",
    scopes: scope.split(/\s+/).filter(Boolean),
    receivedAt,
    expiresIn: expires_in,
    // The response's lifetime minus the allowed skew; no fixed lifetime is assumed.
    accessExpiresAt: receivedAt + expires_in * 1000 - CLOCK_SKEW_S * 1000,
    ...(typeof earliest_refresh_at === "number" && Number.isFinite(earliest_refresh_at) ? { earliestRefreshAtRaw: earliest_refresh_at } : {}),
  };
}

export const hasInferenceScopes = (scopes: readonly string[]) => INFERENCE_SCOPES.every((scope) => scopes.includes(scope));

const form = (values: Record<string, string>) => new URLSearchParams(values).toString();
const FORM_HEADERS = { "Content-Type": "application/x-www-form-urlencoded" };

/**
 * Redeems an authorization code exactly once. A network failure is `uncertain`: the code may already be
 * spent, so the caller ends the attempt and never resends it.
 */
export async function exchangeCode(input: { clientId: string; code: string; verifier: string; redirectUri: string }): Promise<TokenSet> {
  let res: BoundedResponse;
  try {
    res = await boundedFetch(
      TOKEN_URL,
      {
        method: "POST",
        headers: FORM_HEADERS,
        body: form({ grant_type: "authorization_code", client_id: input.clientId, code: input.code, code_verifier: input.verifier, redirect_uri: input.redirectUri, resource: RESOURCE }),
      },
      15_000,
      TOKEN_BODY_CAP,
    );
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    throw new OAuthError("uncertain");
  }
  const body = parseJson(res.text);
  if (res.status !== 200) {
    const code = safeCode(record(body)?.error);
    throw new OAuthError(code === "invalid_client" ? "configuration" : res.status >= 500 ? "uncertain" : "invalid", code, res.status);
  }
  return parseTokenResponse(body, true);
}

const TERMINAL_REFRESH = new Set(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"]);

/**
 * One refresh with the latest rotating refresh token. Outcomes the caller must handle:
 * `terminal` (token unusable), `configuration` (invalid_client, no OAuth loop), `uncertain` (the token may
 * have rotated, never resend it), `temporary` (definitely not processed: 429), `protocol`.
 */
export async function refreshTokens(input: { clientId: string; refreshToken: string; signal?: AbortSignal }): Promise<TokenSet> {
  let res: BoundedResponse;
  try {
    res = await boundedFetch(
      TOKEN_URL,
      { method: "POST", headers: FORM_HEADERS, body: form({ grant_type: "refresh_token", client_id: input.clientId, refresh_token: input.refreshToken, resource: RESOURCE }) },
      15_000,
      TOKEN_BODY_CAP,
      input.signal,
    );
  } catch (error) {
    if (error instanceof OAuthError) throw new OAuthError("uncertain", error.upstreamCode, error.status);
    throw new OAuthError("uncertain");
  }
  const body = parseJson(res.text);
  if (res.status !== 200) {
    const code = safeCode(record(body)?.error);
    if (code && TERMINAL_REFRESH.has(code)) throw new OAuthError("terminal", code, res.status);
    if (code === "invalid_client") throw new OAuthError("configuration", code, res.status);
    if (res.status === 429) throw new OAuthError("temporary", code, res.status);
    throw new OAuthError(res.status >= 500 ? "uncertain" : "protocol", code, res.status);
  }
  try {
    return parseTokenResponse(body, false);
  } catch {
    // A 200 whose body we cannot use may still have rotated the token.
    throw new OAuthError("uncertain", "token_response_invalid", 200);
  }
}

/** Revokes a refresh token: 5 s in total, a second attempt only after a 5xx or a network failure. */
export async function revokeRefreshToken(input: { clientId: string; refreshToken: string }): Promise<"confirmed" | "unconfirmed"> {
  const deadline = oauthDeps.now() + 5_000;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const left = deadline - oauthDeps.now();
    if (left <= 0) break;
    try {
      await ensureDiscovery();
      const res = await boundedFetch(
        REVOKE_URL,
        { method: "POST", headers: FORM_HEADERS, body: form({ token: input.refreshToken, token_type_hint: "refresh_token", client_id: input.clientId }) },
        left,
        TOKEN_BODY_CAP,
      );
      if (res.status === 200) return "confirmed";
      if (res.status < 500) return "unconfirmed";
    } catch {
      // Network failure or deadline: one more try while time remains.
    }
  }
  return "unconfirmed";
}
