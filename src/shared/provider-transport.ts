// Connection-wide authentication, static headers, default query, and model source for custom
// OpenAI-compatible connections. Pure contracts and validation primitives shared by the server (the
// authority) and the settings form (feedback only). No secrets and no server imports live here.
// See docs/implementation/providers.md.

export type CustomAuth =
  | { mode: "bearer" }
  | { mode: "api-key"; headerName: string }
  | { mode: "headers" };

export type CustomAuthMode = CustomAuth["mode"];

/** A header or query row as the client sends it. An omitted value keeps the saved value of the same name. */
export interface SecretRowInput {
  name: string;
  value?: string;
}

/** A saved row as the owner or admin sees it. Values are write-only and never returned. */
export interface SecretRowSummary {
  name: string;
  hasValue: boolean;
}

export type CustomModelSource = { mode: "discover" } | { mode: "manual"; ids: string[] };

export interface CustomTransportInput {
  auth?: CustomAuth;
  headers?: SecretRowInput[];
  query?: SecretRowInput[];
}

export interface CustomTransportSummary {
  auth: CustomAuth;
  hasApiKey: boolean;
  headers: SecretRowSummary[];
  query: SecretRowSummary[];
}

/** Stable reasons the server returns as `reason` beside a dotted `field`; the form maps them to its own text. */
export type ConnectionFieldReason =
  | "required"
  | "too_long"
  | "too_many"
  | "control_character"
  | "invalid_unicode"
  | "whitespace"
  | "invalid_name"
  | "reserved_header"
  | "duplicate"
  | "auth_header_collision"
  | "invalid_url"
  | "secret_reentry_required"
  | "key_not_allowed"
  | "deployment_mismatch"
  | "unsupported_field"
  | "invalid_value"
  | "changed";

export const CONNECTION_FIELD_REASONS: readonly ConnectionFieldReason[] = [
  "required", "too_long", "too_many", "control_character", "invalid_unicode", "whitespace", "invalid_name", "reserved_header",
  "duplicate", "auth_header_collision", "invalid_url", "secret_reentry_required", "key_not_allowed", "deployment_mismatch",
  "unsupported_field", "invalid_value", "changed",
];

export const TRANSPORT_LIMITS = {
  baseUrlBytes: 2048,
  apiKeyBytes: 8192,
  headerRows: 16,
  headerNameBytes: 64,
  headerValueBytes: 4096,
  headerTotalBytes: 16 * 1024,
  queryRows: 8,
  queryValueBytes: 512,
  queryTotalBytes: 2048,
  finalUrlBytes: 8192,
  manualIds: 32,
  manualIdBytes: 128,
} as const;

/** Names the transport or connection owns. Extra headers can never set these. */
export const RESERVED_HEADERS: ReadonlySet<string> = new Set([
  "host", "content-length", "transfer-encoding", "cookie", "authorization", "proxy-authorization", "connection", "upgrade",
  "trailer", "te", "keep-alive", "expect", "content-type", "accept-encoding", "user-agent",
]);

/** Never allowed even as the chosen api-key header: cookies, host, and framing headers. */
const NEVER_AUTH = new Set(["host", "content-length", "transfer-encoding", "cookie", "connection", "upgrade", "trailer", "te", "keep-alive", "expect"]);

const utf8 = new TextEncoder();
export const byteLength = (value: string) => utf8.encode(value).length;

// C0, DEL, and C1 controls. CR and LF are C0.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const QUERY_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Shared text checks: no controls, no malformed Unicode. Order decides which reason the user sees first. */
function textReason(value: string): ConnectionFieldReason | null {
  if (LONE_SURROGATE.test(value)) return "invalid_unicode";
  if (CONTROL.test(value)) return "control_character";
  return null;
}

export function headerNameReason(name: string): ConnectionFieldReason | null {
  if (!name) return "required";
  const text = textReason(name);
  if (text) return text;
  if (name !== name.trim()) return "whitespace";
  if (name.startsWith(":")) return "reserved_header";
  if (byteLength(name) > TRANSPORT_LIMITS.headerNameBytes) return "too_long";
  if (!TOKEN.test(name)) return "invalid_name";
  const lower = name.toLowerCase();
  if (RESERVED_HEADERS.has(lower) || lower.startsWith("proxy-") || lower.startsWith("sec-")) return "reserved_header";
  return null;
}

/** The chosen api-key header: the same denylist, except Authorization may carry the raw key. */
export function authHeaderNameReason(name: string): ConnectionFieldReason | null {
  const lower = name.toLowerCase();
  if (lower === "authorization" && name === name.trim()) return null;
  const reason = headerNameReason(name);
  if (reason) return reason;
  return NEVER_AUTH.has(lower) ? "reserved_header" : null;
}

