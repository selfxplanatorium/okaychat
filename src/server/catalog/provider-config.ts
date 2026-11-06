import { createHash } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { ProviderConnectionInput } from "../../shared/types.js";
import {
  apiKeyReason,
  authHeaderNameReason,
  authHeaderOf,
  deploymentIdOf,
  headerBytes,
  headerNameReason,
  headerValueReason,
  modelIdReason,
  normalizeCustomBaseURL,
  queryBytes,
  queryNameReason,
  queryValueReason,
  TRANSPORT_LIMITS,
  type ConnectionFieldReason,
  type CustomAuth,
  type CustomModelSource,
  type CustomTransportSummary,
  type SecretRowInput,
} from "../../shared/provider-transport.js";
import { decrypt, domainHmac, encrypt } from "../crypto.js";

// Connection-wide transport configuration for custom connections: one schema for every save path, the
// patch merge with write-only secrets, the versioned config_json codec, safe summaries, and the digests
// that key caches and knowledge pins. See docs/implementation/providers.md.

export const isCustomProvider = (id: string) => id.startsWith("custom-");

export interface ConfigRow {
  name: string;
  value: string;
}

/** Decrypted, validated configuration of a v1 custom connection. Server-only; never serialized to a client. */
export interface CustomTransportConfig {
  auth: CustomAuth;
  headers: ConfigRow[];
  query: ConfigRow[];
  modelSource: CustomModelSource;
}

/** `ok: false` is a corrupt or unknown stored configuration: the connection fails closed, never falls back to Bearer. */
export type ConnectionTransport = { ok: true; config: CustomTransportConfig } | { ok: false };

const REASON_TEXT: Record<ConnectionFieldReason, string> = {
  required: "This field is required.",
  too_long: "This value is too long.",
  too_many: "Too many entries.",
  control_character: "Control characters such as line breaks are not allowed.",
  invalid_unicode: "This value contains malformed text.",
  whitespace: "Remove leading or trailing spaces.",
  invalid_name: "This name contains characters that are not allowed.",
  reserved_header: "This header is reserved for the connection or HTTP transport.",
  duplicate: "This name is used more than once.",
  auth_header_collision: "This header is already used for authentication.",
  invalid_url: "Enter an http or https base URL without credentials, query, fragment, or operation path.",
  secret_reentry_required: "Enter this value again or remove it.",
  key_not_allowed: "Static headers mode sends no API key. Remove the key or choose another authentication.",
  deployment_mismatch: "A deployment URL needs manual model ids containing exactly that deployment name.",
  unsupported_field: "This setting is only available for custom connections.",
  invalid_value: "This value is not valid.",
  changed: "The connection changed while saving. Try again.",
};

/** A safe 400 naming the field and a stable reason. Never carries the rejected value. */
export class ConnectionInputError extends HTTPException {
  constructor(
    readonly field: string,
    readonly reason: ConnectionFieldReason,
    status: 400 | 409 = 400,
  ) {
    super(status, { message: REASON_TEXT[reason] });
    this.name = "ConnectionInputError";
  }

  body() {
    return { error: this.message, field: this.field, reason: this.reason };
  }
}

// A declaration, not an arrow, so calls narrow under control-flow analysis.
function fail(field: string, reason: ConnectionFieldReason): never {
  throw new ConnectionInputError(field, reason);
}

// Coarse structural caps only; byte, count, and character rules are applied below with field-level reasons.
const rowSchema = z.object({ name: z.string().max(512), value: z.string().max(16_384).optional() }).strict();
const authSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("bearer") }).strict(),
  z.object({ mode: z.literal("api-key"), headerName: z.string().max(512) }).strict(),
  z.object({ mode: z.literal("headers") }).strict(),
]);
const modelSourceSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("discover") }).strict(),
  z.object({ mode: z.literal("manual"), ids: z.array(z.string().max(1024)).max(256) }).strict(),
]);
const transportSchema = z.object({
  auth: authSchema.optional(),
  headers: z.array(rowSchema).max(256).optional(),
  query: z.array(rowSchema).max(256).optional(),
}).strict();

/** The one provider PUT schema for the user and admin routes. Unknown top-level keys are dropped as before. */
export const providerInputSchema = z.object({
  apiKey: z.string().max(65_536).optional(),
  baseURL: z.string().max(16_384).optional(),
  name: z.string().max(60).optional(),
  enabled: z.boolean().optional(),
  transport: transportSchema.optional(),
  modelSource: modelSourceSchema.optional(),
});

