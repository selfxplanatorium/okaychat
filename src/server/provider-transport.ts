import { TRANSPORT_LIMITS, byteLength } from "../shared/provider-transport.js";
import type { ConnectionTransport, CustomTransportConfig } from "./catalog/provider-config.js";
import { AppError } from "./errors.js";
import { USER_AGENT } from "./env.js";
import { BlockedAddressError, publicFetch, readCapped } from "./public-fetch.js";

// The one HTTP boundary for v1 custom connections. Every provider request of such a connection is pinned
// to the connection's own origin and base path, gets exactly the configured auth, headers, and default
// query on every attempt, refuses redirects, and leaves only safe metadata on failure. Built-ins and
// legacy custom rows keep their existing transport unchanged. See docs/implementation/providers.md.

/** The connection fields this boundary reads. Matches the server `Connection`. */
export interface TransportConnection {
  providerId: string;
  apiKey?: string;
  baseURL?: string;
  guarded?: boolean;
  transport?: ConnectionTransport;
}

/** Statuses the safe body names; the status itself still drives retries and the error taxonomy. */
const SAFE_FAILURE: Record<number, string> = {
  401: "The custom connection rejected the credentials. Check the selected authentication and key.",
  403: "The custom connection rejected the credentials. Check the selected authentication and key.",
  404: "The custom connection answered not found. Check the deployment, path, and API version.",
};
const GENERIC_FAILURE = "The custom connection request failed.";

export const configurationError = () =>
  new AppError({ code: "validation", message: "The custom connection configuration is invalid. Save it again in Settings → Providers.", retryable: false });

const redirectError = () =>
  new AppError({ code: "validation", message: "The custom connection answered with a redirect, which is not followed.", retryable: false });

const destinationError = () =>
  new AppError({ code: "validation", message: "The request does not target the custom connection's address.", retryable: false });

const queryConflictError = () =>
  new AppError({ code: "validation", message: "The request sets a query parameter the connection configures.", retryable: false });

/**
 * A `fetch` for the connection: the v1 boundary for custom connections, otherwise exactly what callers used
 * before (publicFetch for guarded rows, undefined to let the SDK use the global fetch).
 */
export function providerFetch(conn: TransportConnection | undefined, leaf?: typeof fetch): typeof fetch | undefined {
  if (!conn?.transport) return leaf ?? (conn?.guarded ? publicFetch : undefined);
  return customTransport(conn, leaf);
}

/** Like providerFetch, but never undefined; for callers that call fetch themselves. */
export const connectionFetch = (conn: TransportConnection | undefined, leaf?: typeof fetch): typeof fetch =>
  providerFetch(conn, leaf) ?? ((input, init) => globalThis.fetch(input, init));

const urlOf = (input: RequestInfo | URL) => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url);

/** Canonical origin and literal base path, or null for a stored base URL that cannot be pinned. */
function pinOf(baseURL: string | undefined): { origin: string; path: string } | null {
  if (!baseURL) return null;
  try {
    const url = new URL(baseURL);
    if (url.username || url.password || url.search || url.hash) return null;
    return { origin: url.origin, path: url.pathname.replace(/\/+$/, "") };
  } catch {
    return null;
  }
}

/** Resolves an operation URL relative to the base path, rejecting another origin or any escape from it. */
function pinnedTarget(raw: string, pin: { origin: string; path: string }): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw destinationError();
  }
  if (url.origin !== pin.origin || url.username || url.password || url.hash || raw.includes("#")) throw destinationError();
  const suffix = url.pathname.slice(pin.path.length);
  if (!url.pathname.startsWith(pin.path) || (suffix && !suffix.startsWith("/"))) throw destinationError();
  if (/%2f|%5c|%2e/i.test(suffix)) throw destinationError();
  return url;
}

function applyQuery(url: URL, config: CustomTransportConfig): void {
  for (const row of config.query) {
    const present = url.searchParams.getAll(row.name);
    if (present.length === 0) url.searchParams.append(row.name, row.value);
    else if (present.length > 1 || present[0] !== row.value) throw queryConflictError();
  }
  if (byteLength(url.href) > TRANSPORT_LIMITS.finalUrlBytes) throw destinationError();
}

function applyHeaders(headers: Headers, conn: TransportConnection, config: CustomTransportConfig): void {
  // Auth is authoritative on every attempt: SDK-generated Authorization and any preexisting chosen header go.
  headers.delete("authorization");
  for (const row of config.headers) headers.delete(row.name);
  const auth = config.auth;
  if (auth.mode === "api-key") {
    headers.delete(auth.headerName);
    if (!conn.apiKey) throw configurationError();
    headers.set(auth.headerName, conn.apiKey);
  } else if (auth.mode === "bearer" && conn.apiKey) {
    headers.set("authorization", `Bearer ${conn.apiKey}`);
  }
  for (const row of config.headers) headers.set(row.name, row.value);
}

