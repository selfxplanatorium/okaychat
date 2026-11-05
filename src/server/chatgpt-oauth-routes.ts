import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppEnv } from "./auth.js";
import { requireUser } from "./auth.js";
import { db } from "./db.js";
import { env } from "./env.js";
import { newId, sha256 } from "./crypto.js";
import { isConnected } from "./codex.js";
import { CHATGPT_HELPER_PATH, CHATGPT_MANAGE_USAGE_URL, type ChatGPTLoginIntent } from "../shared/chatgpt.js";
import { authorizationUrl, ensureDiscovery, exchangeCode, hasInferenceScopes, loopbackRedirect, newPkceSet, OAuthError, parseCallback, randomSecret, revokeRefreshToken, verifyIdToken, type PkceSet } from "./chatgpt-oauth.js";
import { activate, activeRegistration, bump, changed, disconnect, hostId, ownRegistration, registrations, revision, seal, transaction, unseal } from "./chatgpt-oauth-store.js";

export function canonicalOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}
const publicOrigin = canonicalOrigin(process.env.OKAYCHAT_PUBLIC_URL);
const enabled = process.env.OKAYCHAT_CHATGPT_OAUTH_ENABLED === "true";
const available = !!publicOrigin && enabled;
const ttl = 10 * 60_000;
interface Attempt {
  id: string; user_id: string; session_hash: string; registration_id: string | null; state_hash: string;
  secrets_enc: string | null; helper_cap_hash: string; helper_bound_hash: string | null; redirect_uri: string | null;
  status: string; intent: ChatGPTLoginIntent; expected_generation: number | null; connection_revision: number; expires_at: number; error_code: string | null;
}
interface Secrets { pkce: PkceSet; capability?: string }
function secrets(row: Attempt): Secrets {
  if (!row.secrets_enc) throw new OAuthError("invalid");
  return unseal<Secrets>(row.user_id, row.id, row.secrets_enc);
}
const csrf = (session: string) => createHmac("sha256", env.secret).update(`chatgpt-csrf:v1:${session}`).digest("base64url");
function equal(a: string, b: string) { const aa = Buffer.from(a); const bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); }
function view(row: Attempt) { return { id: row.id, status: row.status, expiresAt: row.expires_at, ...(row.error_code ? { errorCode: row.error_code } : {}) }; }
function purge() {
  db.prepare("UPDATE chatgpt_login_attempts SET status='failed',secrets_enc=NULL,error_code='chatgpt_login_expired' WHERE expires_at<=? AND status IN ('preparing','waiting','exchanging')").run(Date.now());
  db.prepare("DELETE FROM chatgpt_login_attempts WHERE expires_at<?").run(Date.now() - 300_000);
}
function live(row: Attempt) {
  const session = db.prepare("SELECT 1 FROM sessions WHERE token_hash=? AND user_id=? AND expires_at>?").get(row.session_hash, row.user_id, Date.now());
  return !!session && row.expires_at > Date.now() && revision(row.user_id) === row.connection_revision;
}
function failed(row: Attempt, code = "chatgpt_login_invalid") {
  db.prepare("UPDATE chatgpt_login_attempts SET status='failed',secrets_enc=NULL,error_code=? WHERE id=?").run(code, row.id);
}
function owned(userId: string, session: string, id: string): Attempt | undefined {
  purge();
  return db.prepare("SELECT * FROM chatgpt_login_attempts WHERE user_id=? AND session_hash=? AND id=?").get(userId, session, id) as Attempt | undefined;
}
const base = () => new Hono<AppEnv>().use("*", bodyLimit({ maxSize: 16_384 })).use("*", async (c, next) => {
  c.header("Cache-Control", "no-store"); c.header("Referrer-Policy", "no-referrer"); await next();
}).onError((_error, c) => c.json({ error: "ChatGPT connection could not complete.", featureCode: "chatgpt_login_invalid" }, 400));
export const chatgptRoutes = base();
chatgptRoutes.use("*", requireUser);
chatgptRoutes.use("*", async (c, next) => {
  if (c.req.method !== "GET") {
    if (!publicOrigin || c.req.header("Origin") !== publicOrigin || !equal(c.req.header("X-CSRF-Token") ?? "", csrf(c.get("session"))) || c.req.header("Content-Type")?.split(";")[0] !== "application/json") return c.json({ error: "Forbidden" }, 403);
  }
  await next();
});
chatgptRoutes.get("/status", c => {
  purge();
  const userId = c.get("user").id;
  const pending = db.prepare("SELECT * FROM chatgpt_login_attempts WHERE user_id=? AND session_hash=? ORDER BY created_at DESC LIMIT 1").get(userId, c.get("session")) as Attempt | undefined;
  return c.json({ mode: "desktop_helper", publicOrigin, available, unavailableReason: !publicOrigin ? "public_url_required" : !enabled ? "integration_unverified" : null, csrfToken: csrf(c.get("session")), activeRegistrationId: activeRegistration(userId)?.id ?? null, registrations: registrations(userId), pending: pending ? view(pending) : null, legacyImagesConnected: isConnected(userId), helperUrl: CHATGPT_HELPER_PATH, manageUsageUrl: CHATGPT_MANAGE_USAGE_URL });
});
const starts = new Map<string, number[]>();
chatgptRoutes.post("/login", async c => {
  if (!available) return c.json({ error: "Desktop integration is not verified for this deployment.", featureCode: "chatgpt_oauth_unavailable" }, 503);
  const input = z.object({ registrationId: z.string().max(100).optional(), intent: z.enum(["connect", "reconnect", "enable_plan"]) }).strict().parse(await c.req.json());
  const userId = c.get("user").id;
  const recent = (starts.get(userId) ?? []).filter(at => at > Date.now() - ttl);
  if (recent.length >= 5) return c.json({ error: "Try again later." }, 429);
  recent.push(Date.now()); starts.set(userId, recent);
  const target = input.registrationId ? ownRegistration(userId, input.registrationId) : undefined;
  if ((input.intent !== "connect" && !target) || (input.intent === "connect" && input.registrationId)) return c.json({ error: "Unknown registration" }, 404);
  const id = newId("cgl"), pkce = newPkceSet(), capability = randomSecret(), expiresAt = Date.now() + ttl;
  transaction(() => {
    bump(userId);
    db.prepare(`INSERT INTO chatgpt_login_attempts(id,user_id,session_hash,registration_id,state_hash,secrets_enc,helper_cap_hash,status,intent,expected_generation,connection_revision,created_at,expires_at) VALUES (?,?,?,?,?,?,?,'preparing',?,?,?,?,?)`).run(id, userId, c.get("session"), target?.id ?? null, sha256(pkce.state), seal(userId, id, { pkce, capability }), sha256(capability), input.intent, target?.generation ?? null, revision(userId), Date.now(), expiresAt);
  });
  return c.json({ attemptId: id, expiresAt, launchDownloadUrl: `/api/chatgpt/login/${id}/launch` }, 201);
});
chatgptRoutes.get("/login/:id", c => {
  const row = owned(c.get("user").id, c.get("session"), c.req.param("id"));
  return row ? c.json(view(row)) : c.json({ error: "Not found" }, 404);
});
chatgptRoutes.get("/login/:id/launch", c => {
  const row = owned(c.get("user").id, c.get("session"), c.req.param("id"));
  if (!row) return c.json({ error: "Not found" }, 404);
  if (!live(row) || row.status !== "preparing") return c.json({ error: "Expired" }, 410);
  const data = secrets(row);
  if (!data.capability) return c.json({ error: "Already downloaded" }, 409);
  const capability = data.capability;
  delete data.capability;
  db.prepare("UPDATE chatgpt_login_attempts SET secrets_enc=? WHERE id=?").run(seal(row.user_id, row.id, data), row.id);
  c.header("Content-Disposition", 'attachment; filename="okaychat-chatgpt-launch.json"');
  return c.json({ version: 1, publicOrigin, attemptId: row.id, helperCapability: capability, expiresAt: row.expires_at });
});
chatgptRoutes.delete("/login/:id", c => {
  const row = owned(c.get("user").id, c.get("session"), c.req.param("id"));
  if (!row) return c.json({ error: "Not found" }, 404);
  db.prepare("UPDATE chatgpt_login_attempts SET status='cancelled',secrets_enc=NULL WHERE id=? AND status IN ('preparing','waiting','exchanging')").run(row.id);
  return c.json({ ok: true });
});
chatgptRoutes.post("/registrations/:id/activate", async c => { activate(c.get("user").id, c.req.param("id")); return c.json({ ok: true }); });
chatgptRoutes.delete("/registrations/:id", async c => c.json({ ok: true, remoteRevocation: await disconnect(c.get("user").id, c.req.param("id")) }));
chatgptRoutes.post("/registrations/:id/welcome-seen", c => {
  db.prepare("UPDATE chatgpt_registrations SET welcome_seen_at=COALESCE(welcome_seen_at,?) WHERE user_id=? AND id=?").run(Date.now(), c.get("user").id, c.req.param("id"));
  return c.json({ ok: true });
});
chatgptRoutes.delete("/registrations/:id/forget", c => {
  const row = ownRegistration(c.get("user").id, c.req.param("id"));
  if (!row) return c.json({ error: "Not found" }, 404);
  if (row.state !== "disconnected") return c.json({ error: "Disconnect first" }, 409);
  db.prepare("DELETE FROM chatgpt_registrations WHERE user_id=? AND id=?").run(row.user_id, row.id);
  return c.json({ ok: true });
});