/** Parses a PUT body into input or a field error. Zod messages are not used: some echo the rejected value. */
export function parseProviderInput(providerId: string, body: unknown): ProviderConnectionInput {
  const parsed = providerInputSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const field = issue.path.map(String).join(".") || "body";
    fail(field, issue.code === "unrecognized_keys" ? "unsupported_field" : issue.code === "too_big" ? "too_long" : "invalid_value");
  }
  const input = parsed.data!;
  checkInputScope(providerId, input);
  return input;
}

function checkInputScope(providerId: string, input: ProviderConnectionInput): void {
  // Generic auth must never replace a built-in protocol (native, OAuth, image-only, regional speech).
  if (!isCustomProvider(providerId)) {
    if (input.transport !== undefined) fail("transport", "unsupported_field");
    if (input.modelSource !== undefined) fail("modelSource", "unsupported_field");
    if (input.baseURL) {
      try {
        new URL(input.baseURL);
      } catch {
        fail("baseURL", "invalid_url");
      }
    }
  }
  if (input.name !== undefined && /[\u0000-\u001f\u007f-\u009f]/.test(input.name)) fail("name", "control_character");
}

// ---- stored configuration ----

interface StoredTransportV1 {
  auth: CustomAuth;
  headerNames: string[];
  queryNames: string[];
  valuesEnc: string;
}

/** config_json split into the known fields and everything else, which every save preserves. */
export interface DecodedConfig {
  name?: string;
  rest: Record<string, unknown>;
  /** Absent for legacy custom rows and built-ins. */
  transport?: ConnectionTransport;
}

const KNOWN_KEYS = new Set(["name", "customTransportVersion", "transport", "modelSource"]);

function validAuth(value: unknown): CustomAuth | null {
  const parsed = authSchema.safeParse(value);
  if (!parsed.success) return null;
  const auth = parsed.data;
  if (auth.mode === "api-key") {
    if (authHeaderNameReason(auth.headerName) || auth.headerName !== auth.headerName.toLowerCase()) return null;
  }
  return auth;
}

function validModelSource(value: unknown): CustomModelSource | null {
  const parsed = modelSourceSchema.safeParse(value);
  if (!parsed.success) return null;
  const source = parsed.data;
  if (source.mode === "manual") {
    if (!source.ids.length || source.ids.length > TRANSPORT_LIMITS.manualIds) return null;
    if (new Set(source.ids).size !== source.ids.length || source.ids.some((id) => modelIdReason(id))) return null;
  }
  return source;
}

function decodeTransport(providerId: string, config: Record<string, unknown>): ConnectionTransport {
  if (config.customTransportVersion !== 1 || !isCustomProvider(providerId)) return { ok: false };
  try {
    const stored = config.transport as StoredTransportV1 | undefined;
    const auth = validAuth(stored?.auth);
    const modelSource = validModelSource(config.modelSource);
    if (!stored || !auth || !modelSource || typeof stored.valuesEnc !== "string") return { ok: false };
    if (!Array.isArray(stored.headerNames) || !Array.isArray(stored.queryNames)) return { ok: false };
    const values = JSON.parse(decrypt(stored.valuesEnc)) as { headers?: unknown; query?: unknown };
    const rows = (list: unknown, names: unknown[], check: (row: ConfigRow) => boolean): ConfigRow[] | null => {
      if (!Array.isArray(list) || list.length !== names.length) return null;
      const out: ConfigRow[] = [];
      for (let i = 0; i < list.length; i++) {
        const row = list[i] as Partial<ConfigRow> | null;
        if (!row || typeof row.name !== "string" || typeof row.value !== "string" || row.name !== names[i] || !check(row as ConfigRow)) return null;
        out.push({ name: row.name, value: row.value });
      }
      return out;
    };
    const headers = rows(values.headers, stored.headerNames, (r) => !headerNameReason(r.name) && r.name === r.name.toLowerCase() && !headerValueReason(r.value));
    const query = rows(values.query, stored.queryNames, (r) => !queryNameReason(r.name) && !queryValueReason(r.value));
    if (!headers || !query) return { ok: false };
    if (headers.length > TRANSPORT_LIMITS.headerRows || query.length > TRANSPORT_LIMITS.queryRows) return { ok: false };
    const authName = authHeaderOf(auth);
    if (headers.some((row) => row.name === authName)) return { ok: false };
    return { ok: true, config: { auth, headers, query, modelSource } };
  } catch {
    return { ok: false };
  }
}

