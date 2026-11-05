import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  API_LIMITS,
  API_SCOPES,
  bitsFromScopes,
  scopesFromBits,
  type ApiKeySummary,
  type ApiPrincipal,
  type ApiScope,
  type CreateApiKeyInput,
  type CreateApiKeyResult,
} from "../../shared/api-access.js";
import { db, tx } from "../db.js";
import { AppError } from "../errors.js";
import { featureAllowed, policyInvalidError } from "../permissions/guard.js";
import { resolvePermissions } from "../permissions/resolve.js";
import { assertStorage, QuotaError } from "../quota.js";

// External API credentials (docs/implementation/api-access.md). A token is `okc_api_v1_<selector>.<secret>`.
// Only a domain-separated SHA-256 of the whole token is stored: a copied database cannot recover the
// secret, though a compromised running server still can. Selectors are public lookup material, never
// authentication, and are never derived from a label or user id.

const TOKEN_PREFIX = "okc_api_v1_";
const TOKEN_RE = /^okc_api_v1_[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/;
const SELECTOR_BYTES = 12;
const SECRET_BYTES = 32;
const HASH_DOMAIN = "okaychat:external-api:v1:";
const TOMBSTONE_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A fixed 32-byte dummy so an unknown selector costs the same comparison as a known one. */
const DUMMY_HASH = Buffer.alloc(32);

/** Test seam: deterministic entropy. Production never sets it. */
let entropy: (size: number) => Buffer = (size) => randomBytes(size);
export function setApiKeyEntropy(source: ((size: number) => Buffer) | null): void {
  entropy = source ?? ((size) => randomBytes(size));
}

const canonical = (bytes: Buffer): string => bytes.toString("base64url");

export function tokenHash(token: string): Buffer {
  return createHash("sha256").update(HASH_DOMAIN).update(token, "utf8").digest();
}

export interface ParsedToken {
  selector: string;
  hash: Buffer;
}

/**
 * Parses the wire token and verifies both base64url components are canonical (decoding and re-encoding
 * yields the same text). Anything else is indistinguishable from a missing credential.
 */
export function parseApiToken(token: string): ParsedToken | null {
  if (!TOKEN_RE.test(token)) return null;
  const body = token.slice(TOKEN_PREFIX.length);
  const dot = body.indexOf(".");
  const selectorText = body.slice(0, dot);
  const secretText = body.slice(dot + 1);
  const selector = Buffer.from(selectorText, "base64url");
  const secret = Buffer.from(secretText, "base64url");
  if (selector.length !== SELECTOR_BYTES || secret.length !== SECRET_BYTES) return null;
  if (canonical(selector) !== selectorText || canonical(secret) !== secretText) return null;
  return { selector: `${TOKEN_PREFIX}${selectorText}`, hash: tokenHash(token) };
}

interface KeyRow {
  id: string;
  user_id: string;
  prefix: string;
  secret_hash: Uint8Array;
  label: string;
  scopes: number;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
}

const KEY_COLUMNS = "id, user_id, prefix, secret_hash, label, scopes, created_at, expires_at, last_used_at, revoked_at";

export function statusOf(row: Pick<KeyRow, "revoked_at" | "expires_at">, now: number): ApiKeySummary["status"] {
  if (row.revoked_at !== null) return "revoked";
  if (row.expires_at !== null && now >= row.expires_at) return "expired";
  return "active";
}

const toSummary = (row: KeyRow, now: number): ApiKeySummary => ({
  id: row.id,
  label: row.label,
  prefix: row.prefix,
  scopes: scopesFromBits(row.scopes),
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  lastUsedAt: row.last_used_at,
  revokedAt: row.revoked_at,
  status: statusOf(row, now),
});

/** Code points (not UTF-16 units) and bytes, with C0/C1 controls refused. */
export function validLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.trim();
  if (!label) return null;
  if ([...label].length > API_LIMITS.labelCodePoints) return null;
  if (Buffer.byteLength(label, "utf8") > API_LIMITS.labelBytes) return null;
  for (const char of label) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return null;
  }
  return label;
}

