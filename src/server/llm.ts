import { creditModelMiddleware } from "./credits/model.js";
import { assertCreditPermit, type CreditContext, type CreditPermit } from "./credits/store.js";
import { finiteCredits } from "./credits/admission.js";
import type { UsageKind } from "./usage.js";
import { reserveOperation } from "./permissions/limits.js";
import { modelPolicy } from "./permissions/model.js";
import { assertModelAllowed } from "./permissions/guard.js";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel, type JSONValue, type LanguageModel, type ModelMessage } from "ai";
import type { RetryNotice } from "../shared/errors.js";
import type { ModelInfo, ReasoningEffort } from "../shared/types.js";
import { CHATGPT, chatgptFetch } from "./catalog/chatgpt.js";
import { OLLAMA_DEFAULT_URL } from "./catalog/ollama.js";
import type { Connection } from "./catalog/providers.js";
import { sha256 } from "./crypto.js";
import { USER_AGENT } from "./env.js";
import { AppError } from "./errors.js";
import { modelAccessMessage, sharedModelAccess } from "./entitlements.js";
import { providerFetch } from "./provider-transport.js";
import { createRetryingFetch, type RetryingFetchOptions } from "./retry.js";
import { withResponseBounds } from "./response-bounds.js";
import { openaiToolSchemas } from "./openai-schema.js";
import { createOllamaModel } from "./ollama-model.js";

type ProviderOptions = Record<string, Record<string, JSONValue>>;

export interface ModelHandle {
  model: LanguageModel;
  providerOptions: ProviderOptions;
  /**
   * Builds the request messages with cache breakpoints for formats that need them. `system[0]` is the part
   * shared by every chat of the account, `system[1]` the chat's own context. See docs/implementation/prompt-caching.md.
   */
  markCache: (system: string[], messages: ModelMessage[]) => ModelMessage[];
  /**
   * Moves the conversation breakpoint to the newest message of a later step in a tool loop, so the
   * tool results gathered so far are cached too. Only formats with explicit breakpoints set it.
   */
  markStep?: (messages: ModelMessage[]) => ModelMessage[];
}

const isOpencode = (providerId: string) => providerId === "opencode-go" || providerId === "opencode";

/**
 * Headers that route requests to the backend holding the prefix cache. OpenCode Go picks the upstream by
 * `x-opencode-session`, so it is per account, not per chat: every chat of an account then shares the
 * cached tool and system prefix. See docs/implementation/prompt-caching.md.
 */
function affinityHeaders(providerId: string, affinity: string): Record<string, string> {
  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (isOpencode(providerId)) {
    headers["x-opencode-session"] = affinity;
    headers["x-session-affinity"] = affinity;
    headers["x-opencode-client"] = "okaychat";
  }
  return headers;
}

/** Stable per-account routing and cache key. Hashed so the account id never leaves the server. */
export const cacheAffinity = (userId: string) => `okc-${sha256(`cache:${userId}`).slice(0, 32)}`;

export interface CreateModelOptions {
  creditPermit: CreditPermit;
  usageContext: CreditContext & { kind: UsageKind };
  userId: string;
  effort?: ReasoningEffort;
  /** Chat turns stream a visible "Retrying in Ns…" notice; background calls simply wait. */
  onRetry?: (notice: RetryNotice) => void;
  /** Test seam for the retry clock and fake provider; never set in production code. */
  retry?: Omit<RetryingFetchOptions, "onRetry" | "fetchImpl">;
  /** Test seam: the leaf below the connection transport; never set in production code. */
  leafFetch?: typeof fetch;
  /**
   * Optional caller guard, checked before the first attempt and before every retry. Channel AI uses it
   * to re-check room membership, the feature, the binding, and the run's live state without changing
   * private chat prompt assembly.
   */
  guard?: () => void;
  /**
   * External API only: byte and record bounds for the provider response body. The app's own chat calls
   * leave this unset. See docs/implementation/api-access.md.
   */
  responseBounds?: { maxBytes: number; maxRecordBytes: number };
}

