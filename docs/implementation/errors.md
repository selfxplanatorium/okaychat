# Errors, retries, and diagnostics

Every failure a user can meet has one vocabulary on the server, one safe wire shape, one presentation
decision in the browser, and one reference support can match to a log line. Raw provider JSON, prompts,
file text, and stacks stay on the server.

## Pieces

| File | Role |
| --- | --- |
| `src/shared/errors.ts` | `ErrorCode`, `ErrorWire`, `RetryNotice`, and `parseErrorWire` (allowlist parser) |
| `src/server/errors.ts` | `AppError`, the code catalog (status, retryability, keys, safe English fallback), `toWireError`, `handleAppError` |
| `src/server/provider-errors.ts` | Provider shape/status mapping, `Retry-After` parsing, safe logging behind a reference |
| `src/server/retry.ts` | Capped jittered delay, abortable sleep, the retrying provider fetch |
| `src/server/llm.ts` | Model calls made through `llm.ts` go through `createRetryingFetch`; the SDK's own retry is disabled. Exceptions are listed under Retries |
| `src/web/lib/api.ts` | `ApiError`, structured JSON parsing, safe network/abort failures, stream-error parsing |
| `src/web/lib/error-presentation.ts` | The one pure inline/page/action decision and the "Copy details" allowlist |
| `src/web/i18n/en/errors.ts` | All user-visible messages, hints, and actions |

`HTTPException` remains valid for simple route errors. `handleAppError` turns one into the same wire
shape; `AppError` is for anything that needs a taxonomy title, hint, retry rule, or reference. `QuotaError`
extends `AppError` so every write path answers `storage_quota` (413) without a special case.

## Taxonomy

| Code | Default status | Retryable | Where it comes from |
| --- | --- | --- | --- |
| `provider_auth` | 401 | no | 401/403, invalid key, Anthropic `authentication_error`, Google `UNAUTHENTICATED`/`PERMISSION_DENIED` |
| `provider_rate_limit` | 429 | yes | 429 unless the body names billing/credit; Google `RESOURCE_EXHAUSTED` |
| `provider_quota` | 402 | no | 402, `insufficient_quota`, billing/credit balance, hard limit |
| `model_not_found` | 404 | no | 404, `model_not_found`, unknown model/deployment messages |
| `context_length` | 400 | no | 400/413 with context/token/too-large text, `context_length_exceeded`, `request_too_large` |
| `provider_overloaded` | 503 | yes (transient 5xx only) | every 5xx, 529, `overloaded_error`, `server_error`, `UNAVAILABLE`; 501/507 and an out-of-memory, quota, context, or credentials body are non-retryable |
| `network` | 502 | yes | `fetch failed`, DNS, refused/reset connections, no HTTP status |
| `timeout` | 504 | yes | `TimeoutError`, `ETIMEDOUT`, deadline messages |
| `aborted` | 499 | no | `AbortError`, `ABORT_ERR`, a cancelled wait |
| `tool_failed` | 500 | no | a tool boundary failure that is not a provider failure |
| `service_unavailable` | 503 | yes | a required service (worker, sidecar) is down; raised by the registry's fail-fast guard, a worker 503 or unreachable worker in PDF export/creation, and the speech/sandbox clients, with a safe fix hint (`docs/implementation/service-health.md`) |
| `storage_quota` | 413 | no | `assertStorage` and every write path |
| `validation` | 400 | no | invalid input, unsupported file, model preconditions |
| `not_found` | 404 | no | deleted or missing owned row |
| `forbidden` | 403 | no | permission refusal, blocked outbound address |
| `conflict` | 409 | no | duplicate name, concurrent change |
| `rate_limited` | 429 | yes | a 429 from this server's own route, such as the speech concurrency cap. Provider 429s stay `provider_rate_limit` |
| `unknown` | 500 | no | anything no boundary identified; retry is still a manual action |

`ERROR_CODES` lists 18 codes. The table above matches it. If a feature adds a new one,
follow the rule at the end of this file.

## Mapping

`describeProviderError(error, { log, model, provider, kind })` is the provider boundary:

1. An existing `AppError` passes through.
2. Abort is checked first by `name`, `code`, and `reason`. A timeout is checked only when no HTTP status
   is present: a 401 whose message mentions "timeout" is still `provider_auth`.
3. The SDK's `RetryError` is unwrapped to its `lastError`.
4. `statusCode` (or `status` from native Ollama) selects the status table above. Every 5xx maps to
   `provider_overloaded` (or `timeout` for HTTP 408 and timeout text); only transient 5xx statuses are
   marked retryable. A non-transient 5xx (501, 507, ...) stays `provider_overloaded` with `retryable: false`.
5. For 400/413/422, the concatenated body type/code/status/message is matched for context length,
   model gone, auth, billing/quota, and overload, in that order. A 400 with no marker is `validation`.
6. With no status, `fetch failed`/DNS/connection errors become `network`; `TimeoutError` is `timeout`;
   native Ollama messages are recognized too ("Could not reach Ollama…" → `network`,
   "did not answer … in time" → `timeout`); a tool context uses `tool_failed`.
