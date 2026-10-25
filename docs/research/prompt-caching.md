# Prompt caching

Researched 2026-10-19 from the opencode source (`packages/ai/src/cache-policy.ts`, `protocols/shared.ts`, `protocols/utils/cache.ts`).

## Rules that apply to every provider

1. Every request must extend the previous one byte for byte. Never rewrite earlier messages. Compaction (summary or trim) is the one deliberate exception and it resets the cache once. A trim boundary only moves forward, its placeholders are deterministic, and an automatic trim must leave 25% headroom below the threshold or a summary follows, so trimming cannot churn the cache every turn.
2. Templates such as DeepSeek's render the tool definitions after the first system message. So the request has three layers, most stable first:
   - System message 1 (`systemPrompt()` in `chat.ts`): identical for every chat of the account and model. Base prompt, model identity, artifacts, custom instructions, MCP instructions, memory policy, generative UI instructions.
   - System message 2 (`chatContext()`): per chat, rarely changing. Project section and the pinned memory summary.
   - Turn context (`turn-context.ts`): a user message before each user message holding the date, newly recalled facts, and the skills index. It is stored and replayed verbatim, and holds only what earlier blocks in the chat do not show.
3. Route every request of an account to the same backend with one stable per-account affinity (`cacheAffinity()`, see `opencode-go.md`).
4. Keep the tool list constant within a turn. Use `toolChoice: "none"` instead of removing tools.

## Per wire format

| Format | Mechanism | What okaychat sends |
| --- | --- | --- |
| Anthropic Messages | Explicit `cache_control` breakpoints, max 4 | Breakpoints on system message 1 (covers tools + it) and the last message. Via AI SDK `providerOptions.anthropic.cacheControl = { type: "ephemeral" }`. Not measured live |
| OpenAI Responses (GPT-5.6+) | Breakpoints only. The implicit one sits at the end of the conversation | `promptCacheKey = <account affinity>` plus an explicit breakpoint (`providerOptions.openai.promptCacheBreakpoint = { mode: "explicit" }`) on system message 1. Without it, any change to the chat context or a new chat misses the whole prompt |
| OpenAI Responses (older) / Chat | Automatic prefix caching | `promptCacheKey` / body field `prompt_cache_key` = account affinity |
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

## Provider behavior (researched 2026-10-23)

- OpenAI (developers.openai.com prompt-caching guide): routing hashes the first tokens (tool definitions included) plus `prompt_cache_key`. Keep one key near 15 requests/min or overflow routing misses. Changing `tools` (names, descriptions, schemas, order), `parallel_tool_calls`, `reasoning.effort`, or `text.format` invalidates the prefix. The guide recommends `tool_choice: "none"` over removing tools. In-memory retention is 5–10 min idle (max 1 h); `prompt_cache_retention: "24h"` exists for gpt-5.x/4.1, and GPT-5.6+ use `prompt_cache_options.ttl` (`30m` default, `12h`). Not set by okaychat yet: unverified whether OpenCode Go forwards them.
- DeepSeek (api-docs.deepseek.com kv_cache): automatic disk cache, best effort. Cache units end at the end of each request's input and output, and a later request hits only when it contains a whole unit. A request that is not an exact extension of an earlier one falls back to the shared system/tools unit.
- Anthropic: `cache_control` TTL `5m` (default) or `1h` (2x write price). okaychat keeps `5m`.

## What broke caching (fixed 2026-10-23)

Measured from the `usage` table and by replaying stored chats through `turnStream` with a fetch stub that diffs consecutive request bodies (`/tmp`-style harness, not committed):

1. The recalled-memory + skills block sat before the latest user message and was rebuilt each turn, so the next request diverged at the previous turn's block. Every turn re-prefilled the previous user message, reply, and all tool results (tens of thousands of tokens after research turns), and DeepSeek matched only the system/tools unit. Fix: `turn-context.ts` stores the block per user message and `turnStream` replays all of them verbatim. Continuations of a turn (approval, browser tools) reuse the stored block. Memory text is encrypted, replayed only while the memory revision is unchanged, and wiped from `turn_context` when the revision bumps.
2. `prepareStep` removed `web_search` from `activeTools` once the search budget ran out and sent no tools on the final step. Both change the tool block and re-prefill the whole conversation. Fix: tools stay constant; the final step uses `toolChoice: "none"`; `web_search` already rejects calls past the budget. Same in sub-agents.

3. The affinity and `prompt_cache_key` were per chat. GPT partitions its cache by key, and OpenCode routes DeepSeek by session header, so every new chat paid the full tool+system prefix (25–40k tokens with 85 tools). Fix: one hashed per-account value.
4. Per-chat and per-day content (project, memory summary, date) sat in the one system message. On DeepSeek a change there dropped the cache from 41k to 3.5k tokens. On GPT-5.6+ it dropped to 0. Fix: the three layers above, plus the explicit GPT breakpoint.
5. The turn context repeated the same recalled facts (up to 30 recent facts, about 2.5k tokens) and skills index every turn. Fix: a new block carries only facts, a skills index, or a date not already shown by replayed blocks. Sub-agents moved their remaining-search line from the system prompt into the task message.

Live result 2026-10-23 (OpenCode Go, 85 tools, short exchanges, `/tmp` harness through `turnStream`): DeepSeek v4.1 flash 98.4–99.7% per turn, gpt-6-luna 98–100%, new chats included. Before: 0% on new chats and 93–96% per later turn.

## Known remaining misses

- Tool results, a new user message, and the previous answer are new tokens no cache can hold. A turn that fetches a 20k-token page into a 40k context lands near 67% for that step.
- DeepSeek caching is best effort: about one request in 30 still missed completely in testing.
- Screenshots and MCP tool images are injected for one step only and never persisted, so the step after them and the next turn diverge at that point.
- Idle gaps beyond provider retention (minutes for OpenAI in-memory, unspecified for DeepSeek) are cold misses no client can avoid without longer TTL options.

## Skills

The enabled-skills index is current-turn context beside the user message, never part of the
system prefix, and is replayed in later turns with the memory block (dropped when the chat has no
skills index any more). Skill bodies arrive through load/read tool results. Installing or creating a skill,
including during an approval continuation, leaves the system prompt unchanged. Stored attachment
copies and legacy migration likewise preserve the original data URL/text message parts.
