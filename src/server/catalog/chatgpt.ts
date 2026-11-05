import type { ModelInfo, ReasoningEffort } from "../../shared/types.js";
import { USER_AGENT } from "../env.js";
import { AppError } from "../errors.js";
import { OAuthError } from "../chatgpt-oauth.js";
import {
  chatgptAccess,
  chatgptConnected,
  chatgptPin,
  onChatGPTChange,
  registerChatGPTRequest,
  type Pin,
} from "../chatgpt-oauth-store.js";
import { chatgptFailureStatus, collectCompletedResponse, guardStreamingResponse, trackResponse } from "../chatgpt-sse.js";

// Chat through a personal Sign in with ChatGPT (SIWC) registration, independent of the Codex CLI login
// used for images. Both endpoints are pinned: no provider row, browser value, token claim, or admin
// override can move them. See docs/implementation/codex-chat.md.

export { chatgptConnected };

export const CHATGPT = "chatgpt";
export const CHATGPT_NAME = "ChatGPT plan";
export const CHATGPT_BASE_URL = "https://api.openai.com/v1";
export const CHATGPT_MODELS_URL = `${CHATGPT_BASE_URL}/models`;
export const CHATGPT_RESPONSES_URL = `${CHATGPT_BASE_URL}/responses`;
export const CHATGPT_NAMESPACE = "okaychat";

const HOST = "api.openai.com";
const MAX_OUTPUT = 4_096;
const FALLBACK_CONTEXT = 32_768;
const MODEL_TTL_MS = 15 * 60_000;
const CATALOG_BODY_CAP = 2 * 1024 * 1024;
const UTILITY_BODY_CAP = 16 * 1024 * 1024;
const UTILITY_TIMEOUT_MS = 120_000;
const EFFORTS: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Families with documented function-calling support. An unknown catalog row gets no tools. */
const TOOL_FAMILY = /^(?:gpt|o[1-9]|codex|chatgpt)(?:[.-]|$)/i;

/** Top-level fields the ChatGPT-plan Responses route rejects or that would change its storage contract. */
const UNSUPPORTED_FIELDS = [
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
] as const;

/** Explicit cache metadata is stripped recursively; the plan route has no verified cache key contract. */
const CACHE_FIELDS = new Set([
  "prompt_cache_breakpoint",
  "prompt_cache_retention",
  "prompt_cache_key",
  "promptCacheBreakpoint",
  "promptCacheRetention",
  "promptCacheKey",
]);

interface CacheEntry {
  models: ModelInfo[];
  at: number;
  registrationId: string;
  generation: number;
}

const modelCache = new Map<string, CacheEntry>();

export const forgetChatgptModels = (userId: string) => {
  modelCache.delete(userId);
};

// A new active registration or a disconnect must never reuse another account's catalog.
onChatGPTChange(forgetChatgptModels);

interface RawModel {
  slug?: unknown;
  display_name?: unknown;
  visibility?: unknown;
  supported_in_api?: unknown;
  context_window?: unknown;
  input_modalities?: unknown;
  supported_reasoning_levels?: unknown;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const safeText = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.trim() ? value.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, max) : undefined;

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function toModelInfo(raw: RawModel): ModelInfo | undefined {
  const slug = safeText(raw.slug, 200);
  if (!slug) return undefined;
  const visibility = typeof raw.visibility === "string" ? raw.visibility : undefined;
  if (visibility !== undefined && visibility !== "list") return undefined;
  if (raw.supported_in_api === false) return undefined;

  const modalities = Array.isArray(raw.input_modalities)
    ? [...new Set(raw.input_modalities.slice(0, 20).map((entry) => safeText(entry, 40)).filter((entry): entry is string => !!entry))]
    : [];
  const inputModalities = modalities.length ? modalities : ["text"];
  const efforts: ReasoningEffort[] = [];
  if (Array.isArray(raw.supported_reasoning_levels)) {
    for (const entry of raw.supported_reasoning_levels.slice(0, 100)) {
      const effort = safeText(record(entry)?.effort, 20) as ReasoningEffort | undefined;
      if (effort && EFFORTS.includes(effort) && !efforts.includes(effort)) efforts.push(effort);
    }
  }
  return {
    ref: `${CHATGPT}/${slug}`,
    providerId: CHATGPT,
    id: slug,
    name: safeText(raw.display_name, 200) ?? slug,
    format: "openai-responses",
    baseURL: CHATGPT_BASE_URL,
    context: positive(raw.context_window) ?? FALLBACK_CONTEXT,
    maxOutput: MAX_OUTPUT,
    // Only documented families get tools; an unknown row stays text-only rather than claiming capability.
    toolCall: TOOL_FAMILY.test(slug),
    reasoning: efforts.length > 0,
    ...(efforts.length ? { reasoningEfforts: efforts } : {}),
    attachments: inputModalities.includes("image"),
    inputModalities,
    // The plan route rejects temperature and has no retail price.
    temperature: false,
    free: false,
  };
}