/** The single decoder for both connection tables and pinned resolution. Missing version means legacy defaults. */
export function decodeConfig(providerId: string, configJson: string): DecodedConfig {
  let config: Record<string, unknown>;
  try {
    const parsed = JSON.parse(configJson) as unknown;
    config = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    config = {};
  }
  const rest = Object.fromEntries(Object.entries(config).filter(([key]) => !KNOWN_KEYS.has(key)));
  const name = typeof config.name === "string" ? config.name : undefined;
  if (config.customTransportVersion === undefined) return { name, rest };
  return { name, rest, transport: decodeTransport(providerId, config) };
}

function encodeConfig(name: string | undefined, rest: Record<string, unknown>, config: CustomTransportConfig | undefined): string {
  if (!config) return JSON.stringify({ ...rest, name });
  const transport: StoredTransportV1 = {
    auth: config.auth,
    headerNames: config.headers.map((row) => row.name),
    queryNames: config.query.map((row) => row.name),
    valuesEnc: encrypt(JSON.stringify({ headers: config.headers, query: config.query })),
  };
  return JSON.stringify({ ...rest, name, customTransportVersion: 1, transport, modelSource: config.modelSource });
}

// ---- patch merge ----

export interface StoredConnection {
  apiKey?: string;
  baseURL?: string;
  enabled: boolean;
  config: DecodedConfig;
}

export interface ConnectionCandidate {
  apiKey?: string;
  baseURL?: string;
  enabled: boolean;
  configJson: string;
  /** True when the save opted into (or kept) the v1 configuration. */
  custom?: CustomTransportConfig;
}

const originOf = (url: string | undefined) => {
  try {
    return url ? new URL(url).origin : undefined;
  } catch {
    return url;
  }
};

const sameAuthTarget = (a: CustomAuth, b: CustomAuth) =>
  a.mode === b.mode && (a.mode !== "api-key" || a.headerName === (b as { headerName: string }).headerName);

interface MergedRows {
  rows: ConfigRow[];
  /** Indexes whose value was kept from the saved row rather than supplied now. */
  retained: Set<number>;
}

function mergeRows(
  field: "transport.headers" | "transport.query",
  input: SecretRowInput[] | undefined,
  existing: ConfigRow[],
  normalize: (name: string) => string,
  nameReason: (name: string) => ConnectionFieldReason | null,
  valueReason: (value: string) => ConnectionFieldReason | null,
  maxRows: number,
): MergedRows {
  if (input === undefined) return { rows: existing, retained: new Set(existing.map((_, i) => i)) };
  if (input.length > maxRows) fail(field, "too_many");
  const saved = new Map(existing.map((row) => [row.name, row.value]));
  const seen = new Set<string>();
  const rows: ConfigRow[] = [];
  const retained = new Set<number>();
  input.forEach((row, i) => {
    const reason = nameReason(row.name);
    if (reason) fail(`${field}.${i}.name`, reason);
    const name = normalize(row.name);
    if (seen.has(name)) fail(`${field}.${i}.name`, "duplicate");
    seen.add(name);
    if (row.value === undefined) {
      // Only the same normalized name keeps its value; a rename is a delete plus a create.
      const kept = saved.get(name);
      if (kept === undefined) fail(`${field}.${i}.value`, "required");
      rows.push({ name, value: kept! });
      retained.add(i);
    } else {
      const valueError = valueReason(row.value);
      if (valueError) fail(`${field}.${i}.value`, valueError);
      rows.push({ name, value: row.value });
    }
  });
  return { rows, retained };
}

function normalizedAuth(auth: CustomAuth): CustomAuth {
  if (auth.mode !== "api-key") return { mode: auth.mode };
  const reason = authHeaderNameReason(auth.headerName);
  if (reason) fail("transport.auth.headerName", reason);
  return { mode: "api-key", headerName: auth.headerName.toLowerCase() };
}

