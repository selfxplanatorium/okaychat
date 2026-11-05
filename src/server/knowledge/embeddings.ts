import type { KnowledgeEmbeddingOption, KnowledgeEmbeddingProvider, KnowledgeEmbeddingSetting } from "../../shared/knowledge.js";
import { ollamaEmbed } from "../catalog/ollama.js";
import { getConnection, listProviders, type Connection } from "../catalog/providers.js";
import { USER_AGENT } from "../env.js";
import { modelAccessMessage, sharedModelAccess } from "../entitlements.js";
import { describeProviderError } from "../provider-errors.js";
import { publicFetch, readCapped } from "../public-fetch.js";
import { assertFeature } from "../permissions/guard.js";
import { reserveOperation } from "../permissions/limits.js";

// Embedding backends for knowledge collections. Every provider is called over plain fetch; Ollama uses
// the existing native helper. A non-admin's custom endpoint keeps the same publicFetch rule as chat.
// Keys are read from the encrypted connection store and never leave the server.

export class EmbeddingError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "EmbeddingError";
  }
}

export interface Embedder {
  provider: KnowledgeEmbeddingProvider;
  providerId: string;
  model: string;
  embed: (texts: string[], signal?: AbortSignal) => Promise<Float32Array[]>;
}

/** Bounded batch size; providers accept more but a single failure then wastes a large request. */
export const EMBED_BATCH = 16;
const MAX_INPUT_CHARS = 8_000;
/** A provider that returns a huge vector is broken; 16k dimensions covers every current embedding model. */
export const MAX_VECTOR_DIMENSIONS = 16_384;
/** Embedding responses are parsed only after a byte check; a broken or hostile endpoint cannot exhaust memory. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 30_000;
/** Retry-After stays honest up to this bound; longer server requests are clamped, not silently shortened to 8 s. */
export const MAX_RETRY_AFTER_MS = 120_000;

const DEFAULT_MODELS: Partial<Record<KnowledgeEmbeddingProvider, string>> = {
  openai: "text-embedding-3-small",
  google: "gemini-embedding-001",
  ollama: "nomic-embed-text",
};

const LABELS: Record<string, string> = {
  openai: "OpenAI",
  google: "Google",
  ollama: "Ollama",
};

/**
 * A shared key serves embeddings only when the user's model policy includes the embedding model. Own keys bypass
 * policies. A custom endpoint has no known model until the user types one, so it needs an unrestricted policy here.
 */
function embeddingAllowed(userId: string, conn: Connection, model: string | undefined): boolean {
  if (!conn.shared) return true;
  const access = sharedModelAccess(userId, conn.providerId);
  return access.visible && (access.all || (!!model && access.ids.has(model)));
}

/** Every backend the account can use right now, including the explicit lexical-only choice. */
export async function embeddingOptions(userId: string): Promise<KnowledgeEmbeddingOption[]> {
  const out: KnowledgeEmbeddingOption[] = [{ provider: "none", label: "No embeddings (keyword search only)" }];
  for (const provider of ["openai", "google", "ollama"] as const) {
    const conn = getConnection(userId, provider);
    if (!conn?.enabled || !embeddingAllowed(userId, conn, DEFAULT_MODELS[provider])) continue;
    out.push({ provider, providerId: provider, model: DEFAULT_MODELS[provider], label: LABELS[provider]! });
  }
  for (const info of await listProviders(userId)) {
    if (!info.custom || !info.connected || !info.enabled) continue;
    if (info.shared && !sharedModelAccess(userId, info.id).all) continue;
    out.push({ provider: "compatible", providerId: info.id, model: "", label: info.name });
  }
  return out;
}

export function defaultEmbeddingModel(provider: KnowledgeEmbeddingProvider): string {
  return DEFAULT_MODELS[provider] ?? "";
}

export function embeddingKey(setting: KnowledgeEmbeddingSetting): string {
  return setting.provider === "none" ? "none" : `${setting.provider}:${setting.providerId ?? ""}:${setting.model ?? ""}`;
}

/** Normalizes to unit length. Rejects non-finite, zero, oversized, or overflowing vectors instead of storing unusable rows. */
export function normalizeVector(values: readonly number[]): Float32Array {
  if (!values.length) throw new EmbeddingError("The embedding provider returned an empty vector.");
  if (values.length > MAX_VECTOR_DIMENSIONS) throw new EmbeddingError(`The embedding provider returned ${values.length} dimensions; the limit is ${MAX_VECTOR_DIMENSIONS}.`);
  let sum = 0;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new EmbeddingError("The embedding provider returned a non-finite value.");
    sum += value * value;
  }
  // MAX_VALUE squared overflows to Infinity; scaling that would write NaNs into the database.
  if (!Number.isFinite(sum)) throw new EmbeddingError("The embedding provider returned a vector too large to normalize.");
  if (!(sum > 0)) throw new EmbeddingError("The embedding provider returned a zero vector.");
  const scale = 1 / Math.sqrt(sum);
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = values[i]! * scale;
  return out;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

