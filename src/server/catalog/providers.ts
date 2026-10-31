import { HTTPException } from "hono/http-exception";
import type { ModelInfo, ProviderConnectionInput, ProviderInfo } from "../../shared/types.js";
import { decrypt, encrypt } from "../crypto.js";
import { db } from "../db.js";
import { modelAccessMessage, sharedModelAccess, type SharedModelAccess } from "../entitlements.js";
import { audienceIncludes, clearAudience, getAudience } from "../groups.js";
import { USER_AGENT } from "../env.js";
import { assertPublicHost, BlockedAddressError, publicFetch } from "../public-fetch.js";
import { CHATGPT, CHATGPT_BASE_URL, CHATGPT_NAME, chatgptConnected, chatgptModels } from "./chatgpt.js";
import { getCatalog, isChatModelId, isSupportedProvider, resolveRoute, toModelInfo, unknownModel, type RawProvider } from "./models-dev.js";
import { forgetOllamaModels, OLLAMA, OLLAMA_DEFAULT_URL, OLLAMA_DOC, OLLAMA_NAME, ollamaModels } from "./ollama.js";

export const OPENCODE_GO = "opencode-go";
const GO_MODELS_URL = "https://opencode.ai/inference/go/v1/models";

// Shown first, in this order. OpenCode Go is the default connection.
const PRIMARY = [OPENCODE_GO, CHATGPT, "opencode", "anthropic", "openai", "google", "openrouter", "deepseek", "xai", "mistral", "groq"];

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

/**
 * Non-admins may only point connections at the public internet, or any user could read the server's
 * network through a provider or MCP URL. Requests are checked again at connection time.
 */
export async function privateUrlError(userId: string, url: string | undefined): Promise<string | null> {
  if (!url || mayUsePrivateHosts(userId)) return null;
  try {
    await assertPublicHost(new URL(url));
    return null;
  } catch (error) {
    return error instanceof BlockedAddressError ? "Only admins can use local or private network addresses." : (error as Error).message;
  }
}

/** A user id, or null for the server-wide connections an admin shares with every user. */
export type ConnectionScope = string | null;

/** `viewer` limits the server-wide scope to connections whose audience includes that user. */
function readScope(scope: ConnectionScope, viewer?: string): Map<string, Connection> {
  const guarded = scope !== null && !mayUsePrivateHosts(scope);
  const rows = (
    scope === null
      ? viewer === undefined
        ? db.prepare("SELECT provider_id, api_key_enc, base_url, config_json, enabled FROM shared_connections").all()
        : db
            .prepare(`SELECT provider_id, api_key_enc, base_url, config_json, enabled FROM shared_connections WHERE ${audienceIncludes("provider", "provider_id")}`)
            .all(viewer, viewer)
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
          // Ollama falls back to loopback even without a stored URL, so a non-admin row is guarded
          // even when it predates the default being written.
          ...(guarded && (r.base_url || r.provider_id === OLLAMA) ? { guarded: true } : {}),
        },
      ];
    }),
  );
}

/** What a user can use: server-wide connections, overridden by the user's own for the same provider. */
function readConnections(userId: string): Map<string, Connection> {
  const shared = [...readScope(null, userId)].filter(([, c]) => c.enabled && c.providerId !== CHATGPT);
  const own = readScope(userId);
  // The ChatGPT login lives in codex_auth. A provider_connections row only records whether chat uses it.
  const chatgpt = own.get(CHATGPT);
  own.delete(CHATGPT);
  if (chatgptConnected(userId)) own.set(CHATGPT, { providerId: CHATGPT, baseURL: CHATGPT_BASE_URL, enabled: chatgpt?.enabled ?? true });
  return new Map([...shared, ...own]);
}

export function getConnection(userId: string, providerId: string): Connection | undefined {
  return readConnections(userId).get(providerId);
}

/** The user's own row only, never a server-wide connection they can merely use. */
export function getOwnConnection(userId: string, providerId: string): Connection | undefined {
  return readScope(userId).get(providerId);
}

/** A server-wide connection as an admin sees it, for the Admin → Providers page. */
export function getSharedConnection(providerId: string): Connection | undefined {
  return readScope(null).get(providerId);
}

