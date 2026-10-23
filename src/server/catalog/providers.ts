import { HTTPException } from "hono/http-exception";
import type { ModelInfo, ProviderConnectionInput, ProviderInfo } from "../../shared/types.js";
import { decrypt, encrypt } from "../crypto.js";
import { db } from "../db.js";
import { USER_AGENT } from "../env.js";
import { publicFetch } from "../public-fetch.js";
import { getCatalog, isChatModelId, isSupportedProvider, resolveRoute, toModelInfo, unknownModel, type RawProvider } from "./models-dev.js";

export const OPENCODE_GO = "opencode-go";
const GO_MODELS_URL = "https://opencode.ai/inference/go/v1/models";

// Shown first, in this order. OpenCode Go is the default connection.
const PRIMARY = [OPENCODE_GO, "opencode", "anthropic", "openai", "google", "openrouter", "deepseek", "xai", "mistral", "groq"];

// models.dev calls the pay-as-you-go gateway just "OpenCode", which reads like OpenCode Go.
const NAMES: Record<string, string> = { opencode: "Opencode Zen" };

interface ConnectionRow {
  provider_id: string;
  api_key_enc: string | null;
  base_url: string | null;
  config_json: string;
  enabled: number;
}

export interface Connection {
  providerId: string;
  apiKey?: string;
  baseURL?: string;
  name?: string;
  enabled: boolean;
  /** Configured by an admin for every user. The user cannot see or change it. */
  shared?: boolean;
  /** A non-admin's own base URL: every request must reach a public address, never the server's network. */
  guarded?: boolean;
}

/** Admins may point connections at local servers (Ollama, LM Studio). Other users may not. */
export const mayUsePrivateHosts = (userId: string) =>
  (db.prepare("SELECT role FROM users WHERE id = ?").get(userId) as { role: string } | undefined)?.role === "admin";

/** A user id, or null for the server-wide connections an admin shares with every user. */
export type ConnectionScope = string | null;

function readScope(scope: ConnectionScope): Map<string, Connection> {
  const guarded = scope !== null && !mayUsePrivateHosts(scope);
  const rows = (
    scope === null
      ? db.prepare("SELECT provider_id, api_key_enc, base_url, config_json, enabled FROM shared_connections").all()
      : db.prepare("SELECT provider_id, api_key_enc, base_url, config_json, enabled FROM provider_connections WHERE user_id = ?").all(scope)
  ) as unknown as ConnectionRow[];
  return new Map(
    rows.map((r) => {
      const config = JSON.parse(r.config_json) as { name?: string };
      return [
        r.provider_id,
        {
          providerId: r.provider_id,
          apiKey: r.api_key_enc ? decrypt(r.api_key_enc) : undefined,
          baseURL: r.base_url ?? undefined,
          name: config.name,
          enabled: r.enabled === 1,
          ...(scope === null ? { shared: true } : {}),
          ...(guarded && r.base_url ? { guarded: true } : {}),
        },
      ];
    }),
  );
}

/** What a user can use: server-wide connections, overridden by the user's own for the same provider. */
function readConnections(userId: string): Map<string, Connection> {
  const shared = [...readScope(null)].filter(([, c]) => c.enabled);
  return new Map([...shared, ...readScope(userId)]);
}

export function getConnection(userId: string, providerId: string): Connection | undefined {
  return readConnections(userId).get(providerId);
}