export function createModel(info: ModelInfo, conn: Connection, opts: CreateModelOptions): ModelHandle {
  if (info.ref.startsWith("n8n/")) throw new AppError({ code: "validation", message: "Agents cannot be used as language models." });
  const check = () => {
    assertModelAllowed(opts.userId, info.ref);
    if (conn.shared) {
      const access = sharedModelAccess(opts.userId, info.providerId);
      if (!access.visible || (!access.all && !access.ids.has(info.id))) throw new AppError({ code: "forbidden", message: modelAccessMessage(info.ref) });
    }
    opts.guard?.();
  };
  check();
  assertCreditPermit(opts.creditPermit, opts.userId);
  const handle = createRawModel(info, conn, opts);
  return { ...handle, model: wrapLanguageModel({ model: handle.model as Parameters<typeof wrapLanguageModel>[0]["model"], middleware: [modelPolicy(opts.userId, info, check), creditModelMiddleware({ permit: opts.creditPermit, userId: opts.userId, model: info, kind: opts.usageContext.kind, context: Object.fromEntries(Object.entries(opts.usageContext).filter(([key]) => key !== "kind")) })] }) };
}

function createRawModel(info: ModelInfo, conn: Connection, opts: CreateModelOptions): ModelHandle {
  // Recheck the live policy here, not only where the model was listed: a turn can run after an admin
  // revoked access, and a caller can hand over an earlier model/connection pair. Nothing reaches the
  // provider before this passes.
  if (info.providerId !== conn.providerId) throw new AppError({ code: "validation", message: "The model and connection do not match." });
  if (conn.shared) {
    const access = sharedModelAccess(opts.userId, info.providerId);
    if (!access.visible || (!access.all && !access.ids.has(info.id))) {
      throw new AppError({ code: "forbidden", message: modelAccessMessage(info.ref) });
    }
  }
  const beforeAttempt = (attempt: number) => {
    assertModelAllowed(opts.userId, info.ref);
    if (conn.shared) {
      const access = sharedModelAccess(opts.userId, info.providerId);
      if (!access.visible || (!access.all && !access.ids.has(info.id))) throw new AppError({ code: "forbidden", message: modelAccessMessage(info.ref) });
    }
    opts.guard?.();
    // The dispatch middleware reserved attempt one and holds its lease throughout the call.
    if (attempt > 1) reserveOperation({ userId: opts.userId, modelRef: info.ref }, "llm.call", { hold: false });
  };
  const affinity = cacheAffinity(opts.userId);
  const headers = affinityHeaders(info.providerId, affinity);
  // Legacy custom rows keep the historical keyless placeholder; a v1 custom connection's auth is set
  // only by its transport, so the SDK gets no key of its own.
  const apiKey = conn.apiKey ?? "not-needed";
  if (conn.transport && info.baseURL !== conn.baseURL) throw new AppError({ code: "validation", message: "The model and connection do not match." });
  const baseURL = conn.transport ? conn.baseURL : info.baseURL;
  // All provider retries happen here, before a response body is consumed. Every caller disables the
  // SDK's own retry (maxRetries: 0), so delays never compound. See docs/implementation/errors.md.
  const fetch = withResponseBounds(
    // The connection transport sits inside the retries, so auth, headers, and query are applied on every attempt.
    createRetryingFetch({ ...(opts.retry ?? {}), ...(finiteCredits(opts.userId) ? { policy: { maxAttempts: 1 } } : {}), onRetry: opts.onRetry, beforeAttempt, fetchImpl: providerFetch(conn, opts.leafFetch) }),
    opts.responseBounds ?? { maxBytes: Infinity, maxRecordBytes: Infinity },
  );
  // OpenAI-style caches are partitioned by prompt_cache_key: a per-chat key made every new chat start cold.
  const cacheKey = affinity;
  const effort = opts.effort && info.reasoning && (!info.reasoningEfforts || info.reasoningEfforts.includes(opts.effort)) ? opts.effort : undefined;
  const passthrough = (system: string[], messages: ModelMessage[]) => [...systemMessages(system), ...messages];

  switch (info.format) {
    case "openai-responses": {
      const chatgpt = info.providerId === CHATGPT;
      const provider = createOpenAI(chatgpt
        ? { apiKey: "chatgpt-login", baseURL, headers, fetch: createRetryingFetch({ ...(opts.retry ?? {}), ...(finiteCredits(opts.userId) ? { policy: { maxAttempts: 1 } } : {}), onRetry: opts.onRetry, beforeAttempt, fetchImpl: chatgptFetch(opts.userId) }) }
        : { apiKey, baseURL, headers, fetch });
      const openai: Record<string, JSONValue> = { ...(chatgpt ? {} : { promptCacheKey: cacheKey }), store: false };
      if (effort) {
        openai.reasoningEffort = effort;
        openai.reasoningSummary = "auto";
      }
      // GPT-5.6+ cache only at breakpoints; the implicit one sits at the end of the conversation. An explicit
      // one after the shared system part lets new chats and changed chat context reuse tools + system.
      // Plan OAuth has no verified explicit cache-key compatibility profile.
      const markCache = !chatgpt && EXPLICIT_BREAKPOINTS.test(info.id)
        ? (system: string[], messages: ModelMessage[]) => [...systemMessages(system, OPENAI_BREAKPOINT), ...messages]
        : passthrough;
      return { model: wrapLanguageModel({ model: provider.responses(info.id), middleware: openaiToolSchemas }), providerOptions: { openai }, markCache };
    }
    case "anthropic": {
      const provider = createAnthropic({ apiKey, baseURL, headers, fetch });
      const anthropic: Record<string, JSONValue> = {};
      if (effort && effort !== "none") {
        if (info.reasoningEfforts?.length) {
          anthropic.effort = effort === "minimal" ? "low" : effort;
          // Effort alone does not turn thinking on; adaptive-thinking models need it requested.
          if (ADAPTIVE_THINKING.test(info.id)) anthropic.thinking = { type: "adaptive" };
        } else anthropic.thinking = { type: "enabled", budgetTokens: effortBudget(effort) };
        anthropic.sendReasoning = true;
      }
      return { model: provider(info.id), providerOptions: { anthropic }, markCache: anthropicBreakpoints, markStep: anthropicStepBreakpoint };
    }
    case "google": {
      const provider = createGoogleGenerativeAI({ apiKey, baseURL, headers, fetch });
      const google: Record<string, JSONValue> = {};
      if (info.reasoning) {
        // Gemini 2.5 takes a token budget (0 turns Flash's thinking off; Pro cannot turn it off);
        // later models take a named level.
        const budgeted = /gemini-2\.5/.test(info.id);
        const level = effort === "minimal" || effort === "low" ? "low" : effort === "medium" ? "medium" : "high";
        google.thinkingConfig = {
          includeThoughts: true,
          ...(effort && effort !== "none"
            ? budgeted ? { thinkingBudget: Math.min(effortBudget(effort), /pro/.test(info.id) ? 32_768 : 24_576) } : { thinkingLevel: level }
            : effort === "none" && budgeted && !/pro/.test(info.id) ? { thinkingBudget: 0, includeThoughts: false } : {}),
        };
      }
      return { model: provider(info.id), providerOptions: { google }, markCache: passthrough };
    }
    case "ollama": {
      // Native /api/chat: no OpenAI JSON, no cache fields. The daemon manages its own prompt cache.
      // Effort reaches native `think` here because /api/chat has no provider options object; the
      // context window is sent as num_ctx so runtime and advertised context agree.
      const cap = assertModelAllowed(opts.userId, info.ref).limits.contextTokens;
      const context = Number.isInteger(info.context) && info.context > 0 ? Math.min(info.context, cap ?? Infinity) : undefined;
      return {
        model: createOllamaModel({
          id: info.id,
          baseURL: baseURL ?? OLLAMA_DEFAULT_URL,
          guarded: conn.guarded,
          thinking: info.reasoning,
          thinkingLevels: info.thinkingLevels,
          thinkingOff: info.reasoningEfforts ? info.reasoningEfforts.includes("none") : info.reasoning,
          context,
          reasoning: effort,
          // Same retry boundary as every other provider, injected before ollamaRequest maps errors.
          fetch,
        }),
        providerOptions: {},
        markCache: passthrough,
      };
    }
    case "openai-chat": {
      const name = info.providerId.replace(/[^a-zA-Z0-9]/g, "");
      const provider = createOpenAICompatible({
        name,
        apiKey: conn.transport ? undefined : apiKey,
        baseURL: baseURL ?? "",
        headers,
        fetch,
        includeUsage: true,
        // Most compatible backends (DeepSeek, Kimi, GLM, Qwen) honor OpenAI's prompt_cache_key or ignore it.
        transformRequestBody: (body) => ({ ...body, prompt_cache_key: cacheKey }),
      });
      const options: Record<string, JSONValue> = {};
      if (effort) options.reasoningEffort = effort;
      return { model: wrapLanguageModel({ model: provider.chatModel(info.id), middleware: openaiToolSchemas }), providerOptions: { [name]: options }, markCache: passthrough };
    }
  }
}

