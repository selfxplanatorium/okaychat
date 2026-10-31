import { parseErrorWire, unknownWire, type ErrorCode, type ErrorWire } from "@shared/errors";
import { redactSecrets } from "@shared/redact";

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
  }
}

const httpFallback = (status: number) => `The request failed (HTTP ${status}).`;

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
  if (wire) return new ApiError(wire.message, status, wire);
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
      throw new ApiError("The request was stopped.", 499, { code: "aborted", message: "The request was stopped.", retryable: false });
    }
    throw new ApiError("The server could not be reached.", 0, { code: "network", message: "The server could not be reached.", retryable: true });
  }
  const body = res.headers.get("content-type")?.includes("json") ? await res.json().catch(() => undefined) : await res.text().catch(() => "");
  if (typeof window !== "undefined" && isSessionUnauthorized(res.status, path, body)) {
    window.dispatchEvent(new Event("okaychat:unauthorized"));
  }
  if (typeof window !== "undefined" && init?.method && init.method !== "GET" && !path.startsWith("/auth")) window.dispatchEvent(new Event("okaychat:storage-changed"));
  if (!res.ok) throw apiErrorFromBody(body, res.status);
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
  const direct = parseErrorWire(error);
  if (direct) return direct;
  if (error instanceof Error) {
    const wrapped = parseErrorWire(error.message);
    if (wrapped) return wrapped;
  }
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