export function saveConnection(scope: ConnectionScope, providerId: string, input: ProviderConnectionInput) {
  const existing = readScope(scope).get(providerId);
  // An omitted key keeps the stored one, so the UI never needs to read secrets back.
  const baseURL = input.baseURL === undefined ? existing?.baseURL : input.baseURL.trim() || undefined;
  // A kept key must never follow a new endpoint, or a hijacked session could redirect it to its own host.
  if (input.apiKey === undefined && existing?.apiKey && originOf(baseURL) !== originOf(existing.baseURL)) {
    throw new HTTPException(400, { message: "Enter the API key again when changing the base URL." });
  }
  const apiKey = input.apiKey === undefined ? existing?.apiKey : input.apiKey || undefined;
  const name = input.name ?? existing?.name;
  const values = [
    providerId,
    apiKey ? encrypt(apiKey) : null,
    baseURL ?? null,
    JSON.stringify({ name }),
    (input.enabled ?? existing?.enabled ?? true) ? 1 : 0,
    Date.now(),
  ];
  if (scope === null) {
    db.prepare(
      `INSERT INTO shared_connections (provider_id, api_key_enc, base_url, config_json, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (provider_id) DO UPDATE SET api_key_enc = excluded.api_key_enc, base_url = excluded.base_url,
         config_json = excluded.config_json, enabled = excluded.enabled`,
    ).run(...values);
  } else {
    db.prepare(
      `INSERT INTO provider_connections (user_id, provider_id, api_key_enc, base_url, config_json, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, provider_id) DO UPDATE SET api_key_enc = excluded.api_key_enc, base_url = excluded.base_url,
         config_json = excluded.config_json, enabled = excluded.enabled`,
    ).run(scope, ...values);
  }
  liveCache.clear();
}

const originOf = (url: string | undefined) => {
  try {
    return url ? new URL(url).origin : undefined;
  } catch {
    return url;
  }
};

export function deleteConnection(scope: ConnectionScope, providerId: string) {
  if (scope === null) db.prepare("DELETE FROM shared_connections WHERE provider_id = ?").run(providerId);
  else db.prepare("DELETE FROM provider_connections WHERE user_id = ? AND provider_id = ?").run(scope, providerId);
}

const isCustom = (id: string) => id.startsWith("custom-");
const isLocal = (url?: string) => !!url && /\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal)/.test(url);

// Checking every model of every provider is the slow part of listing providers. It only changes with the catalog.
const supported = new WeakMap<object, RawProvider[]>();
function supportedProviders(catalog: Record<string, RawProvider>): RawProvider[] {
  let list = supported.get(catalog);
  if (!list) supported.set(catalog, (list = Object.values(catalog).filter(isSupportedProvider)));
  return list;
}