function parseModels(body: unknown): ModelInfo[] | undefined {
  const json = record(body);
  if (!json || !Array.isArray(json.models)) return undefined;
  const models: ModelInfo[] = [];
  for (const entry of json.models) {
    const model = record(entry) as RawModel | undefined;
    if (!model) continue;
    const info = toModelInfo(model);
    if (info) models.push(info);
  }
  return models;
}

interface BoundedBody {
  status: number;
  headers: Headers;
  text: string;
}

/** Reads at most `cap` bytes; the rest of the upstream body is cancelled. */
async function readPrefixed(res: Response, cap: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = cap - size;
      if (room <= 0) {
        void reader.cancel().catch(() => {});
        break;
      }
      const slice = value.byteLength > room ? value.subarray(0, room) : value;
      text += decoder.decode(slice, { stream: true });
      size += slice.byteLength;
      if (slice.byteLength < value.byteLength) {
        void reader.cancel().catch(() => {});
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return text + decoder.decode();
}

async function boundedBody(res: Response, cap: number): Promise<BoundedBody> {
  return { status: res.status, headers: res.headers, text: await readPrefixed(res, cap) };
}

function isAbort(error: unknown): boolean {
  const value = error as { name?: string; code?: string } | undefined;
  return value?.name === "AbortError" || value?.name === "TimeoutError" || value?.code === "ABORT_ERR";
}

function mapAuthFailure(error: unknown, signals: { signal?: AbortSignal; deadline?: AbortSignal }): never {
  if (signals.signal?.aborted) {
    throw signals.signal.reason ?? new DOMException("The request was stopped.", "AbortError");
  }
  if (signals.deadline?.aborted) {
    throw new AppError({ code: "timeout", message: "ChatGPT took too long to answer.", provider: CHATGPT, cause: error });
  }
  if (error instanceof AppError) throw error;
  if (error instanceof OAuthError) {
    const providerCode = error.upstreamCode ? { providerCode: error.upstreamCode } : {};
    if (error.kind === "temporary") {
      throw new AppError({
        code: "provider_rate_limit",
        message: "ChatGPT is busy. Try again shortly.",
        provider: CHATGPT,
        recoveryAction: "retry",
        ...providerCode,
        cause: error,
      });
    }
    if (error.kind === "uncertain") {
      throw new AppError({
        code: "provider_auth",
        message: "ChatGPT could not renew access. Reconnect to continue.",
        hint: "Reconnect ChatGPT in Settings → Providers.",
        provider: CHATGPT,
        featureCode: "chatgpt_refresh_uncertain",
        recoveryAction: "reconnect_chatgpt",
        ...providerCode,
        cause: error,
      });
    }
    if (error.kind === "configuration") {
      throw new AppError({
        code: "provider_auth",
        message: "ChatGPT sign-in is not configured correctly.",
        hint: "Ask an admin to check the deployment configuration.",
        provider: CHATGPT,
        featureCode: "chatgpt_protocol_error",
        recoveryAction: "contact_admin",
        ...providerCode,
        cause: error,
      });
    }
    if (error.kind === "identity") {
      throw new AppError({
        code: "provider_auth",
        message: "This ChatGPT sign-in does not match the saved account.",
        hint: "Reconnect ChatGPT in Settings → Providers.",
        provider: CHATGPT,
        featureCode: "chatgpt_identity_mismatch",
        recoveryAction: "reconnect_chatgpt",
        ...providerCode,
        cause: error,
      });
    }
    throw new AppError({
      code: "provider_auth",
      message: "ChatGPT needs to be reconnected.",
      hint: "Reconnect ChatGPT in Settings → Providers.",
      provider: CHATGPT,
      featureCode: "chatgpt_reconnect_required",
      recoveryAction: "reconnect_chatgpt",
      ...providerCode,
      cause: error,
    });
  }
  if (isAbort(error)) throw error;
  throw new AppError({
    code: "provider_auth",
    message: "ChatGPT needs to be reconnected.",
    hint: "Reconnect ChatGPT in Settings → Providers.",
    provider: CHATGPT,
    featureCode: "chatgpt_reconnect_required",
    recoveryAction: "reconnect_chatgpt",
    cause: error,
  });
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => !!signal);
  if (!present.length) return undefined;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present);
}

