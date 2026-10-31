import type {
  ModelInfo,
  OllamaInstalledModel,
  OllamaInventory,
  OllamaPullProgress,
  OllamaStatus,
} from "../../shared/types.js";
import { USER_AGENT } from "../env.js";
import { BlockedAddressError, publicFetch } from "../public-fetch.js";
import { isChatModelId } from "./models-dev.js";

// Ollama's native HTTP API. The daemon normally listens on loopback; admins may connect it through a
// private address, everyone else goes through publicFetch like every other user-supplied URL.
// See docs/implementation/ollama.md.

export const OLLAMA = "ollama";
export const OLLAMA_NAME = "Ollama";
export const OLLAMA_DEFAULT_URL = "http://127.0.0.1:11434";
export const OLLAMA_DOC = "https://docs.ollama.com/api";

/** The fields of a provider connection that matter here. Kept structural so this module stays light. */
export interface OllamaConnection {
  baseURL?: string;
  /** True for a non-admin's own URL: every request must reach a public address. */
  guarded?: boolean;
  /**
   * A transport for this connection. `createModel` passes the retrying provider fetch for `/api/chat`
   * only; management routes keep the plain transport, so a pull or delete never retries a mutation.
   */
  fetch?: typeof fetch;
}

export class OllamaError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OllamaError";
  }
}

export const ollamaBaseURL = (conn: OllamaConnection) => (conn.baseURL || OLLAMA_DEFAULT_URL).trim().replace(/\/+$/, "");
const endpoint = (conn: OllamaConnection, path: string) => `${ollamaBaseURL(conn)}${path}`;
const keyOf = (conn: OllamaConnection) => `${ollamaBaseURL(conn)}|${conn.guarded ? "guarded" : "direct"}`;

const isAbort = (error: unknown): error is Error => error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");

/** Reads at most this much of an error body. A broken daemon must not stream unbounded text into memory. */
const MAX_ERROR_BODY = 16 * 1024;
/** One NDJSON progress line; layer progress is tiny, so this only catches garbage. */
const MAX_PULL_LINE = 1024 * 1024;

async function errorText(res: Response): Promise<string> {
  let text = "";
  if (res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let read = 0;
    try {
      while (read < MAX_ERROR_BODY) {
        const { done, value } = await reader.read();
        if (done) break;
        const room = MAX_ERROR_BODY - read;
        const slice = value.byteLength > room ? value.subarray(0, room) : value;
        text += decoder.decode(slice, { stream: true });
        read += slice.byteLength;
        if (slice.byteLength < value.byteLength) break;
      }
      text += decoder.decode();
    } catch {
      // Keep whatever arrived; the HTTP status still explains the failure.
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  const trimmed = text.trim();
  if (!trimmed) return "";
  try {
    const body = JSON.parse(trimmed) as { error?: unknown; message?: unknown };
    const message = typeof body.error === "string" ? body.error : typeof body.message === "string" ? body.message : trimmed;
    return message.trim().slice(0, 500);
  } catch {
    return trimmed.slice(0, 500);
  }
}

/**
 * Turns an HTTP failure into text a person can act on: a missing model explains how to pull it,
 * a failing daemon says where it looked, and anything else keeps Ollama's own message.
 */
export async function ollamaHttpError(res: Response, action: string, model?: string): Promise<OllamaError> {
  const detail = await errorText(res);
  const missing = res.status === 404 && /not found|no such model|does not exist/i.test(detail);
  if (missing && model) {
    return new OllamaError(`Ollama model ${model} is not installed. Pull it in Settings → Providers → Ollama.`, 404);
  }
  const suffix = detail ? `: ${detail}` : "";
  return new OllamaError(`Ollama could not ${action} (HTTP ${res.status})${suffix}`, res.status);
}

/**
 * One native request. Non-admin connections use publicFetch, including redirects, so a custom URL can
 * never read the server's network. A caller's abort signal is passed through unchanged; timeouts are
 * added only for the short management calls.
 */
export async function ollamaRequest(
  conn: OllamaConnection,
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs, signal, ...rest } = init;
  const timeout = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
  let timedOut = false;
  timeout?.addEventListener("abort", () => (timedOut = true), { once: true });
  const merged = signal && timeout ? AbortSignal.any([signal, timeout]) : (signal ?? timeout);
  const send = conn.fetch ?? (conn.guarded ? publicFetch : fetch);
  const headers = new Headers(rest.headers);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  headers.set("User-Agent", USER_AGENT);
  try {
    return await send(endpoint(conn, path), { ...rest, signal: merged, headers });
  } catch (error) {
    if (signal?.aborted || error instanceof BlockedAddressError) throw error;
    if (timedOut) throw new OllamaError(`Ollama did not answer at ${ollamaBaseURL(conn)} in time.`);
    if (isAbort(error)) throw error;
    throw new OllamaError(`Could not reach Ollama at ${ollamaBaseURL(conn)}. Is the daemon running and is the URL correct?`);
  }
}

async function responseJSON<T>(res: Response, action: string): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new OllamaError(`Ollama returned an unreadable response while trying to ${action}.`);
  }
}