/** Nonempty, unique subset of the known scopes, returned in canonical order. */
export function validScopes(value: unknown): ApiScope[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > API_SCOPES.length) return null;
  const seen = new Set<string>();
  for (const scope of value) {
    if (typeof scope !== "string" || !(API_SCOPES as readonly string[]).includes(scope)) return null;
    if (seen.has(scope)) return null;
    seen.add(scope);
  }
  return API_SCOPES.filter((scope) => seen.has(scope));
}

/** Optional expiry: an integer strictly after `now`, at most 366 days out. */
export function validExpiry(value: unknown, now: number): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return undefined;
  if (value <= now || value > now + API_LIMITS.keyMaxDays * DAY_MS) return undefined;
  return value;
}

export function listApiKeys(userId: string, now = Date.now()): ApiKeySummary[] {
  const rows = db
    .prepare(`SELECT ${KEY_COLUMNS} FROM api_keys WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(userId, API_LIMITS.retainedKeys) as unknown as KeyRow[];
  return rows.map((row) => toSummary(row, now));
}

export function getApiKey(userId: string, id: string): ApiKeySummary | null {
  const row = db.prepare(`SELECT ${KEY_COLUMNS} FROM api_keys WHERE user_id = ? AND id = ?`).get(userId, id) as KeyRow | undefined;
  return row ? toSummary(row, Date.now()) : null;
}

/** All-model feature state: the account can create keys and list models only while this is on. */
export function apiAccessEnabled(userId: string): boolean {
  // A broken stored policy fails closed with the authored 503 rather than reading as a plain denial.
  const effective = resolvePermissions(userId, null);
  if (effective.invalid) throw policyInvalidError();
  return featureAllowed(userId, "apiAccess", effective);
}

/** Exact-model feature state, which additionally filters every listed model and completion. */
export function apiModelAllowed(userId: string, modelRef: string): boolean {
  const effective = resolvePermissions(userId, modelRef);
  if (effective.invalid) throw policyInvalidError();
  return featureAllowed({ userId, modelRef }, "apiAccess", effective);
}

// Live revocation listeners ---------------------------------------------------------------------------

type RevocationListener = (userId: string, keyId: string) => void;
const revocationListeners = new Set<RevocationListener>();

/** Registers a local notification for an immediate abort. Polling still covers expiry and policy changes. */
export function onApiKeyRevoked(listener: RevocationListener): () => void {
  revocationListeners.add(listener);
  return () => revocationListeners.delete(listener);
}

function notifyRevoked(userId: string, keyId: string): void {
  for (const listener of revocationListeners) {
    try {
      listener(userId, keyId);
    } catch {
      // A failing listener must not undo the committed revocation.
    }
  }
}

// Lifecycle ---------------------------------------------------------------------------------------------

function pruneTombstones(userId: string, now: number): void {
  const cutoff = now - TOMBSTONE_MS;
  const rows = db
    .prepare(
      `SELECT id, revoked_at, expires_at FROM api_keys
       WHERE user_id = ? AND (revoked_at IS NOT NULL OR expires_at IS NOT NULL)
         AND COALESCE(revoked_at, expires_at) <= ?`,
    )
    .all(userId, cutoff) as Array<{ id: string; revoked_at: number | null; expires_at: number | null }>;
  for (const row of rows) {
    // An expired key records one retained lifecycle event before its metadata is purged. A revoked key
    // already has its revocation event, so it never gains an expired one.
    if (row.revoked_at === null) {
      db.prepare("INSERT OR IGNORE INTO api_key_audit (user_id, key_id, event, created_at) VALUES (?, ?, 'expired', ?)").run(userId, row.id, now);
    }
    db.prepare("DELETE FROM api_keys WHERE id = ? AND user_id = ?").run(row.id, userId);
  }
}

function activeCount(userId: string, now: number): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .get(userId, now) as { n: number }
  ).n;
}

function retainedCount(userId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ?").get(userId) as { n: number }).n;
}

function audit(userId: string, keyId: string, event: "created" | "revoked" | "password_revoked" | "expired", now: number): void {
  db.prepare("INSERT INTO api_key_audit (user_id, key_id, event, created_at) VALUES (?, ?, ?, ?)").run(userId, keyId, event, now);
  pruneAudit(userId);
}

export function pruneAudit(userId: string): void {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM api_key_audit WHERE user_id = ?").get(userId) as { n: number };
  if (n > API_LIMITS.auditRetentionRows) {
    db.prepare(
      `DELETE FROM api_key_audit WHERE id IN (
         SELECT id FROM api_key_audit WHERE user_id = ? ORDER BY id ASC LIMIT ?)`,
    ).run(userId, n - API_LIMITS.auditRetentionRows);
  }
  db.prepare("DELETE FROM api_key_audit WHERE user_id = ? AND created_at < ?").run(userId, Date.now() - API_LIMITS.auditRetentionDays * DAY_MS);
}

function insertKey(userId: string, label: string, scopes: ApiScope[], expiresAt: number | null, now: number): { row: KeyRow; secret: string } {
  for (let attempt = 0; attempt < API_LIMITS.createRetries; attempt++) {
    const selector = canonical(entropy(SELECTOR_BYTES));
    const secret = canonical(entropy(SECRET_BYTES));
    const token = `${TOKEN_PREFIX}${selector}.${secret}`;
    const prefix = `${TOKEN_PREFIX}${selector}`;
    const id = `apk_${canonical(entropy(12))}`;
    try {
      db.prepare(
        `INSERT INTO api_keys (id, user_id, prefix, secret_hash, label, scopes, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, userId, prefix, tokenHash(token), label, bitsFromScopes(scopes), now, expiresAt);
      const row = db.prepare(`SELECT ${KEY_COLUMNS} FROM api_keys WHERE id = ?`).get(id) as unknown as KeyRow;
      return { row, secret: token };
    } catch (error) {
      if (String((error as Error).message).includes("UNIQUE") && attempt < API_LIMITS.createRetries - 1) continue;
      throw error;
    }
  }
  // Every selector collided: entropy is broken or the table is exhausted.
  throw new AppError({ code: "unknown", status: 500, message: "The API key could not be created. Try again." });
}