type Target = { kind: "models"; url: string; method: "GET" } | { kind: "responses"; url: string; method: "POST" };

function pinnedTarget(input: RequestInfo | URL, init: RequestInit | undefined): Target {
  const raw = input instanceof Request ? input.url : String(input);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError({ code: "validation", message: "ChatGPT requests must use a valid URL.", provider: CHATGPT });
  }
  if (url.protocol !== "https:" || url.hostname !== HOST || url.port || url.username || url.password || url.search || url.hash) {
    throw new AppError({ code: "forbidden", message: "ChatGPT requests must go to the pinned provider endpoint.", provider: CHATGPT });
  }
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (url.pathname === "/v1/models" && method === "GET") return { kind: "models", url: CHATGPT_MODELS_URL, method: "GET" };
  if (url.pathname === "/v1/responses" && method === "POST") return { kind: "responses", url: CHATGPT_RESPONSES_URL, method: "POST" };
  throw new AppError({ code: "validation", message: "ChatGPT requests must use models (GET) or responses (POST).", provider: CHATGPT });
}

function pinnedHeaders(kind: Target["kind"], token: string): Headers {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Accept", kind === "models" ? "application/json" : "text/event-stream");
  headers.set("User-Agent", USER_AGENT);
  if (kind === "responses") headers.set("Content-Type", "application/json");
  return headers;
}

async function requestText(input: RequestInfo | URL, init: RequestInit | undefined): Promise<string | undefined> {
  const body = init?.body;
  if (body === undefined || body === null) {
    if (input instanceof Request && input.body) return input.text();
    return undefined;
  }
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (ArrayBuffer.isView(body)) return new TextDecoder().decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  if (body instanceof URLSearchParams) return body.toString();
  throw new AppError({ code: "validation", message: "ChatGPT requests must be JSON.", provider: CHATGPT });
}

/** Deep-copies while dropping explicit cache metadata at any depth. */
function stripCacheFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCacheFields);
  const object = record(value);
  if (!object) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(object)) {
    if (!CACHE_FIELDS.has(key)) out[key] = stripCacheFields(entry);
  }
  return out;
}

function flattenTools(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const out: Record<string, unknown>[] = [];
  for (const entry of value) {
    const tool = record(entry);
    if (!tool) continue;
    // The SDK can already emit a namespace; flatten it into ours rather than nesting namespaces.
    if (tool.type === "namespace") {
      out.push(...flattenTools(tool.tools));
      continue;
    }
    if (tool.type !== "function" && tool.type !== "custom") continue;
    const copy = { ...tool };
    const name = safeText(copy.name, 128);
    if (!name) continue;
    copy.name = name.startsWith(`${CHATGPT_NAMESPACE}.`) ? name.slice(CHATGPT_NAMESPACE.length + 1) : name;
    out.push(copy);
  }
  return out;
}

function adaptToolChoice(value: unknown): string | Record<string, unknown> | undefined {
  if (value === "auto" || value === "none" || value === "required") return value;
  const choice = record(value);
  if (!choice || choice.type !== "function") return undefined;
  const name = safeText(choice.name, 128);
  if (!name) return undefined;
  return { ...choice, name: name.startsWith(`${CHATGPT_NAMESPACE}.`) ? name : `${CHATGPT_NAMESPACE}.${name}` };
}

