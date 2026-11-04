# Prompt caching

Cache policy is implemented in `src/server/llm.ts`, `chat.ts`, and `turn-context.ts`.

## Stable prefix

Each request extends its preceding conversation without rewriting earlier messages. Compaction and explicit memory revocation deliberately change that context.

The prompt has three layers, from most stable to most variable:

1. System message 1: the shared account/model policy, including base instructions, user instructions, tool-server guidance, memory policy, and enabled artifact/widget instructions.
2. System message 2: project instructions/files and the chat's pinned memory summary.
3. Turn context: the date, newly recalled facts, and enabled-skills index immediately before the corresponding user message.

`turn-context.ts` persists each turn's block and replays it verbatim. A new block omits facts, an unchanged skills index, and a date already shown earlier. Continuations reuse their existing block. Memory content is encrypted and replayed only while the account's revision remains valid; revocation clears the saved memory context.

Every block is a user-role message wrapped in the fixed `turnContext` prompt (`<app_context>`, naming the app as author and telling the model not to mention it unless needed). A bare "Today's date: …" user message read as the user's words, and models answered it instead of short or meaningless user messages. The wrapper is deterministic, so replayed blocks stay byte-identical. Temporary chats store no blocks: their date goes once before the first user message, and only per-query memory and the voice note sit before the latest one.

## Routing and tools

`cacheAffinity()` returns one stable hashed value per account for session-routing headers and OpenAI's `prompt_cache_key`. It is shared across chats and delegated tasks.

Keep the tool definitions constant within a turn. The `deep_research` tool joins a chat's list at its first research turn and stays, so only that turn changes the block; see `deep-research.md`. Exhausted search budgets are enforced by the tool's execution guard; they do not remove its schema. The final step uses `toolChoice: "none"` rather than an empty tool list.

## Wire formats

| Connection | What okaychat sends |
| --- | --- |
| Anthropic Messages | Explicit cache-control breakpoints on system message 1 and the conversation tail, through `providerOptions.anthropic.cacheControl`. Later steps of a tool loop add one more on the step's newest message (`markStep`), so tool results gathered in the reply are cached; three markers at most. |
| OpenAI Responses, GPT-5.6 and newer | Account affinity as `promptCacheKey`, with an explicit breakpoint on system message 1 where supported. |
| Other OpenAI Responses / Chat Completions | Account affinity as `promptCacheKey`; prefix caching is provider-managed. |
| Google Gemini | No explicit tail breakpoint; implicit caching is provider-managed. |
| ChatGPT-plan connection | Account affinity is retained, but `catalog/chatgpt.ts` strips unsupported breakpoint/retention fields. See `codex-chat.md`. |

The chosen model's wire format controls its provider options. Cache retention, actual reuse, and pricing are provider behavior; the app cannot guarantee a cache hit.

## Usage accounting

AI SDK normalizes `usage.inputTokens` to total input, including cached input. The details expose cache-read and cache-write counts. Cost per million tokens is:

```text
uncached = input - cacheRead - cacheWrite
cost = uncached * inputPrice + cacheRead * cacheReadPrice
     + cacheWrite * cacheWritePrice + output * outputPrice
```

Use a context-tier price when input exceeds its threshold; invalid token breakdowns are clamped. Per-message usage shows input, cached, output, reasoning, and cost. A thread's hit ratio is total cache-read tokens divided by total input tokens. Context fill uses the last step's input plus output, not the turn total.

## Limits

- New user text, tool results, and replies are new tokens until a subsequent request can reuse them.
- Screenshots and MCP images are injected for one model step without persisting the image content, so later requests can diverge there.
- Idle provider caches expire independently of the app.
- Changing tools, model settings, account instructions, or the per-chat system context can change the reusable prefix.
- Editing an assistant reply rewrites text inside the conversation, so the next request diverges at that message and re-primes the cache from there. The server sends the stored edited text even when the requesting tab still holds the old copy (`withStoredEdits`). See `docs/implementation/message-editing.md`.
- Summary/trim compaction resets the affected prefix. Trim boundaries move forward, keep deterministic placeholders, and leave headroom to avoid repeated compaction.

## Skills and attachments

The skills index belongs to turn context, never the stable system prefix. Skill bodies arrive through load/read tool results. Disabling skills revokes offered tools and drops the replayed index; normal skill creation or editing reads live tables without rewriting the running turn's prefix.

Saving temporary chats and materializing legacy attachments preserve their original message parts. Durable file metadata is recorded separately so persistence does not rewrite the conversation's data URLs.