function normalizedModelSource(source: CustomModelSource): CustomModelSource {
  if (source.mode === "discover") return { mode: "discover" };
  if (!source.ids.length) fail("modelSource.ids", "required");
  if (source.ids.length > TRANSPORT_LIMITS.manualIds) fail("modelSource.ids", "too_many");
  const seen = new Set<string>();
  source.ids.forEach((id, i) => {
    const reason = modelIdReason(id);
    if (reason) fail(`modelSource.ids.${i}`, reason);
    if (seen.has(id)) fail(`modelSource.ids.${i}`, "duplicate");
    seen.add(id);
  });
  return { mode: "manual", ids: [...source.ids] };
}

/**
 * Builds a complete custom-connection candidate from the owned row and a validated patch, or throws a
 * field error. Nothing is persisted here and nothing is read from another scope.
 */
export function buildCustomCandidate(providerId: string, existing: StoredConnection | undefined, input: ProviderConnectionInput): ConnectionCandidate {
  const previous = existing?.config.transport;
  if (previous && !previous.ok && input.transport === undefined && input.modelSource === undefined && !isOnlyToggle(input)) {
    // A corrupt stored configuration cannot be partially patched: the owner must supply it again.
    fail("transport", "secret_reentry_required");
  }
  const prior = previous?.ok ? previous.config : undefined;
  const toV1 = !existing || !!previous || input.transport !== undefined || input.modelSource !== undefined;

  // Base URL. A supplied value is held to the new rules; a retained one must satisfy them before opting into v1.
  let baseURL = existing?.baseURL;
  if (input.baseURL !== undefined) {
    const normalized = normalizeCustomBaseURL(input.baseURL);
    if ("reason" in normalized) fail("baseURL", normalized.reason);
    baseURL = (normalized as { url: string }).url;
  } else if (toV1) {
    if (!baseURL) fail("baseURL", "required");
    const normalized = normalizeCustomBaseURL(baseURL!);
    if ("reason" in normalized) fail("baseURL", normalized.reason);
    baseURL = (normalized as { url: string }).url;
  }
  if (!baseURL) fail("baseURL", "required");
  const originChanged = !!existing && originOf(existing.baseURL) !== originOf(baseURL);
  const keySupplied = typeof input.apiKey === "string" && input.apiKey !== "";
  if (keySupplied) {
    const reason = apiKeyReason(input.apiKey!);
    if (reason) fail("apiKey", reason);
  }

  const name = input.name ?? existing?.config.name ?? providerId;
  const enabled = input.enabled ?? existing?.enabled ?? true;
  const rest = existing?.config.rest ?? {};

  if (!toV1) {
    // A legacy row keeps its on-wire behavior until the owner opts in; only the key/origin rule applies.
    if (input.apiKey === undefined && existing?.apiKey && originChanged) fail("apiKey", "secret_reentry_required");
    const apiKey = input.apiKey === undefined ? existing?.apiKey : input.apiKey || undefined;
    return { apiKey, baseURL, enabled, configJson: encodeConfig(name, rest, undefined) };
  }

  const priorAuth: CustomAuth = prior?.auth ?? { mode: "bearer" };
  const auth = normalizedAuth(input.transport?.auth ?? priorAuth);
  let apiKey: string | undefined;
  if (auth.mode === "headers") {
    // Static headers mode never generates authentication; switching to it clears the key atomically.
    if (keySupplied) fail("apiKey", "key_not_allowed");
    apiKey = undefined;
  } else if (input.apiKey === "") {
    apiKey = undefined;
  } else if (keySupplied) {
    apiKey = input.apiKey;
  } else {
    // Never repurpose a stored key for another auth header; after a corrupt config its header is unknown.
    if (existing?.apiKey && (!sameAuthTarget(priorAuth, auth) || (previous && !previous.ok))) fail("apiKey", "secret_reentry_required");
    apiKey = existing?.apiKey;
  }
  if (auth.mode === "api-key" && !apiKey) fail("apiKey", "required");

  const headers = mergeRows("transport.headers", input.transport?.headers, prior?.headers ?? [], (n) => n.toLowerCase(), headerNameReason, headerValueReason, TRANSPORT_LIMITS.headerRows);
  const query = mergeRows("transport.query", input.transport?.query, prior?.query ?? [], (n) => n, queryNameReason, queryValueReason, TRANSPORT_LIMITS.queryRows);
  const authName = authHeaderOf(auth);
  const collision = headers.rows.findIndex((row) => row.name === authName);
  if (collision >= 0) fail(input.transport?.headers ? `transport.headers.${collision}.name` : "transport.auth", "auth_header_collision");

  if (originChanged) {
    // Every surviving secret follows the new address only when supplied again in this request.
    if (apiKey && !keySupplied) fail("apiKey", "secret_reentry_required");
    for (const [field, merged, supplied] of [
      ["transport.headers", headers, input.transport?.headers],
      ["transport.query", query, input.transport?.query],
    ] as const) {
      if (!merged.rows.length) continue;
      if (supplied === undefined) fail(field, "secret_reentry_required");
      const kept = [...merged.retained][0];
      if (kept !== undefined) fail(`${field}.${kept}.value`, "secret_reentry_required");
    }
  }

  if (headerBytes(auth, apiKey, headers.rows) > TRANSPORT_LIMITS.headerTotalBytes) fail("transport.headers", "too_long");
  if (queryBytes(query.rows) > TRANSPORT_LIMITS.queryTotalBytes) fail("transport.query", "too_long");

  const modelSource = normalizedModelSource(input.modelSource ?? prior?.modelSource ?? { mode: "discover" });
  const deployment = deploymentIdOf(baseURL!);
  if (deployment !== null && (modelSource.mode !== "manual" || modelSource.ids.length !== 1 || modelSource.ids[0] !== deployment)) {
    fail("modelSource", "deployment_mismatch");
  }

  const custom: CustomTransportConfig = { auth, headers: headers.rows, query: query.rows, modelSource };
  return { apiKey, baseURL, enabled, configJson: encodeConfig(name, rest, custom), custom };
}

