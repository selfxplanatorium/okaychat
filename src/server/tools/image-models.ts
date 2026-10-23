import type { ImageModelList, ImageModelOption, ImageServiceDef } from "../../shared/image-services.js";
import type { Connection } from "../catalog/providers.js";
import { sha256 } from "../crypto.js";
import { USER_AGENT } from "../env.js";
import { publicFetch } from "../public-fetch.js";

// Image model lists come from each provider, so the picker shows what the user's key can call today.
// Black Forest Labs has no list endpoint and uses the built-in list. See docs/research/image-generation.md.

const TTL_MS = 60 * 60_000;
const cache = new Map<string, { list: ImageModelList; at: number }>();

const trimmed = (url: string | undefined, fallback: string) => (url ?? fallback).replace(/\/$/, "");

async function getJson(url: string, headers: Record<string, string>, conn?: Connection): Promise<unknown> {
  const res = await (conn?.guarded ? publicFetch : fetch)(url, { headers: { "User-Agent": USER_AGENT, ...headers }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.json();
}

type Row = Record<string, unknown>;
const rows = (value: unknown, key: string): Row[] => {
  const list = (value as Record<string, unknown> | null)?.[key];
  return Array.isArray(list) ? (list as Row[]) : [];
};
const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);

async function fetchModels(def: ImageServiceDef, conn: Connection | undefined): Promise<ImageModelOption[] | null> {
  const key = conn?.apiKey ?? "";
  const bearer = { Authorization: `Bearer ${key}` };
  switch (def.id) {
    case "openai": {
      const body = await getJson(`${trimmed(conn?.baseURL, "https://api.openai.com/v1")}/models`, bearer, conn);
      return rows(body, "data").flatMap((m) => {
        const id = str(m.id);
        return id && /^(gpt-image|chatgpt-image|dall-e)/.test(id) ? [{ id }] : [];
      });
    }
    case "google": {
      const out: ImageModelOption[] = [];
      let page: string | undefined;
      // The list is paged. Three pages of 1000 cover it with room to spare.
      for (let i = 0; i < 3; i++) {
        const url = `${trimmed(conn?.baseURL, "https://generativelanguage.googleapis.com/v1beta")}/models?pageSize=1000${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`;
        const body = await getJson(url, { "x-goog-api-key": key }, conn);
        for (const m of rows(body, "models")) {
          const id = str(m.name)?.replace(/^models\//, "");
          // Gemini image models generate content; Imagen models predict.
          if (id && /image|imagen|nano-banana/.test(id)) out.push({ id, name: str(m.displayName) });
        }
        page = str((body as Row).nextPageToken);
        if (!page) break;
      }
      return out;
    }
    case "xai": {
      const body = await getJson(`${trimmed(conn?.baseURL, "https://api.x.ai/v1")}/image-generation-models`, bearer, conn);
      return rows(body, "models").flatMap((m) => (str(m.id) ? [{ id: str(m.id)! }] : []));
    }
    case "togetherai": {
      const body = await getJson(`${trimmed(conn?.baseURL, "https://api.together.xyz/v1")}/models`, bearer, conn);
      const list = Array.isArray(body) ? (body as Row[]) : rows(body, "data");
      return list.flatMap((m) => (m.type === "image" && str(m.id) ? [{ id: str(m.id)!, name: str(m.display_name) }] : []));
    }
    case "fal": {
      // Ranked by popularity. The first page holds the models people actually use.
      const body = await getJson("https://api.fal.ai/v1/models?category=text-to-image&status=active&limit=100", { Authorization: `Key ${key}` });
      return rows(body, "models").flatMap((m) => {
        const id = str(m.endpoint_id);
        return id ? [{ id, name: str((m.metadata as Row | undefined)?.display_name) }] : [];
      });
    }
    case "replicate": {
      const body = await getJson("https://api.replicate.com/v1/collections/text-to-image", bearer);
      return rows(body, "models").flatMap((m) => {
        const id = str(m.owner) && str(m.name) ? `${m.owner}/${m.name}` : undefined;
        return id ? [{ id, name: undefined }] : [];
      });
    }
    case "black-forest-labs":
    case "codex":
      return null;
  }
}

/** Live list for the connected key, cached for an hour. Falls back to the built-in list when the provider fails. */
export async function listImageModels(def: ImageServiceDef, conn: Connection | undefined): Promise<ImageModelList> {
  const fallback = (error?: string): ImageModelList => ({ models: def.models.map((id) => ({ id })), live: false, ...(error ? { error } : {}) });
  const cacheKey = `${def.id}:${sha256(`${conn?.apiKey ?? ""}\n${conn?.baseURL ?? ""}`)}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.list;
  try {
    const models = await fetchModels(def, conn);
    if (!models) return fallback();
    const unique = [...new Map(models.map((m) => [m.id, m])).values()];
    if (!unique.length) return fallback(`${def.name} listed no image models for this key.`);
    const list = { models: unique, live: true };
    cache.set(cacheKey, { list, at: Date.now() });
    return list;
  } catch (error) {
    // Never echo a response body: some providers repeat the key in error messages.
    return fallback(`Could not load models from ${def.name}: ${(error as Error).name === "TimeoutError" ? "timed out" : (error as Error).message.slice(0, 120)}`);
  }
}
