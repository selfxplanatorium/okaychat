import { assertFeature, featureAllowed } from "../permissions/guard.js";
import { isRestrictedKnowledgeThread, ownsThreadRow } from "../knowledge/thread-policy.js";
import { afterCommit, db, tx } from "../db.js";
import { decrypt, encrypt, newId, sha256 } from "../crypto.js";
import { AppError } from "../errors.js";
import { assertStorage, QuotaError } from "../quota.js";
import { channelEligibility, channelRow } from "../channels/access.js";
import type { ChannelVisibility } from "../../shared/channels.js";
import { encodeCursor } from "./schemas.js";
import {
  TEXT_EVENT_TYPES,
  WEBHOOK_LIMITS,
  WEBHOOK_TEST_SAMPLE,
  isProductionEventType,
  type DeliveryAttempt,
  type DeliveryDetail,
  type DeliveryErrorCode,
  type DeliveryPage,
  type DeliveryStatus,
  type DeliverySummary,
  type EndpointCreateInput,
  type EndpointCreateResult,
  type EndpointDetail,
  type EndpointPatchInput,
  type EndpointSummary,
  type EventMap,
  type EventType,
  type OutgoingEnvelope,
  type ProductionEventType,
  type RequestPreview,
  type TextProjection,
} from "../../shared/outgoing-webhooks.js";
import { decodeCursor, applyHeaderChanges, textProjection, trimmedName, validateChannelIds, validateEndpointUrl, validateHeaders, validateSubscriptions } from "./schemas.js";
import { webhookKeyId, webhookSecret } from "./signatures.js";
import { abortEndpointSends, wakeOutbox } from "./runtime.js";

/**
 * Owner-scoped endpoint, outbox, test-preparation, and rate stores for outgoing webhooks.
 * Every read/write binds the owner id in SQL; a foreign id is indistinguishable from a missing one.
 * Source writes and outbox inserts share the caller's transaction, and every endpoint admission is a
 * nested savepoint so a quota/cap/projection failure drops only that endpoint's copy.
 */

interface EndpointRow {
  id: string;
  user_id: string;
  name: string;
  config_enc: string;
  signing_secret_enc: string;
  key_id: string;
  subscriptions_json: string;
  channel_ids_json: string;
  include_message_text: number;
  enabled: number;
  revision: number;
  next_sequence: number;
  consecutive_failures: number;
  failed_attempts: number;
  dropped_count: number;
  last_drop_reason: "quota" | "capacity" | "rate" | "projection" | null;
  last_drop_at: number | null;
  auto_disabled_at: number | null;
  last_delivery_id: string | null;
  last_status: "succeeded" | "failed" | null;
  last_http_status: number | null;
  last_attempt_at: number | null;
  last_duration_ms: number | null;
  created_at: number;
  updated_at: number;
}

export interface DeliveryRow {
  id: string;
  endpoint_id: string;
  user_id: string;
  endpoint_revision: number;
  event_id: string;
  event_type: string;
  sequence: number;
  occurred_at: number;
  created_at: number;
  body_enc: string | null;
  source_thread_id: string | null;
  source_channel_id: string | null;
  source_message_id: string | null;
  source_root_id: string | null;
  status: DeliveryStatus;
  version: number;
  attempts: number;
  attempts_json: string;
  next_attempt_at: number;
  last_error_code: DeliveryErrorCode | null;
  last_http_status: number | null;
  finished_at: number | null;
  is_test: number;
  /** SQLite's decimal text form, so a sequence never passes through JS number arithmetic. */
  sequence_text?: string;
}

interface Config {
  url: string;
  headers: Record<string, string>;
}

const conflict = (message: string, details?: unknown) =>
  new AppError({ code: "conflict", status: 409, message, ...(details === undefined ? {} : { details }) });

const notFound = () => new AppError({ code: "not_found", message: "Webhook endpoint not found." });

export const endpointRow = (userId: string, id: string): EndpointRow | undefined =>
  db.prepare("SELECT * FROM outgoing_webhook_endpoints WHERE id = ? AND user_id = ?").get(id, userId) as EndpointRow | undefined;

export const deliveryRow = (userId: string, endpointId: string, deliveryId: string): DeliveryRow | undefined =>
  db
    .prepare("SELECT *, CAST(sequence AS TEXT) AS sequence_text FROM outgoing_webhook_deliveries WHERE id = ? AND endpoint_id = ? AND user_id = ?")
    .get(deliveryId, endpointId, userId) as DeliveryRow | undefined;

function configOf(row: EndpointRow): Config {
  try {
    const raw = JSON.parse(decrypt(row.config_enc)) as Partial<Config>;
    return {
      url: typeof raw.url === "string" ? raw.url : "",
      headers: raw.headers && typeof raw.headers === "object" ? (raw.headers as Record<string, string>) : {},
    };
  } catch {
    // A row that cannot be decrypted is still listable without leaking ciphertext or breaking the page.
    return { url: "", headers: {} };
  }
}

function subscriptionsOf(row: EndpointRow): ProductionEventType[] {
  try {
    const parsed = JSON.parse(row.subscriptions_json) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isProductionEventType) : [];
  } catch {
    return [];
  }
}