export function saveConnection(scope: ConnectionScope, providerId: string, input: ProviderConnectionInput) {
  if (providerId === CHATGPT) {
    // A ChatGPT plan belongs to one person. It is connected through the Codex login, never with a key.
    if (scope === null) throw new HTTPException(400, { message: "A ChatGPT plan cannot be shared with other users." });
    input = { enabled: input.enabled };
  }
  const existing = readScope(scope).get(providerId);
  // Ollama has a real default address, so the row always carries it (and a non-admin's row is
  // unambiguously guarded). Other providers keep an absent or empty URL as before.
  const fallbackURL = providerId === OLLAMA ? (existing?.baseURL ?? OLLAMA_DEFAULT_URL) : undefined;
  // An omitted key keeps the stored one, so the UI never needs to read secrets back.
  const baseURL = input.baseURL === undefined ? (existing?.baseURL ?? fallbackURL) : input.baseURL.trim() || fallbackURL;
  if (providerId === OLLAMA && baseURL) {
    // The native endpoints are appended to this value, so a query or fragment would produce a
    // nonsense URL. Reject it here for both the user and admin routes.
    let parsed: URL;
    try {
      parsed = new URL(baseURL);
    } catch {
      throw new HTTPException(400, { message: "Enter a valid Ollama address." });
    }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new HTTPException(400, { message: "Enter an http or https Ollama address without a query or fragment." });
    }
  }
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
  if (providerId === OLLAMA) forgetOllamaModels();
}

const originOf = (url: string | undefined) => {
  try {
    return url ? new URL(url).origin : undefined;
  } catch {
    return url;
  }
};

