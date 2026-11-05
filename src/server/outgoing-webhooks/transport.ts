import type { DeliveryErrorCode } from "../../shared/outgoing-webhooks.js";
import { WEBHOOK_LIMITS, WEBHOOK_USER_AGENT } from "../../shared/outgoing-webhooks.js";
import { BlockedAddressError, publicFetch } from "../public-fetch.js";

/**
 * One delivery attempt. This is the only network boundary for outgoing webhooks: every attempt —
 * including a settings test and an admin-triggered retry — goes through `publicFetch`, which checks
 * DNS at connection time and pins the checked addresses.
 *
 * HTTPS and port 443 are enforced again here, because a stored URL could predate a policy change.
 * Redirects are never followed; a 3xx is a permanent failure and its Location is never inspected.
 * Response bodies are cancelled without being read, so remote retention is zero bytes.
 */

export interface WebhookTransportInput {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
  /** Aborted by shutdown, a config revision change, expiry, or manual cleanup. */
  signal: AbortSignal;
  timeoutMs?: number;
}

export interface WebhookTransportResult {
  outcome: "succeeded" | "failed";
  httpStatus: number | null;
  errorCode: DeliveryErrorCode | null;
  durationMs: number;
}

/** No proxy, custom CA, insecure TLS, cookie, or environment proxy: plain pinned HTTPS. */
export function assertDeliverableUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && (!url.port || url.port === "443") && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

const RETRYABLE_STATUS = (status: number) => status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);

export async function sendWebhook(input: WebhookTransportInput): Promise<WebhookTransportResult> {
  const startedAt = Date.now();
  if (!assertDeliverableUrl(input.url)) {
    return { outcome: "failed", httpStatus: null, errorCode: "blocked_destination", durationMs: 0 };
  }
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), input.timeoutMs ?? WEBHOOK_LIMITS.attemptMs);
  timer.unref?.();
  const signal = AbortSignal.any([input.signal, timeout.signal]);
  try {
    const response = await publicFetch(input.url, {
      method: "POST",
      headers: { ...input.headers, "User-Agent": WEBHOOK_USER_AGENT },
      body: input.body as unknown as BodyInit,
      redirect: "manual",
      signal,
    });
    const status = response.status;
    // Discard immediately on every status; nothing from a receiver is parsed, stored, or rendered.
    await response.body?.cancel().catch(() => {});
    if (status >= 200 && status <= 299) {
      return { outcome: "succeeded", httpStatus: status, errorCode: null, durationMs: Date.now() - startedAt };
    }
    if (status >= 300 && status <= 399) {
      return { outcome: "failed", httpStatus: status, errorCode: "redirect", durationMs: Date.now() - startedAt };
    }
    return {
      outcome: "failed",
      httpStatus: status,
      errorCode: RETRYABLE_STATUS(status) ? "http_retryable" : "http_permanent",
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    if (timeout.signal.aborted) return { outcome: "failed", httpStatus: null, errorCode: "timeout", durationMs };
    if (input.signal.aborted) return { outcome: "failed", httpStatus: null, errorCode: "shutdown", durationMs };
    if (error instanceof BlockedAddressError) return { outcome: "failed", httpStatus: null, errorCode: "blocked_destination", durationMs };
    const code = typeof (error as { code?: unknown }).code === "string" ? String((error as { code: string }).code) : "";
    // Never retain error.message: it can contain the destination, a Location, or upstream text.
    if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_FAIL" || code === "EAI_NONAME") {
      return { outcome: "failed", httpStatus: null, errorCode: "dns", durationMs };
    }
    return { outcome: "failed", httpStatus: null, errorCode: "network", durationMs };
  } finally {
    clearTimeout(timer);
  }
}
