import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { decrypt, encrypt, newId, sha256 } from "./crypto.js";
import { OAuthError, hasInferenceScopes, refreshTokens, revokeRefreshToken, verifyIdToken, type TokenSet, type VerifiedIdentity } from "./chatgpt-oauth.js";
import type { ChatGPTRegistrationState, ChatGPTRegistrationView } from "../shared/chatgpt.js";

export interface Registration {
  id: string; user_id: string; client_id: string; identity_enc: string; credentials_enc: string | null;
  state: ChatGPTRegistrationState; active: number; generation: number; token_version: number;
  refresh_state: string; access_expires_at: number | null; connected_at: number; welcome_seen_at: number | null;
  last_error_code: string | null;
}
export interface Pin { id: string; generation: number }
const listeners = new Set<(userId: string) => void>();
const flights = new Map<string, Promise<void>>();
const controllers = new Map<string, Set<AbortController>>();
export function onChatGPTChange(fn: (userId: string) => void) { listeners.add(fn); }
export function changed(userId: string) {
  for (const controller of controllers.get(userId) ?? []) controller.abort();
  controllers.delete(userId);
  for (const fn of listeners) fn(userId);
}
export function ownRegistration(userId: string, id: string): Registration | undefined {
  return db.prepare("SELECT * FROM chatgpt_registrations WHERE user_id=? AND id=?").get(userId, id) as Registration | undefined;
}
export function activeRegistration(userId: string): Registration | undefined {
  return db.prepare("SELECT * FROM chatgpt_registrations WHERE user_id=? AND active=1").get(userId) as Registration | undefined;
}
export function seal(userId: string, registrationId: string, value: unknown): string {
  return encrypt(JSON.stringify({ schemaVersion: 1, userId, registrationId, value }));
}
export function unseal<T>(userId: string, registrationId: string, cipher: string): T {
  const data = JSON.parse(decrypt(cipher)) as { schemaVersion?: number; userId?: string; registrationId?: string; value?: T };
  if (data.schemaVersion !== 1 || data.userId !== userId || data.registrationId !== registrationId || data.value === undefined) throw new OAuthError("protocol");
  return data.value;
}
export function credentials(row: Registration): TokenSet {
  if (!row.credentials_enc) throw new OAuthError("terminal");
  return unseal<TokenSet>(row.user_id, row.id, row.credentials_enc);
}
export function revision(userId: string): number {
  db.prepare("INSERT OR IGNORE INTO chatgpt_controls(user_id) VALUES (?)").run(userId);
  return (db.prepare("SELECT revision FROM chatgpt_controls WHERE user_id=?").get(userId) as { revision: number }).revision;
}
export function bump(userId: string) {
  revision(userId);
  db.prepare("UPDATE chatgpt_controls SET revision=revision+1 WHERE user_id=?").run(userId);
  db.prepare("UPDATE chatgpt_login_attempts SET status='cancelled',secrets_enc=NULL WHERE user_id=? AND status IN ('preparing','waiting','exchanging')").run(userId);
}
export function hostId(userId: string): string {
  db.prepare("INSERT OR IGNORE INTO chatgpt_hosts VALUES (?,?,?)").run(userId, `urn:uuid:${randomUUID()}`, Date.now());
  return (db.prepare("SELECT host_id FROM chatgpt_hosts WHERE user_id=?").get(userId) as { host_id: string }).host_id;
}
export function chatgptConnected(userId: string): boolean {
  const row = activeRegistration(userId);
  if (!row || row.state !== "ready" || !row.credentials_enc || row.refresh_state !== "idle") return false;
  const enabled = db.prepare("SELECT enabled FROM provider_connections WHERE user_id=? AND provider_id='chatgpt'").get(userId) as { enabled: number } | undefined;
  return enabled?.enabled !== 0 && hasInferenceScopes(credentials(row).scopes);
}
export function chatgptPin(userId: string): Pin {
  const row = activeRegistration(userId);
  if (!chatgptConnected(userId) || !row) throw new OAuthError("terminal", "chatgpt_reconnect_required");
  return { id: row.id, generation: row.generation };
}
function pinned(userId: string, pin: Pin): Registration {
  const row = activeRegistration(userId);
  if (!row || row.id !== pin.id || row.generation !== pin.generation || !chatgptConnected(userId)) throw new OAuthError("terminal", "chatgpt_reconnect_required");
  return row;
}
/** A request owns its abort controller until its response body finishes or is cancelled. */
export function registerChatGPTRequest(userId: string, controller: AbortController): () => void {
  const set = controllers.get(userId) ?? new Set<AbortController>();
  set.add(controller); controllers.set(userId, set);
  return () => { set.delete(controller); if (!set.size) controllers.delete(userId); };
}
async function renew(row: Registration) {
  const tokens = credentials(row);
  if (!tokens.refreshToken) throw new OAuthError("terminal", "chatgpt_reconnect_required");
  const sent = db.prepare("UPDATE chatgpt_registrations SET refresh_state='sending' WHERE user_id=? AND id=? AND generation=? AND token_version=? AND refresh_state='idle' AND active=1").run(row.user_id, row.id, row.generation, row.token_version);
  if (!sent.changes) throw new OAuthError("uncertain");
  try {
    const next = await refreshTokens({ clientId: row.client_id, refreshToken: tokens.refreshToken });
    if (!next.refreshToken) throw new OAuthError("uncertain", "replacement_refresh_missing");
    if (next.idToken) await verifyIdToken(next.idToken, { clientId: row.client_id, subject: unseal<VerifiedIdentity>(row.user_id, row.id, row.identity_enc).subject });
    else next.idToken = tokens.idToken;
    const state = hasInferenceScopes(next.scopes) ? "ready" : "plan_disabled";
    const saved = db.prepare("UPDATE chatgpt_registrations SET credentials_enc=?,state=?,access_expires_at=?,token_version=token_version+1,refresh_state='idle',updated_at=? WHERE user_id=? AND id=? AND generation=? AND token_version=? AND refresh_state='sending' AND active=1").run(seal(row.user_id, row.id, next), state, next.accessExpiresAt, Date.now(), row.user_id, row.id, row.generation, row.token_version);
    if (!saved.changes) { await revokeRefreshToken({ clientId: row.client_id, refreshToken: next.refreshToken }); throw new OAuthError("terminal"); }
  } catch (error) {
    const terminal = error instanceof OAuthError && error.kind === "terminal";
    db.prepare("UPDATE chatgpt_registrations SET state='reconnect_required',refresh_state='uncertain',credentials_enc=CASE WHEN ? THEN NULL ELSE credentials_enc END,last_error_code=?,updated_at=? WHERE user_id=? AND id=? AND generation=? AND token_version=? AND refresh_state='sending'").run(terminal ? 1 : 0, terminal ? "chatgpt_reconnect_required" : "chatgpt_refresh_uncertain", Date.now(), row.user_id, row.id, row.generation, row.token_version);
    throw error;
  }
}
export async function chatgptAccess(userId: string, opts: { pin: Pin; rejectedVersion?: number; signal?: AbortSignal }): Promise<{ token: string; version: number }> {
  opts.signal?.throwIfAborted();
  // Waiters must join before checking refresh_state: the durable sending marker is deliberately unusable.
  const pending = flights.get(opts.pin.id);
  if (pending) await wait(pending, opts.signal);
  let row = pinned(userId, opts.pin);
  const tokens = credentials(row);
  if (tokens.accessExpiresAt <= Date.now() + 120_000 || opts.rejectedVersion === row.token_version) {
    let flight = flights.get(row.id);
    if (!flight) {
      flight = renew(row).finally(() => flights.delete(row.id));
      flights.set(row.id, flight);
    }
    await wait(flight, opts.signal);
    row = pinned(userId, opts.pin);
  }
  opts.signal?.throwIfAborted();
  return { token: credentials(row).accessToken, version: row.token_version };
}
async function wait<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
export function registrations(userId: string): ChatGPTRegistrationView[] {
  const rows = db.prepare("SELECT * FROM chatgpt_registrations WHERE user_id=? ORDER BY connected_at").all(userId) as unknown as Registration[];
  return rows.map(row => {
    const identity = unseal<VerifiedIdentity>(userId, row.id, row.identity_enc);
    const suffix = row.id.slice(-6);
    return { id: row.id, suffix, label: identity.name ?? identity.email ?? `ChatGPT account · ${suffix}`, ...(identity.email ? { email: identity.email } : {}), planLabel: "ChatGPT plan", state: row.state, active: !!row.active, renewable: !!(row.credentials_enc && credentials(row).refreshToken), accessExpiresAt: row.access_expires_at, connectedAt: row.connected_at, welcomeSeen: row.welcome_seen_at !== null, ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}) };
  });
}
export function activate(userId: string, id: string) {
  const row = ownRegistration(userId, id);
  if (!row?.credentials_enc || !["ready", "plan_disabled"].includes(row.state)) throw new OAuthError("invalid");
  transaction(() => {
    bump(userId);
    db.prepare("UPDATE chatgpt_registrations SET active=0,generation=generation+1 WHERE user_id=? AND active=1").run(userId);
    db.prepare("UPDATE chatgpt_registrations SET active=1,generation=generation+1 WHERE user_id=? AND id=?").run(userId, id);
  });
  changed(userId);
}
export async function disconnect(userId: string, id: string) {
  const row = ownRegistration(userId, id);
  if (!row) throw new OAuthError("invalid");
  const tokens = row.credentials_enc ? credentials(row) : undefined;
  transaction(() => {
    bump(userId);
    db.prepare("UPDATE chatgpt_registrations SET state='disconnected',active=0,generation=generation+1,credentials_enc=NULL,refresh_state='idle',access_expires_at=NULL WHERE user_id=? AND id=?").run(userId, id);
  });
  changed(userId);
  // A raced refresh discards and revokes its replacement itself before this function reports success.
  await flights.get(id)?.catch(() => {});
  return tokens?.refreshToken ? revokeRefreshToken({ clientId: row.client_id, refreshToken: tokens.refreshToken }) : "not_applicable" as const;
}
export function transaction<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const result = fn(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; }
}
export function deleteChatGPTUser(userId: string) { bump(userId); changed(userId); }
// A process restart cannot know whether the remote service rotated a token or spent a code.
db.exec("UPDATE chatgpt_registrations SET refresh_state='uncertain',state='reconnect_required',last_error_code='chatgpt_refresh_uncertain' WHERE refresh_state='sending'; UPDATE chatgpt_login_attempts SET status='failed',secrets_enc=NULL,error_code='chatgpt_login_expired' WHERE status IN ('preparing','waiting','exchanging');");