/** Deterministic little-endian float32 storage, so a database copy decodes the same on any machine. */
export function encodeVector(vector: Float32Array): Buffer {
  const buffer = Buffer.alloc(vector.length * 4);
  for (let i = 0; i < vector.length; i++) buffer.writeFloatLE(vector[i]!, i * 4);
  return buffer;
}

export function decodeVector(value: Uint8Array | null | undefined): Float32Array | null {
  if (!value || value.byteLength < 4 || value.byteLength % 4 !== 0) return null;
  const buffer = Buffer.from(value);
  const out = new Float32Array(buffer.byteLength / 4);
  for (let i = 0; i < out.length; i++) out[i] = buffer.readFloatLE(i * 4);
  return out;
}

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  signal?: AbortSignal;
  /** Injectable for tests; the real path waits with a timer that a cancel aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onRetry?: (attempt: number, error: EmbeddingError, delay: number) => void;
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** Retries rate limits and transient server errors with exponential backoff, honoring Retry-After. */
export async function withRetry<T>(run: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const base = opts.baseMs ?? 500;
  const max = opts.maxMs ?? 8_000;
  const sleep = opts.sleep ?? wait;
  for (let attempt = 0; ; attempt++) {
    opts.signal?.throwIfAborted();
    try {
      return await run(attempt);
    } catch (error) {
      opts.signal?.throwIfAborted();
      if (!(error instanceof EmbeddingError) || attempt >= attempts - 1 || !retryable(error)) throw error;
      // A provider's Retry-After is a real instruction; clamp only to an absolute safe maximum.
      const delay = error.retryAfterMs !== undefined
        ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, error.retryAfterMs))
        : Math.min(max, base * 2 ** attempt);
      opts.onRetry?.(attempt + 1, error, delay);
      await sleep(delay, opts.signal);
    }
  }
}

const retryable = (error: EmbeddingError) =>
  error.status === 429 || (error.status !== undefined && error.status >= 500) || error.status === undefined;

function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

async function errorFrom(res: Response, provider: string): Promise<EmbeddingError> {
  let detail = "";
  try {
    const bytes = await readCapped(res, 16 * 1024, "response too large");
    detail = new TextDecoder().decode(bytes);
  } catch {
    // Status alone still maps safely when the provider sends an oversized body.
  }
  // Ingestion stores this message and returns it to the UI; an upstream body can echo keys or document text.
  const safe = describeProviderError({ status: res.status, responseBody: detail }, { provider, log: false });
  return new EmbeddingError(`${safe.message} ${safe.hint}`, res.status, retryAfter(res.headers.get("retry-after")));
}