function channelIdsOf(row: EndpointRow): string[] {
  try {
    const parsed = JSON.parse(row.channel_ids_json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function hostnameOf(row: EndpointRow): string {
  try {
    return new URL(configOf(row).url).hostname;
  } catch {
    return "invalid";
  }
}

/**
 * A chat that ever used another account's shared knowledge is never redistributable (shares, exports,
 * archives, schedules), even while its dependencies resolve, so it never leaves through a webhook either.
 */
function threadExportable(userId: string, threadId: string): boolean {
  return ownsThreadRow(userId, threadId) && !isRestrictedKnowledgeThread(threadId);
}

const endpointReservation = (name: string, configEnc: string, secretEnc: string) =>
  Buffer.byteLength(name) + Buffer.byteLength(configEnc) + Buffer.byteLength(secretEnc) + 2048;

function saturateSql(column: string): string {
  return `MIN(${column} + 1, 9007199254740991)`;
}

const attemptLog = (json: string): DeliveryAttempt[] => {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is DeliveryAttempt => typeof value === "object" && value !== null && typeof (value as DeliveryAttempt).number === "number").slice(-10);
  } catch {
    return [];
  }
};

function canRetryRow(row: DeliveryRow, endpoint: EndpointRow): boolean {
  if (row.is_test) return false;
  if (row.status !== "dead") return false;
  if (!endpoint.enabled) return false;
  if (row.endpoint_revision !== endpoint.revision) return false;
  if (row.attempts >= WEBHOOK_LIMITS.totalAttempts) return false;
  if (row.created_at < Date.now() - WEBHOOK_LIMITS.bodyRetentionMs) return false;
  return sourceAccessible(row, endpoint);
}

function summaryOf(row: EndpointRow, userId: string): EndpointSummary {
  const counts = db
    .prepare(
      `SELECT
        COALESCE(SUM(CASE WHEN status IN ('queued','sending','backoff') THEN 1 ELSE 0 END), 0) AS pending,
        COALESCE(SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END), 0) AS dead,
        MIN(CASE WHEN status IN ('queued','sending','backoff') THEN created_at END) AS oldest
       FROM outgoing_webhook_deliveries WHERE endpoint_id = ? AND user_id = ?`,
    )
    .get(row.id, userId) as { pending: number; dead: number; oldest: number | null };
  return {
    id: row.id,
    name: row.name,
    hostname: hostnameOf(row),
    enabled: !!row.enabled,
    revision: row.revision,
    subscriptions: subscriptionsOf(row),
    channelIds: channelIdsOf(row),
    includeMessageText: !!row.include_message_text,
    keyId: row.key_id,
    headerNames: Object.keys(configOf(row).headers).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    consecutiveFailures: row.consecutive_failures,
    failedAttempts: row.failed_attempts,
    droppedCount: row.dropped_count,
    lastDropReason: row.last_drop_reason,
    lastDropAt: row.last_drop_at,
    autoDisabledAt: row.auto_disabled_at,
    pendingCount: counts.pending,
    deadCount: counts.dead,
    oldestPendingAt: counts.oldest,
    lastDelivery:
      row.last_delivery_id && row.last_status && row.last_attempt_at !== null
        ? {
            id: row.last_delivery_id,
            status: row.last_status,
            httpStatus: row.last_http_status,
            attemptedAt: row.last_attempt_at,
            durationMs: row.last_duration_ms ?? 0,
          }
        : null,
  };
}

export function detailOf(row: EndpointRow, userId: string): EndpointDetail {
  return { ...summaryOf(row, userId), url: configOf(row).url, hasSigningSecret: true };
}

export function listEndpoints(userId: string): EndpointSummary[] {
  const rows = db
    .prepare("SELECT * FROM outgoing_webhook_endpoints WHERE user_id = ? ORDER BY created_at DESC, id DESC")
    .all(userId) as unknown as EndpointRow[];
  return rows.map((row) => summaryOf(row, userId));
}

export function getEndpoint(userId: string, id: string): EndpointDetail | undefined {
  const row = endpointRow(userId, id);
  return row ? detailOf(row, userId) : undefined;
}

/** Save-time room scope: only currently owned rooms, never DMs, never archived rooms. */
function assertOwnedRooms(userId: string, channelIds: string[]): void {
  for (const id of channelIds) {
    const row = db.prepare("SELECT owner_id, kind, archived_at, visibility FROM channels WHERE id = ?").get(id) as
      | { owner_id: string; kind: string; archived_at: number | null; visibility: ChannelVisibility }
      | undefined;
    if (!row || row.owner_id !== userId || row.kind !== "room" || row.archived_at !== null || !channelEligibility(userId, { id, visibility: row.visibility })) {
      throw new AppError({ code: "validation", message: "A selected room is not one you currently own." });
    }
  }
}

function assertChannelEventEligible(userId: string, row: EndpointRow, channelId: string, messageId: string | null, deletion: boolean): boolean {
  if (!channelIdsOf(row).includes(channelId)) return false;
  if (!featureAllowed({ userId, modelRef: null }, "channels")) return false;
  const channel = channelRow(channelId);
  if (!channel || channel.owner_id !== userId || channel.kind !== "room" || channel.archived_at !== null) return false;
  // Group-scoped rooms close even for their owner after a group removal; the export closes with them.
  if (!channelEligibility(userId, channel)) return false;
  if (deletion || !messageId) return true;
  return !!db.prepare("SELECT 1 FROM channel_messages WHERE channel_id = ? AND id = ? AND deleted_at IS NULL").get(channelId, messageId);
}

/** Live source authority for a stored row. Used by dispatch, log reads, and manual retry. */
export function sourceAccessible(row: DeliveryRow, endpoint?: EndpointRow): boolean {
  if (row.is_test) return true;
  switch (row.event_type) {
    case "chat.turn.completed":
    case "chat.turn.failed":
      return !!row.source_thread_id && threadExportable(row.user_id, row.source_thread_id);
    case "schedule.run.completed":
    case "schedule.run.failed":
      if (!featureAllowed({ userId: row.user_id, modelRef: null }, "schedules")) return false;
      return !row.source_thread_id || threadExportable(row.user_id, row.source_thread_id);
    case "channel.message.created":
    case "channel.message.edited":
    case "channel.mention":
      if (!row.source_channel_id) return false;
      if (row.source_root_id && !db.prepare("SELECT 1 FROM channel_messages WHERE channel_id = ? AND id = ? AND deleted_at IS NULL").get(row.source_channel_id, row.source_root_id)) return false;
      return !!endpoint && assertChannelEventEligible(row.user_id, endpoint, row.source_channel_id, row.source_message_id, false);
    case "channel.message.deleted":
      if (!row.source_channel_id) return false;
      return !!endpoint && assertChannelEventEligible(row.user_id, endpoint, row.source_channel_id, row.source_message_id, true);
    case "archive.export.finished":
    case "archive.import.finished":
      return true;
    default:
      return false;
  }
}

export function createEndpoint(userId: string, input: EndpointCreateInput): EndpointCreateResult {
  assertFeature(userId, "outgoingWebhooks");
  const name = trimmedName(input.name);
  const url = validateEndpointUrl(input.url);
  const headers = Object.fromEntries(validateHeaders(input.headers));
  const subscriptions = validateSubscriptions(input.subscriptions);
  const channelIds = validateChannelIds(input.channelIds);
  const now = Date.now();
  return tx(() => {
    const account = (db.prepare("SELECT COUNT(*) AS n FROM outgoing_webhook_endpoints WHERE user_id = ?").get(userId) as { n: number }).n;
    if (account >= WEBHOOK_LIMITS.endpointsPerAccount) throw conflict(`You already have ${WEBHOOK_LIMITS.endpointsPerAccount} endpoints. Delete one first.`);
    const process = (db.prepare("SELECT COUNT(*) AS n FROM outgoing_webhook_endpoints").get() as { n: number }).n;
    if (process >= WEBHOOK_LIMITS.endpointsPerProcess) throw conflict("This server has reached its webhook endpoint limit. Try again later.");
    assertOwnedRooms(userId, channelIds);
    const secret = webhookSecret();
    const config: Config = { url, headers };
    const configEnc = encrypt(JSON.stringify(config));
    const secretEnc = encrypt(secret);
    assertStorage(userId, endpointReservation(name, configEnc, secretEnc));
    const id = newId("wh");
    db.prepare(
      `INSERT INTO outgoing_webhook_endpoints
       (id, user_id, name, config_enc, signing_secret_enc, key_id, subscriptions_json, channel_ids_json,
        include_message_text, enabled, revision, next_sequence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 1, ?, ?)`,
    ).run(
      id,
      userId,
      name,
      configEnc,
      secretEnc,
      webhookKeyId(),
      JSON.stringify(subscriptions),
      JSON.stringify(channelIds),
      input.includeMessageText ? 1 : 0,
      now,
      now,
    );
    return { endpoint: detailOf(endpointRow(userId, id)!, userId), signingSecret: secret };
  });
}

/** Cancels unsent work and invalidates prepared tests. Active controllers are aborted best-effort. */
export function cancelEndpointWork(endpointId: string, options: { scrubText?: boolean } = {}): void {
  const now = Date.now();
  db.prepare(
    `UPDATE outgoing_webhook_deliveries SET status = 'cancelled', version = version + 1, finished_at = ?
     WHERE endpoint_id = ? AND status IN ('queued','backoff','sending')`,
  ).run(now, endpointId);
  if (options.scrubText) {
    db.prepare(
      `UPDATE outgoing_webhook_deliveries SET body_enc = NULL
       WHERE endpoint_id = ? AND status = 'cancelled'`,
    ).run(endpointId);
  }
  db.prepare("DELETE FROM outgoing_webhook_test_preparations WHERE endpoint_id = ? AND consumed_at IS NULL").run(endpointId);
  afterCommit(() => abortEndpointSends(endpointId));
}

export function updateEndpoint(userId: string, id: string, patch: EndpointPatchInput): EndpointDetail {
  const cleanupDisable = patch.enabled === false && Object.keys(patch).every((key) => key === "revision" || key === "enabled");
  // Turning an endpoint off must stay possible after an administrator denies the feature, so the owner
  // can stop future exports while they clean up. Every other management write needs the feature.
  if (!cleanupDisable) assertFeature(userId, "outgoingWebhooks");
  return tx(() => {
    const row = endpointRow(userId, id);
    if (!row) throw notFound();
    if (row.revision !== patch.revision) {
      throw conflict("This endpoint changed. Reload and try again.", { endpoint: detailOf(row, userId) });
    }
    const current = configOf(row);
    let config = current;
    if (patch.url !== undefined && patch.url !== current.url) {
      if (patch.headerChanges !== undefined) throw new AppError({ code: "validation", message: "A URL change must send the complete header set." });
      if (patch.replaceHeaders === undefined) throw new AppError({ code: "validation", message: "A URL change must replace the headers too." });
      config = { url: validateEndpointUrl(patch.url), headers: Object.fromEntries(validateHeaders(patch.replaceHeaders)) };
    } else if (patch.replaceHeaders !== undefined) {
      throw new AppError({ code: "validation", message: "Replace headers only when the URL changes." });
    } else if (patch.headerChanges !== undefined) {
      config = { url: current.url, headers: Object.fromEntries(applyHeaderChanges(Object.entries(current.headers), patch.headerChanges)) };
    }
    const name = patch.name === undefined ? row.name : trimmedName(patch.name);
    const subscriptions = patch.subscriptions === undefined ? subscriptionsOf(row) : validateSubscriptions(patch.subscriptions);
    const channelIds = patch.channelIds === undefined ? channelIdsOf(row) : validateChannelIds(patch.channelIds);
    const includeText = patch.includeMessageText ?? !!row.include_message_text;
    const enabled = patch.enabled ?? !!row.enabled;
    if (patch.channelIds) assertOwnedRooms(userId, channelIds);
    if (patch.subscriptions === undefined && patch.channelIds === undefined && patch.name === undefined &&
        patch.url === undefined && patch.headerChanges === undefined && patch.includeMessageText === undefined && patch.enabled === undefined) {
      return detailOf(row, userId);
    }
    const configEnc = encrypt(JSON.stringify(config));
    const secretEnc = row.signing_secret_enc;
    const growth = endpointReservation(name, configEnc, secretEnc) - endpointReservation(row.name, row.config_enc, row.signing_secret_enc);
    if (growth > 0) assertStorage(userId, growth);
    const now = Date.now();
    db.prepare(
      `UPDATE outgoing_webhook_endpoints SET name = ?, config_enc = ?, subscriptions_json = ?, channel_ids_json = ?,
        include_message_text = ?, enabled = ?, revision = revision + 1, consecutive_failures = 0,
        auto_disabled_at = CASE WHEN ? = 1 THEN NULL ELSE auto_disabled_at END, updated_at = ?
       WHERE id = ? AND user_id = ? AND revision = ?`,
    ).run(
      name,
      configEnc,
      JSON.stringify([...subscriptions].sort()),
      JSON.stringify([...channelIds].sort()),
      includeText ? 1 : 0,
      enabled ? 1 : 0,
      enabled ? 1 : 0,
      now,
      id,
      userId,
      patch.revision,
    );
    const wasText = !!row.include_message_text;
    cancelEndpointWork(id, { scrubText: wasText && !includeText });
    return detailOf(endpointRow(userId, id)!, userId);
  });
}

export function deleteEndpoint(userId: string, id: string, revision: number): void {
  tx(() => {
    const row = endpointRow(userId, id);
    if (!row) throw notFound();
    if (row.revision !== revision) throw conflict("This endpoint changed. Reload and try again.", { endpoint: detailOf(row, userId) });
    db.prepare("DELETE FROM outgoing_webhook_endpoints WHERE id = ? AND user_id = ?").run(id, userId);
    afterCommit(() => abortEndpointSends(id));
  });
}

export function setEndpointEnabled(userId: string, id: string, revision: number, enabled: boolean): EndpointDetail {
  return updateEndpoint(userId, id, { revision, enabled });
}

export function rotateSecret(userId: string, id: string, revision: number): { endpoint: EndpointDetail; signingSecret: string } {
  assertFeature(userId, "outgoingWebhooks");
  return tx(() => {
    const row = endpointRow(userId, id);
    if (!row) throw notFound();
    if (row.revision !== revision) throw conflict("This endpoint changed. Reload and try again.", { endpoint: detailOf(row, userId) });
    const secret = webhookSecret();
    const secretEnc = encrypt(secret);
    const growth = endpointReservation(row.name, row.config_enc, secretEnc) - endpointReservation(row.name, row.config_enc, row.signing_secret_enc);
    if (growth > 0) assertStorage(userId, growth);
    db.prepare(
      `UPDATE outgoing_webhook_endpoints SET signing_secret_enc = ?, key_id = ?, enabled = 0, revision = revision + 1,
        consecutive_failures = 0, updated_at = ? WHERE id = ? AND user_id = ?`,
    ).run(secretEnc, webhookKeyId(), Date.now(), id, userId);
    cancelEndpointWork(id, { scrubText: false });
    return { endpoint: detailOf(endpointRow(userId, id)!, userId), signingSecret: secret };
  });
}

function consumeWindow(scope: string, userId: string, bucketId: string, minute: number, limit: number): boolean {
  const result = db
    .prepare(
      `INSERT INTO outgoing_webhook_rate_windows (scope, user_id, bucket_id, minute, count) VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(scope, user_id, bucket_id, minute) DO UPDATE SET count = count + 1 WHERE count < ?`,
    )
    .run(scope, userId, bucketId, minute, limit);
  return result.changes > 0;
}

export function consumeManagementRate(userId: string): void {
  const now = Date.now();
  if (!consumeWindow("management", userId, "", Math.floor(now / 60_000), WEBHOOK_LIMITS.managementPerAccountMinute)) {
    throw new AppError({ code: "rate_limited", status: 429, message: "Too many webhook changes. Wait a minute and try again.", retryAfterMs: 60_000 - (now % 60_000) });
  }
}

export function consumeTestRate(userId: string): void {
  const now = Date.now();
  if (!consumeWindow("test", userId, "", Math.floor(now / 60_000), WEBHOOK_LIMITS.testsPerAccountMinute)) {
    throw new AppError({ code: "rate_limited", status: 429, message: "Too many webhook tests. Wait a minute and try again.", retryAfterMs: 60_000 - (now % 60_000) });
  }
}

/** Endpoint sequence lives in SQLite: JS never performs arithmetic above the safe integer range. */
function allocateSequence(endpointId: string): string {
  db.prepare("UPDATE outgoing_webhook_endpoints SET next_sequence = next_sequence + 1 WHERE id = ?").run(endpointId);
  return (db.prepare("SELECT CAST(next_sequence - 1 AS TEXT) AS value FROM outgoing_webhook_endpoints WHERE id = ?").get(endpointId) as { value: string }).value;
}

function dataHasText(data: unknown): boolean {
  return !!data && typeof data === "object" && (data as Record<string, unknown>).text !== undefined;
}

function validTextProjection(data: Record<string, unknown>): boolean {
  const value = data.text;
  if (value === undefined) return true;
  if (!value || typeof value !== "object") return false;
  const projection = value as { value?: unknown; truncated?: unknown };
  return typeof projection.value === "string" && typeof projection.truncated === "boolean";
}

function envelopeFor(
  eventId: string,
  deliveryId: string,
  sequence: string,
  occurredAt: number,
  type: string,
  data: Record<string, unknown>,
): OutgoingEnvelope {
  return {
    specVersion: 1,
    eventId,
    deliveryId,
    sequence,
    occurredAt,
    type,
    data,
  } as unknown as OutgoingEnvelope;
}

function bodyBytes(plain: string): number {
  return Buffer.byteLength(plain, "utf8");
}

function noteDrop(endpointId: string, reason: "quota" | "capacity" | "rate" | "projection", now: number): void {
  db.prepare(
    `UPDATE outgoing_webhook_endpoints SET dropped_count = ${saturateSql("dropped_count")}, last_drop_reason = ?, last_drop_at = ? WHERE id = ?`,
  ).run(reason, now, endpointId);
}

function activeCount(where: string, value: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM outgoing_webhook_deliveries WHERE ${where} AND status IN ('queued','sending','backoff')`).get(value) as { n: number }).n;
}

export interface AdmissionInput<K extends ProductionEventType> {
  userId: string;
  type: K;
  /** Stable identity excluding the outcome. Re-admitting the same key is a no-op. */
  sourceKey: string;
  occurredAt?: number;
  threadId?: string | null;
  channelId?: string | null;
  messageId?: string | null;
  rootId?: string | null;
  /** Visible text, projected only for endpoints that opted in. */
  text?: string;
  data: (text: TextProjection | undefined) => EventMap[K];
}

/**
 * Admits one source event to every eligible endpoint. Must run inside the source transaction: a
 * rolled-back source leaves no outbox row, and each endpoint's admission can fail independently.
 */
export function admitEvent<K extends ProductionEventType>(input: AdmissionInput<K>): void {
  if (!featureAllowed({ userId: input.userId, modelRef: null }, "outgoingWebhooks")) return;
  if (input.type.startsWith("channel.") && !featureAllowed({ userId: input.userId, modelRef: null }, "channels")) return;
  if (input.type.startsWith("schedule.") && !featureAllowed({ userId: input.userId, modelRef: null }, "schedules")) return;
  const now = Date.now();
  const occurredAt = Number.isSafeInteger(input.occurredAt) ? input.occurredAt! : now;
  const eventId = `whe_${sha256(JSON.stringify([1, input.userId, input.sourceKey]))}`;
  const endpoints = db
    .prepare("SELECT * FROM outgoing_webhook_endpoints WHERE user_id = ? AND enabled = 1 ORDER BY id")
    .all(input.userId) as unknown as EndpointRow[];
  if (!endpoints.length) return;
  pruneAccount(input.userId, now);
  pruneGlobal(now);
  let admitted = false;
  for (const endpoint of endpoints) {
    if (!subscriptionsOf(endpoint).includes(input.type)) continue;
    if (input.type.startsWith("channel.") && input.channelId) {
      const deletion = input.type === "channel.message.deleted";
      if (!assertChannelEventEligible(input.userId, endpoint, input.channelId, input.messageId ?? null, deletion)) continue;
    }
    if ((input.type === "chat.turn.completed" || input.type === "chat.turn.failed") && input.threadId) {
      if (!threadExportable(input.userId, input.threadId)) continue;
    }
    if ((input.type === "schedule.run.completed" || input.type === "schedule.run.failed") && input.threadId) {
      if (!threadExportable(input.userId, input.threadId)) continue;
    }
    const admission = (() => {
      try {
        return tx(() => {
          // A replayed source write is the same event for this endpoint; do not spend a sequence, a
          // minute-window slot, or a durable reservation on it.
          if (db.prepare("SELECT 1 FROM outgoing_webhook_deliveries WHERE endpoint_id = ? AND event_id = ?").get(endpoint.id, eventId)) {
            return "duplicate" as const;
          }
          const minute = Math.floor(now / 60_000);
          if (activeCount("endpoint_id = ?", endpoint.id) >= WEBHOOK_LIMITS.activePerEndpoint) return "capacity" as const;
          if (activeCount("user_id = ?", input.userId) >= WEBHOOK_LIMITS.activePerAccount) return "capacity" as const;
          const process = (db.prepare("SELECT COUNT(*) AS n FROM outgoing_webhook_deliveries WHERE status IN ('queued','sending','backoff')").get() as { n: number }).n;
          if (process >= WEBHOOK_LIMITS.activePerProcess) return "capacity" as const;
          const stored = (db.prepare("SELECT COUNT(*) AS n FROM outgoing_webhook_deliveries").get() as { n: number }).n;
          if (stored >= WEBHOOK_LIMITS.deliveryRowsPerProcess) return "capacity" as const;
          if (!consumeWindow("admission", input.userId, "", minute, WEBHOOK_LIMITS.admissionsPerAccountMinute)) return "rate" as const;
          let text = textProjection(input.text, !!endpoint.include_message_text);
          let data = input.data(text) as unknown as Record<string, unknown>;
          if (!validTextProjection(data)) return "projection" as const;
          const sequence = allocateSequence(endpoint.id);
          const deliveryId = `whd_${sha256(JSON.stringify([1, eventId, endpoint.id]))}`;
          let envelope = envelopeFor(eventId, deliveryId, sequence, occurredAt, input.type, data);
          let plain = JSON.stringify(envelope);
          // JSON escaping can push an opted-in text past the body cap. Cut the text further rather than
          // dropping the whole event; the payload keeps its ids and flags the truncation.
          if (bodyBytes(plain) > WEBHOOK_LIMITS.bodyBytes && text) {
            let value = Array.from(text.value);
            for (let attempt = 0; attempt < 8 && value.length && bodyBytes(plain) > WEBHOOK_LIMITS.bodyBytes; attempt++) {
              value = value.slice(0, Math.floor(value.length * 0.7));
              text = { value: value.join(""), truncated: true };
              data = input.data(text) as unknown as Record<string, unknown>;
              if (!validTextProjection(data)) return "projection" as const;
              envelope = envelopeFor(eventId, deliveryId, sequence, occurredAt, input.type, data);
              plain = JSON.stringify(envelope);
            }
          }
          if (bodyBytes(plain) > WEBHOOK_LIMITS.bodyBytes) return "projection" as const;
          assertStorage(input.userId, WEBHOOK_LIMITS.deliveryReservationBytes);
          db.prepare(
            `INSERT INTO outgoing_webhook_deliveries
             (id, endpoint_id, user_id, endpoint_revision, event_id, event_type, sequence, occurred_at, created_at,
              body_enc, source_thread_id, source_channel_id, source_message_id, source_root_id, status, version,
              attempts, attempts_json, next_attempt_at, is_test)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 1, 0, '[]', ?, 0)`,
          ).run(
            deliveryId,
            endpoint.id,
            input.userId,
            endpoint.revision,
            eventId,
            input.type,
            sequence,
            occurredAt,
            now,
            encrypt(plain),
            input.threadId ?? null,
            input.channelId ?? null,
            input.messageId ?? null,
            input.rootId ?? null,
            now,
          );
          return "admitted" as const;
        });
      } catch (error) {
        // A quota refusal is the one expected admission failure. Any other database failure is the
        // source's own error and must not be reported as a successful write with a dropped copy.
        if (error instanceof QuotaError) return "quota" as const;
        throw error;
      }
    })();
    if (admission === "admitted" || admission === "duplicate") {
      if (admission === "admitted") admitted = true;
      continue;
    }
    if (admission === "capacity" || admission === "rate" || admission === "projection" || admission === "quota") {
      noteDrop(endpoint.id, admission, now);
    }
  }
  if (admitted) {
    afterCommit(wakeOutbox);
    afterCommit(() => pruneGlobal(now));
  }
}

/** Before admission: terminal rows over the per-account caps are removed oldest first, never active rows. */
export function pruneAccount(userId: string, now = Date.now()): void {
  db.prepare(
    `DELETE FROM outgoing_webhook_deliveries WHERE user_id = ? AND status IN ('succeeded','dead','cancelled')
     AND created_at < ?`,
  ).run(userId, now - WEBHOOK_LIMITS.retentionMs);
  const terminal = (db.prepare(
    "SELECT COUNT(*) AS n FROM outgoing_webhook_deliveries WHERE user_id = ? AND status IN ('succeeded','dead','cancelled')",
  ).get(userId) as { n: number }).n;
  if (terminal > WEBHOOK_LIMITS.terminalRowsPerAccount) {
    db.prepare(
      `DELETE FROM outgoing_webhook_deliveries WHERE id IN (
         SELECT id FROM outgoing_webhook_deliveries WHERE user_id = ? AND status IN ('succeeded','dead','cancelled')
         ORDER BY created_at, id LIMIT ?)`,
    ).run(userId, terminal - WEBHOOK_LIMITS.terminalRowsPerAccount);
  }
  const dead = (db.prepare("SELECT COUNT(*) AS n FROM outgoing_webhook_deliveries WHERE user_id = ? AND status = 'dead'").get(userId) as { n: number }).n;
  if (dead > WEBHOOK_LIMITS.deadRowsPerAccount) {
    db.prepare(
      `DELETE FROM outgoing_webhook_deliveries WHERE id IN (
         SELECT id FROM outgoing_webhook_deliveries WHERE user_id = ? AND status = 'dead'
         ORDER BY created_at, id LIMIT ?)`,
    ).run(userId, dead - WEBHOOK_LIMITS.deadRowsPerAccount);
  }
}

export function enforceProcessCap(now = Date.now()): void {
  pruneGlobal(now);
}

function pruneGlobal(now = Date.now()): void {
  const total = (db.prepare("SELECT COUNT(*) AS n FROM outgoing_webhook_deliveries").get() as { n: number }).n;
  if (total < WEBHOOK_LIMITS.deliveryRowsPerProcess) return;
  const excess = total - WEBHOOK_LIMITS.deliveryRowsPerProcess + 1;
  db.prepare(
    `DELETE FROM outgoing_webhook_deliveries WHERE id IN (
       SELECT id FROM outgoing_webhook_deliveries WHERE status IN ('succeeded','dead','cancelled')
       ORDER BY created_at, id LIMIT ?)`,
  ).run(excess);
  void now;
}

export function deliverySummaries(rows: DeliveryRow[]): DeliverySummary[] {
  return rows.map((row) => {
    const endpoint = db.prepare("SELECT * FROM outgoing_webhook_endpoints WHERE id = ?").get(row.endpoint_id) as EndpointRow | undefined;
    return {
      id: row.id,
      eventId: row.event_id,
      eventType: row.event_type as DeliverySummary["eventType"],
      sequence: row.sequence_text ?? String(row.sequence),
      endpointRevision: row.endpoint_revision,
      createdAt: row.created_at,
      occurredAt: row.occurred_at,
      status: row.status,
      version: row.version,
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at,
      finishedAt: row.finished_at,
      lastErrorCode: row.last_error_code,
      lastHttpStatus: row.last_http_status,
      isTest: !!row.is_test,
      canRetry: !!endpoint && canRetryRow(row, endpoint),
    };
  });
}

export function listDeliveries(userId: string, endpointId: string, options: { status?: DeliveryStatus; cursor?: string; limit?: number }): DeliveryPage {
  if (!endpointRow(userId, endpointId)) throw notFound();
  const limit = Math.min(50, Math.max(1, options.limit ?? 30));
  const cursor = options.cursor ? decodeCursorOrThrow(options.cursor) : null;
  const clauses = ["endpoint_id = ?", "user_id = ?"];
  const params: Array<string | number | null> = [endpointId, userId];
  if (options.status) {
    clauses.push("status = ?");
    params.push(options.status);
  }
  if (cursor) {
    clauses.push("(created_at < ? OR (created_at = ? AND id < ?))");
    params.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const rows = db
    .prepare(`SELECT *, CAST(sequence AS TEXT) AS sequence_text FROM outgoing_webhook_deliveries WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...params, limit + 1) as unknown as DeliveryRow[];
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    items: deliverySummaries(page),
    nextCursor: hasMore && page.length ? encodeCursor(page.at(-1)!.created_at, page.at(-1)!.id) : null,
  };
}