/**
 * Creates one key. Pruning, the storage reservation, both count limits, the insert, and its audit row
 * happen synchronously in one transaction, so concurrent creates cannot exceed the limits.
 */
export function createApiKey(userId: string, input: CreateApiKeyInput, now = Date.now()): CreateApiKeyResult {
  const label = validLabel(input.label);
  if (!label) throw new AppError({ code: "validation", message: "Enter a label of 1 to 80 characters without control characters." });
  const scopes = validScopes(input.scopes);
  if (!scopes) throw new AppError({ code: "validation", message: "Choose at least one valid scope." });
  const expiresAt = validExpiry(input.expiresAt, now);
  if (expiresAt === undefined) throw new AppError({ code: "validation", message: "Choose a future expiry within 366 days." });
  if (!apiAccessEnabled(userId)) {
    throw new AppError({ code: "forbidden", message: "Your administrator has disabled external API access." });
  }
  return tx(() => {
    pruneTombstones(userId, now);
    assertStorage(userId, API_LIMITS.keyBytes);
    if (activeCount(userId, now) >= API_LIMITS.activeKeys) {
      throw new AppError({ code: "conflict", message: `You have ${API_LIMITS.activeKeys} active API keys. Revoke one first.` });
    }
    if (retainedCount(userId) >= API_LIMITS.retainedKeys) {
      throw new AppError({ code: "conflict", message: "You have reached the retained API key limit. Revoke keys and try again later." });
    }
    const { row, secret } = insertKey(userId, label, scopes, expiresAt, now);
    audit(userId, row.id, "created", now);
    return { key: toSummary(row, now), secret };
  });
}

/**
 * Revokes one key. A repeat is idempotent and returns the original timestamp without a second audit row.
 * Works when storage is full: revocation only clears a flag and adds bounded metadata.
 */
