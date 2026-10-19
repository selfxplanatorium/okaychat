import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { JSONValue, LanguageModel, ModelMessage } from "ai";
import type { ModelInfo, ReasoningEffort } from "../shared/types.js";
import type { Connection } from "./catalog/providers.js";
import { USER_AGENT } from "./env.js";

type ProviderOptions = Record<string, Record<string, JSONValue>>;

export interface ModelHandle {
  model: LanguageModel;
  providerOptions: ProviderOptions;
  /** Rewrites messages to place cache breakpoints for formats that need them. */
  markCache: (system: string | undefined, messages: ModelMessage[]) => { system?: ModelMessage; messages: ModelMessage[] };
}

const isOpencode = (providerId: string) => providerId === "opencode-go" || providerId === "opencode";

/**
 * Headers that route all turns of a thread to the same backend so prefix caches hit.
 * See docs/research/opencode-go.md.
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

export function createModel(info: ModelInfo, conn: Connection, opts: { affinity: string; effort?: ReasoningEffort }): ModelHandle {
  const headers = affinityHeaders(info.providerId, opts.affinity);
  const apiKey = conn.apiKey ?? "not-needed";
  const baseURL = info.baseURL;
  const cacheKey = opts.affinity.slice(0, 64);
  const effort = opts.effort && info.reasoning && (!info.reasoningEfforts || info.reasoningEfforts.includes(opts.effort)) ? opts.effort : undefined;
  const passthrough = (system: string | undefined, messages: ModelMessage[]) => ({
    system: system ? ({ role: "system", content: system } as ModelMessage) : undefined,
    messages,
  });

  switch (info.format) {
    case "openai-responses": {
      const provider = createOpenAI({ apiKey, baseURL, headers });
      const openai: Record<string, JSONValue> = { promptCacheKey: cacheKey, store: false };
      if (effort) {
        openai.reasoningEffort = effort;
        openai.reasoningSummary = "auto";
      }
      return { model: provider.responses(info.id), providerOptions: { openai }, markCache: passthrough };
    }
    case "anthropic": {
      const provider = createAnthropic({ apiKey, baseURL, headers });
      const anthropic: Record<string, JSONValue> = {};
      if (effort && effort !== "none") {
        if (info.reasoningEfforts?.length) anthropic.effort = effort === "minimal" ? "low" : effort;
        else anthropic.thinking = { type: "enabled", budgetTokens: effortBudget(effort) };
        anthropic.sendReasoning = true;
      }
      return { model: provider(info.id), providerOptions: { anthropic }, markCache: anthropicBreakpoints };
    }
    case "google": {
      const provider = createGoogleGenerativeAI({ apiKey, baseURL, headers });
      const google: Record<string, JSONValue> = {};
      if (info.reasoning) {
        google.thinkingConfig = {
          includeThoughts: true,
          ...(effort && effort !== "none" ? { thinkingLevel: effort === "minimal" ? "low" : effort === "low" ? "low" : effort === "medium" ? "medium" : "high" } : {}),
        };
      }
      return { model: provider(info.id), providerOptions: { google }, markCache: passthrough };
    }
    case "openai-chat": {
      const name = info.providerId.replace(/[^a-zA-Z0-9]/g, "");
      const provider = createOpenAICompatible({
        name,
        apiKey,
        baseURL: baseURL ?? "",
        headers,
        includeUsage: true,
        // Most compatible backends (DeepSeek, Kimi, GLM, Qwen) honor OpenAI's prompt_cache_key or ignore it.
        transformRequestBody: (body) => ({ ...body, prompt_cache_key: cacheKey }),
      });
      const options: Record<string, JSONValue> = {};
      if (effort) options.reasoningEffort = effort;
      return { model: provider.chatModel(info.id), providerOptions: { [name]: options }, markCache: passthrough };
    }
  }
}

function effortBudget(effort: ReasoningEffort): number {
  return { none: 0, minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 32768, max: 64000 }[effort];
}

const EPHEMERAL = { anthropic: { cacheControl: { type: "ephemeral" } } } as const;

/**
 * Anthropic caches only at explicit breakpoints (max 4). Mark the system prompt (covers tools + system)
 * and the last message (moves forward each turn). See docs/research/prompt-caching.md.
 */
function anthropicBreakpoints(system: string | undefined, messages: ModelMessage[]) {
  const out = [...messages];
  const lastIndex = out.length - 1;
  const last = out[lastIndex];
  if (last && last.role !== "system") {
    out[lastIndex] = { ...last, providerOptions: { ...last.providerOptions, ...EPHEMERAL } } as ModelMessage;
  }
  return {
    system: system ? ({ role: "system", content: system, providerOptions: EPHEMERAL } as ModelMessage) : undefined,
    messages: out,
  };
}