export const chatgptHelperRoutes = base();
const invalidAttempts = new Map<string, { at: number; count: number }>();
chatgptHelperRoutes.use("*", async (c, next) => {
  if (!available) return c.json({ error: "Unavailable" }, 503);
  if (c.req.header("Origin") !== undefined || c.req.header("Cookie") !== undefined || [...c.req.raw.headers.keys()].some(key => key.startsWith("sec-fetch-")) || c.req.header("Content-Type")?.split(";")[0] !== "application/json") return c.json({ error: "Forbidden" }, 403);
  await next();
});
const helperInput = z.object({ attemptId: z.string().max(100), helperSecret: z.string().regex(/^[A-Za-z0-9_-]{43}$/), port: z.number().int().min(1024).max(65535).optional(), callbackUrl: z.string().max(8192).optional() }).strict();
chatgptHelperRoutes.post("/:action", async c => {
  const input = helperInput.parse(await c.req.json());
  const row = db.prepare("SELECT * FROM chatgpt_login_attempts WHERE id=?").get(input.attemptId) as Attempt | undefined;
  const capability = c.req.header("Authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  const valid = !!row && !!capability && equal(sha256(capability), row.helper_cap_hash);
  // One attempt cannot be brute-forced, and one stranger cannot exhaust a server-wide bucket. Invalid
  // requests get a much higher ceiling only to bound parsing and row lookups.
  const key = valid ? `attempt:${row.id}` : "invalid";
  const ceiling = valid ? 10 : 5000;
  let limit = invalidAttempts.get(key);
  if (!limit || limit.at < Date.now() - 60_000) { limit = { at: Date.now(), count: 0 }; invalidAttempts.set(key, limit); }
  if (limit.count >= ceiling) return c.json({ error: "Try again later" }, 429);
  limit.count++;
  if (!valid) return c.json({ error: "Not found" }, 404);
  if (!live(row)) return c.json({ error: "Expired" }, 410);
  const action = c.req.param("action");
  if (action === "prepare") {
    if (row.status !== "preparing" || row.helper_bound_hash || !input.port) return c.json({ error: "Already prepared" }, 409);
    const data = secrets(row);
    if (data.capability) return c.json({ error: "Download launch first" }, 409);
    const redirectUri = loopbackRedirect(input.port);
    await ensureDiscovery();
    // Discovery is asynchronous; recheck the session/revision and CAS after it returns.
    if (!live(row)) return c.json({ error: "Expired" }, 410);
    const saved = db.prepare("UPDATE chatgpt_login_attempts SET helper_bound_hash=?,redirect_uri=?,status='waiting' WHERE id=? AND status='preparing' AND helper_bound_hash IS NULL").run(sha256(input.helperSecret), redirectUri, row.id);
    if (!saved.changes) return c.json({ error: "Already prepared" }, 409);
    const target = row.registration_id ? ownRegistration(row.user_id, row.registration_id) : undefined;
    return c.json({ authorizationUrl: authorizationUrl({ clientId: target?.client_id, hostId: hostId(row.user_id), redirectUri, pkce: data.pkce, consent: row.intent === "enable_plan" }), expiresAt: row.expires_at });
  }
  if (!row.helper_bound_hash || !equal(sha256(input.helperSecret), row.helper_bound_hash)) return c.json({ error: "Not found" }, 404);
  if (action === "cancel") { failed(row, "chatgpt_login_cancelled"); return c.json({ ok: true }); }
  if (action !== "complete" || !input.callbackUrl) return c.json({ error: "Not found" }, 404);
  if (row.status !== "waiting" || !row.redirect_uri) return c.json({ error: "Already consumed" }, 409);
  const data = secrets(row);
  const target = row.registration_id ? ownRegistration(row.user_id, row.registration_id) : undefined;
  const callback = parseCallback(input.callbackUrl, { redirectUri: row.redirect_uri, state: data.pkce.state, clientId: target?.client_id });
  if (callback.kind === "state_mismatch") return c.json({ error: "Invalid callback" }, 400);
  if (callback.kind === "denied") { failed(row); return c.json({ error: "Sign-in declined" }, 400); }
  const consumed = db.prepare("UPDATE chatgpt_login_attempts SET status='exchanging',secrets_enc=NULL WHERE id=? AND status='waiting'").run(row.id);
  if (!consumed.changes) return c.json({ error: "Already consumed" }, 409);
  let tokens: Awaited<ReturnType<typeof exchangeCode>> | undefined;
  try {
    tokens = await exchangeCode({ clientId: callback.clientId, code: callback.code, verifier: data.pkce.verifier, redirectUri: row.redirect_uri });
    const identity = await verifyIdToken(tokens.idToken!, { clientId: callback.clientId, nonce: data.pkce.nonce, subject: target ? unseal<{ subject: string }>(row.user_id, target.id, target.identity_enc).subject : undefined });
    const id = target?.id ?? newId("cgr");
    const state = hasInferenceScopes(tokens.scopes) ? "ready" : "plan_disabled";
    transaction(() => {
      const fresh = db.prepare("SELECT status FROM chatgpt_login_attempts WHERE id=?").get(row.id) as { status: string } | undefined;
      if (!live(row) || fresh?.status !== "exchanging" || (target && ownRegistration(row.user_id, target.id)?.generation !== row.expected_generation)) throw new OAuthError("invalid");
      db.prepare("UPDATE chatgpt_registrations SET active=0,generation=generation+1 WHERE user_id=? AND active=1 AND id<>?").run(row.user_id, id);
      if (target) db.prepare("UPDATE chatgpt_registrations SET identity_enc=?,credentials_enc=?,state=?,active=1,generation=generation+1,token_version=token_version+1,refresh_state='idle',access_expires_at=?,updated_at=?,last_error_code=NULL WHERE user_id=? AND id=?").run(seal(row.user_id, id, identity), seal(row.user_id, id, tokens), state, tokens!.accessExpiresAt, Date.now(), row.user_id, id);
      else db.prepare("INSERT INTO chatgpt_registrations(id,user_id,client_id,identity_enc,credentials_enc,state,active,access_expires_at,connected_at,updated_at) VALUES (?,?,?,?,?,?,1,?,?,?)").run(id, row.user_id, callback.clientId, seal(row.user_id, id, identity), seal(row.user_id, id, tokens), state, tokens!.accessExpiresAt, Date.now(), Date.now());
      db.prepare("UPDATE chatgpt_login_attempts SET status='succeeded' WHERE id=?").run(row.id);
    });
    changed(row.user_id);
    return c.json({ ok: true, status: state === "ready" ? "succeeded" : "plan_disabled" });
  } catch {
    failed(row);
    if (tokens?.refreshToken) await revokeRefreshToken({ clientId: callback.clientId, refreshToken: tokens.refreshToken });
    return c.json({ error: "ChatGPT sign-in could not complete.", featureCode: "chatgpt_login_invalid" }, 400);
  }
});