const isOnlyToggle = (input: ProviderConnectionInput) =>
  Object.entries(input).every(([key, value]) => value === undefined || key === "enabled");

/** True when the patch changes nothing but the switch or the label, so no destination check is needed. */
export const changesDestination = (input: ProviderConnectionInput) =>
  Object.entries(input).some(([key, value]) => value !== undefined && key !== "enabled" && key !== "name");

/** The redacted owner/admin projection: names and presence only. */
export function transportSummary(transport: ConnectionTransport | undefined, apiKey: string | undefined): { transport: CustomTransportSummary; modelSource: CustomModelSource } {
  const config = transport?.ok ? transport.config : undefined;
  return {
    transport: {
      auth: config?.auth ?? { mode: "bearer" },
      hasApiKey: !!apiKey,
      headers: (config?.headers ?? []).map((row) => ({ name: row.name, hasValue: true })),
      query: (config?.query ?? []).map((row) => ({ name: row.name, hasValue: true })),
    },
    modelSource: config?.modelSource ?? { mode: "discover" },
  };
}

// ---- digests ----

/** The fields a digest needs; matches the server Connection without importing it. */
export interface DigestInput {
  providerId: string;
  apiKey?: string;
  baseURL?: string;
  shared?: boolean;
  guarded?: boolean;
  transport?: ConnectionTransport;
}

const sorted = (rows: ConfigRow[]) => [...rows].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.value < b.value ? -1 : 1)).map((r) => [r.name, r.value]);

/**
 * Cryptographic digest of everything that changes who answers and with which credentials. Keys caches and
 * live pin comparisons; never logged and never derived from raw text a reader could see.
 */
export function connectionDigest(conn: DigestInput): string {
  const t = conn.transport;
  const config = t?.ok
    ? [1, t.config.auth, sorted(t.config.headers), sorted(t.config.query), t.config.modelSource]
    : t ? ["invalid"] : ["legacy"];
  return createHash("sha256")
    .update(JSON.stringify(["okaychat:connection:v1", conn.providerId, conn.shared ? "shared" : "own", conn.baseURL ?? "", conn.apiKey ?? "", conn.guarded ? "g" : "d", config]))
    .digest("hex");
}

/**
 * Query part of a knowledge pin. Empty for every connection without configured query, so existing pins keep
 * their hash; a changed API version changes it and forces an explicit reindex. Keyed, so a pin never reveals values.
 */
export function pinQuerySuffix(transport: ConnectionTransport | undefined): string {
  if (!transport) return "";
  if (!transport.ok) return `\ninvalid`;
  if (!transport.config.query.length) return "";
  return `\n${domainHmac("okaychat:knowledge-pin-query", JSON.stringify(sorted(transport.config.query)))}`;
}
