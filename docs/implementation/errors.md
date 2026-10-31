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
| `src/server/llm.ts` | Every model provider call goes through `createRetryingFetch`; the SDK's own retry is disabled |
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
| `provider_overloaded` | 503 | yes | 5xx, 529, `overloaded_error`, `server_error`, `UNAVAILABLE`; an out-of-memory body is non-retryable |
| `network` | 502 | yes | `fetch failed`, DNS, refused/reset connections, no HTTP status |
| `timeout` | 504 | yes | `TimeoutError`, `ETIMEDOUT`, deadline messages |
| `aborted` | 499 | no | `AbortError`, `ABORT_ERR`, a cancelled wait |
| `tool_failed` | 500 | no | a tool boundary failure that is not a provider failure |
| `service_unavailable` | 503 | yes | a required service (worker, sidecar) is down |
| `storage_quota` | 413 | no | `assertStorage` and every write path |
| `validation` | 400 | no | invalid input, unsupported file, model preconditions |
| `not_found` | 404 | no | deleted or missing owned row |
| `forbidden` | 403 | no | permission refusal, blocked outbound address |
| `conflict` | 409 | no | duplicate name, concurrent change, route-level "too many attempts" |
| `unknown` | 500 | no | anything no boundary identified; retry is still a manual action |

The brief lists 17 codes in total; `ERROR_CODES` contains exactly that list. If a feature adds a new one,
follow the rule at the end of this file.

## Mapping

`describeProviderError(error, { log, model, provider, kind })` is the provider boundary:

1. An existing `AppError` passes through.
2. Abort and timeout are checked by `name`, `code`, and message before HTTP status.
3. The SDK's `RetryError` is unwrapped to its `lastError`.
4. `statusCode` (or `status` from native Ollama) selects the status table above.
5. For 400/413/422, the concatenated body type/code/status/message is matched for context length,
   model gone, auth, billing/quota, and overload, in that order. A 400 with no marker is `validation`.
6. With no status, `fetch failed`/DNS/connection errors become `network`; `TimeoutError` is `timeout`;
   a tool context uses `tool_failed`.
7. `retry-after` or `retry-after-ms` becomes `retryAfterMs` (seconds or HTTP date). Headers are read
   case-insensitively. A safe provider request id (`x-request-id`, OpenAI/Anthropic/Google variants)
   travels in the wire.

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

`createRetryingFetch` wraps every provider call in `llm.ts` (OpenAI, OpenAI-compatible, Anthropic,
Google, ChatGPT/Codex). Every `generateText`/`streamText` caller passes `maxRetries: 0`, so the SDK never
adds a second compounding policy.

- Three attempts total (two retries).
- Delay: 1 s, then 2 s, capped at 15 s, with ±20% jitter from `random()`.
- A provider `Retry-After` is used exactly. If it asks for more than 30 s, the request is **not** retried:
  the safe error with `retryAfterMs` is surfaced instead of retrying early. The same applies when the
  header is the only way to respect it.
- Only `provider_rate_limit`, `provider_overloaded`, `network`, and `timeout` are retried. A 429 whose
  body names quota/billing/credit is returned at once. Auth, validation, context length, model-not-found,
  aborted, storage, and permanent 4xx never retry.
- Abort cancels the wait immediately (`sleep` listens to the caller's signal). A request whose body is a
  stream, or whose `Request` body was already used, is never retried.
- A failed attempt's response body is discarded before the next attempt. Once response streaming has
  started, nothing retries, so emitted text and tool side effects cannot be duplicated.
- While a chat waits, the server writes a transient `data-retry` chunk with `attempt`, `delayMs`, and
  `code`. The client stores it per chat (`state/retry-status.ts`), the thread footer shows
  "Retrying in Ns…", and a `done` chunk, stream error, finish, or Stop clears it. The chunk is transient:
  it is not stored, not replayed, and not part of the prompt prefix.

### Limits

- Native Ollama chat requests are not wrapped by `createRetryingFetch`; its adapter keeps its own
  transport, abort, `num_ctx`, thinking, and capability behavior. A daemon 5xx or network failure is
  mapped by the same taxonomy at the chat boundary but is not retried a second time.
- Resumable stream replay is unchanged: 15 minutes after the last update. A server restart still loses
  an in-flight generation; reload recovery, not durable background storage.
- A non-JSON legacy server error still reaches the UI through its safe `{ error }` string. Unknown shapes
  become "The request failed (HTTP n)." and never echo the body.

## Boundaries and presentation

| Boundary | What is sent | Client rendering |
| --- | --- | --- |
| Top-level HTTP | `handleAppError` → `errorJson` | `ApiError` reads the structured fields; settings/upload rows show translated message + safe specific detail inline |
| Chat turn | `createUIMessageStream`/`toUIMessageStream` `onError` returns the wire JSON string | `ChatErrorMessage` parses it and shows Retry, Switch model, Open setting, Copy details |
| Tool result | `tool-output-error` carries the same wire JSON; tool errors that never had a code fall back to `tool_failed` | `ToolFallbackError` and `ToolShell` show message + hint, never a raw object |
| Background schedule | `last_error` stores the safe message | The Scheduled row shows it; raw details stay in the log |
| Render failure | none | `ErrorBoundary` shows Reload and Copy details on a full page |

`presentError(error, context)` is the only surface decision:

- `chat` → inline; Retry only when `retryable`; Switch model for provider/network/timeout/unknown
  failures; Open setting for provider/auth/quota/model (`providers`), context (`compaction`), and
  storage (`account`); Copy details always.
- `tool` → inline message + hint, no actions.
- `settings`, `upload`, `background` → inline; a safe specific server detail is added only for
  validation/not-found/forbidden/conflict/storage/unknown.
- `render` → page with Reload and Copy details.

"Copy details" is an allowlist (`code`, `ref`, `model`, `provider`, `requestId`). It is not a
serialization: a poisoned wire object with `apiKey`, `prompt`, `file`, or `stack` contributes nothing.
The reference is also shown in the chat error block so support can match the server log.

## Diagnostics

- Every provider failure that is logged gets an 8-character reference (`ref`) generated at the boundary.
  The browser shows it; the log line starts `[provider] ref=…`.
- The log records code, status, provider, model, request id, error name, and truncated/redacted message
  and response body. It never records `requestBodyValues`, an API key, or a prompt. Temporary chats set
  `log: false`, as before.
- `handleAppError` generates the same reference for an unidentified 500 and logs only the redacted stack.
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