export function revokeApiKey(userId: string, id: string, now = Date.now()): ApiKeySummary | null {
  const existing = db.prepare(`SELECT ${KEY_COLUMNS} FROM api_keys WHERE user_id = ? AND id = ?`).get(userId, id) as KeyRow | undefined;
  if (!existing) return null;
  const changed = tx(() => {
    const result = db
      .prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
      .run(now, id, userId);
    if (Number(result.changes) > 0) audit(userId, id, "revoked", now);
    return Number(result.changes) > 0;
  });
  if (changed) notifyRevoked(userId, id);
  const row = db.prepare(`SELECT ${KEY_COLUMNS} FROM api_keys WHERE user_id = ? AND id = ?`).get(userId, id) as unknown as KeyRow;
  return toSummary(row, now);
}

/** Recovery: every key of the account is revoked in the caller's transaction. */
export function revokeAllApiKeys(userId: string, event: "password_revoked", now = Date.now()): number {
  const rows = db.prepare("SELECT id FROM api_keys WHERE user_id = ? AND revoked_at IS NULL").all(userId) as Array<{ id: string }>;
  for (const row of rows) {
    db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL").run(now, row.id, userId);
    audit(userId, row.id, event, now);
  }
  return rows.length;
}

/** Called after the recovery transaction commits, so live calls stop. */
export function notifyAllRevoked(userId: string): void {
  const rows = db.prepare("SELECT id FROM api_keys WHERE user_id = ? AND revoked_at IS NOT NULL").all(userId) as Array<{ id: string }>;
  for (const row of rows) notifyRevoked(userId, row.id);
}

// Authentication ----------------------------------------------------------------------------------------

export interface AuthenticatedKey {
  principal: ApiPrincipal;
  expiresAt: number | null;
}

/**
 * Looks up a bearer token and returns its principal only while the key is live. Unknown selectors run the
 * same fixed-length comparison against a dummy digest, so timing does not reveal whether a key exists.
 */
export function authenticateApiToken(token: string, now = Date.now()): AuthenticatedKey | null {
  const parsed = parseApiToken(token);
  if (!parsed) return null;
  const row = db.prepare(`SELECT ${KEY_COLUMNS} FROM api_keys WHERE prefix = ?`).get(parsed.selector) as KeyRow | undefined;
  const expected = row ? Buffer.from(row.secret_hash) : DUMMY_HASH;
  const matches = expected.length === parsed.hash.length && timingSafeEqual(expected, parsed.hash);
  if (!row || !matches) return null;
  if (row.revoked_at !== null) return null;
  if (row.expires_at !== null && now >= row.expires_at) return null;
  const scopes = scopesFromBits(row.scopes);
  // A corrupted bitmap fails closed rather than granting a scope.
  if (!scopes.length) return null;
  return { principal: { userId: row.user_id, keyId: row.id, scopes }, expiresAt: row.expires_at };
}

/** True while the credential is still live: used by admission and the once-a-second mid-call recheck. */
export function principalAlive(principal: ApiPrincipal, now = Date.now()): boolean {
  const row = db.prepare("SELECT revoked_at, expires_at, scopes FROM api_keys WHERE id = ? AND user_id = ?")
    .get(principal.keyId, principal.userId) as { revoked_at: number | null; expires_at: number | null; scopes: number } | undefined;
  if (!row || row.revoked_at !== null) return false;
  if (row.expires_at !== null && now >= row.expires_at) return false;
  const scopes = scopesFromBits(row.scopes);
  return scopes.length > 0 && principal.scopes.every((scope) => scopes.includes(scope));
}

/** The successful-auth timestamp includes authorized calls with a bad body or scope, not only paid calls. */
export function markKeyUsed(keyId: string, now = Date.now()): void {
  db.prepare("UPDATE api_keys SET last_used_at = MAX(COALESCE(last_used_at, 0), ?) WHERE id = ?").run(now, keyId);
}

export function hasScope(principal: ApiPrincipal, scope: ApiScope): boolean {
  return principal.scopes.includes(scope);
}

/** Quota failures keep their 413 wire code when a key creation is rejected. */
export const isQuotaError = (error: unknown): error is QuotaError => error instanceof QuotaError;
