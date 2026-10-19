# OpenCode Go

Researched 2026-10-19 from opencode.ai/docs/go, models.dev, and the opencode source (`packages/core/src/session/model-request.ts`).

## What it is

A $10/month (Go) or $40/month (Go Plus) subscription that exposes a curated set of models through one API key. Same token prices on both plans. Plus raises limits.

## Auth

API key from https://opencode.ai/console. Sent as the normal provider auth header for each wire format (`Authorization: Bearer` for OpenAI formats, `x-api-key` for Anthropic, `x-goog-api-key` for Google). Env name in models.dev: `OPENCODE_API_KEY`.

## Endpoints

There is no single wire format. Each model speaks one of four:

| Format | AI SDK package | Base URL |
| --- | --- | --- |
| OpenAI Responses | `@ai-sdk/openai` (`.responses()`) | `https://opencode.ai/inference/go/openai/v1` |
| OpenAI Chat Completions | `@ai-sdk/openai-compatible` | `https://opencode.ai/inference/go/openai/v1` |
| Anthropic Messages | `@ai-sdk/anthropic` | `https://opencode.ai/inference/go/anthropic/v1` |
| Google Gemini | `@ai-sdk/google` | `https://opencode.ai/inference/go/google/v1beta` |

Live model list (no auth needed): `GET https://opencode.ai/inference/go/v1/models` (OpenAI list shape, ids only).

## Which format per model

models.dev (`https://models.dev/api.json`, key `opencode-go`) gives per model:

- `provider.npm`: the AI SDK package. Missing means the provider default `@ai-sdk/openai-compatible`.
- `provider.api`: base URL.
- `limit.context`, `limit.input`, `limit.output`.
- `cost` per 1M tokens: `input`, `output`, `cache_read`, `cache_write`, optional `tiers` (higher price above a context size).
- `reasoning`, `reasoning_options` (effort values), `tool_call`, `attachment`, `modalities`, `temperature`, `interleaved` (reasoning field name for chat completions).

Strategy in okaychat: fetch the live list, join with models.dev metadata, cache both (models.dev 6 h, live list 15 min). A live id missing from models.dev falls back to openai-compatible with conservative defaults (128k context).

## Required client behavior

From the docs: send a client-specific `User-Agent` (not a generic SDK name) and a stable session id in `x-opencode-session`.

opencode itself sends, per request:

```
User-Agent: opencode/<version>
x-opencode-session: <affinity>        # root session id; forks and children share the parent's
x-session-affinity: <affinity>
X-Session-Id: <affinity>
x-opencode-client: <app name>
promptCacheKey: <affinity>            # OpenAI prompt_cache_key, max 64 chars
```

The affinity id routes all requests of a conversation to the same backend so the provider prefix cache hits. okaychat uses the thread id (root thread id for forks) as affinity and `User-Agent: okaychat/<version>`.

## Limits

Each model has a monthly dollar limit (example: GLM-5.3-Flash $60 on Go, $180 on Go Plus). Rolling windows on top: 5 hours = 20% of monthly, weekly = 50%, monthly = 100%. With Console credits and "Use balance" on, requests fall back to pay-as-you-go after limits. Free models (names ending in `-free`) keep working after limits.

No public usage/limits API was found. okaychat estimates window usage from its own recorded cost per model. Unverified: whether the API returns a rate-limit header we could read.

## Policy note

The docs say clients "should send typical coding-agent traffic". A general chat client is a gray area. Keep the headers honest and do not impersonate opencode.
