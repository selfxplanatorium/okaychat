# OpenCode Go connection

OpenCode Go is the default onboarding connection. Provider discovery and metadata merging live in `src/server/catalog/providers.ts` and `models-dev.ts`; request construction and cache affinity live in `src/server/llm.ts`.

## Credentials and endpoints

The connection stores a user's API key encrypted at rest. Administrator-shared connections follow the same audience and per-user precedence rules as other providers.

| Wire format | Package | Base URL |
| --- | --- | --- |
| OpenAI Responses | `@ai-sdk/openai` | `https://opencode.ai/inference/go/v1` |
| OpenAI Chat Completions | `@ai-sdk/openai-compatible` | `https://opencode.ai/inference/go/openai/v1` |
| Anthropic Messages | `@ai-sdk/anthropic` | `https://opencode.ai/inference/go/anthropic/v1` |
| Google Gemini | `@ai-sdk/google` | `https://opencode.ai/inference/go/google/v1beta` |

## Model discovery

The app fetches `https://opencode.ai/inference/go/v1/models` and joins those ids with models.dev metadata. The catalog supplies model names, wire formats, capabilities, context limits, and token prices. models.dev is cached for six hours; the live Go list for fifteen minutes.

An unknown live id inherits metadata and the wire format of a known sibling in its family when possible. For example, a Qwen id missing from models.dev can inherit the Anthropic format used by another Qwen model. An id without a usable sibling falls back to conservative defaults.

Only chat-capable models enter the chat picker. Image generation has its own service/model selection.

## Request affinity

The app identifies itself as okaychat and sends one stable hashed per-account affinity from `cacheAffinity()` in `llm.ts`. OpenCode session headers and the OpenAI `prompt_cache_key` use that affinity, so conversations and delegated tasks from the account can reuse their shared prefix. The app does not impersonate OpenCode.

The prefix structure and wire-format cache options are documented in `prompt-caching.md`.

## Usage display

Go's five-hour, weekly, and monthly views use the app's own recorded costs. They are estimates of recorded spending, not a provider-authoritative remaining quota. Model prices and availability come from the catalogs; account plans and provider limits can change independently of the app.