export function deleteConnection(scope: ConnectionScope, providerId: string) {
  if (scope === null) {
    db.prepare("DELETE FROM shared_connections WHERE provider_id = ?").run(providerId);
    clearAudience("provider", providerId);
  } else db.prepare("DELETE FROM provider_connections WHERE user_id = ? AND provider_id = ?").run(scope, providerId);
  if (providerId === OLLAMA) forgetOllamaModels();
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
  // A restricted shared connection with no currently entitled model is hidden like one outside the audience.
  const accessOf = (conn: Connection | undefined): SharedModelAccess | null =>
    scope !== null && conn?.shared ? sharedModelAccess(scope, conn.providerId) : null;
  const out: ProviderInfo[] = [];
  for (const provider of supportedProviders(catalog)) {
    // Ollama is listed below from its native API, never from models.dev's generic entry.
    if (provider.id === OLLAMA) continue;
    const conn = connections.get(provider.id);
    const access = accessOf(conn);
    let modelCount = Object.keys(provider.models).length;
    if (access && !access.all) {
      if (!access.ids.size) continue;
      const granted = (await modelsForProvider(provider, conn!)).filter((model) => access.ids.has(model.id));
      if (!granted.length) continue;
      modelCount = granted.length;
    }
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
      modelCount,
      ...(scope === null && conn ? { audience: getAudience("provider", provider.id) } : {}),
    });
  }
  {
    const conn = connections.get(OLLAMA);
    const access = accessOf(conn);
    // Shown even when disconnected, so Ollama is discoverable next to the hosted providers.
    const installed = conn?.enabled ? await ollamaModels(conn, { wait: false }) : [];
    const granted = access && !access.all ? installed.filter((model) => access.ids.has(model.id)) : installed;
    if (!(conn?.shared && access && !access.all && !granted.length)) {
      out.push({
        id: OLLAMA,
        name: OLLAMA_NAME,
        doc: OLLAMA_DOC,
        primary: false,
        custom: false,
        needsBaseURL: true,
        connected: !!conn,
        enabled: conn?.enabled ?? false,
        shared: scope !== null && !!conn?.shared,
        baseURL: conn?.baseURL ?? OLLAMA_DEFAULT_URL,
        modelCount: granted.length,
        ...(scope === null && conn ? { audience: getAudience("provider", OLLAMA) } : {}),
      });
    }
  }
  if (scope !== null) {
    const conn = connections.get(CHATGPT);
    out.push({
      id: CHATGPT,
      name: CHATGPT_NAME,
      primary: true,
      custom: false,
      needsBaseURL: false,
      connected: !!conn,
      enabled: conn?.enabled ?? false,
      shared: false,
      modelCount: conn ? (await chatgptModels(scope)).length : 0,
    });
  }
  for (const conn of connections.values()) {
    if (!isCustom(conn.providerId)) continue;
    const access = accessOf(conn);
    let modelCount = 0;
    if (access && !access.all) {
      if (!access.ids.size) continue;
      modelCount = (await modelsForCustom(conn)).filter((model) => access.ids.has(model.id)).length;
      if (!modelCount) continue;
    }
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
      modelCount,
      ...(scope === null ? { audience: getAudience("provider", conn.providerId) } : {}),
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

// Every chat request resolves its model through listModels, so a provider's converted list is kept until the catalog changes.
const converted = new WeakMap<RawProvider, ModelInfo[]>();
function catalogModels(provider: RawProvider): ModelInfo[] {
  let list = converted.get(provider);
  if (!list) converted.set(provider, (list = Object.values(provider.models).map((m) => toModelInfo(provider, m)).filter((m): m is ModelInfo => m !== null)));
  return list;
}

async function modelsForProvider(provider: RawProvider, conn: Connection): Promise<ModelInfo[]> {
  const known = catalogModels(provider)
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

/** Every model one connection offers, independent of a viewer. Used by the admin policy dialog. */
export async function listModelsForConnection(conn: Connection): Promise<ModelInfo[]> {
  if (isCustom(conn.providerId)) return modelsForCustom(conn);
  if (conn.providerId === CHATGPT) return [];
  if (conn.providerId === OLLAMA) return ollamaModels(conn);
  const catalog = await getCatalog();
  const provider = catalog[conn.providerId];
  return provider ? modelsForProvider(provider, conn) : [];
}

/** The admin's view of a shared connection's catalog. Never reads the admin's own key for the same provider. */
export async function listSharedModels(providerId: string): Promise<ModelInfo[]> {
  const conn = getSharedConnection(providerId);
  return conn ? listModelsForConnection(conn) : [];
}

export async function listModels(userId: string): Promise<ModelInfo[]> {
  // Ollama needs no key and may use its default URL, so it is connected without either field.
  const connections = [...readConnections(userId).values()].filter(
    (c) => c.enabled && (c.providerId === OLLAMA || c.apiKey || c.baseURL),
  );
  const lists = await Promise.all(
    connections.map(async (conn) => {
      const models = conn.providerId === CHATGPT
        ? await chatgptModels(userId)
        : await listModelsForConnection(conn);
      // Own connections override the shared one in readConnections, so only a shared row carries a policy.
      const access = conn.shared ? sharedModelAccess(userId, conn.providerId) : null;
      return access && !access.all ? models.filter((model) => access.ids.has(model.id)) : models;
    }),
  );
  return lists.flat();
}

export async function resolveModel(userId: string, ref: string): Promise<{ model: ModelInfo; conn: Connection }> {
  const slash = ref.indexOf("/");
  const providerId = ref.slice(0, slash);
  const modelId = ref.slice(slash + 1);
  const conn = getConnection(userId, providerId);
  const access = sharedModelAccess(userId, providerId);
  const denied = !access.all && (access.ids.size === 0 || !access.ids.has(modelId));
  if (!conn || !conn.enabled) {
    // Audience revocation must also explain why a saved chat can no longer use its server key.
    if (!conn && getSharedConnection(providerId)?.enabled) throw new HTTPException(403, { message: modelAccessMessage(ref) });
    throw new HTTPException(400, { message: `Provider ${providerId} is not connected` });
  }
  if (conn.shared && denied) throw new HTTPException(403, { message: modelAccessMessage(ref) });
  const models = await listModels(userId);
  const model = models.find((m) => m.ref === ref);
  if (!model) {
    if (conn.shared && !access.all) throw new HTTPException(403, { message: modelAccessMessage(ref) });
    if (providerId === OLLAMA) {
      // listModels keeps the last good list when the daemon is down. For a model that was not found,
      // ask once more so a stopped daemon or a broken address produces an actionable error.
      try {
        await ollamaModels(conn, { strict: true });
      } catch (error) {
        throw new HTTPException(400, { message: (error as Error).message });
      }
      throw new HTTPException(400, {
        message: `Ollama cannot chat with ${ref.slice(OLLAMA.length + 1)}. Choose a model with the completion capability, or pull it in Settings → Providers → Ollama.`,
      });
    }
    throw new HTTPException(400, { message: `Unknown model ${ref}` });
  }
  return { model, conn };
}