function decodeCursorOrThrow(value: string): { createdAt: number; id: string } {
  const parsed = decodeCursor(value);
  if (!parsed) throw new AppError({ code: "validation", message: "Invalid cursor." });
  return parsed;
}

export function getDelivery(userId: string, endpointId: string, deliveryId: string): DeliveryDetail {
  const row = deliveryRow(userId, endpointId, deliveryId);
  const endpoint = endpointRow(userId, endpointId);
  if (!row || !endpoint) throw new AppError({ code: "not_found", message: "Delivery not found." });
  const summary = deliverySummaries([row])[0]!;
  let body: string | null = null;
  let bodyUnavailableReason: DeliveryDetail["bodyUnavailableReason"] = null;
  if (!row.body_enc) {
    // A text-capable event scrubbed for the current opt-out is distinguishable from one aged out.
    bodyUnavailableReason =
      !endpoint.include_message_text && TEXT_EVENT_TYPES.has(row.event_type as EventType) && row.created_at >= Date.now() - WEBHOOK_LIMITS.bodyRetentionMs
        ? "text_disabled"
        : "expired";
  } else if (!sourceAccessible(row, endpoint)) {
    bodyUnavailableReason = "revoked";
  } else {
    try {
      const plain = decrypt(row.body_enc);
      const parsed = JSON.parse(plain) as { data?: unknown };
      if (!endpoint.include_message_text && dataHasText(parsed.data)) bodyUnavailableReason = "text_disabled";
      else body = plain;
    } catch {
      bodyUnavailableReason = "revoked";
    }
  }
  return { ...summary, attemptLog: attemptLog(row.attempts_json), body, bodyUnavailableReason };
}