7. `retry-after` or `retry-after-ms` becomes `retryAfterMs` (seconds or HTTP date). Headers are read
   case-insensitively. A safe provider request id (`x-request-id`, OpenAI/Anthropic/Google variants)
   travels in the wire.

An out-of-memory body, an explicit quota/billing refusal, a context-window refusal, and rejected
credentials make a 5xx permanent even though its status is 5xx. They are never retried.

The wire is only `{ code, message, hint, retryable, retryAfterMs, ref, model, provider, requestId }`.
`details` holds the raw shape server-side only. `toWireError` truncates and redacts key-shaped strings as
defense in depth; `errorJson` always also sets `error` to the same safe message for older callers.

### Shapes covered

- OpenAI: `{ error: { message, type, code } }`; `invalid_api_key`, `insufficient_quota`,
  `model_not_found`, `context_length_exceeded`, `rate_limit_exceeded`.
- Anthropic: `{ type: "error", error: { type, message } }`; `authentication_error`, `permission_error`,
  `not_found_error`, `rate_limit_error`, `overloaded_error`, `request_too_large`.
- Google: `[{ error: { code, message, status } }]` or the object form; `INVALID_ARGUMENT`,
  `UNAUTHENTICATED`, `PERMISSION_DENIED`, `NOT_FOUND`, `RESOURCE_EXHAUSTED`, `UNAVAILABLE`,
  `DEADLINE_EXCEEDED`.
- Ollama: native `OllamaError` with `status` and a message; memory pressure is overloaded but not
  retried.
- Node `fetch`: `TypeError("fetch failed")` with a `cause.code` (`ENOTFOUND`, `ECONNREFUSED`,
  `ECONNRESET`, `ETIMEDOUT`, …).

## Retries

`createRetryingFetch` wraps the provider calls made through `llm.ts` (OpenAI, OpenAI-compatible, Anthropic,
Google, ChatGPT/Codex, and native Ollama `/api/chat`). Every `generateText`/`streamText` caller passes
`maxRetries: 0`, so the SDK never adds a second compounding policy. Two paths sit outside this rule:

- **Embeddings** (`src/server/knowledge/embeddings.ts`, OpenAI and Google) use their own `withRetry`, not
  `createRetryingFetch`. Four attempts by default, 500 ms base doubling to an 8 s cap, and no jitter. It
  retries 429, 5xx, and failures without a status. A provider `Retry-After` is used exactly, capped at 120 s
  (not the 30 s cutoff above).
- **Image APIs** (`src/server/tools/image.ts`, `generateImage` from the AI SDK) pass `maxRetries: 1`, so the
  SDK retries once, so a failed image call can bill a second time at most. Native Ollama keeps its own
transport, abort, `num_ctx`, thinking, and capability behavior; the retrying fetch is injected into
that connection for `/api/chat` only. Management calls (pull, delete, status, inventory) use the plain
transport, so a mutation is never retried.

- Three attempts total (two retries).
- Delay: 1 s, then 2 s, capped at 15 s, with ±20% jitter from `random()`.
- A provider `Retry-After` is used exactly. If it asks for more than 30 s, the request is **not** retried:
  the safe error with `retryAfterMs` is surfaced instead of retrying early.
- Only `provider_rate_limit`, `provider_overloaded`, `network`, and `timeout` are retried. Timeouts
  (`TimeoutError`, `ETIMEDOUT`, "timed out" messages, HTTP 408) retry with a `timeout` notice unless
  the **caller's** signal is already aborted, including an expired `AbortSignal.timeout()`. A 429
  whose body names quota/billing/credit is returned at once. Auth, validation, context length,
  model-not-found, aborted, storage, and permanent 4xx never retry. A 5xx whose body names OOM,
  quota, context, or credentials is permanent too.
