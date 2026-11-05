# External API access

A deliberately small, stateless, OpenAI-compatible text API at `/v1`. A credential belongs to exactly one
account and grants only enumerated scopes; it never becomes an application session. See the code under
`src/server/api-access/` and the shared contracts in `src/shared/api-access.ts`.

## Endpoints

| Route | Scope | Notes |
| --- | --- | --- |
| `GET /v1/models` | `models:read` | Eligible, currently permitted refs, sorted. `created: 0` because the catalog has no creation timestamp. |
| `POST /v1/chat/completions` | `chat:write` | Buffered JSON or SSE. |

`/v1/responses`, tools, function calling, files, images, audio, memory, retrieval, projects, skills,
schedules, history persistence, compaction, continuation, delegation, and generative UI are not
implemented. Unknown paths return JSON 404; wrong methods return 405 with `Allow`.

The router is mounted in `index.ts` outside the `/api` body limit and CSRF chain. Vite proxies `/v1`,
and the service worker never caches `/v1`.

## Credentials

`okc_api_v1_<selector>.<secret>`: 16-character canonical unpadded base64url selector (12 random bytes) and
43-character canonical secret (32 random bytes), 71 characters total. Only
`SHA-256('okaychat:external-api:v1:' + token)` is stored, as a 32-byte BLOB. Unknown selectors still run
a fixed-length `timingSafeEqual` against a dummy digest.

- The complete token appears once, in the `POST /api/api-keys` response and the created dialog. It is
  never re-readable, exported, logged, or included in audit.
- Labels are 1–80 code points, at most 320 UTF-8 bytes, without C0/C1 controls. Scopes are a nonempty
  unique subset of `models:read` and `chat:write`; neither implies the other.
- Expiry is optional, strictly future, and at most 366 days out at creation. Expired at
  `now >= expires_at`.
- 20 active keys and 200 retained rows per account. Rows become tombstones 30 days after going inactive;
  a full retained limit returns 409 until they are pruned.
- Revoke is permanent and idempotent. There is no edit, rotation, enable, or secret recovery.
- Password change and an administrator password reset revoke every key in the same transaction as the
  password/session update. Sign-out does not. Account deletion cascades keys and telemetry.

## Database and accounting

Migration after the team-channels tail creates `api_keys`, `api_rate_windows`, `api_requests`,
`api_key_audit`, `api_telemetry_floors`, and adds `usage.api_key_id` / `usage.api_request_id` with their
indexes.

- Key metadata reserves exactly 1 KiB per row through `storageUsedSql`. Requests, audit, rate windows,
  and usage rows are bounded operational metadata, like the other operational counters.
- A receipt is opened after admission and before `streamText`; `markApiDispatched` sets `running` right
  before the provider call. Settlement and the ledger insert happen in one synchronous `tx`, so duplicate
  callbacks and abort races are no-ops and a terminal result is never replaced.
- Usage kind is `api`; both ids are required and the unique `api_request_id` index dedupes. Provider usage
  that never arrived is recorded honestly as `unknown`, not estimated. Cost uses `costOf` and may be zero
  when the catalog has no price.
- Requests retain 30 days / 10,000 rows, audit 90 days / 1,000 rows, and minute windows the current and
  previous two minutes. Startup marks open receipts `interrupted`; nothing resumes. A 10-minute unref'd
  sweep prunes in bounded batches and raises `api_telemetry_floors` when a cap deletes detail rows.

## Authentication and limits

- Pre-auth gate: 120 attempts/minute per transport socket address and 2,000/minute per process, with a
  bounded 10,000-address map. Forwarded headers are never used for this gate.
- One `Authorization` header, case-insensitive `Bearer`, one ASCII space, exact token. Comma-combined
  values, Basic, query tokens, cookie-only requests, and malformed tokens share one 401 envelope and
  `WWW-Authenticate: Bearer realm="okaychat"`.
- Durable fixed UTC-minute rates: 60/key and 120/account, charged atomically after authentication and
  before scope/body validation. A rejected rate check increments neither bucket.
- Concurrency: 2/key, 4/account, 32/process, plus the shared `reserveTurn` account ceiling and the
  policy's `kind:'turn'` lease. Nothing is queued; a full slot is `429 concurrent_limit`.