function normalizeInput(input: unknown, instructions: unknown): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  if (typeof instructions === "string" && instructions.trim()) {
    items.push({ role: "developer", content: [{ type: "input_text", text: instructions }] });
  }
  if (typeof input === "string") {
    if (input) items.push({ role: "user", content: [{ type: "input_text", text: input }] });
    return items;
  }
  if (!Array.isArray(input)) return items;
  for (const entry of input) {
    const item = record(entry);
    if (!item || item.type === "item_reference") continue;
    const copy: Record<string, unknown> = { ...item };
    // Nothing is stored server-side, so item ids point at nothing and must not be replayed.
    delete copy.id;
    if (copy.role === "system") copy.role = "developer";
    if (copy.type === "function_call") {
      if (copy.namespace === undefined) copy.namespace = CHATGPT_NAMESPACE;
      if (copy.namespace === CHATGPT_NAMESPACE && typeof copy.name === "string" && copy.name.startsWith(`${CHATGPT_NAMESPACE}.`)) {
        copy.name = copy.name.slice(CHATGPT_NAMESPACE.length + 1);
      }
    }
    items.push(copy);
  }
  return items;
}

/**
 * Adapts an AI SDK Responses body for the plan route: stateless, streamed, developer-role policy, no
 * unsupported fields, and every application tool inside the `okaychat` namespace.
 */
export function adaptResponsesBody(body: Record<string, unknown>): Record<string, unknown> {
  const json = stripCacheFields(body) as Record<string, unknown>;
  for (const field of UNSUPPORTED_FIELDS) delete json[field];
  delete json.previous_response_id;
  json.input = normalizeInput(json.input, json.instructions);
  delete json.instructions;

  const tools = flattenTools(json.tools);
  if (tools.length) {
    json.tools = [{ type: "namespace", name: CHATGPT_NAMESPACE, description: "Available application tools.", tools }];
    const choice = adaptToolChoice(json.tool_choice);
    if (choice === undefined) delete json.tool_choice;
    else json.tool_choice = choice;
  } else {
    delete json.tools;
    delete json.tool_choice;
  }

  json.store = false;
  json.stream = true;
  return json;
}

function machineCode(text: string): string | undefined {
  try {
    const json = record(JSON.parse(text));
    const error = record(json?.error) ?? json;
    const code = error?.code ?? error?.type;
    return typeof code === "string" && /^[A-Za-z0-9_.:-]{1,120}$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/** Plan usage limits stop the generic retry boundary; other statuses keep their upstream meaning. */
async function classifyErrorResponse(res: Response): Promise<Response> {
  if (![400, 401, 403, 429, 503].includes(res.status)) return res;
  const body = await boundedBody(res, 16 * 1024);
  return new Response(body.text, { status: chatgptFailureStatus(machineCode(body.text), body.status), headers: body.headers });
}

async function fetchModelList(userId: string, pin: Pin): Promise<ModelInfo[] | undefined> {
  const controller = new AbortController();
  const unregister = registerChatGPTRequest(userId, controller);
  const deadline = AbortSignal.timeout(8_000);
  const signal = AbortSignal.any([controller.signal, deadline]);
  let rejectedVersion: number | undefined;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const access = await chatgptAccess(userId, { pin, ...(rejectedVersion !== undefined ? { rejectedVersion } : {}), signal });
      const res = await fetch(CHATGPT_MODELS_URL, { method: "GET", headers: pinnedHeaders("models", access.token), signal, redirect: "error" });
      if (res.status === 401 && attempt === 0) {
        rejectedVersion = access.version;
        await res.body?.cancel().catch(() => {});
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return undefined;
      }
      const body = await boundedBody(res, CATALOG_BODY_CAP);
      return parseModels(JSON.parse(body.text));
    }
    return undefined;
  } finally {
    unregister();
  }
}

/** The plan's visible models. A failed fetch keeps the last good list for the same registration. */
export async function chatgptModels(userId: string): Promise<ModelInfo[]> {
  let pin: Pin;
  try {
    pin = chatgptPin(userId);
  } catch {
    modelCache.delete(userId);
    return [];
  }
  const hit = modelCache.get(userId);
  if (hit && hit.registrationId === pin.id && hit.generation === pin.generation && Date.now() - hit.at < MODEL_TTL_MS) return hit.models;
  try {
    const models = await fetchModelList(userId, pin);
    if (models) {
      modelCache.set(userId, { models, at: Date.now(), registrationId: pin.id, generation: pin.generation });
      return models;
    }
  } catch {
    // A refresh failure is not a disconnect; the same registration may still use its last list.
  }
  return hit && hit.registrationId === pin.id && hit.generation === pin.generation ? hit.models : [];
}

