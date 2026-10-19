# Prompt caching

Researched 2026-10-19 from the opencode source (`packages/ai/src/cache-policy.ts`, `protocols/shared.ts`, `protocols/utils/cache.ts`).

## Rules that apply to every provider

1. Keep the request prefix byte-stable: system prompt first, then tools in a deterministic order (sort by name), then messages. Anything that changes per request (timestamps, the user's current time, random ids) goes at the end or nowhere.
2. Never rewrite earlier messages. Compaction is the one deliberate exception and it resets the cache once.
3. Route every request of a thread to the same backend with a stable affinity id (see `opencode-go.md`).

## Per wire format

| Format | Mechanism | What okaychat sends |
| --- | --- | --- |
| Anthropic Messages | Explicit `cache_control` breakpoints, max 4 | Breakpoints on last tool, system prompt, last message. Via AI SDK `providerOptions.anthropic.cacheControl = { type: "ephemeral" }` on those parts |
| OpenAI Responses / Chat | Automatic prefix caching | `providerOptions.openai.promptCacheKey = <affinity>` (max 64 chars). For openai-compatible, body field `prompt_cache_key` |
| Google Gemini | Implicit caching | Nothing. A tail breakpoint would write a new cache each step and cost more |
| Qwen via Anthropic format | Ignores breakpoints on tools | System + tail only |

opencode's default ("auto") policy: last tool definition, first and last system part, conversation tail. Tail breakpoint moves forward after each tool result so long agent loops stay cached.

## Usage accounting

Providers disagree on whether `input_tokens` includes cached tokens. AI SDK v7 normalizes to `usage.inputTokens` (total, including cached) with `inputTokenDetails.cacheReadTokens` and `cacheWriteTokens`. Cost:

```
noCache = input - cacheRead - cacheWrite
cost = noCache*in + cacheRead*cache_read + cacheWrite*cache_write + output*out   (per 1M)
```

Use the tier price when the request's input tokens exceed `tier.size`. Clamp nonsense breakdowns (cached > input) to zero.

## What we show

Per message: input, cached, output, reasoning tokens, cost. Per thread: cache hit ratio = cacheRead / input across the thread.
