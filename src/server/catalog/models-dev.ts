import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelCost, ModelInfo, WireFormat } from "../../shared/types.js";
import { env, USER_AGENT } from "../env.js";

// models.dev is the catalog opencode uses: per-model wire format, base URL, limits, and prices.
const SOURCE = "https://models.dev/api.json";
const CACHE_FILE = path.join(env.dataDir, "models-dev.json");
const TTL_MS = 6 * 60 * 60 * 1000;

interface RawModel {
  id: string;
  name: string;
  family?: string;
  attachment?: boolean;
  reasoning?: boolean;
  reasoning_options?: Array<{ type: string; values?: string[] }>;
  tool_call?: boolean;
  temperature?: boolean;
  knowledge?: string;
  release_date?: string;
  status?: string;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; input?: number; output?: number };
  provider?: { npm?: string; api?: string };
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
    tiers?: Array<{ input: number; output: number; cache_read?: number; cache_write?: number; tier?: { size?: number } }>;
  };
}

export interface RawProvider {
  id: string;
  name: string;
  npm?: string;
  api?: string;
  env?: string[];
  doc?: string;
  models: Record<string, RawModel>;
}

type Catalog = Record<string, RawProvider>;

// Providers whose own AI SDK package we do not ship but which speak OpenAI chat completions.
const OPENAI_COMPATIBLE_BASES: Record<string, string> = {
  xai: "https://api.x.ai/v1",
  mistral: "https://api.mistral.ai/v1",
  groq: "https://api.groq.com/openai/v1",
  cerebras: "https://api.cerebras.ai/v1",
  togetherai: "https://api.together.xyz/v1",
  perplexity: "https://api.perplexity.ai",
  deepinfra: "https://api.deepinfra.com/v1/openai",
  fireworks: "https://api.fireworks.ai/inference/v1",
};

// The catalog is about 6 MB of JSON. Only the fields above are kept: the rest (descriptions, dates,
// weights flags) roughly doubled the heap the parsed catalog holds for the life of the process.
function compact(catalog: Catalog): Catalog {
  const out: Catalog = {};
  for (const [key, p] of Object.entries(catalog)) {
    const models: Record<string, RawModel> = {};
    for (const [id, m] of Object.entries(p.models ?? {})) {
      models[id] = {
        id: m.id,
        name: m.name,
        family: m.family,
        attachment: m.attachment,
        reasoning: m.reasoning,
        reasoning_options: m.reasoning_options,
        tool_call: m.tool_call,
        temperature: m.temperature,
        knowledge: m.knowledge,
        release_date: m.release_date,
        status: m.status,
        modalities: m.modalities && { input: m.modalities.input, output: m.modalities.output },
        limit: m.limit && { context: m.limit.context, input: m.limit.input, output: m.limit.output },
        provider: m.provider && { npm: m.provider.npm, api: m.provider.api },
        cost: m.cost && {
          input: m.cost.input,
          output: m.cost.output,
          cache_read: m.cost.cache_read,
          cache_write: m.cost.cache_write,
          tiers: m.cost.tiers?.map((t) => ({ input: t.input, output: t.output, cache_read: t.cache_read, cache_write: t.cache_write, tier: t.tier && { size: t.tier.size } })),
        },
      };
    }
    out[key] = { id: p.id, name: p.name, npm: p.npm, api: p.api, env: p.env, doc: p.doc, models };
  }
  return out;
}

let memory: { data: Catalog; fetchedAt: number } | null = null;
let inflight: Promise<Catalog> | null = null;