/** One additional manual attempt, never a new automatic budget. */
export function retryDelivery(userId: string, endpointId: string, deliveryId: string, revision: number, version: number): { deliveryId: string; version: number } {
  assertFeature(userId, "outgoingWebhooks");
  return tx(() => {
    const endpoint = endpointRow(userId, endpointId);
    if (!endpoint) throw notFound();
    if (endpoint.revision !== revision) throw conflict("This endpoint changed. Reload and try again.", { endpoint: detailOf(endpoint, userId) });
    const row = deliveryRow(userId, endpointId, deliveryId);
    if (!row) throw new AppError({ code: "not_found", message: "Delivery not found." });
    if (row.version !== version) throw conflict("This delivery changed. Reload and try again.");
    if (!canRetryRow(row, endpoint)) throw conflict("This delivery cannot be retried.");
    db.prepare(
      "UPDATE outgoing_webhook_deliveries SET status = 'queued', next_attempt_at = ?, version = version + 1, finished_at = NULL WHERE id = ? AND version = ?",
    ).run(Date.now(), deliveryId, version);
    afterCommit(wakeOutbox);
    return { deliveryId, version: version + 1 };
  });
}

export function clearDeliveries(userId: string, endpointId: string): { deleted: number } {
  if (!endpointRow(userId, endpointId)) throw notFound();
  const result = db
    .prepare("DELETE FROM outgoing_webhook_deliveries WHERE endpoint_id = ? AND user_id = ? AND status IN ('succeeded','dead','cancelled')")
    .run(endpointId, userId);
  return { deleted: Number(result.changes) };
}

