import type { DeliveryErrorCode } from "../../shared/outgoing-webhooks.js";
import { WEBHOOK_LIMITS, WEBHOOK_USER_AGENT } from "../../shared/outgoing-webhooks.js";
import {
  claimDelivery,
  dueDeliveryIds,
  expireDeliveries,
  recoverSendingDeliveries,
  settleDelivery,
  type ClaimedDelivery,
} from "./store.js";
import { signDelivery } from "./signatures.js";
import { sendWebhook, type WebhookTransportInput, type WebhookTransportResult } from "./transport.js";
import { setDeliveryAbortHook, setEndpointAbortHook, setOutboxWake } from "./runtime.js";
import { wakeOutbox, abortDeliverySend } from "./runtime.js";

/**
 * One bounded in-process worker. Slots (1/endpoint, 2/account, 16/process) are reserved before a claim,
 * the attempt count and UTC-minute windows are durable, and the network call happens outside SQLite.
 * There is no distributed lease: this repository already requires one writer process.
 */

type Transport = (input: WebhookTransportInput) => Promise<WebhookTransportResult>;

interface Hooks {
  transport: Transport;
  random: () => number;
  now: () => number;
}

let hooks: Hooks = { transport: sendWebhook, random: Math.random, now: Date.now };
let started = false;
let pumping = false;
let timer: NodeJS.Timeout | null = null;
let lastPumpAt: number | null = null;

const inFlight = new Set<string>();
const activeByEndpoint = new Map<string, number>();
const activeByAccount = new Map<string, number>();
const controllers = new Map<string, { endpointId: string; controller: AbortController }>();

const bump = (map: Map<string, number>, key: string, delta: number) => {
  const next = (map.get(key) ?? 0) + delta;
  if (next <= 0) map.delete(key);
  else map.set(key, next);
};

/** Reserves a slot for a candidate. All three ceilings must have room. */
function reserveSlots(endpointId: string, userId: string): boolean {
  if (inFlight.size >= WEBHOOK_LIMITS.slotsPerProcess) return false;
  if ((activeByEndpoint.get(endpointId) ?? 0) >= WEBHOOK_LIMITS.slotsPerEndpoint) return false;
  if ((activeByAccount.get(userId) ?? 0) >= WEBHOOK_LIMITS.slotsPerAccount) return false;
  bump(activeByEndpoint, endpointId, 1);
  bump(activeByAccount, userId, 1);
  return true;
}

function releaseSlots(endpointId: string, userId: string): void {
  bump(activeByEndpoint, endpointId, -1);
  bump(activeByAccount, userId, -1);
}

function retryDelay(attempt: number): number {
  const ceiling = Math.min(WEBHOOK_LIMITS.retryCapMs, WEBHOOK_LIMITS.retryBaseMs * 2 ** Math.max(0, attempt - 1));
  const low = Math.floor(ceiling / 2);
  return low + Math.floor(hooks.random() * (ceiling - low + 1));
}

function headersFor(claimed: ClaimedDelivery, timestamp: number): Record<string, string> {
  const body = Buffer.from(claimed.body, "utf8");
  const signature = signDelivery(claimed.secret, timestamp, claimed.row.id, body);
  return {
    ...claimed.config.headers,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": WEBHOOK_USER_AGENT,
    "Idempotency-Key": claimed.row.id,
    "X-Okaychat-Event-Id": claimed.row.event_id,
    "X-Okaychat-Delivery-Id": claimed.row.id,
    "X-Okaychat-Attempt": String(claimed.row.attempts),
    "X-Okaychat-Key-Id": claimed.endpoint.key_id,
    "X-Okaychat-Timestamp": String(timestamp),
    "X-Okaychat-Signature": `v1=${signature}`,
  };
}

async function attempt(claimed: ClaimedDelivery): Promise<void> {
  const { row, endpoint } = claimed;
  const controller = new AbortController();
  controllers.set(row.id, { endpointId: endpoint.id, controller });
  try {
    const timestamp = Math.floor(hooks.now() / 1000);
    const result = await hooks.transport({
      url: claimed.config.url,
      headers: headersFor(claimed, timestamp),
      body: Buffer.from(claimed.body, "utf8"),
      signal: controller.signal,
    });
    if (result.errorCode === "shutdown") return;
    try {
      settleDelivery({
        deliveryId: row.id,
        attemptNumber: row.attempts,
        expectedVersion: row.version,
        outcome: result.outcome,
        httpStatus: result.httpStatus,
        errorCode: result.errorCode,
        durationMs: result.durationMs,
        retryDelayMs: result.outcome === "failed" ? retryDelay(row.attempts) : undefined,
      });
    } catch {
      // A transient storage failure must not stop the process; the lease expires and the next pump retries.
    }
  } finally {
    controllers.delete(row.id);
    inFlight.delete(row.id);
    releaseSlots(endpoint.id, row.user_id);
    wakeOutbox();
  }
}

