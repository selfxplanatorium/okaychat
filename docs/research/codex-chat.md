# Chat through a ChatGPT plan (Codex backend)

Verified on 2026-10-25 with a ChatGPT Plus login from `codex-cli` 0.163.0: model list, streaming, non-streaming, multi-step tool calls, and reasoning through `createModel()`.

## How others do it

There is no official API for ChatGPT plans. The Codex CLI talks to `https://chatgpt.com/backend-api/codex`, and community OpenCode plugins (`numman-ali/opencode-openai-codex-auth` and its forks, `cortexkit/openai-auth`) reuse its OAuth login against the same endpoint. okaychat does the same with the login the image feature already stores (`docs/research/codex-images.md`). Those plugins state the use is meant for personal use of one's own plan. okaychat never shares a login between users.

## Requests

- `POST {base}/responses`: the OpenAI Responses API. `@ai-sdk/openai` works with a custom `fetch` (`catalog/chatgpt.ts`).
- Headers: `Authorization: Bearer <tokens.access_token>`, `chatgpt-account-id: <tokens.account_id>`, `originator: codex_cli_rs`.
- Required: `stream: true` (`"Stream must be set to true"`) and `store: false` (`"Store must be set to false"`). Non-streaming AI SDK calls (titles, compaction) get the `response.completed` event rebuilt as JSON.
- Rejected: `temperature` (`Unsupported parameter`), `prompt_cache_retention`, and `prompt_cache_breakpoint` (`not supported on this model`). So no explicit breakpoints. `prompt_cache_key` is accepted.
- Accepted: custom or empty `instructions` (the backend no longer requires the Codex system prompt), `system`/`developer` input messages, `max_output_tokens`, tools, `reasoning.effort`/`summary`, `include: ["reasoning.encrypted_content"]`.
- `item_reference` items and item `id`s are stripped, as the community plugins do, because nothing is stored server-side.
- Responses carry plan quota headers (`x-codex-primary-used-percent`, `x-codex-primary-window-minutes` = 300, `x-codex-secondary-*` = weekly, `x-codex-plan-type`). Not used yet.

## Models

`GET {base}/models?client_version=<cli version>` with the same headers returns `{ models: [...] }`. We keep `visibility: "list"` entries and use `slug`, `display_name`, `context_window`, `input_modalities`, and `supported_reasoning_levels` (efforts outside our `ReasoningEffort`, such as `ultra`, are dropped). The list is cached per user for 15 minutes; a failed fetch keeps the last list.

## Tokens

The access token is a JWT that lasted 10 days in testing. `codexAccess()` refreshes it when it expires within 5 minutes, or after a 401: `POST https://auth.openai.com/oauth/token` with JSON `{ client_id: "app_EMoamEEZ73f0CkXaXp7hrann", grant_type: "refresh_token", refresh_token, scope: "openid profile email" }`. The new tokens go back into `codex_auth` in the CLI's `auth.json` shape, so image runs keep working. Refreshes run in the same per-user queue as CLI runs, because the refresh token rotates.

Chat does not need the CLI installed. Signing in does (`codex login --device-auth`).