/** Only a bounded, numeric wait survives; the raw header never reaches a log. */
function safeHeaders(source: Headers): Headers {
  const out = new Headers({ "content-type": "application/json" });
  const ms = source.get("retry-after-ms")?.trim();
  if (ms && /^\d{1,9}$/.test(ms)) out.set("retry-after-ms", ms);
  const after = source.get("retry-after")?.trim();
  if (after) {
    if (/^\d{1,6}$/.test(after)) out.set("retry-after", after);
    else {
      const at = Date.parse(after);
      if (Number.isFinite(at)) out.set("retry-after", String(Math.max(0, Math.min(86_400, Math.ceil((at - Date.now()) / 1000)))));
    }
  }
  return out;
}

/** A failed response reduced to its status and authored text, so an echoed secret cannot reach any error field. */
async function safeFailure(response: Response): Promise<Response> {
  await response.body?.cancel().catch(() => {});
  const message = SAFE_FAILURE[response.status] ?? GENERIC_FAILURE;
  return new Response(JSON.stringify({ error: { message, type: "custom_connection_error" } }), { status: response.status, headers: safeHeaders(response.headers) });
}

const NETWORK_CODE = /^[A-Z][A-Z0-9_]{1,40}$/;
const isAbort = (error: unknown) => {
  const name = (error as { name?: string } | undefined)?.name;
  return name === "AbortError" || name === "TimeoutError";
};
const mentionsRedirect = (error: unknown) => {
  const current = error as { message?: unknown; cause?: { message?: unknown } } | undefined;
  return /redirect/i.test(String(current?.message ?? "")) || /redirect/i.test(String(current?.cause?.message ?? ""));
};

/**
 * A thrown network failure rebuilt from local facts only: undici and publicFetch messages can carry the URL
 * (with its query) or the Location of a refused redirect. Keeps the shape the retry and SDK classify.
 */
function safeThrown(error: unknown): unknown {
  if (isAbort(error)) return error;
  if (error instanceof AppError) return error;
  if (error instanceof BlockedAddressError || (error as { name?: string })?.name === "BlockedAddressError") return new BlockedAddressError();
  if (mentionsRedirect(error)) return redirectError();
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
  const raw = typeof cause?.code === "string" ? cause.code : typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "";
  const code = NETWORK_CODE.test(raw) ? raw : /could not resolve/i.test(String((error as Error)?.message ?? "")) ? "ENOTFOUND" : "ECONNRESET";
  return new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
}

function customTransport(conn: TransportConnection, leaf?: typeof fetch): typeof fetch {
  const send: typeof fetch = leaf ?? (conn.guarded ? publicFetch : (input, init) => globalThis.fetch(input, init));
  return async (input, init) => {
    const transport = conn.transport;
    const pin = pinOf(conn.baseURL);
    if (!transport?.ok || !pin) throw configurationError();
    const config = transport.config;
    // Destination first: nothing below attaches a secret to a URL outside the connection's base path.
    const target = pinnedTarget(urlOf(input), pin);
    applyQuery(target, config);
    let outgoing: RequestInit;
    try {
      const request = new Request(input, init);
      const headers = new Headers(request.headers);
      applyHeaders(headers, conn, config);
      // A plain init body (string, bytes, Blob, URLSearchParams) passes through unchanged. Multipart and
      // Request bodies use the Request's own stream, so the boundary in Content-Type still matches it.
      const plain = !(input instanceof Request) && init?.body != null && !(init.body instanceof FormData) && !(init.body instanceof ReadableStream);
      const body = plain ? init!.body : request.body;
      outgoing = {
        method: request.method,
        headers,
        body,
        signal: request.signal,
        redirect: "error",
        ...(body && !plain ? { duplex: "half" } : {}),
      } as RequestInit;
    } catch (error) {
      // A Headers or Request error message can quote the offending value.
      throw error instanceof AppError ? error : configurationError();
    }
    let response: Response;
    try {
      response = await send(target.href, outgoing);
    } catch (error) {
      throw safeThrown(error);
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      throw redirectError();
    }
    // Successful bodies stream through unbuffered; only failures are replaced.
    return response.ok ? response : safeFailure(response);
  };
}

/** Bounded discovery: 1 MiB of JSON, at most 10,000 valid ids, the caller's deadline. */
export async function discoverModelIds(conn: TransportConnection, signal: AbortSignal, leaf?: typeof fetch): Promise<string[] | null> {
  const base = pinOf(conn.baseURL);
  if (!base) return null;
  const res = await connectionFetch(conn, leaf)(`${base.origin}${base.path}/models`, { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const bytes = await readCapped(res, 1024 * 1024, "The model list is too large.");
  const body = JSON.parse(new TextDecoder().decode(bytes)) as { data?: unknown };
  if (!Array.isArray(body.data)) return [];
  const ids: string[] = [];
  for (const row of body.data) {
    const id = (row as { id?: unknown } | null)?.id;
    if (typeof id === "string" && id.length > 0 && id.length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/.test(id)) ids.push(id);
    if (ids.length >= 10_000) break;
  }
  return ids;
}