function effortBudget(effort: ReasoningEffort): number {
  return { none: 0, minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 32768, max: 64000 }[effort];
}

/** Claude models that think only when adaptive thinking is requested (4.6 and later). */
const ADAPTIVE_THINKING = /^claude-(?:opus|sonnet|haiku|fable)-(?:4-[6-9]|[5-9])(?!\d)/;

const EPHEMERAL = { anthropic: { cacheControl: { type: "ephemeral" } } } as const;
const OPENAI_BREAKPOINT = { openai: { promptCacheBreakpoint: { mode: "explicit" } } } as const;
/** OpenAI models that cache only at breakpoints (GPT-5.6 and later). */
const EXPLICIT_BREAKPOINTS = /^gpt-(5\.([6-9]|\d{2,})|[6-9]|\d{2,})(\b|[.-])/;

/** The shared part first, optionally marked as a cache breakpoint; then the chat's own context. */
function systemMessages(system: string[], breakpoint?: ModelMessage["providerOptions"]): ModelMessage[] {
  return system.filter((text) => text.trim()).map((content, index) =>
    ({ role: "system", content, ...(index === 0 && breakpoint ? { providerOptions: breakpoint } : {}) }) as ModelMessage);
}

/**
 * One extra breakpoint on a step's last message. The SDK rebuilds each step from the initial (already
 * marked) messages plus the responses, so only the system marker, the initial tail, and this one are
 * present: within Anthropic's limit of four.
 */
function anthropicStepBreakpoint(messages: ModelMessage[]): ModelMessage[] {
  const lastIndex = messages.length - 1;
  const last = messages[lastIndex];
  if (!last || last.role === "system") return messages;
  const out = [...messages];
  out[lastIndex] = { ...last, providerOptions: { ...last.providerOptions, ...EPHEMERAL } } as ModelMessage;
  return out;
}

/**
 * Anthropic caches only at explicit breakpoints (max 4). Mark the shared system part (covers tools + it,
 * reused by every chat) and the last message (moves forward each step). See docs/implementation/prompt-caching.md.
 */
function anthropicBreakpoints(system: string[], messages: ModelMessage[]): ModelMessage[] {
  const out = [...messages];
  const lastIndex = out.length - 1;
  const last = out[lastIndex];
  if (last && last.role !== "system") {
    out[lastIndex] = { ...last, providerOptions: { ...last.providerOptions, ...EPHEMERAL } } as ModelMessage;
  }
  return [...systemMessages(system, EPHEMERAL), ...out];
}
