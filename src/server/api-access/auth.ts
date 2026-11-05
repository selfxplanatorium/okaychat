import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import type { ApiPrincipal } from "../../shared/api-access.js";
import { newId } from "../crypto.js";
import { AppError } from "../errors.js";
import { authenticateApiToken, markKeyUsed } from "./keys.js";
import { chargeApiRate } from "./limits.js";
import { apiFailure, apiHeaders, describeApiFailure, sendApiError } from "./protocol.js";

// Bearer authentication for `/v1` (docs/implementation/api-access.md). This is deliberately not the
// session middleware: an API credential never becomes an app session, never carries a role, and a cookie
// alone is always insufficient.

export type ApiEnv = { Variables: { apiPrincipal: ApiPrincipal; apiRequestId: string } };

const WINDOW_MS = 60_000;
const PER_ADDRESS = 120;
const PER_PROCESS = 2_000;
const MAX_ADDRESSES = 10_000;

interface Bucket {
  count: number;
  resetAt: number;
}

const addresses = new Map<string, Bucket>();
let processBucket: Bucket = { count: 0, resetAt: 0 };

function roll(bucket: Bucket, now: number): Bucket {
  if (bucket.resetAt <= now) {
    bucket.count = 0;
    bucket.resetAt = now + WINDOW_MS;
  }
  return bucket;
}

function remoteAddress(c: Context): string | null {
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
}

/**
 * Pre-auth abuse gate keyed by the transport socket address only: forwarded headers are forgeable and
 * never used for this security limit. Shared proxies therefore share one bucket. A full map of live
 * entries denies new addresses rather than evicting an attacker's own entry.
 */
function allowAttempt(c: Context, now: number): boolean {
  processBucket = roll(processBucket, now);
  if (processBucket.count >= PER_PROCESS) return false;
  const address = remoteAddress(c);
  if (address === null) {
    processBucket.count++;
    return true;
  }
  const existing = addresses.get(address);
  if (existing) {
    roll(existing, now);
    addresses.delete(address);
    addresses.set(address, existing);
    if (existing.count >= PER_ADDRESS) return false;
    existing.count++;
    processBucket.count++;
    return true;
  }
  if (addresses.size >= MAX_ADDRESSES) {
    for (const [key, bucket] of addresses) {
      if (bucket.resetAt <= now) addresses.delete(key);
    }
    if (addresses.size >= MAX_ADDRESSES) return false;
  }
  addresses.set(address, { count: 1, resetAt: now + WINDOW_MS });
  processBucket.count++;
  return true;
}

/** Test seam: reset the in-memory gate. */
export function resetApiAuthGate(): void {
  addresses.clear();
  processBucket = { count: 0, resetAt: 0 };
}

/** One request id per attempt: `apr_…` for a completion, `areq_…` for everything else. */
export function newApiRequestId(generation: boolean): string {
  return newId(generation ? "apr" : "areq");
}

/**
 * The path inside the mounted router, so a bare `/v1` and descendants are both recognized. It is the
 * router's own decoded path, so `/v1/%6Dodels` is `/models` here exactly as it is for route matching.
 */
export function apiPath(c: Context): string {
  const path = c.req.path;
  return path === "/v1" ? "/" : path.startsWith("/v1/") ? path.slice(3) : path;
}

/**
 * Parses exactly one Authorization header: case-insensitive `Bearer`, one ASCII space, and the exact
 * token. Combined (comma) values, Basic, query tokens, cookie tokens, and whitespace trailers are all
 * rejected as an absent credential.
 */
export function bearerToken(c: Context): string | null {
  const raw = c.req.header("authorization");
  if (raw === undefined) return null;
  // The Node adapter coalesces duplicate Authorization headers with ", "; no valid token contains one.
  if (raw.includes(",")) return null;
  const match = /^Bearer ([A-Za-z0-9_.-]+)$/i.exec(raw);
  return match?.[1] ?? null;
}

const invalidCredential = () => apiFailure(401, "authentication_error", "invalid_api_key", "Invalid API key.");

/** Sets the no-store request id header on every response, including errors and streams. */
export const apiContext: MiddlewareHandler<ApiEnv> = async (c, next) => {
  const generation = c.req.method === "POST" && apiPath(c) === "/chat/completions";
  const requestId = newApiRequestId(generation);
  c.set("apiRequestId", requestId);
  c.header("Cache-Control", "no-store");
  c.header("X-Request-Id", requestId);
  await next();
  // Responses built before the handler (404/405, errors) still carry the protocol headers.
  for (const [key, value] of Object.entries(apiHeaders(requestId))) {
    if (!c.res.headers.has(key)) c.res.headers.set(key, value);
  }
};

/** The pre-auth gate. It never parses a body and never touches session auth. */
export const apiGate: MiddlewareHandler<ApiEnv> = async (c, next) => {
  if (!allowAttempt(c, Date.now())) {
    return sendApiError(c, apiFailure(429, "rate_limit_error", "rate_limit_exceeded", "Too many requests.", null, 1_000), c.get("apiRequestId"));
  }
  await next();
};

/** Resolves the bearer principal and charges the durable key/account minute buckets. */
export const apiAuth: MiddlewareHandler<ApiEnv> = async (c, next) => {
  const requestId = c.get("apiRequestId");
  const token = bearerToken(c);
  if (!token) return sendApiError(c, invalidCredential(), requestId);
  const now = Date.now();
  const authenticated = authenticateApiToken(token, now);
  if (!authenticated) return sendApiError(c, invalidCredential(), requestId);
  try {
    // Scope, body, and provider failures after this point still cost one API rate unit.
    chargeApiRate(authenticated.principal.userId, authenticated.principal.keyId, now);
  } catch (error) {
    return sendApiError(c, describeApiFailure(error), requestId);
  }
  markKeyUsed(authenticated.principal.keyId, now);
  c.set("apiPrincipal", authenticated.principal);
  await next();
};

/** A live denial mid-call is not a new authentication challenge. */
export function liveDenial(): AppError {
  return new AppError({ code: "forbidden", status: 403, message: "This API credential is no longer active." });
}
