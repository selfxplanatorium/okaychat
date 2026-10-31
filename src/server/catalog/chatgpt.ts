import type { ModelInfo, ReasoningEffort } from "../../shared/types.js";
import { codexAccess, codexVersion, isConnected, onLoginChange } from "../codex.js";

// Chat through the user's own ChatGPT plan: the Codex CLI login, sent straight to the backend the CLI uses.
// That backend speaks the Responses API with a few constraints the fetch below enforces.
// See docs/implementation/codex-chat.md.

export const CHATGPT = "chatgpt";
export const CHATGPT_NAME = "ChatGPT plan (Codex)";
export const CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/codex";
// Sent as client_version when the CLI is not installed. The backend hides models newer clients need.
const FALLBACK_CLIENT_VERSION = "0.163.0";
const MAX_OUTPUT = 128_000;
const EFFORTS: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export const chatgptConnected = isConnected;

interface RawCodexModel {
  slug: string;
  display_name?: string;
  visibility?: string;
  supported_in_api?: boolean;
  context_window?: number;
  input_modalities?: string[];
  supported_reasoning_levels?: Array<{ effort: string }>;
}

const MODELS_TTL_MS = 15 * 60_000;
const modelCache = new Map<string, { models: ModelInfo[]; at: number }>();

async function clientVersion(): Promise<string> {
  return (await codexVersion())?.match(/\d+\.\d+\.\d+/)?.[0] ?? FALLBACK_CLIENT_VERSION;
}

function toModelInfo(raw: RawCodexModel): ModelInfo {
  const modalities = raw.input_modalities ?? ["text"];
  const efforts = (raw.supported_reasoning_levels ?? []).map((l) => l.effort).filter((e): e is ReasoningEffort => EFFORTS.includes(e as ReasoningEffort));
  return {
    ref: `${CHATGPT}/${raw.slug}`,
    providerId: CHATGPT,
    id: raw.slug,
    name: raw.display_name ?? raw.slug,
    format: "openai-responses",
    baseURL: CHATGPT_BASE_URL,
    context: raw.context_window ?? 272_000,
    maxOutput: MAX_OUTPUT,
    reasoning: true,
    ...(efforts.length ? { reasoningEfforts: efforts } : {}),
    toolCall: true,
    attachments: modalities.includes("image"),
    inputModalities: modalities,
    temperature: false,
    free: false,
  };
}

/** The models the user's plan offers. A failed fetch keeps the last list rather than emptying the picker. */
export async function chatgptModels(userId: string): Promise<ModelInfo[]> {
  const hit = modelCache.get(userId);
  if (hit && Date.now() - hit.at < MODELS_TTL_MS) return hit.models;
  try {
    const res = await chatgptFetch(userId)(`${CHATGPT_BASE_URL}/models?client_version=${await clientVersion()}`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return hit?.models ?? [];
    const body = (await res.json()) as { models?: RawCodexModel[] };
    const models = (body.models ?? []).filter((m) => m.visibility === "list" && m.supported_in_api !== false).map(toModelInfo);
    modelCache.set(userId, { models, at: Date.now() });
    return models;
  } catch {
    return hit?.models ?? [];
  }
}

export const forgetChatgptModels = (userId: string) => modelCache.delete(userId);
// Another ChatGPT account can have a different plan, so its models are fetched again.
onLoginChange(forgetChatgptModels);

/**
 * Adds the login's bearer token and account header, retries once with a refreshed token on 401, and adapts
 * AI SDK Responses bodies: the backend requires `stream: true` and `store: false` and rejects some fields.
 * Non-streaming calls (titles, compaction) get the final response rebuilt from the event stream.
 */
export function chatgptFetch(userId: string): typeof fetch {
  return async (input, init) => {
    let body = init?.body;
    let streamed = true;
    if (typeof body === "string") {
      const json = JSON.parse(body) as Record<string, unknown>;
      streamed = json.stream === true;
      body = JSON.stringify(adaptBody(json));
    }
    const send = async (force: boolean) => {
      const { token, accountId } = await codexAccess(userId, force);
      const headers = new Headers(init?.headers);
      headers.delete("x-api-key");
      headers.set("Authorization", `Bearer ${token}`);
      headers.set("chatgpt-account-id", accountId);
      headers.set("originator", "codex_cli_rs");
      if (body !== undefined) headers.set("Accept", "text/event-stream");
      return fetch(input, { ...init, headers, body });
    };
    let res = await send(false);
    if (res.status === 401) {
      await res.body?.cancel();
      res = await send(true);
    }
    if (!res.ok || streamed || body === undefined) return res;
    return collectResponse(res);
  };
}

function adaptBody(json: Record<string, unknown>): Record<string, unknown> {
  const { temperature: _t, top_p: _p, prompt_cache_retention: _r, ...rest } = json;
  // Without server-side storage, item ids point at nothing; the backend rejects references to them.
  const input = Array.isArray(rest.input)
    ? rest.input.filter((item: { type?: string }) => item.type !== "item_reference").map(({ id: _id, ...item }: Record<string, unknown>) => item)
    : rest.input;
  return { ...rest, input, instructions: rest.instructions ?? "", store: false, stream: true };
}

/** Turns the event stream into the JSON body a non-streaming Responses call expects. */
async function collectResponse(res: Response): Promise<Response> {
  const text = await res.text();
  let final: unknown;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const event = JSON.parse(line.slice(5)) as { type?: string; response?: unknown };
      if (event.type === "response.completed" || event.type === "response.incomplete" || event.type === "response.failed") final = event.response;
    } catch {
      // keep-alive or partial line
    }
  }
  if (!final) return new Response(JSON.stringify({ error: { message: "ChatGPT returned no response." } }), { status: 502, headers: { "Content-Type": "application/json" } });
  return new Response(JSON.stringify(final), { status: 200, headers: { "Content-Type": "application/json" } });
}