/** Providers as a user sees them (own plus shared), or with `null` as the admin sees the shared set. */
export async function listProviders(scope: ConnectionScope): Promise<ProviderInfo[]> {
  const catalog = await getCatalog();
  const connections = scope === null ? readScope(null) : readConnections(scope);
  const out: ProviderInfo[] = [];
  for (const provider of supportedProviders(catalog)) {
    const conn = connections.get(provider.id);
    out.push({
      id: provider.id,
      name: NAMES[provider.id] ?? provider.name,
      doc: provider.doc,
      primary: PRIMARY.includes(provider.id),
      custom: false,
      needsBaseURL: isLocal(provider.api),
      connected: !!conn && (!!conn.apiKey || !!conn.baseURL),
      enabled: conn?.enabled ?? false,
      shared: scope !== null && !!conn?.shared,
      baseURL: conn?.baseURL ?? provider.api,
      modelCount: Object.keys(provider.models).length,
    });
  }
  for (const conn of connections.values()) {
    if (!isCustom(conn.providerId)) continue;
    out.push({
      id: conn.providerId,
      name: conn.name ?? conn.providerId,
      primary: false,
      custom: true,
      needsBaseURL: true,
      connected: true,
      enabled: conn.enabled,
      shared: scope !== null && !!conn.shared,
      baseURL: conn.baseURL,
      modelCount: 0,
    });
  }
  const rank = (p: ProviderInfo) => (p.primary ? PRIMARY.indexOf(p.id) : PRIMARY.length);
  return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

// Live `/models` lists, keyed by URL. Short TTL because providers add models often.
const liveCache = new Map<string, { ids: string[]; at: number }>();
const LIVE_TTL_MS = 15 * 60 * 1000;

const liveInflight = new Map<string, Promise<string[] | null>>();

function fetchLive(url: string, apiKey?: string, guarded = false): Promise<string[] | null> {
  let pending = liveInflight.get(url);
  if (!pending) {
    pending = (async () => {
      const hit = liveCache.get(url);
      try {
        const res = await (guarded ? publicFetch : fetch)(url, {
          headers: { "User-Agent": USER_AGENT, ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
          signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) return hit?.ids ?? null;
        const body = (await res.json()) as { data?: Array<{ id: string }> };
        const ids = (body.data ?? []).map((m) => m.id);
        liveCache.set(url, { ids, at: Date.now() });
        return ids;
      } catch {
        return hit?.ids ?? null;
      } finally {
        liveInflight.delete(url);
      }
    })();
    liveInflight.set(url, pending);
  }
  return pending;
}

async function fetchLiveIds(url: string, apiKey?: string, guarded = false): Promise<string[] | null> {
  const hit = liveCache.get(url);
  if (!hit) return fetchLive(url, apiKey, guarded);
  // A known list answers at once. An expired one is refreshed behind the request instead of delaying it.
  if (Date.now() - hit.at >= LIVE_TTL_MS) void fetchLive(url, apiKey, guarded);
  return hit.ids;
}

/** Loads the catalog and the OpenCode Go list at boot, so the first page load after a restart does not fetch them. */
export async function warmCatalog() {
  await Promise.all([getCatalog(), fetchLiveIds(GO_MODELS_URL)]);
}

async function modelsForProvider(provider: RawProvider, conn: Connection): Promise<ModelInfo[]> {
  const known = Object.values(provider.models)
    .map((m) => toModelInfo(provider, m))
    .filter((m): m is ModelInfo => m !== null)
    .map((m) => (conn.baseURL && !provider.id.startsWith("opencode") ? { ...m, baseURL: conn.baseURL } : m));

  if (provider.id !== OPENCODE_GO) return known;

  // Go's lineup changes faster than models.dev. The live list is the source of truth for
  // which ids exist; models.dev supplies format, limits, and prices where it knows them.
  const live = await fetchLiveIds(GO_MODELS_URL);
  if (!live) return known;
  const byId = new Map(known.map((m) => [m.id, m]));
  const fallback = resolveRoute(provider)!;
  // Unknown ids usually share a wire format with their family (qwen3.6 with qwen3.8, grok-4.6 with grok-4.7).
  const familyOf = (id: string) => id.match(/^[a-z]+/)?.[0] ?? id;
  const sibling = (id: string) => known.find((m) => familyOf(m.id) === familyOf(id));
  return live.filter((id) => isChatModelId(id)).map((id) => {
    const hit = byId.get(id);
    if (hit) return hit;
    const kin = sibling(id);
    return unknownModel(provider.id, id, kin?.format ?? fallback.format, kin?.baseURL ?? fallback.baseURL);
  });
}

async function modelsForCustom(conn: Connection): Promise<ModelInfo[]> {
  if (!conn.baseURL) return [];
  const ids = (await fetchLiveIds(`${conn.baseURL.replace(/\/$/, "")}/models`, conn.apiKey, conn.guarded)) ?? [];
  return ids.filter((id) => isChatModelId(id)).map((id) => ({ ...unknownModel(conn.providerId, id, "openai-chat", conn.baseURL), name: id }));
}

export async function listModels(userId: string): Promise<ModelInfo[]> {
  const catalog = await getCatalog();
  const connections = [...readConnections(userId).values()].filter((c) => c.enabled && (c.apiKey || c.baseURL));
  const lists = await Promise.all(
    connections.map((conn) => {
      if (isCustom(conn.providerId)) return modelsForCustom(conn);
      const provider = catalog[conn.providerId];
      return provider ? modelsForProvider(provider, conn) : Promise.resolve([]);
    }),
  );
  return lists.flat();
}

export async function resolveModel(userId: string, ref: string): Promise<{ model: ModelInfo; conn: Connection }> {
  const slash = ref.indexOf("/");
  const providerId = ref.slice(0, slash);
  const conn = getConnection(userId, providerId);
  if (!conn || !conn.enabled) throw new HTTPException(400, { message: `Provider ${providerId} is not connected` });
  const models = await listModels(userId);
  const model = models.find((m) => m.ref === ref);
  if (!model) throw new HTTPException(400, { message: `Unknown model ${ref}` });
  return { model, conn };
}