// ---------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------

export interface PreparedTest {
  preparationId: string;
  expiresAt: number;
  preview: RequestPreview;
}

export function prepareTest(userId: string, endpointId: string, revision: number): PreparedTest {
  assertFeature(userId, "outgoingWebhooks");
  consumeTestRate(userId);
  return tx(() => {
    const endpoint = endpointRow(userId, endpointId);
    if (!endpoint) throw notFound();
    if (endpoint.revision !== revision) throw conflict("This endpoint changed. Reload and try again.", { endpoint: detailOf(endpoint, userId) });
    const now = Date.now();
    db.prepare("DELETE FROM outgoing_webhook_test_preparations WHERE expires_at <= ? AND consumed_at IS NULL").run(now);
    const outstanding = db.prepare("SELECT 1 FROM outgoing_webhook_test_preparations WHERE user_id = ? AND consumed_at IS NULL").get(userId);
    if (outstanding) throw conflict("Prepare one test at a time. Send or let the previous preview expire.");
    const activeTest = db
      .prepare("SELECT 1 FROM outgoing_webhook_deliveries WHERE user_id = ? AND is_test = 1 AND status IN ('queued','sending','backoff')")
      .get(userId);
    if (activeTest) throw conflict("A test delivery is still running. Wait for it to finish.");
    const config = configOf(endpoint);
    const testId = newId("wht");
    const eventId = `whe_${sha256(JSON.stringify([1, userId, `test:${endpoint.id}:${testId}`]))}`;
    const deliveryId = `whd_${sha256(JSON.stringify([1, eventId, endpoint.id]))}`;
    const preparationId = newId("whp");
    const sequence = allocateSequence(endpoint.id);
    const text = textProjection(WEBHOOK_TEST_SAMPLE, !!endpoint.include_message_text);
    const data: EventMap["webhook.test"] = { testId, sample: true, ...(text ? { text } : {}) };
    const plain = JSON.stringify(envelopeFor(eventId, deliveryId, sequence, now, "webhook.test", data as unknown as Record<string, unknown>));
    if (bodyBytes(plain) > WEBHOOK_LIMITS.bodyBytes) throw new AppError({ code: "validation", message: "The test body is too large." });
    assertStorage(userId, WEBHOOK_LIMITS.testReservationBytes);
    const expiresAt = now + WEBHOOK_LIMITS.preparationMs;
    db.prepare(
      `INSERT INTO outgoing_webhook_test_preparations
       (id, endpoint_id, user_id, endpoint_revision, body_enc, event_id, delivery_id, sequence, created_at, expires_at, consumed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(preparationId, endpoint.id, userId, endpoint.revision, encrypt(plain), eventId, deliveryId, sequence, now, expiresAt);
    return {
      preparationId,
      expiresAt,
      preview: {
        method: "POST",
        url: config.url,
        headers: previewHeaders(config.headers),
        body: plain,
        bodySha256: sha256(plain),
        timeoutMs: WEBHOOK_LIMITS.attemptMs,
        maxAttempts: 1,
      },
    };
  });
}

export function previewHeaders(custom: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "okaychat-webhooks/1",
    "Idempotency-Key": "<deliveryId>",
    "X-Okaychat-Event-Id": "<eventId>",
    "X-Okaychat-Delivery-Id": "<deliveryId>",
    "X-Okaychat-Attempt": "1",
    "X-Okaychat-Key-Id": "<keyId>",
    "X-Okaychat-Timestamp": "<unix seconds>",
    "X-Okaychat-Signature": "v1=<hex hmac>",
  };
  for (const [name, value] of Object.entries(custom)) {
    void value;
    headers[name] = "[redacted]";
  }
  return headers;
}

export function sendTest(userId: string, endpointId: string, revision: number, preparationId: string): { deliveryId: string } {
  assertFeature(userId, "outgoingWebhooks");
  return tx(() => {
    const endpoint = endpointRow(userId, endpointId);
    if (!endpoint) throw notFound();
    const prep = db
      .prepare("SELECT *, CAST(sequence AS TEXT) AS sequence_text FROM outgoing_webhook_test_preparations WHERE id = ? AND endpoint_id = ? AND user_id = ?")
      .get(preparationId, endpointId, userId) as
      | { id: string; endpoint_revision: number; body_enc: string | null; event_id: string; delivery_id: string; sequence_text: string; expires_at: number; consumed_at: number | null }
      | undefined;
    if (prep && prep.consumed_at !== null) return { deliveryId: prep.delivery_id };
    if (!prep) {
      // A config change deletes unused preparations; the caller named a stale revision, so this is a
      // conflict to reload rather than a missing resource.
      if (endpoint.revision !== revision) throw conflict("This endpoint changed. Reload and try again.", { endpoint: detailOf(endpoint, userId) });
      throw new AppError({ code: "not_found", message: "Test preparation not found." });
    }
    if (prep.endpoint_revision !== revision || endpoint.revision !== revision) {
      throw conflict("This endpoint changed. Reload and try again.", { endpoint: detailOf(endpoint, userId) });
    }
    if (prep.expires_at <= Date.now() || !prep.body_enc) throw conflict("This test preview expired. Prepare it again.");
    const activeTest = db
      .prepare("SELECT 1 FROM outgoing_webhook_deliveries WHERE user_id = ? AND is_test = 1 AND status IN ('queued','sending','backoff')")
      .get(userId);
    if (activeTest) throw conflict("A test delivery is still running. Wait for it to finish.");
    consumeTestRate(userId);
    const now = Date.now();
    db.prepare("UPDATE outgoing_webhook_test_preparations SET consumed_at = ?, body_enc = NULL WHERE id = ? AND consumed_at IS NULL").run(now, prep.id);
    assertStorage(userId, 0);
    db.prepare(
      `INSERT INTO outgoing_webhook_deliveries
       (id, endpoint_id, user_id, endpoint_revision, event_id, event_type, sequence, occurred_at, created_at,
        body_enc, status, version, attempts, attempts_json, next_attempt_at, is_test)
       VALUES (?, ?, ?, ?, ?, 'webhook.test', ?, ?, ?, ?, 'queued', 1, 0, '[]', ?, 1)`,
    ).run(prep.delivery_id, endpoint.id, userId, endpoint.revision, prep.event_id, prep.sequence_text, now, now, prep.body_enc, now);
    afterCommit(wakeOutbox);
    return { deliveryId: prep.delivery_id };
  });
}

// ---------------------------------------------------------------------------------------------------
// Worker primitives
// ---------------------------------------------------------------------------------------------------

export interface ClaimedDelivery {
  row: DeliveryRow;
  endpoint: EndpointRow;
  config: Config;
  secret: string;
  body: string;
}

export function dueDeliveryIds(now: number, limit = 256): Array<{ id: string; user_id: string; endpoint_id: string }> {
  return db
    .prepare(
      `SELECT id, user_id, endpoint_id FROM outgoing_webhook_deliveries
       WHERE status IN ('queued','backoff') AND next_attempt_at <= ?
       ORDER BY next_attempt_at, endpoint_id, sequence LIMIT ?`,
    )
    .all(now, limit) as unknown as Array<{ id: string; user_id: string; endpoint_id: string }>;
}

/**
 * Claims one due row under a transaction: revision, feature, source, minute windows, and concurrency
 * caps are checked again. The attempt count increments durably before any network call.
 */
export function claimDelivery(deliveryId: string, now: number): ClaimedDelivery | null | "throttled" {
  return tx(() => {
    const row = db.prepare("SELECT * FROM outgoing_webhook_deliveries WHERE id = ?").get(deliveryId) as DeliveryRow | undefined;
    if (!row || (row.status !== "queued" && row.status !== "backoff") || row.next_attempt_at > now) return null;
    const endpoint = db.prepare("SELECT * FROM outgoing_webhook_endpoints WHERE id = ? AND user_id = ?").get(row.endpoint_id, row.user_id) as EndpointRow | undefined;
    if (!endpoint) {
      db.prepare("DELETE FROM outgoing_webhook_deliveries WHERE id = ?").run(row.id);
      return null;
    }
    const finish = (status: DeliveryStatus, code: DeliveryErrorCode | null) => {
      db.prepare(
        "UPDATE outgoing_webhook_deliveries SET status = ?, last_error_code = ?, finished_at = ?, version = version + 1 WHERE id = ?",
      ).run(status, code, now, row.id);
      return null;
    };
    if (!row.is_test && !endpoint.enabled) return finish("cancelled", "endpoint_disabled");
    if (row.endpoint_revision !== endpoint.revision) return finish("cancelled", "config_changed");
    if (!featureAllowed({ userId: row.user_id, modelRef: null }, "outgoingWebhooks")) return finish("cancelled", "feature_denied");
    if (!sourceAccessible(row, endpoint)) return finish("cancelled", "source_revoked");
    if (row.created_at < now - WEBHOOK_LIMITS.bodyRetentionMs) return finish("dead", "expired");
    if (row.attempts >= (row.is_test ? 1 : WEBHOOK_LIMITS.totalAttempts)) return finish("dead", "attempt_limit");
    if (!row.body_enc) return finish("dead", "expired");
    const minute = Math.floor(now / 60_000);
    const endpointCount = db
      .prepare("SELECT count FROM outgoing_webhook_rate_windows WHERE scope = 'endpoint_dispatch' AND user_id = ? AND bucket_id = ? AND minute = ?")
      .get(row.user_id, row.endpoint_id, minute) as { count: number } | undefined;
    if ((endpointCount?.count ?? 0) >= WEBHOOK_LIMITS.dispatchPerEndpointMinute) return "throttled";
    const accountCount = db
      .prepare("SELECT count FROM outgoing_webhook_rate_windows WHERE scope = 'account_dispatch' AND user_id = ? AND bucket_id = '' AND minute = ?")
      .get(row.user_id, minute) as { count: number } | undefined;
    if ((accountCount?.count ?? 0) >= WEBHOOK_LIMITS.dispatchPerAccountMinute) return "throttled";
    consumeWindow("endpoint_dispatch", row.user_id, row.endpoint_id, minute, WEBHOOK_LIMITS.dispatchPerEndpointMinute);
    consumeWindow("account_dispatch", row.user_id, "", minute, WEBHOOK_LIMITS.dispatchPerAccountMinute);
    let config: Config;
    let secret: string;
    let body: string;
    try {
      config = configOf(endpoint);
      secret = decrypt(endpoint.signing_secret_enc);
      body = decrypt(row.body_enc);
    } catch {
      return finish("dead", "invalid_config");
    }
    const attemptNumber = row.attempts + 1;
    const attempts = attemptLog(row.attempts_json);
    const manual = row.status === "queued" && row.attempts > 0;
    attempts.push({ number: attemptNumber, ...(manual ? { manual: true as const } : {}), startedAt: now, finishedAt: 0, outcome: "uncertain", httpStatus: null, errorCode: null, durationMs: 0 });
    db.prepare(
      `UPDATE outgoing_webhook_deliveries SET status = 'sending', attempts = ?, attempts_json = ?, next_attempt_at = ?,
        version = version + 1, last_error_code = NULL, last_http_status = NULL WHERE id = ?`,
    ).run(attemptNumber, JSON.stringify(attempts.slice(-10)), now, row.id);
    const claimed = db.prepare("SELECT * FROM outgoing_webhook_deliveries WHERE id = ?").get(row.id) as unknown as DeliveryRow;
    return { row: claimed, endpoint, config, secret, body };
  });
}

export interface SettlementInput {
  deliveryId: string;
  attemptNumber: number;
  expectedVersion: number;
  outcome: "succeeded" | "failed";
  httpStatus: number | null;
  errorCode: DeliveryErrorCode | null;
  durationMs: number;
  retryDelayMs?: number;
}

/** Settles only the claimed attempt of the still-current revision; late results are ignored. */
export function settleDelivery(input: SettlementInput, now = Date.now()): "succeeded" | "backoff" | "dead" | "ignored" {
  return tx(() => {
    const row = db.prepare("SELECT * FROM outgoing_webhook_deliveries WHERE id = ?").get(input.deliveryId) as DeliveryRow | undefined;
    const endpoint = row
      ? (db.prepare("SELECT * FROM outgoing_webhook_endpoints WHERE id = ? AND user_id = ?").get(row.endpoint_id, row.user_id) as EndpointRow | undefined)
      : undefined;
    if (!row || !endpoint) return "ignored";
    if (row.status !== "sending" || row.version !== input.expectedVersion || row.attempts !== input.attemptNumber) return "ignored";
    if (row.endpoint_revision !== endpoint.revision && !row.is_test) {
      db.prepare("UPDATE outgoing_webhook_deliveries SET status = 'cancelled', finished_at = ?, version = version + 1 WHERE id = ?").run(now, row.id);
      return "ignored";
    }
    const attempts = attemptLog(row.attempts_json);
    const last = attempts.at(-1);
    if (last && last.number === input.attemptNumber) {
      last.finishedAt = now;
      last.outcome = input.outcome === "succeeded" ? "succeeded" : "failed";
      last.httpStatus = input.httpStatus;
      last.errorCode = input.errorCode;
      last.durationMs = Math.max(0, Math.round(input.durationMs));
    }
    const retryable = input.outcome === "failed" && (input.errorCode === "network" || input.errorCode === "dns" ||
      input.errorCode === "timeout" || input.errorCode === "http_retryable");
    let next: "succeeded" | "backoff" | "dead" = input.outcome === "succeeded" ? "succeeded" : "dead";
    let nextAttemptAt = now;
    if (retryable && !row.is_test && !last?.manual && row.attempts < WEBHOOK_LIMITS.automaticAttempts) {
      next = "backoff";
      nextAttemptAt = now + Math.max(0, input.retryDelayMs ?? 0);
    }
    db.prepare(
      `UPDATE outgoing_webhook_deliveries SET status = ?, attempts_json = ?, last_error_code = ?, last_http_status = ?,
        finished_at = ?, next_attempt_at = ?, version = version + 1 WHERE id = ?`,
    ).run(next, JSON.stringify(attempts.slice(-10)), input.errorCode, input.httpStatus, next === "backoff" ? null : now, nextAttemptAt, row.id);
    if (row.is_test) return next;
    pruneAccount(row.user_id, now);
    if (input.outcome === "succeeded") {
      db.prepare(
        `UPDATE outgoing_webhook_endpoints SET consecutive_failures = 0, last_delivery_id = ?, last_status = 'succeeded',
          last_http_status = ?, last_attempt_at = ?, last_duration_ms = ?, updated_at = ? WHERE id = ?`,
      ).run(row.id, input.httpStatus, now, Math.max(0, Math.round(input.durationMs)), now, endpoint.id);
      return next;
    }
    const failures = (db.prepare("SELECT consecutive_failures FROM outgoing_webhook_endpoints WHERE id = ?").get(endpoint.id) as { consecutive_failures: number }).consecutive_failures;
    const nextFailures = Math.min(9007199254740991, failures + 1);
    db.prepare(
      `UPDATE outgoing_webhook_endpoints SET failed_attempts = ${saturateSql("failed_attempts")}, consecutive_failures = ?,
        last_delivery_id = ?, last_status = 'failed', last_http_status = ?, last_attempt_at = ?, last_duration_ms = ?,
        updated_at = ? WHERE id = ?`,
    ).run(nextFailures, row.id, input.httpStatus, now, Math.max(0, Math.round(input.durationMs)), now, endpoint.id);
    if (nextFailures >= 10) {
      db.prepare(
        "UPDATE outgoing_webhook_endpoints SET enabled = 0, auto_disabled_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND enabled = 1",
      ).run(now, now, endpoint.id);
      db.prepare(
        `UPDATE outgoing_webhook_deliveries SET status = 'cancelled', version = version + 1, finished_at = ?
         WHERE endpoint_id = ? AND status IN ('queued','backoff','sending') AND id <> ?`,
      ).run(now, endpoint.id, row.id);
      afterCommit(() => abortEndpointSends(endpoint.id));
    }
    return next;
  });
}

/** Startup: a claimed attempt may have died before or after the receiver acted. Never reset the count. */
export function recoverSendingDeliveries(now = Date.now()): number {
  return tx(() => {
    const rows = db.prepare("SELECT * FROM outgoing_webhook_deliveries WHERE status = 'sending'").all() as unknown as DeliveryRow[];
    for (const row of rows) {
      if (row.is_test) {
        db.prepare("UPDATE outgoing_webhook_deliveries SET status = 'dead', last_error_code = 'shutdown', finished_at = ?, version = version + 1 WHERE id = ?").run(now, row.id);
        continue;
      }
      const exhausted = row.attempts >= WEBHOOK_LIMITS.automaticAttempts || attemptLog(row.attempts_json).at(-1)?.manual;
      if (row.created_at < now - WEBHOOK_LIMITS.bodyRetentionMs || exhausted) {
        const code = exhausted ? "attempt_limit" : "expired";
        db.prepare("UPDATE outgoing_webhook_deliveries SET status = 'dead', last_error_code = ?, finished_at = ?, version = version + 1 WHERE id = ?").run(code, now, row.id);
        continue;
      }
      db.prepare(
        "UPDATE outgoing_webhook_deliveries SET status = 'backoff', last_error_code = 'network', next_attempt_at = ?, version = version + 1 WHERE id = ?",
      ).run(now + 30_000, row.id);
    }
    return rows.length;
  });
}

/** Marks every nonterminal row older than the body window dead; returns the ids to abort. */
export function expireDeliveries(now = Date.now()): string[] {
  const expired = db
    .prepare("SELECT id FROM outgoing_webhook_deliveries WHERE created_at < ? AND status IN ('queued','sending','backoff')")
    .all(now - WEBHOOK_LIMITS.bodyRetentionMs) as Array<{ id: string }>;
  if (!expired.length) return [];
  db.prepare(
    "UPDATE outgoing_webhook_deliveries SET status = 'dead', last_error_code = 'expired', finished_at = ?, version = version + 1 WHERE created_at < ? AND status IN ('queued','sending','backoff')",
  ).run(now, now - WEBHOOK_LIMITS.bodyRetentionMs);
  return expired.map((row) => row.id);
}

export function clearExpiredBodies(now = Date.now()): number {
  const result = db
    .prepare("UPDATE outgoing_webhook_deliveries SET body_enc = NULL WHERE body_enc IS NOT NULL AND created_at < ?")
    .run(now - WEBHOOK_LIMITS.bodyRetentionMs);
  return Number(result.changes);
}

export function scrubTextDisabledBodies(limit = 100): number {
  // Only bodies that actually contain a text projection are scrubbed. A metadata-only failure body
  // stays readable in the log, and an opt-out never causes a false "text disabled" reason.
  const rows = db.prepare(
    `SELECT d.id, d.body_enc FROM outgoing_webhook_deliveries d
     JOIN outgoing_webhook_endpoints e ON e.id = d.endpoint_id
     WHERE d.body_enc IS NOT NULL AND e.include_message_text = 0 LIMIT ?`,
  ).all(limit) as Array<{ id: string; body_enc: string }>;
  let cleared = 0;
  for (const row of rows) {
    try {
      const parsed = JSON.parse(decrypt(row.body_enc)) as { data?: unknown };
      if (!dataHasText(parsed.data)) continue;
      db.prepare("UPDATE outgoing_webhook_deliveries SET body_enc = NULL WHERE id = ?").run(row.id);
      cleared++;
    } catch {
      // Unreadable ciphertext is left for retention rather than silently deleted here.
    }
  }
  return cleared;
}

export function deleteExpiredTestPreparations(now = Date.now()): number {
  const result = db.prepare("DELETE FROM outgoing_webhook_test_preparations WHERE expires_at <= ?").run(now);
  return Number(result.changes);
}

export function pruneOldRateWindows(now = Date.now()): number {
  const result = db.prepare("DELETE FROM outgoing_webhook_rate_windows WHERE minute < ?").run(Math.floor(now / 60_000) - 2);
  return Number(result.changes);
}

export function pruneProcessDeliveries(now = Date.now()): number {
  const before = (db.prepare("SELECT COUNT(*) AS n FROM outgoing_webhook_deliveries").get() as { n: number }).n;
  db.prepare("DELETE FROM outgoing_webhook_deliveries WHERE created_at < ? AND status IN ('succeeded','dead','cancelled')").run(now - WEBHOOK_LIMITS.retentionMs);
  const after = (db.prepare("SELECT COUNT(*) AS n FROM outgoing_webhook_deliveries").get() as { n: number }).n;
  return before - after;
}

/** Cleanup for accounts whose terminal rows are past retention, bounded per batch. */
export function pruneAllAccounts(now = Date.now()): number {
  const users = db
    .prepare(
      `SELECT DISTINCT user_id FROM outgoing_webhook_deliveries
       WHERE status IN ('succeeded','dead','cancelled') LIMIT 100`,
    )
    .all() as Array<{ user_id: string }>;
  for (const row of users) pruneAccount(row.user_id, now);
  return users.length;
}

/** Cancels older unsent text-bearing copies after an edit or a deletion (stale text must not ship). */
export function cancelTextDeliveriesForMessage(channelId: string, messageId: string, now = Date.now()): void {
  const types = ["channel.message.created", "channel.message.edited", "channel.mention"];
  db.prepare(
    `UPDATE outgoing_webhook_deliveries SET status = 'cancelled', body_enc = NULL, version = version + 1, finished_at = ?
     WHERE source_channel_id = ? AND source_message_id = ? AND status IN ('queued','backoff','sending')
       AND event_type IN (${types.map(() => "?").join(",")})`,
  ).run(now, channelId, messageId, ...types);
}

/** A channel transfer/removal/archival cancels unsent rows for that room. */
export function cancelChannelDeliveries(channelId: string, now = Date.now()): void {
  db.prepare(
    `UPDATE outgoing_webhook_deliveries SET status = 'cancelled', version = version + 1, finished_at = ?
     WHERE source_channel_id = ? AND status IN ('queued','backoff','sending')`,
  ).run(now, channelId);
}

export function adminEndpointPage(options: { cursor?: string; limit?: number }): {
  items: Array<{ endpointId: string; ownerId: string; enabled: boolean; autoDisabledAt: number | null; pendingCount: number; deadCount: number; failedAttempts: number; droppedCount: number; oldestPendingAt: number | null }>;
  nextCursor: string | null;
  totals: { active: number; dead: number; dropped: number; workerSlots: number; lastPumpAt: number | null };
} {
  const limit = Math.min(50, Math.max(1, options.limit ?? 30));
  const cursor = options.cursor ? decodeCursorOrThrow(options.cursor) : null;
  const rows = db
    .prepare(
      `SELECT e.id, e.user_id, e.enabled, e.auto_disabled_at, e.failed_attempts, e.dropped_count, e.created_at,
        (SELECT COUNT(*) FROM outgoing_webhook_deliveries d WHERE d.endpoint_id = e.id AND d.status IN ('queued','sending','backoff')) AS pending,
        (SELECT COUNT(*) FROM outgoing_webhook_deliveries d WHERE d.endpoint_id = e.id AND d.status = 'dead') AS dead,
        (SELECT MIN(d.created_at) FROM outgoing_webhook_deliveries d WHERE d.endpoint_id = e.id AND d.status IN ('queued','sending','backoff')) AS oldest
       FROM outgoing_webhook_endpoints e
       ${cursor ? "WHERE e.created_at < ? OR (e.created_at = ? AND e.id < ?)" : ""}
       ORDER BY e.created_at DESC, e.id DESC LIMIT ?`,
    )
    .all(...(cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : []), limit + 1) as unknown as Array<{
      id: string; user_id: string; enabled: number; auto_disabled_at: number | null; failed_attempts: number; dropped_count: number;
      created_at: number; pending: number; dead: number; oldest: number | null;
    }>;
  const page = rows.slice(0, limit);
  const totals = db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM outgoing_webhook_deliveries WHERE status IN ('queued','sending','backoff')) AS active,
        (SELECT COUNT(*) FROM outgoing_webhook_deliveries WHERE status = 'dead') AS dead,
        (SELECT COALESCE(SUM(dropped_count), 0) FROM outgoing_webhook_endpoints) AS dropped`,
    )
    .get() as { active: number; dead: number; dropped: number };
  return {
    items: page.map((row) => ({
      endpointId: row.id,
      ownerId: row.user_id,
      enabled: !!row.enabled,
      autoDisabledAt: row.auto_disabled_at,
      pendingCount: row.pending,
      deadCount: row.dead,
      failedAttempts: row.failed_attempts,
      droppedCount: row.dropped_count,
      oldestPendingAt: row.oldest,
    })),
    nextCursor: rows.length > limit && page.length ? encodeCursor(page.at(-1)!.created_at, page.at(-1)!.id) : null,
    totals: { ...totals, workerSlots: WEBHOOK_LIMITS.slotsPerProcess, lastPumpAt: null },
  };
}

export function abortUserEndpointSends(userId: string): void {
  const rows = db.prepare("SELECT id FROM outgoing_webhook_endpoints WHERE user_id = ?").all(userId) as Array<{ id: string }>;
  for (const row of rows) abortEndpointSends(row.id);
}

export function adminDisable(userId: string, endpointId: string, revision: number, reason: string): EndpointDetail {
  return tx(() => {
    const row = endpointRow(userId, endpointId);
    if (!row) throw notFound();
    if (row.revision !== revision) throw conflict("This endpoint changed. Reload and try again.", { endpoint: detailOf(row, userId) });
    db.prepare(
      "UPDATE outgoing_webhook_endpoints SET enabled = 0, revision = revision + 1, updated_at = ? WHERE id = ? AND user_id = ?",
    ).run(Date.now(), endpointId, userId);
    cancelEndpointWork(endpointId, { scrubText: false });
    void reason;
    return detailOf(endpointRow(userId, endpointId)!, userId);
  });
}
