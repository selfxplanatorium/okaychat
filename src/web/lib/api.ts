import { parseErrorWire, unknownWire, type ErrorCode, type ErrorWire } from "@shared/errors";
import type { AgentReason } from "@shared/n8n-agents";
import { redactSecrets } from "@shared/redact";
import { t } from "@/i18n";
import { presentError } from "@/lib/error-presentation";

/** A request failure with the safe structured fields the server sends. Never a raw provider body. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly ref?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly requestId?: string;
  /** An authored reason for an unusable agent answer; never remote text. */
  readonly agentReason?: AgentReason;

  constructor(message: string, readonly status: number, wire?: Partial<ErrorWire>) {
    super(message);
    this.name = "ApiError";
    this.code = wire?.code ?? "unknown";
    if (wire?.hint) this.hint = wire.hint;
    this.retryable = wire?.retryable === true;
    if (wire?.retryAfterMs !== undefined) this.retryAfterMs = wire.retryAfterMs;
    if (wire?.ref) this.ref = wire.ref;
    if (wire?.model) this.model = wire.model;
    if (wire?.provider) this.provider = wire.provider;
    if (wire?.requestId) this.requestId = wire.requestId;
    if (wire?.agentReason) this.agentReason = wire.agentReason;
  }
}

const httpFallback = (status: number) => t("errors.httpFailure", { status });

/** The registry refresh signal. Raised only by a real outage response, never by the health request itself. */
const SERVICE_FAILED_EVENT = "okaychat:service-failed";

export function notifyServiceFailure(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SERVICE_FAILED_EVENT));
}

/**
 * A `service_unavailable` failure asks the store to re-check. `/services` is excluded: a failing health
 * request is not evidence and must not start a refresh loop.
 */
export function notifyServiceFailureForWire(wire: ErrorWire | undefined, path: string): void {
  if (wire?.code !== "service_unavailable") return;
  // `/services?refresh=1` is still the health request; it must never trigger another one.
  if (path.split("?")[0] !== "/services") notifyServiceFailure();
}

/**
 * The same safe error and refresh signal for a raw fetch boundary (speech audio, PDF export) that cannot
 * use `api()`. The response body is parsed only into known wire fields; raw worker text never reaches the UI.
 */
export async function responseError(res: Response, path: string, fallback?: string): Promise<ApiError> {
  const body = res.headers.get("content-type")?.includes("json")
    ? await res.json().catch(() => undefined)
    : await res.text().catch(() => "");
  const wire = parseErrorWire(body);
  notifyServiceFailureForWire(wire, path);
  return apiErrorFromBody(body, res.status, fallback ?? httpFallback(res.status));
}

/** A legacy `{ error }` body is trusted only as authored 4xx validation, never as upstream detail. */
function legacyMessage(body: unknown, status: number): string | undefined {
  if (status < 400 || status >= 500) return undefined;
  if (typeof body !== "object" || body === null) return undefined;
  const value = (body as { error?: unknown }).error;
  if (typeof value !== "string") return undefined;
  const message = value.trim();
  // Route authors send a sentence. JSON, HTML, stacks, and key-shaped text are upstream failures.
  if (!message || message.length > 500) return undefined;
  if (/^\s*[{[]/.test(message) || /<\/?[a-z][\s\S]*>/i.test(message) || /\bat\s+\S+.*?:\d+:\d+/.test(message)) return undefined;
  if (/\b(?:api[-_]?key|authorization|token|secret)\b\s*[:=]/i.test(message)) return undefined;
  return redactSecrets(message).slice(0, 300);
}

/** Turns a JSON error body or a legacy `{ error }` body into an ApiError without echoing unknown shapes. */
export function apiErrorFromBody(body: unknown, status: number, fallback = httpFallback(status)): ApiError {
  const wire = parseErrorWire(body);
  if (wire) {
    const shown = presentError(wire, "settings");
    return new ApiError(shown.detail ?? t(shown.messageKey), status, wire);
  }
  return new ApiError(legacyMessage(body, status) || fallback, status);
}

const aborted = (error: unknown) => (error as { name?: string })?.name === "AbortError";

/**
 * The session 401 is an untyped legacy `{ error: "unauthorized" }`. A provider 401 arrives as wire
 * JSON (`provider_auth`) and must never sign the user out.
 */
export function isSessionUnauthorized(status: number, path: string, body: unknown): boolean {
  if (status !== 401 || path.startsWith("/auth")) return false;
  if (parseErrorWire(body)) return false;
  if (typeof body === "object" && body !== null && "code" in body) return false;
  return true;
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      credentials: "same-origin",
      ...rest,
      headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...rest.headers },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch (error) {
    if (aborted(error) || rest.signal?.aborted) {
      throw new ApiError(t("errors.abortedMessage"), 499, { code: "aborted", retryable: false });
    }
    throw new ApiError(t("errors.networkMessage"), 0, { code: "network", retryable: true });
  }
  const body = res.headers.get("content-type")?.includes("json") ? await res.json().catch(() => undefined) : await res.text().catch(() => "");
  if (typeof window !== "undefined" && isSessionUnauthorized(res.status, path, body)) {
    window.dispatchEvent(new Event("okaychat:unauthorized"));
  }
  if (typeof window !== "undefined" && init?.method && init.method !== "GET" && !path.startsWith("/auth")) window.dispatchEvent(new Event("okaychat:storage-changed"));
  if (!res.ok) {
    // A service outage is also a signal to re-check the registry; the store debounces and single-flights it.
    notifyServiceFailureForWire(parseErrorWire(body), path);
    throw apiErrorFromBody(body, res.status);
  }
  return body as T;
}

/** A non-OK chat response carries the same wire JSON; throw it so the message error can parse it. */
export async function structuredResponseError(res: Response): Promise<string | undefined> {
  if (res.ok) return undefined;
  const body = await res.clone().text().catch(() => "");
  const wire = parseErrorWire(body);
  return wire ? JSON.stringify(wire) : undefined;
}

/** A streamed chat error is the same wire JSON in a string; assistant-ui may wrap it in an Error. */
export function parseChatError(error: unknown): ErrorWire {
  // assistant-ui projects Error instances into plain { code, message } objects.
  // Decode the nested wire before accepting its generic outer code.
  if (typeof error === "object" && error !== null && "message" in error) {
    const nested = parseErrorWire(error.message);
    if (nested) return nested;
  }
  const direct = parseErrorWire(error);
  if (direct) return direct;
  return unknownWire();
}

const prefetched = new Map<string, { promise: Promise<unknown>; at: number }>();
// A prefetch serves the screen that is mounting now. An older one could show stale data.
const PREFETCH_TTL_MS = 10_000;

/** Starts a GET whose result a later `takePrefetched` call for the same path receives once. */
export function prefetch(path: string) {
  const promise = api(path);
  promise.catch(() => {});
  prefetched.set(path, { promise, at: Date.now() });
}

export function takePrefetched<T>(path: string): Promise<T> | undefined {
  const hit = prefetched.get(path);
  prefetched.delete(path);
  return hit && Date.now() - hit.at < PREFETCH_TTL_MS ? (hit.promise as Promise<T>) : undefined;
}