export function headerValueReason(value: string): ConnectionFieldReason | null {
  if (!value) return "required";
  const text = textReason(value);
  if (text) return text;
  if (value !== value.trim()) return "whitespace";
  if (byteLength(value) > TRANSPORT_LIMITS.headerValueBytes) return "too_long";
  // Printable ASCII only: Headers would otherwise reinterpret Latin-1 bytes.
  if (!/^[\x20-\x7e]+$/.test(value)) return "invalid_value";
  return null;
}

export function apiKeyReason(value: string): ConnectionFieldReason | null {
  if (!value) return "required";
  const text = textReason(value);
  if (text) return text;
  if (value !== value.trim()) return "whitespace";
  if (byteLength(value) > TRANSPORT_LIMITS.apiKeyBytes) return "too_long";
  if (!/^[\x20-\x7e]+$/.test(value)) return "invalid_value";
  return null;
}

export function queryNameReason(name: string): ConnectionFieldReason | null {
  if (!name) return "required";
  const text = textReason(name);
  if (text) return text;
  if (name !== name.trim()) return "whitespace";
  return QUERY_NAME.test(name) ? null : "invalid_name";
}

export function queryValueReason(value: string): ConnectionFieldReason | null {
  if (!value) return "required";
  const text = textReason(value);
  if (text) return text;
  if (byteLength(value) > TRANSPORT_LIMITS.queryValueBytes) return "too_long";
  return null;
}

export function modelIdReason(id: string): ConnectionFieldReason | null {
  if (!id) return "required";
  const text = textReason(id);
  if (text) return text;
  if (byteLength(id) > TRANSPORT_LIMITS.manualIdBytes) return "too_long";
  if (!MODEL_ID.test(id) || /^\.+$/.test(id)) return "invalid_value";
  return null;
}

/** Final operation names a base URL must not end in; the SDK appends them. */
const OPERATION_SUFFIX = /\/(?:chat\/completions|completions|embeddings|models|responses|images\/generations|audio\/(?:speech|transcriptions))$/i;

/**
 * Canonical custom base URL: absolute http(s), no userinfo/query/fragment/backslash/controls, no operation
 * suffix, host/scheme/default port normalized by URL, trailing slashes removed, path case preserved.
 */
export function normalizeCustomBaseURL(raw: string): { url: string } | { reason: ConnectionFieldReason } {
  if (!raw) return { reason: "required" };
  const text = textReason(raw);
  if (text) return { reason: text };
  if (raw !== raw.trim()) return { reason: "whitespace" };
  if (byteLength(raw) > TRANSPORT_LIMITS.baseUrlBytes) return { reason: "too_long" };
  if (raw.includes("\\") || raw.includes("?") || raw.includes("#")) return { reason: "invalid_url" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { reason: "invalid_url" };
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || !url.hostname) return { reason: "invalid_url" };
  // Encoded separators or dot segments make the literal base path ambiguous.
  if (/%2f|%5c|%2e/i.test(url.pathname)) return { reason: "invalid_url" };
  const path = url.pathname.replace(/\/+$/, "");
  if (OPERATION_SUFFIX.test(path)) return { reason: "invalid_url" };
  if (deploymentMarkers(path) > 1) return { reason: "invalid_url" };
  if (deploymentMarkers(path) === 1 && deploymentIdOf(path) === null) return { reason: "invalid_url" };
  return { url: `${url.protocol}//${url.host}${path}` };
}

const deploymentMarkers = (path: string) => (path.match(/\/openai\/deployments(?:\/|$)/gi) ?? []).length;

/**
 * The deployment id when a base path ends at `/openai/deployments/<id>` (an optional proxy prefix is allowed).
 * Structural only: a hostname never grants trust or changes policy.
 */
export function deploymentIdOf(pathOrUrl: string): string | null {
  let path = pathOrUrl;
  try {
    if (/^https?:/i.test(pathOrUrl)) path = new URL(pathOrUrl).pathname;
  } catch {
    return null;
  }
  const match = path.replace(/\/+$/, "").match(/\/openai\/deployments\/([^/]+)$/i);
  if (!match) return null;
  const id = match[1]!;
  return modelIdReason(id) ? null : id;
}

/** The header the connection sends its key in, or null when it sends none. */
export function authHeaderOf(auth: CustomAuth): string | null {
  return auth.mode === "bearer" ? "authorization" : auth.mode === "api-key" ? auth.headerName.toLowerCase() : null;
}

/** Bytes of the configured headers as sent, auth included. */
export function headerBytes(auth: CustomAuth, apiKey: string | undefined, headers: Array<{ name: string; value: string }>): number {
  const line = (name: string, value: string) => byteLength(name) + 2 + byteLength(value) + 2;
  const authName = authHeaderOf(auth);
  const authValue = auth.mode === "bearer" ? (apiKey ? `Bearer ${apiKey}` : "") : apiKey ?? "";
  return headers.reduce((sum, row) => sum + line(row.name, row.value), authName && authValue ? line(authName, authValue) : 0);
}

export function queryBytes(query: Array<{ name: string; value: string }>): number {
  const params = new URLSearchParams();
  for (const row of query) params.append(row.name, row.value);
  return byteLength(params.toString());
}