interface AuthorizedResponse {
  res: Response;
  controller: AbortController;
  cleanup: () => void;
}

/**
 * One authorized pinned request, with a single pre-stream 401 replay. Headers are rebuilt from the
 * allowlist, so an SDK dummy key, a stale routing header, or a caller cookie never reaches the provider.
 */
async function authorizedRequest(
  userId: string,
  pin: Pin,
  target: Target,
  body: string | undefined,
  options: { signal?: AbortSignal; deadline?: AbortSignal },
): Promise<AuthorizedResponse> {
  const send = async (rejectedVersion?: number): Promise<AuthorizedResponse & { version: number }> => {
    const external = combineSignals(options.signal, options.deadline);
    const controller = new AbortController();
    const unregister = registerChatGPTRequest(userId, controller);
    const onAbort = () => controller.abort(external?.reason);
    if (external?.aborted) controller.abort(external.reason);
    else external?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      external?.removeEventListener("abort", onAbort);
      unregister();
    };
    let access: { token: string; version: number };
    try {
      access = await chatgptAccess(userId, { pin, ...(rejectedVersion !== undefined ? { rejectedVersion } : {}), signal: external });
    } catch (error) {
      cleanup();
      mapAuthFailure(error, options);
    }
    let res: Response;
    try {
      res = await fetch(target.url, {
        method: target.method,
        headers: pinnedHeaders(target.kind, access.token),
        ...(body !== undefined ? { body } : {}),
        signal: controller.signal,
        redirect: "error",
      });
    } catch (error) {
      cleanup();
      if (options.deadline?.aborted) mapAuthFailure(error, options);
      throw error;
    }
    return { res, controller, cleanup, version: access.version };
  };

  const first = await send();
  if (first.res.status !== 401) return first;
  await first.res.body?.cancel().catch(() => {});
  first.cleanup();
  return send(first.version);
}

/**
 * The fetch used by `createModel()` for the `chatgpt` provider. It pins the registration/generation when
 * the model handle is created, validates the destination before asking for a credential, and rebuilds
 * non-streaming utility calls from the event stream. Streaming responses are passed through incrementally.
 */
export function chatgptFetch(userId: string): typeof fetch {
  let pin: Pin | { error: unknown };
  try {
    pin = chatgptPin(userId);
  } catch (error) {
    pin = { error };
  }

  return async (input, init) => {
    const target = pinnedTarget(input, init);
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const raw = await requestText(input, init);
    let streamed = true;
    let body: string | undefined;
    if (target.kind === "responses") {
      if (raw === undefined) throw new AppError({ code: "validation", message: "ChatGPT responses need a JSON body.", provider: CHATGPT });
      let parsed: Record<string, unknown>;
      try {
        const value = record(JSON.parse(raw));
        if (!value) throw new Error("not an object");
        parsed = value;
      } catch {
        throw new AppError({ code: "validation", message: "ChatGPT responses need a JSON object.", provider: CHATGPT });
      }
      streamed = parsed.stream === true;
      body = JSON.stringify(adaptResponsesBody(parsed));
    }

    const utility = target.kind === "responses" && !streamed;
    const deadline = utility ? AbortSignal.timeout(UTILITY_TIMEOUT_MS) : undefined;
    if ("error" in pin) mapAuthFailure(pin.error, { signal: callerSignal, deadline });
    const { res, controller, cleanup } = await authorizedRequest(userId, pin, target, body, {
      signal: callerSignal,
      deadline,
    });

    if (!res.ok) {
      try {
        const classified = await classifyErrorResponse(res);
        return trackResponse(classified, { onEnd: cleanup, abort: () => controller.abort() });
      } catch (error) {
        cleanup();
        throw error;
      }
    }

    if (utility) {
      try {
        return await collectCompletedResponse(res, {
          signal: callerSignal,
          ...(deadline ? { deadline } : {}),
          maxBytes: UTILITY_BODY_CAP,
          timeoutMs: UTILITY_TIMEOUT_MS,
        });
      } finally {
        cleanup();
      }
    }

    return guardStreamingResponse(res, { onEnd: cleanup, abort: () => controller.abort() });
  };
}