function refresh(): Promise<Catalog> {
  inflight ??= (async () => {
    try {
      const res = await fetch(SOURCE, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`models.dev ${res.status}`);
      const data = compact((await res.json()) as Catalog);
      memory = { data, fetchedAt: Date.now() };
      await writeFile(CACHE_FILE, JSON.stringify(memory));
      return data;
    } catch (error) {
      // A stale catalog beats no catalog.
      if (memory) return memory.data;
      throw error;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

async function load(): Promise<Catalog> {
  if (!memory) {
    try {
      const cached = JSON.parse(await readFile(CACHE_FILE, "utf8")) as { data: Catalog; fetchedAt: number };
      // Copies written before compaction still hold every field.
      memory = { data: compact(cached.data), fetchedAt: cached.fetchedAt };
    } catch {
      // No disk cache yet.
    }
  }
  if (!memory) return refresh();
  // Requests never wait on models.dev once a copy exists; an expired one is refreshed behind them.
  if (Date.now() - memory.fetchedAt >= TTL_MS) void refresh().catch(() => {});
  return memory.data;
}

export async function getCatalog(): Promise<Catalog> {
  return load();
}

function formatFor(npm: string | undefined): WireFormat | null {
  switch (npm) {
    case "@ai-sdk/openai":
      return "openai-responses";
    case "@ai-sdk/anthropic":
      return "anthropic";
    case "@ai-sdk/google":
      return "google";
    default:
      return null;
  }
}

/** Resolve wire format and base URL, or null when we cannot talk to this provider. */
export function resolveRoute(provider: RawProvider, model?: RawModel): { format: WireFormat; baseURL?: string } | null {
  const npm = model?.provider?.npm ?? provider.npm;
  const api = model?.provider?.api ?? provider.api ?? OPENAI_COMPATIBLE_BASES[provider.id];
  const native = formatFor(npm);
  if (native) return { format: native, baseURL: api };
  if (api) return { format: "openai-chat", baseURL: api };
  return null;
}

export function isSupportedProvider(provider: RawProvider): boolean {
  return resolveRoute(provider) !== null || Object.values(provider.models).some((m) => resolveRoute(provider, m));
}

function toCost(raw: RawModel["cost"]): ModelCost | undefined {
  if (!raw || raw.input === undefined || raw.output === undefined) return undefined;
  return {
    input: raw.input,
    output: raw.output,
    cacheRead: raw.cache_read,
    cacheWrite: raw.cache_write,
    tiers: raw.tiers
      ?.filter((t) => t.tier?.size)
      .map((t) => ({
        above: t.tier!.size!,
        input: t.input,
        output: t.output,
        cacheRead: t.cache_read,
        cacheWrite: t.cache_write,
      })),
  };
}

// models.dev lists embedding, rerank, and speech models with text output, and most image models with
// text+image output, so modalities alone let them into the chat picker. Their ids are the reliable signal.
const NON_CHAT_ID = /embed|rerank|retriever|moderation|whisper|transcri|tts|speech|realtime|image|imagen|dall-e|sora|veo|video/i;

/** False for models that cannot answer a chat request: embeddings, rerankers, speech, image, and video. */
export function isChatModelId(id: string, family?: string): boolean {
  return !NON_CHAT_ID.test(id) && !NON_CHAT_ID.test(family ?? "");
}

export function toModelInfo(provider: RawProvider, model: RawModel): ModelInfo | null {
  const route = resolveRoute(provider, model);
  if (!route) return null;
  const output = model.modalities?.output;
  if (output && (!output.includes("text") || output.some((m) => m !== "text"))) return null;
  if (!isChatModelId(model.id, model.family)) return null;
  const cost = toCost(model.cost);
  return {
    ref: `${provider.id}/${model.id}`,
    providerId: provider.id,
    id: model.id,
    name: model.name,
    family: model.family,
    format: route.format,
    baseURL: route.baseURL,
    context: model.limit?.context ?? 128_000,
    maxOutput: model.limit?.output ?? 16_384,
    reasoning: model.reasoning ?? false,
    reasoningEfforts: model.reasoning_options?.find((o) => o.type === "effort")?.values,
    toolCall: model.tool_call ?? false,
    attachments: model.attachment ?? false,
    inputModalities: model.modalities?.input ?? ["text"],
    temperature: model.temperature ?? true,
    cost,
    free: cost ? cost.input === 0 && cost.output === 0 : false,
    releaseDate: model.release_date,
    knowledge: model.knowledge,
  };
}

/** Fallback for ids a provider lists live but models.dev does not know yet. */
export function unknownModel(providerId: string, id: string, format: WireFormat, baseURL?: string): ModelInfo {
  return {
    ref: `${providerId}/${id}`,
    providerId,
    id,
    name: id,
    format,
    baseURL,
    context: 128_000,
    maxOutput: 16_384,
    reasoning: false,
    toolCall: true,
    attachments: false,
    inputModalities: ["text"],
    temperature: true,
    free: id.endsWith("-free"),
  };
}