interface RequestOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  sleep?: RetryOptions["sleep"];
  /** Per-request deadline; tests lower it, production uses REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
}

const request = (conn: Connection, opts: RequestOptions) => opts.fetchImpl ?? (conn.guarded ? publicFetch : fetch);

/** Caller cancellation plus a hard request deadline, so a stalled provider cannot hold a job forever. */
function requestSignal(signal: AbortSignal | undefined, timeoutMs = REQUEST_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function responseJson<T>(res: Response, provider: string): Promise<T> {
  let bytes: Uint8Array;
  try {
    bytes = await readCapped(res, MAX_RESPONSE_BYTES, `${provider} embeddings response is larger than ${MAX_RESPONSE_BYTES} bytes.`);
  } catch (error) {
    throw new EmbeddingError(error instanceof EmbeddingError ? error.message : (error as Error).message);
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new EmbeddingError(`${provider} returned an unreadable embeddings response.`);
  }
}

/** Validates OpenAI-compatible rows and applies indexes even when a provider returns them out of order. */
function indexedRows(rows: Array<{ embedding?: unknown; index?: unknown }>, provider: string): number[][] {
  const indexes = rows.map((row) => row.index);
  const anyIndexed = indexes.some((index) => index !== undefined && index !== null);
  if (!anyIndexed) return rows.map((row) => validateRow(row.embedding, provider));
  if (indexes.some((index) => !Number.isInteger(index) || (index as number) < 0 || (index as number) >= rows.length)) {
    throw new EmbeddingError(`${provider} returned an invalid embedding index.`);
  }
  const sorted = [...rows].sort((a, b) => (a.index as number) - (b.index as number));
  const unique = new Set(indexes as number[]);
  if (unique.size !== rows.length) throw new EmbeddingError(`${provider} returned duplicate embedding indexes.`);
  return sorted.map((row) => validateRow(row.embedding, provider));
}

async function openaiEmbed(conn: Connection, model: string, texts: string[], opts: RequestOptions): Promise<number[][]> {
  const base = (conn.baseURL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const res = await withRetry(
    async () => {
      const response = await request(conn, opts)(`${base}/embeddings`, {
        method: "POST",
        signal: requestSignal(opts.signal, opts.timeoutMs),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${conn.apiKey ?? ""}`, "User-Agent": USER_AGENT },
        body: JSON.stringify({ model, input: texts }),
      });
      if (!response.ok) throw await errorFrom(response, "OpenAI");
      return response;
    },
    { signal: opts.signal, sleep: opts.sleep },
  );
  const body = await responseJson<{ data?: Array<{ embedding?: unknown; index?: unknown }> }>(res, "OpenAI");
  if (!Array.isArray(body.data)) throw new EmbeddingError("OpenAI returned no embeddings.");
  return indexedRows(body.data, "OpenAI");
}

async function googleEmbed(conn: Connection, model: string, texts: string[], opts: RequestOptions): Promise<number[][]> {
  const base = (conn.baseURL || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
  const res = await withRetry(
    async () => {
      const response = await request(conn, opts)(`${base}/models/${encodeURIComponent(model)}:batchEmbedContents`, {
        method: "POST",
        signal: requestSignal(opts.signal, opts.timeoutMs),
        headers: { "Content-Type": "application/json", "x-goog-api-key": conn.apiKey ?? "", "User-Agent": USER_AGENT },
        body: JSON.stringify({ requests: texts.map((text) => ({ model: `models/${model}`, content: { parts: [{ text }] } })) }),
      });
      if (!response.ok) throw await errorFrom(response, "Google");
      return response;
    },
    { signal: opts.signal, sleep: opts.sleep },
  );
  const body = await responseJson<{ embeddings?: Array<{ values?: unknown }> }>(res, "Google");
  if (!Array.isArray(body.embeddings)) throw new EmbeddingError("Google returned no embeddings.");
  return body.embeddings.map((row) => validateRow(row.values, "Google"));
}

function validateRow(value: unknown, provider: string): number[] {
  if (!Array.isArray(value)) throw new EmbeddingError(`${provider} returned a malformed embedding.`);
  return value as number[];
}

/**
 * Builds an embedder for a collection, or null for lexical-only mode. `pinned` is the exact connection row a
 * collection was pinned to; passing it avoids picking a different key of the same provider mid-collection.
 */
export function createEmbedder(
  userId: string,
  setting: KnowledgeEmbeddingSetting,
  opts: Omit<RequestOptions, "signal"> = {},
  pinned?: { connection: Connection; providerId: string },
): Embedder | null {
  if (setting.provider === "none") return null;
  const providerId = setting.provider === "compatible" ? setting.providerId : setting.provider;
  if (!providerId) throw new EmbeddingError("Choose an embedding provider for this collection.");
  const conn = pinned?.connection ?? getConnection(userId, providerId);
  if (!conn?.enabled) throw new EmbeddingError(`The ${providerId} connection is not enabled. Reconnect it in Settings → Providers, or use keyword search only.`);
  const model = setting.model?.trim() || defaultEmbeddingModel(setting.provider);
  if (!model) throw new EmbeddingError("Enter the embedding model name for this collection.");
  if (!embeddingAllowed(userId, conn, model)) throw new EmbeddingError(modelAccessMessage(`${providerId}/${model}`));
  const requestOpts: RequestOptions = { ...opts };

  const embed = async (texts: string[], signal?: AbortSignal): Promise<Float32Array[]> => {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      signal?.throwIfAborted();
      // Knowledge may be revoked while a job is running: each batch re-checks and charges one operation.
      assertFeature(userId, "knowledge");
      const lease = reserveOperation({ userId }, "knowledge.embed");
      const batch = texts.slice(i, i + EMBED_BATCH).map((text) => (text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text));
      let rows: number[][];
      try {
        rows =
          setting.provider === "ollama"
            ? await withRetry(
                async () => {
                  try {
                    return await ollamaEmbed(conn, model, batch, requestSignal(signal, opts.timeoutMs));
                  } catch (error) {
                    if (signal?.aborted) throw error;
                    const safe = describeProviderError(error, { provider: "ollama", log: false });
                    throw new EmbeddingError(`${safe.message} ${safe.hint}`, (error as { status?: number }).status);
                  }
                },
                { signal, sleep: opts.sleep },
              )
            : setting.provider === "google"
              ? await googleEmbed(conn, model, batch, { ...requestOpts, signal })
              : await openaiEmbed(conn, model, batch, { ...requestOpts, signal });
      } finally {
        lease.release();
      }
      if (rows.length !== batch.length) throw new EmbeddingError(`${providerId} returned ${rows.length} embeddings for ${batch.length} passages.`);
      out.push(...rows.map((row) => normalizeVector(row)));
    }
    const dimensions = out[0]?.length ?? 0;
    if (out.some((vector) => vector.length !== dimensions)) throw new EmbeddingError(`${providerId} returned vectors with different dimensions.`);
    return out;
  };
  return { provider: setting.provider, providerId, model, embed };
}