async function json<T>(conn: OllamaConnection, path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const res = await ollamaRequest(conn, path, init);
  if (!res.ok) throw await ollamaHttpError(res, `read ${path}`);
  return responseJSON<T>(res, `read ${path}`);
}

const finite = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
/** Context windows are token counts: a zero, negative, or fractional value is not usable metadata. */
const positive = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;

interface RawTag {
  name: string;
  size?: number;
  digest?: string;
  modified_at?: string;
  details?: {
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
  };
}

interface RawShow {
  details?: RawTag["details"];
  capabilities?: string[];
  model_info?: Record<string, unknown>;
  /** Native thinking controls: booleans for on/off models, named levels for gpt-oss. */
  thinking?: { values?: unknown; default?: unknown };
}

interface RawPsModel {
  name?: string;
  model?: string;
  size?: number;
  size_vram?: number;
  expires_at?: string;
}

export async function ollamaVersion(conn: OllamaConnection, signal?: AbortSignal): Promise<string> {
  const body = await json<{ version?: string }>(conn, "/api/version", { signal, timeoutMs: 10_000 });
  if (!body.version) throw new OllamaError("Ollama did not report its version.");
  return body.version;
}

export async function ollamaTags(conn: OllamaConnection, signal?: AbortSignal): Promise<RawTag[]> {
  const body = await json<{ models?: RawTag[] }>(conn, "/api/tags", { signal, timeoutMs: 10_000 });
  return Array.isArray(body.models) ? body.models : [];
}

export async function ollamaShow(conn: OllamaConnection, model: string, signal?: AbortSignal): Promise<RawShow> {
  const res = await ollamaRequest(conn, "/api/show", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
    signal,
    timeoutMs: 15_000,
  });
  if (!res.ok) throw await ollamaHttpError(res, `read metadata for ${model}`, model);
  return responseJSON<RawShow>(res, `read metadata for ${model}`);
}

export async function ollamaPs(conn: OllamaConnection, signal?: AbortSignal): Promise<RawPsModel[]> {
  const body = await json<{ models?: RawPsModel[] }>(conn, "/api/ps", { signal, timeoutMs: 10_000 });
  return Array.isArray(body.models) ? body.models : [];
}

export async function ollamaStatus(conn: OllamaConnection, signal?: AbortSignal): Promise<OllamaStatus> {
  const [version, models, loaded] = await Promise.all([ollamaVersion(conn, signal), ollamaTags(conn, signal), ollamaPs(conn, signal)]);
  return {
    url: ollamaBaseURL(conn),
    version,
    modelCount: models.length,
    loadedCount: loaded.length,
  };
}