- Catalog listing: 8 concurrent per process, 30 s deadline, 10,000 models / 2 MiB.
- A completion has 300 s total, 60 s to the first provider event, 60 s of provider inactivity, 16 MiB of
  provider bytes, 256 KiB per unframed record, 1 MiB of generated text plus hidden reasoning, 2 MiB of
  buffered completion, and 8 MiB of outgoing SSE. The provider transport is bounded by
  `responseBounds` in `llm.ts` and `response-bounds.ts`, which cancels the underlying reader.
- Body: 1 MiB, 10 s idle / 15 s total, fatal UTF-8, strict JSON (duplicate keys and depth >16 rejected),
  strict schemas. Message content 256 KiB each and 768 KiB total.
- Management: 4 KiB bodies, 120 reads and 20 mutations per account per minute.

## Prompt and request mapping

Only `GET /v1/models` and `POST /v1/chat/completions` exist. The completion path:

1. Resolve the model through `resolveModel`, rechecking all-model and exact-model `apiAccess`, the model
   policy, provider visibility, audience, and entitlements.
2. Resolve only the `apiSystem` prompt (admin layers). Chat prompts, data-safety text, personal
   instructions, memory, projects, and tools are never read. An `apiSystem` over 64 KiB fails 503.
3. Validate sampling: temperature only for models that advertise it, and on reasoning models only with
   an explicit `reasoning_effort: "none"`. Explicit effort requires `reasoning: true` and, unless the
   format is Anthropic's budget fallback, an advertised level.
4. Compute the output ceiling from the request/default, model maximum, policy, and the 32,768 hard cap;
   reject `context_length_exceeded` using `estimateTokens` plus a 1,024-token safety margin.
5. Admit, open the receipt, create the model with a guard and bounded transport, then call `streamText`
   once with `maxRetries: 0`, no tools, no `prepareStep`, and no continuation.
6. Read `fullStream` exactly once. Text is forwarded; reasoning is counted but hidden; files, tools, and
   media fail `unsupported_output`; a missing finish fails `incomplete_response`.

SSE sends a role chunk, text chunks (≤8 KiB UTF-8 pieces), a terminal choice, an optional usage chunk,
then exactly one `data: [DONE]`. After headers an error is one JSON data record and a close with no
finish chunk and no DONE. The body is pull-driven, so a slow consumer throttles the provider; a consumer
that stops pulling for 30 s aborts upstream. The role and terminal frames are serialized with
`JSON.stringify`.

## Permissions and recovery

`apiAccess` is a normal feature key (default true, no admin exemption). Creation requires the all-model
feature; listing/usage/audit/revoke stay available while it is disabled. Listing requires the all-model
feature and filters each model; completion requires both the all-model and exact-model feature. A broken
stored policy fails closed with 503 `invalid_policy`.

Live calls poll every second and also abort on the local revoke notification. They recheck the key's
liveness, both feature layers, the model policy, and a fingerprint of the selected connection. A
revocation or connection change aborts upstream; output already delivered cannot be retracted.

## Settings UI

Settings → API access (`/settings/api-access`, anchors `api-keys`, `api-usage`, `api-docs`) is a lazy
settings page. `useApiAccessData` keeps everything page-local; there is no zustand store, outbox, cache,
or startup fetch. The created token lives only in `ApiKeyCreatedDialog`. The page shows key cards,
create/revoke dialogs, usage with UTC days and request/audit pagination, and copyable curl examples
using the current origin. All text goes through `t()`; tables scroll locally with `data-no-drawer-swipe`.

## Operating notes and limits

- TLS is a deployment requirement for remote credentials; loopback test transport is allowed.
- A reverse proxy must forward `Authorization`, disable SSE buffering, redact credentials/query data, and
  permit 300-second streams.
- One Node process and one SQLite writer are supported. The rate limiter is not multi-process.
- A stolen active key grants its scopes until expiry/revoke and can spend shared-provider budget.
  Same-account keys are not isolated budgets.
- Providers receive the caller's messages and any admin `apiSystem` text. No app retention does not mean
  no upstream retention.
- A crash or disconnect can lose usage the provider already billed; local dedupe is not exactly-once
  upstream billing.
- The current catalog helpers do not accept an abort signal, so the 30 s catalog deadline races the
  promise rather than cancelling a vendor fetch. This is a known limitation.
- Live vendor compatibility is not established by the fake-provider tests; each wire format should get
  an owner-authorized smoke before release notes claim it.
