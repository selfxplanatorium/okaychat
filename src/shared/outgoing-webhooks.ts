/**
 * Outgoing event webhooks: the wire contract shared by the server, the settings UI, and the tests.
 * Pure types and constants only — no server imports (see docs/implementation/outgoing-webhooks.md).
 *
 * Delivery is bounded at-least-once, never exactly-once: a timeout or a process death after the
 * receiver accepted a request can duplicate an action. Receivers deduplicate by delivery id.
 */

export const WEBHOOK_SPEC_VERSION = 1 as const;

/** A bounded visible-answer projection. Text is opt-in per endpoint; failures and tombstones never carry it. */
export interface TextProjection {
  value: string;
  truncated: boolean;
}

export const WEBHOOK_FAILURE_CODES = [
  "generation_error",
  "interrupted",
  "run_error",
  "empty_response",
  "timeout",
  "invalid_archive",
  "archive_error",
] as const;
export type FailureCode = (typeof WEBHOOK_FAILURE_CODES)[number];

export interface TurnData {
  threadId: string;
  runId: string;
  assistantMessageId: string;
  text?: TextProjection;
}

export interface ScheduleData {
  scheduleId: string;
  invocationId: string;
  startedAt: number;
  threadId: string | null;
  assistantMessageId: string | null;
  text?: TextProjection;
}

export interface ChannelData {
  channelId: string;
  messageId: string;
  messageSequence: number;
  revision: number;
  rootId: string | null;
  kind: "human" | "assistant";
  text?: TextProjection;
}

export interface ArchiveData {
  jobId: string;
  chatCount: number;
}

export interface EventMap {
  "chat.turn.completed": TurnData & {
    finishReason: "stop" | "length" | "content-filter" | "other" | "unknown";
  };
  "chat.turn.failed": Omit<TurnData, "text"> & { failureCode: FailureCode };
  "schedule.run.completed": ScheduleData;
  "schedule.run.failed": Omit<ScheduleData, "text"> & { failureCode: FailureCode };
  "channel.message.created": ChannelData;
  "channel.message.edited": ChannelData;
  "channel.message.deleted": Omit<ChannelData, "text">;
  "channel.mention": ChannelData;
  "archive.export.finished": ArchiveData & {
    outcome: "completed" | "failed";
    failureCode: FailureCode | null;
  };
  "archive.import.finished": ArchiveData & {
    outcome: "completed" | "failed";
    failureCode: FailureCode | null;
  };
  "webhook.test": { testId: string; sample: true; text?: TextProjection };
}

export type EventType = keyof EventMap;

/** Events an endpoint may subscribe to. `webhook.test` is reserved and never listed. */
export const PRODUCTION_EVENT_TYPES = [
  "chat.turn.completed",
  "chat.turn.failed",
  "schedule.run.completed",
  "schedule.run.failed",
  "channel.message.created",
  "channel.message.edited",
  "channel.message.deleted",
  "channel.mention",
  "archive.export.finished",
  "archive.import.finished",
] as const satisfies readonly EventType[];
export type ProductionEventType = (typeof PRODUCTION_EVENT_TYPES)[number];

/** Event types whose payload can carry message text, so opt-out can hide or scrub it. */
export const TEXT_EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  "chat.turn.completed",
  "schedule.run.completed",
  "channel.message.created",
  "channel.message.edited",
  "channel.mention",
  "webhook.test",
]);

export const isEventType = (value: unknown): value is EventType =>
  typeof value === "string" && (PRODUCTION_EVENT_TYPES as readonly string[]).includes(value);

export const isProductionEventType = (value: unknown): value is ProductionEventType => isEventType(value);

/** One correlated envelope per `(endpoint, event)`; the same event to two endpoints shares its event id. */
export type OutgoingEvent<K extends EventType = EventType> = {
  specVersion: typeof WEBHOOK_SPEC_VERSION;
  eventId: string;
  deliveryId: string;
  /** The endpoint's monotonically allocated integer, rendered as a decimal string. */
  sequence: string;
  occurredAt: number;
  type: K;
  data: EventMap[K];
};

export type OutgoingEnvelope = { [K in EventType]: OutgoingEvent<K> }[EventType];

export const DELIVERY_STATUSES = ["queued", "sending", "backoff", "succeeded", "dead", "cancelled"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];
export const ACTIVE_DELIVERY_STATUSES = ["queued", "sending", "backoff"] as const;
export type ActiveDeliveryStatus = (typeof ACTIVE_DELIVERY_STATUSES)[number];

/** Sanitized failure vocabulary. Remote error text, URLs, and response bodies are never stored or shown. */
export const DELIVERY_ERROR_CODES = [
  "network",
  "dns",
  "timeout",
  "http_retryable",
  "http_permanent",
  "redirect",
  "blocked_destination",
  "invalid_config",
  "expired",
  "attempt_limit",
  "config_changed",
  "feature_denied",
  "source_revoked",
  "endpoint_disabled",
  "shutdown",
] as const;
export type DeliveryErrorCode = (typeof DELIVERY_ERROR_CODES)[number];

export interface DeliveryAttempt {
  number: number;
  /** A manually requested attempt never starts an automatic retry chain, including after restart. */
  manual?: true;
  startedAt: number;
  finishedAt: number;
  outcome: "succeeded" | "failed" | "uncertain";
  httpStatus: number | null;
  errorCode: DeliveryErrorCode | null;
  durationMs: number;
}