/** `/api/pull`, streamed as NDJSON. The generator closes the response body when the caller stops. */
export async function* ollamaPull(
  conn: OllamaConnection,
  model: string,
  signal?: AbortSignal,
): AsyncGenerator<OllamaPullProgress> {
  const res = await ollamaRequest(conn, "/api/pull", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: true }),
    signal,
  });
  if (!res.ok) throw await ollamaHttpError(res, `pull ${model}`, model);
  if (!res.body) throw new OllamaError(`Ollama returned no progress for ${model}.`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        if (signal?.aborted) return;
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.length > MAX_PULL_LINE) throw new OllamaError(`Ollama sent an overlong progress line while pulling ${model}.`);
        if (line.trim()) yield parsePullLine(line, model, conn);
        newline = buffer.indexOf("\n");
      }
      if (buffer.length > MAX_PULL_LINE) throw new OllamaError(`Ollama sent an overlong progress line while pulling ${model}.`);
    }
    buffer += decoder.decode();
    if (buffer.trim() && !signal?.aborted) {
      if (buffer.length > MAX_PULL_LINE) throw new OllamaError(`Ollama sent an overlong progress line while pulling ${model}.`);
      yield parsePullLine(buffer.trim(), model, conn);
    }
  } catch (error) {
    if (signal?.aborted) return;
    throw error;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function parsePullLine(line: string, model: string, conn: OllamaConnection): OllamaPullProgress {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new OllamaError(`Ollama sent an unreadable progress line while pulling ${model}.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OllamaError(`Ollama sent an unexpected progress line while pulling ${model}.`);
  }
  const body = parsed as { error?: unknown; status?: unknown; digest?: unknown; total?: unknown; completed?: unknown };
  if (typeof body.error === "string" && body.error) throw new OllamaError(`Ollama could not pull ${model}: ${body.error}`);
  if (typeof body.status !== "string" || !body.status) throw new OllamaError(`Ollama sent no status while pulling ${model}.`);
  const progress: OllamaPullProgress = { status: body.status };
  const total = finite(body.total);
  const completed = finite(body.completed);
  if (typeof body.digest === "string") progress.digest = body.digest;
  if (total !== undefined) progress.total = total;
  if (completed !== undefined) progress.completed = completed;
  if (body.status === "success") {
    invalidateOllama(conn);
  }
  return progress;
}

/** Opens one native `/api/chat` request. The response body is streamed by the language-model adapter. */
export async function ollamaChat(conn: OllamaConnection, body: { model: string }, signal?: AbortSignal): Promise<Response> {
  const res = await ollamaRequest(conn, "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await ollamaHttpError(res, `chat with ${body.model}`, body.model);
  return res;
}

export async function ollamaDelete(conn: OllamaConnection, model: string, signal?: AbortSignal): Promise<void> {
  const res = await ollamaRequest(conn, "/api/delete", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
    signal,
    timeoutMs: 30_000,
  });
  if (!res.ok) throw await ollamaHttpError(res, `delete ${model}`, model);
  if (res.body) await res.body.cancel().catch(() => {});
  invalidateOllama(conn);
}

/** Data layer for embeddings. The settings UI deliberately has no embeddings surface yet. */
export async function ollamaEmbed(
  conn: OllamaConnection,
  model: string,
  input: string | string[],
  signal?: AbortSignal,
): Promise<number[][]> {
  const res = await ollamaRequest(conn, "/api/embed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input }),
    signal,
    timeoutMs: 120_000,
  });
  if (!res.ok) throw await ollamaHttpError(res, `embed with ${model}`, model);
  const body = await responseJSON<{ embeddings?: unknown }>(res, `embed with ${model}`);
  if (!Array.isArray(body.embeddings) || !body.embeddings.every((row) => Array.isArray(row) && row.every((n) => typeof n === "number" && Number.isFinite(n)))) {
    throw new OllamaError(`Ollama returned no usable embeddings for ${model}.`);
  }
  return body.embeddings as number[][];
}

// Installed models change only after a pull or delete. Shows are cached for ten minutes, the tag list
// for one minute, and an expired tag list is refreshed behind a request so a chat never waits on it.
const TAGS_TTL_MS = 60_000;
const SHOW_TTL_MS = 10 * 60_000;
const LIMIT = 256;
const tagCache = new Map<string, { models: ModelInfo[]; at: number }>();
const tagInflight = new Map<string, Promise<ModelInfo[]>>();
const showCache = new Map<string, { show: RawShow; at: number }>();

function remember<T>(cache: Map<string, T>, key: string, value: T) {
  cache.set(key, value);
  if (cache.size > LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

interface ThinkingControls {
  reasoning: boolean;
  /** UI effort choices that map to a valid native `think` value, or undefined when the UI should fall back. */
  efforts?: string[];
  /** Named native levels (gpt-oss). Boolean-only models leave this empty and take true/false. */
  levels: string[];
  /** The daemon accepts `think: false`. */
  off: boolean;
}

function thinkingControls(show: RawShow, caps: string[]): ThinkingControls {
  const raw = show.thinking?.values;
  // Older daemons only expose the capability; treat that as the documented on/off controls.
  const values: Array<boolean | string> = Array.isArray(raw)
    ? raw.filter((value): value is boolean | string => typeof value === "boolean" || (typeof value === "string" && value.length > 0))
    : caps.includes("thinking")
      ? [true, false]
      : [];
  const levels = values.filter((value): value is string => typeof value === "string");
  const off = values.includes(false);
  const reasoning = values.some((value) => value === true || typeof value === "string");
  if (!reasoning) return { reasoning: false, levels, off };
  // Every enabled effort is honest: named levels are passed through; a boolean model only has on/off,
  // so it offers Instant and one "on" choice instead of pretending low/medium/high differ.
  const efforts = levels.length ? [...(off ? ["none"] : []), ...levels] : [...(off ? ["none"] : []), "high"];
  return { reasoning: true, efforts, levels, off };
}

function candidate(conn: OllamaConnection, tag: RawTag, show: RawShow): ModelInfo | null {
  const caps = Array.isArray(show.capabilities) ? show.capabilities : [];
  const architecture = typeof show.model_info?.["general.architecture"] === "string" ? show.model_info["general.architecture"] : undefined;
  // Older daemons omit capabilities. Fall back to the name and architecture rather than offering an
  // embedding model for chat; modern daemons say `completion` explicitly.
  const legacyEmbedding = /bert|embed/i.test(`${architecture ?? ""} ${tag.details?.family ?? ""}`);
  if (caps.length ? !caps.includes("completion") : (!isChatModelId(tag.name, tag.details?.family) || legacyEmbedding)) return null;
  const context =
    positive(show.model_info?.[`${architecture}.context_length`]) ??
    positive(show.model_info?.["general.context_length"]) ??
    4096;
  const vision = caps.includes("vision");
  const thinking = thinkingControls(show, caps);
  const details = show.details ?? tag.details;
  return {
    ref: `${OLLAMA}/${tag.name}`,
    providerId: OLLAMA,
    id: tag.name,
    name: tag.name,
    family: details?.family ?? tag.details?.family,
    format: "ollama",
    baseURL: ollamaBaseURL(conn),
    context,
    maxOutput: Math.min(8192, context),
    reasoning: thinking.reasoning,
    ...(thinking.efforts?.length ? { reasoningEfforts: thinking.efforts } : {}),
    ...(thinking.levels.length ? { thinkingLevels: thinking.levels } : {}),
    toolCall: caps.includes("tools"),
    attachments: vision,
    inputModalities: vision ? ["text", "image"] : ["text"],
    temperature: true,
    free: true,
  };
}

function installed(tag: RawTag, show: RawShow | undefined, loaded: Map<string, RawPsModel>): OllamaInstalledModel {
  const architecture = typeof show?.model_info?.["general.architecture"] === "string" ? show.model_info["general.architecture"] : undefined;
  const context =
    positive(show?.model_info?.[`${architecture}.context_length`]) ??
    positive(show?.model_info?.["general.context_length"]) ??
    4096;
  const embeddingLength =
    finite(show?.model_info?.[`${architecture}.embedding_length`]) ??
    finite(show?.model_info?.["general.embedding_length"]);
  const details = show?.details ?? tag.details;
  const running = loaded.get(tag.name);
  return {
    name: tag.name,
    size: typeof tag.size === "number" ? tag.size : 0,
    ...(tag.digest ? { digest: tag.digest } : {}),
    ...(tag.modified_at ? { modifiedAt: tag.modified_at } : {}),
    ...(details?.family ? { family: details.family } : {}),
    ...(details?.families?.length ? { families: details.families } : {}),
    ...(details?.parameter_size ? { parameterSize: details.parameter_size } : {}),
    ...(details?.quantization_level ? { quantization: details.quantization_level } : {}),
    context,
    ...(embeddingLength !== undefined ? { embeddingLength } : {}),
    capabilities: Array.isArray(show?.capabilities) ? show.capabilities : [],
    loaded: running !== undefined,
    ...(running?.size_vram !== undefined ? { sizeVram: running.size_vram } : {}),
    ...(running?.expires_at ? { expiresAt: running.expires_at } : {}),
  };
}

async function showModel(conn: OllamaConnection, model: string, signal?: AbortSignal): Promise<RawShow> {
  const key = `${keyOf(conn)}|${model}`;
  const hit = showCache.get(key);
  if (hit && Date.now() - hit.at < SHOW_TTL_MS) return hit.show;
  const show = await ollamaShow(conn, model, signal);
  remember(showCache, key, { show, at: Date.now() });
  return show;
}

async function fetchModels(conn: OllamaConnection, signal?: AbortSignal): Promise<ModelInfo[]> {
  const tags = await ollamaTags(conn, signal);
  const out: ModelInfo[] = [];
  // A daemon with many models would otherwise make the first model list serial and slow.
  for (let i = 0; i < tags.length; i += 4) {
    const batch = tags.slice(i, i + 4);
    const rows = await Promise.all(
      batch.map(async (tag) => {
        try {
          return candidate(conn, tag, await showModel(conn, tag.name, signal));
        } catch (error) {
          if (signal?.aborted) throw error;
          // A model whose metadata cannot be read is left out of the chat picker, but the management
          // inventory still lists it with the error so the UI never silently loses an installed model.
          return null;
        }
      }),
    );
    out.push(...rows.filter((row): row is ModelInfo => row !== null));
  }
  remember(tagCache, keyOf(conn), { models: out, at: Date.now() });
  return out;
}

function refreshModels(conn: OllamaConnection): Promise<ModelInfo[]> {
  const key = keyOf(conn);
  const pending = tagInflight.get(key) ?? (async () => {
    try {
      return await fetchModels(conn);
    } finally {
      tagInflight.delete(key);
    }
  })();
  tagInflight.set(key, pending);
  return pending;
}

/** Installed chat models. Never waits on a stale list; a failed refresh keeps the last good list. */
export async function ollamaModels(
  conn: OllamaConnection,
  opts: { wait?: boolean; strict?: boolean } = {},
): Promise<ModelInfo[]> {
  const key = keyOf(conn);
  const hit = tagCache.get(key);
  if (hit && Date.now() - hit.at < TAGS_TTL_MS) return hit.models;
  if (hit) {
    refreshModels(conn).catch(() => {});
    return hit.models;
  }
  if (opts.wait === false) {
    refreshModels(conn).catch(() => {});
    return [];
  }
  try {
    return await refreshModels(conn);
  } catch (error) {
    if (opts.strict) throw error;
    return [];
  }
}

/** Fresh metadata for the management panel, including embedding models and loaded state. */
export async function ollamaInventory(conn: OllamaConnection, signal?: AbortSignal): Promise<OllamaInventory> {
  const [version, tags, ps] = await Promise.all([ollamaVersion(conn, signal), ollamaTags(conn, signal), ollamaPs(conn, signal)]);
  const loaded = new Map<string, RawPsModel>();
  for (const model of ps) {
    if (model.name) loaded.set(model.name, model);
    if (model.model) loaded.set(model.model, model);
  }
  const models: OllamaInstalledModel[] = [];
  const chatModels: ModelInfo[] = [];
  for (let i = 0; i < tags.length; i += 4) {
    const batch = tags.slice(i, i + 4);
    const rows = await Promise.all(
      batch.map(async (tag) => {
        try {
          const show = await showModel(conn, tag.name, signal);
          return { installed: installed(tag, show, loaded), chat: candidate(conn, tag, show) };
        } catch (error) {
          if (signal?.aborted) throw error;
          return { installed: { ...installed(tag, undefined, loaded), showError: (error as Error).message }, chat: null };
        }
      }),
    );
    for (const row of rows) {
      models.push(row.installed);
      if (row.chat) chatModels.push(row.chat);
    }
  }
  // The provider row and the picker can reuse what the panel just fetched.
  remember(tagCache, keyOf(conn), { models: chatModels, at: Date.now() });
  return {
    status: { url: ollamaBaseURL(conn), version, modelCount: tags.length, loadedCount: ps.length },
    models,
  };
}

/** Drops cached metadata for one daemon after a pull, delete, or connection change. */
export function invalidateOllama(conn: OllamaConnection) {
  const prefix = `${keyOf(conn)}|`;
  tagCache.delete(keyOf(conn));
  for (const key of showCache.keys()) if (key.startsWith(prefix)) showCache.delete(key);
}

/** Drops every daemon's cache when the stored connections change. */
export function forgetOllamaModels() {
  tagCache.clear();
  showCache.clear();
}

export type { RawPsModel, RawShow, RawTag };