/** At most 64 eligible rows per pump, one per account per round, preserving due order within an account. */
export async function pumpOutgoingWebhooks(): Promise<void> {
  if (!started || pumping) return;
  pumping = true;
  try {
    const now = hooks.now();
    lastPumpAt = now;
    const due = dueDeliveryIds(now, WEBHOOK_LIMITS.claimBatch * 3);
    const byAccount = new Map<string, Array<{ id: string; endpoint_id: string }>>();
    for (const row of due) {
      const list = byAccount.get(row.user_id) ?? [];
      list.push({ id: row.id, endpoint_id: row.endpoint_id });
      byAccount.set(row.user_id, list);
    }
    const order: Array<{ id: string; endpoint_id: string; user_id: string }> = [];
    let round = 0;
    while (order.length < WEBHOOK_LIMITS.claimBatch) {
      let added = false;
      for (const [userId, list] of byAccount) {
        const next = list[round];
        if (!next) continue;
        order.push({ ...next, user_id: userId });
        added = true;
        if (order.length >= WEBHOOK_LIMITS.claimBatch) break;
      }
      if (!added) break;
      round++;
    }
    for (const candidate of order) {
      if (inFlight.has(candidate.id)) continue;
      if (!reserveSlots(candidate.endpoint_id, candidate.user_id)) continue;
      let claimed: ClaimedDelivery | null | "throttled";
      try {
        claimed = claimDelivery(candidate.id, now);
      } catch {
        claimed = null;
      }
      if (!claimed || claimed === "throttled") {
        releaseSlots(candidate.endpoint_id, candidate.user_id);
        if (claimed === "throttled") continue;
        continue;
      }
      inFlight.add(claimed.row.id);
      void attempt(claimed);
    }
    // Expiry runs here rather than only on the maintenance tick, so an overdue active row cannot wait.
    for (const id of expireDeliveries(now)) abortDeliverySend(id);
  } finally {
    pumping = false;
  }
}

function schedule(): void {
  if (!started) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void pumpOutgoingWebhooks().finally(schedule);
  }, 1_000);
  timer.unref?.();
}

function installAbortHooks(): void {
  setEndpointAbortHook((endpointId) => {
    for (const [deliveryId, entry] of controllers) {
      if (entry.endpointId !== endpointId) continue;
      entry.controller.abort();
      controllers.delete(deliveryId);
    }
  });
  setDeliveryAbortHook((deliveryId) => {
    const entry = controllers.get(deliveryId);
    if (!entry) return;
    entry.controller.abort();
    controllers.delete(deliveryId);
  });
}

function start(): void {
  if (started) return;
  started = true;
  recoverSendingDeliveries(hooks.now());
  setOutboxWake(() => {
    void pumpOutgoingWebhooks();
  });
  installAbortHooks();
  void pumpOutgoingWebhooks();
  schedule();
}

export function startOutgoingWebhookWorker(options?: Partial<Hooks>): void {
  if (options) hooks = { ...hooks, ...options };
  start();
}

/** Tests drive one pump without a timer. */
export async function runOutgoingWebhookPumpForTests(options: Partial<Hooks> = {}): Promise<void> {
  hooks = { ...hooks, ...options };
  if (!started) {
    started = true;
    recoverSendingDeliveries(hooks.now());
    setOutboxWake(() => {
      void pumpOutgoingWebhooks();
    });
    installAbortHooks();
  }
  await pumpOutgoingWebhooks();
  // Let the fire-and-forget attempts settle before the assertion reads the database.
  const deadline = Date.now() + 2_000;
  while ((inFlight.size || pumping) && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
}

export function stopOutgoingWebhookWorker(): void {
  started = false;
  if (timer) clearTimeout(timer);
  timer = null;
  setOutboxWake(null);
  setEndpointAbortHook(null);
  setDeliveryAbortHook(null);
  for (const entry of controllers.values()) entry.controller.abort();
  controllers.clear();
}

export function outgoingWebhookWorkerStats(): { active: number; lastPumpAt: number | null } {
  return { active: inFlight.size, lastPumpAt };
}

export function resetOutgoingWebhookWorkerForTests(): void {
  stopOutgoingWebhookWorker();
  inFlight.clear();
  activeByEndpoint.clear();
  activeByAccount.clear();
  hooks = { transport: sendWebhook, random: Math.random, now: Date.now };
}

/** The failure code vocabulary is shared; this cast keeps the worker's use explicit. */
export const isRetryableCode = (code: DeliveryErrorCode | null): boolean =>
  code === "network" || code === "dns" || code === "timeout" || code === "http_retryable";