- Abort cancels the wait immediately (`sleep` listens to the caller's signal). A request whose body is
  a stream is never retried. A `Request` carrying **any** body (even a string) is never retried,
  because sending it consumes the body; a plain URL plus a string `init.body` is replayable.
- A failed attempt's body is read through a bounded (16 KiB) tee only to decide whether the failure is
  permanent. The untouched branch becomes the returned `Response` on a terminal failure, so the SDK
  still sees the provider's own body and status. Cancel the inspected tee branch without awaiting it:
  that promise needs the kept branch to finish too, and awaiting it can deadlock an open response.
  Once response streaming has started, nothing retries,
  so emitted text and tool side effects cannot be duplicated.
- While a chat waits, the server writes a transient `data-retry` chunk with `attempt`, `delayMs`, and
  `code`. The client stores it per chat (`state/retry-status.ts`) and the thread footer shows
  "Retrying in Ns…". A `done` chunk, stream error, finish, or Stop clears it. The chunk is marked
  `transient`, so it is not stored with the message and never part of the prompt prefix. It **is**
  replayed by the 15-minute resumable stream (that is how an attached tab keeps the countdown); it is
  not in message history after the run.

### Limits

- Resumable stream replay is unchanged: 15 minutes after the last update. A server restart still loses
  an in-flight generation; reload recovery, not durable background storage.
- A non-JSON legacy server error still reaches the UI through its safe `{ error }` string only when the
  response is a 4xx authored message; 5xx and JSON/HTML/stack-shaped legacy bodies become
  "The request failed (HTTP n)." and never echo the body.
- A provider 401 is wire `provider_auth`; it never dispatches the client's `okaychat:unauthorized`
  event, which is reserved for the app's own untyped session 401.

## Boundaries and presentation

| Boundary | What is sent | Client rendering |
| --- | --- | --- |
| Top-level HTTP | `handleAppError` → `errorJson` | `ApiError` reads the structured fields; settings/upload rows show translated message + safe specific detail inline |
| Chat turn | `createUIMessageStream`/`toUIMessageStream` `onError` returns the wire JSON string | `ChatErrorMessage` parses it and shows Retry, Switch model, Open setting, Copy details |
| Tool result | `tool-output-error` carries the same wire JSON; a stream transform replaces raw strings, objects, and stacks with `tool_failed` (the model keeps the original tool error) | `ToolFallbackError` and `ToolShell` show the translated code message + hint, never a raw string or object |
| Background schedule | `last_error` stores the safe message | The Scheduled row shows it; raw details stay in the log |
| Render failure | none | `ErrorBoundary` shows Reload and Copy details on a full page |

`presentError(error, context)` is the only surface decision:

- `chat` → inline; Retry for every code except `aborted` (an automatic retry is limited to transient
  codes, but a manual retry is a valid next step for auth, validation, context length, and permanent
  failures too); Switch model for the `SWITCH_MODEL` set in `error-presentation.ts`: `provider_auth`,
  `provider_rate_limit`, `provider_quota`, `model_not_found`, `context_length`, `provider_overloaded`,
  `network`, `timeout`, `unknown`. Open setting for provider/auth/quota/model (`providers`), context
  (`compaction`), and storage (`account`); Copy details always.
- `tool` → inline message + hint, no actions.
- `settings`, `upload`, `background` → inline; a safe specific server detail is added only for
  validation/not-found/forbidden/conflict/storage/unknown.
- `render` → page with Reload and Copy details.

"Copy details" is an allowlist (`code`, `ref`, `model`, `provider`, `requestId`). It is not a
serialization: a poisoned wire object with `apiKey`, `prompt`, `file`, or `stack` contributes nothing.
The reference is also shown in the chat error block so support can match the server log.
`apiErrorFromBody` also resolves catalog text for coded failures, so settings callers that already
render `ApiError.message` get the same translated title. Safe authored field details remain available;
browser network/abort and HTTP fallback messages use the error catalog too.
assistant-ui projects SDK errors into plain `{ code, message }` objects; `parseChatError` decodes
the wire JSON inside `message` before accepting the outer generic code, preserving the actual
provider code, reference, and recovery actions for both early HTTP and streamed failures.

## Diagnostics

- Every provider failure that is logged gets an 8-character reference (`ref`) generated at the boundary.
  The browser shows it; the log line starts `[provider] ref=…`.
- The log records code, status, provider, model, request id, error name, and a truncated, redacted
  message and response body. It never records `requestBodyValues` or an API key. Temporary chats set
  `log: false`, as before. A provider's raw error body **can** quote the prompt or request fields, so the
  log is defense in depth, not a guarantee: `redactSecrets` removes `sk-` keys, Bearer/Basic tokens, and
  quoted or unquoted JSON/header keys (`apiKey`, `api_key`, `authorization`, `token`, `secret`,
  `password`, `x-api-key`, ...). Prompt text itself is not redacted, so treat the server log as sensitive.
- `handleAppError` generates the same reference for an unidentified 500 and logs only the redacted stack.
- The render boundary logs only the error's name, never its message or stack: a React error can carry
  prompt text or provider payloads.
- User-facing text never includes SQL, file paths, upstream JSON, or stacks.

## Adding a new error

1. Add the code to `ERROR_CODES` in `src/shared/errors.ts`.
2. Add its status, retryability, message/hint keys, and safe English fallback to `ERROR_CATALOG` in
   `src/server/errors.ts`.
3. Add the translated pair and any action to `src/web/i18n/en/errors.ts`; add it to `MESSAGES`/`HINTS`
   in `error-presentation.ts`.
4. Map it at one boundary only (provider status/shape, route, tool, or background). Do not wrap every
   function.
5. Decide retryability and, if it is transient, confirm the retry boundary can replay the request
   without duplicating output.
6. Add a fixture test for the shape, a presentation test for the code, and a leak check if the source
   can carry third-party text. Update this table.

## n8n agents

Agent errors agent_auth/agent_response/agent_failed use safe authored text, no automatic retries and Agents settings recovery. Agent upstream auth is HTTP 502, never application-session 401. agentReason is an allowlisted response reason and omitted from copied details. See [n8n agents](n8n-agents.md).
