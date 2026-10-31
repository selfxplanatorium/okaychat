import type { KnowledgeEmbeddingOption, KnowledgeEmbeddingProvider, KnowledgeEmbeddingSetting } from "../../shared/knowledge.js";
import { ollamaEmbed } from "../catalog/ollama.js";
import { getConnection, listProviders, type Connection } from "../catalog/providers.js";
import { USER_AGENT } from "../env.js";
import { publicFetch } from "../public-fetch.js";

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

/** Every backend the account can use right now, including the explicit lexical-only choice. */
export async function embeddingOptions(userId: string): Promise<KnowledgeEmbeddingOption[]> {
  const out: KnowledgeEmbeddingOption[] = [{ provider: "none", label: "No embeddings (keyword search only)" }];
  for (const provider of ["openai", "google", "ollama"] as const) {
    const conn = getConnection(userId, provider);
    if (!conn?.enabled) continue;
    out.push({ provider, providerId: provider, model: DEFAULT_MODELS[provider], label: LABELS[provider]! });
  }
  for (const info of await listProviders(userId)) {
    if (!info.custom || !info.connected || !info.enabled) continue;
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

/** Normalizes to unit length. Rejects non-finite and zero vectors instead of storing unusable rows. */
export function normalizeVector(values: readonly number[]): Float32Array {
  if (!values.length) throw new EmbeddingError("The embedding provider returned an empty vector.");
  let sum = 0;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new EmbeddingError("The embedding provider returned a non-finite value.");
    sum += value * value;
  }
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
      const delay = Math.min(max, error.retryAfterMs ?? base * 2 ** attempt);
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
    detail = (await res.text()).slice(0, 300);
    const parsed = JSON.parse(detail) as { error?: { message?: string } | string };
    if (typeof parsed.error === "string") detail = parsed.error;
    else if (parsed.error?.message) detail = parsed.error.message;
  } catch {
    // Keep the raw (bounded) body.
  }
  return new EmbeddingError(`${provider} embeddings failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`, res.status, retryAfter(res.headers.get("retry-after")));
}

interface RequestOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  sleep?: RetryOptions["sleep"];
}

const request = (conn: Connection, opts: RequestOptions) => opts.fetchImpl ?? (conn.guarded ? publicFetch : fetch);

async function openaiEmbed(conn: Connection, model: string, texts: string[], opts: RequestOptions): Promise<number[][]> {
  const base = (conn.baseURL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const res = await withRetry(
    async () => {
      const response = await request(conn, opts)(`${base}/embeddings`, {
        method: "POST",
        signal: opts.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${conn.apiKey ?? ""}`, "User-Agent": USER_AGENT },
        body: JSON.stringify({ model, input: texts }),
      });
      if (!response.ok) throw await errorFrom(response, "OpenAI");
      return response;
    },
    { signal: opts.signal, sleep: opts.sleep },
  );
  const body = (await res.json()) as { data?: Array<{ embedding?: unknown }> };
  if (!Array.isArray(body.data)) throw new EmbeddingError("OpenAI returned no embeddings.");
  return body.data.map((row) => validateRow(row.embedding, "OpenAI"));
}

async function googleEmbed(conn: Connection, model: string, texts: string[], opts: RequestOptions): Promise<number[][]> {
  const base = (conn.baseURL || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
  const res = await withRetry(
    async () => {
      const response = await request(conn, opts)(`${base}/models/${encodeURIComponent(model)}:batchEmbedContents`, {
        method: "POST",
        signal: opts.signal,
        headers: { "Content-Type": "application/json", "x-goog-api-key": conn.apiKey ?? "", "User-Agent": USER_AGENT },
        body: JSON.stringify({ requests: texts.map((text) => ({ model: `models/${model}`, content: { parts: [{ text }] } })) }),
      });
      if (!response.ok) throw await errorFrom(response, "Google");
      return response;
    },
    { signal: opts.signal, sleep: opts.sleep },
  );
  const body = (await res.json()) as { embeddings?: Array<{ values?: unknown }> };
  if (!Array.isArray(body.embeddings)) throw new EmbeddingError("Google returned no embeddings.");
  return body.embeddings.map((row) => validateRow(row.values, "Google"));
}

function validateRow(value: unknown, provider: string): number[] {
  if (!Array.isArray(value)) throw new EmbeddingError(`${provider} returned a malformed embedding.`);
  return value as number[];
}

/** Builds an embedder for a collection, or null for lexical-only mode. */
export function createEmbedder(userId: string, setting: KnowledgeEmbeddingSetting, opts: Omit<RequestOptions, "signal"> = {}): Embedder | null {
  if (setting.provider === "none") return null;
  const providerId = setting.provider === "compatible" ? setting.providerId : setting.provider;
  if (!providerId) throw new EmbeddingError("Choose an embedding provider for this collection.");
  const conn = getConnection(userId, providerId);
  if (!conn?.enabled) throw new EmbeddingError(`The ${providerId} connection is not enabled. Reconnect it in Settings → Providers, or use keyword search only.`);
  const model = setting.model?.trim() || defaultEmbeddingModel(setting.provider);
  if (!model) throw new EmbeddingError("Enter the embedding model name for this collection.");
  const requestOpts: RequestOptions = { ...opts };

  const embed = async (texts: string[], signal?: AbortSignal): Promise<Float32Array[]> => {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      signal?.throwIfAborted();
      const batch = texts.slice(i, i + EMBED_BATCH).map((text) => (text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text));
      const rows =
        setting.provider === "ollama"
          ? await withRetry(
              async () => {
                try {
                  return await ollamaEmbed(conn, model, batch, signal);
                } catch (error) {
                  if (signal?.aborted) throw error;
                  throw new EmbeddingError((error as Error).message, (error as { status?: number }).status);
                }
              },
              { signal, sleep: opts.sleep },
            )
          : setting.provider === "google"
            ? await googleEmbed(conn, model, batch, { ...requestOpts, signal })
            : await openaiEmbed(conn, model, batch, { ...requestOpts, signal });
      if (rows.length !== batch.length) throw new EmbeddingError(`${providerId} returned ${rows.length} embeddings for ${batch.length} passages.`);
      out.push(...rows.map((row) => normalizeVector(row)));
    }
    const dimensions = out[0]?.length ?? 0;
    if (out.some((vector) => vector.length !== dimensions)) throw new EmbeddingError(`${providerId} returned vectors with different dimensions.`);
    return out;
  };
  return { provider: setting.provider, providerId, model, embed };
}