export interface EndpointLastDelivery {
  id: string;
  status: "succeeded" | "failed";
  httpStatus: number | null;
  attemptedAt: number;
  durationMs: number;
}

export interface EndpointSummary {
  id: string;
  name: string;
  /** Parsed hostname only. URLs and query strings are credentials and never enter a list. */
  hostname: string;
  enabled: boolean;
  revision: number;
  subscriptions: ProductionEventType[];
  channelIds: string[];
  includeMessageText: boolean;
  keyId: string;
  headerNames: string[];
  createdAt: number;
  updatedAt: number;
  consecutiveFailures: number;
  failedAttempts: number;
  droppedCount: number;
  lastDropReason: DropReason | null;
  lastDropAt: number | null;
  autoDisabledAt: number | null;
  pendingCount: number;
  deadCount: number;
  oldestPendingAt: number | null;
  lastDelivery: EndpointLastDelivery | null;
}

/** The owner's detail may return the saved URL (it may contain a credential) but never header values. */
export interface EndpointDetail extends EndpointSummary {
  url: string;
  hasSigningSecret: true;
}

export type DropReason = "quota" | "capacity" | "rate" | "projection";

export interface DeliverySummary {
  id: string;
  eventId: string;
  eventType: EventType;
  sequence: string;
  endpointRevision: number;
  createdAt: number;
  occurredAt: number;
  status: DeliveryStatus;
  version: number;
  attempts: number;
  nextAttemptAt: number;
  finishedAt: number | null;
  lastErrorCode: DeliveryErrorCode | null;
  lastHttpStatus: number | null;
  isTest: boolean;
  canRetry: boolean;
}

export interface DeliveryDetail extends DeliverySummary {
  attemptLog: DeliveryAttempt[];
  body: string | null;
  bodyUnavailableReason: "expired" | "revoked" | "text_disabled" | null;
}

export interface RequestPreview {
  method: "POST";
  url: string;
  /** Custom header values are `[redacted]`; signature/time/attempt values are explicit placeholders. */
  headers: Record<string, string>;
  body: string;
  bodySha256: string;
  timeoutMs: number;
  maxAttempts: number;
}

export interface EndpointCreateInput {
  name: string;
  url: string;
  headers?: Record<string, string>;
  subscriptions: ProductionEventType[];
  channelIds: string[];
  includeMessageText: boolean;
}

export interface EndpointPatchInput {
  revision: number;
  name?: string;
  url?: string;
  headerChanges?: Record<string, string | null>;
  replaceHeaders?: Record<string, string>;
  subscriptions?: ProductionEventType[];
  channelIds?: string[];
  includeMessageText?: boolean;
  enabled?: boolean;
}

export interface EndpointCreateResult {
  endpoint: EndpointDetail;
  /** Shown exactly once. A lost response requires rotation. */
  signingSecret: string;
}

export interface DeliveryPage {
  items: DeliverySummary[];
  nextCursor: string | null;
}

export interface AdminWebhookItem {
  endpointId: string;
  ownerId: string;
  enabled: boolean;
  autoDisabledAt: number | null;
  pendingCount: number;
  deadCount: number;
  failedAttempts: number;
  droppedCount: number;
  oldestPendingAt: number | null;
}

export interface AdminWebhookPage {
  items: AdminWebhookItem[];
  nextCursor: string | null;
  totals: {
    active: number;
    dead: number;
    dropped: number;
    workerSlots: number;
    lastPumpAt: number | null;
  };
}

export const WEBHOOK_LIMITS = {
  endpointsPerAccount: 10,
  endpointsPerProcess: 1000,
  nameChars: 80,
  urlBytes: 2048,
  headerCount: 8,
  headerNameChars: 64,
  headerValueBytes: 2048,
  headerTotalBytes: 4096,
  subscriptions: PRODUCTION_EVENT_TYPES.length,
  channelIds: 20,
  bodyBytes: 12_288,
  textBytes: 8_192,
  deliveryReservationBytes: 32_768,
  testReservationBytes: 32_768,
  attemptSeconds: 10,
  attemptMs: 10_000,
  automaticAttempts: 6,
  totalAttempts: 10,
  retryBaseMs: 30_000,
  retryCapMs: 900_000,
  activePerEndpoint: 100,
  activePerAccount: 500,
  activePerProcess: 10_000,
  admissionsPerAccountMinute: 300,
  dispatchPerEndpointMinute: 30,
  dispatchPerAccountMinute: 120,
  managementPerAccountMinute: 60,
  testsPerAccountMinute: 5,
  terminalRowsPerAccount: 1_000,
  deadRowsPerAccount: 100,
  deliveryRowsPerProcess: 100_000,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  bodyRetentionMs: 24 * 60 * 60 * 1000,
  preparationMs: 5 * 60 * 1000,
  claimBatch: 64,
  slotsPerProcess: 16,
  slotsPerAccount: 2,
  slotsPerEndpoint: 1,
} as const;

export const WEBHOOK_SECRET_PREFIX = "okc_wh_v1_";
export const WEBHOOK_KEY_PREFIX = "whk_";
export const WEBHOOK_USER_AGENT = "okaychat-webhooks/1";
export const WEBHOOK_TEST_SAMPLE = "okaychat webhook test";
