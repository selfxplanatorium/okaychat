# Outgoing webhooks

Private, per-account HTTPS endpoints receive a curated event projection. There are no shared or
administrator-owned endpoints, no model tools, and no inbound callbacks. Configuration writes never
contact a destination. Delivery uses a durable SQLite outbox and one bounded in-process worker in the
application process (this repository already requires one writer).

## Contract and semantics

Contract: **bounded at-least-once attempts for admitted deliveries**. It is not guaranteed arrival and
not exactly-once side effects. An HTTP timeout, a dropped connection, or process death after a receiver
accepted a request can duplicate it. Receivers must deduplicate by `deliveryId` for at least seven days.
Failed or expired deliveries and admission drops are visible in Settings. An event rejected at
admission is not replayable. SQLite corruption, a restored backup, and bytes already sent cannot be
recalled by this feature. Source generation work itself does not resume after a restart.

The wire envelope is defined in `src/shared/outgoing-webhooks.ts`:

```json
{
  "specVersion": 1,
  "eventId": "whe_…",
  "deliveryId": "whd_…",
  "sequence": "12",
  "occurredAt": 1700000000000,
  "type": "chat.turn.completed",
  "data": { "threadId": "…", "runId": "…", "assistantMessageId": "…", "finishReason": "stop" }
}
```

`eventId` is `whe_` plus SHA-256 of `[1, accountId, sourceKey]`, so the same source event to two
endpoints shares one event id. `deliveryId` is `whd_` plus SHA-256 of `[1, eventId, endpointId]`.
`sequence` is the endpoint's monotonically allocated integer, allocated in SQLite and rendered as a
decimal string; JavaScript never performs arithmetic above the safe integer range. Retries reuse the
same body bytes, event id, delivery id, occurrence time, and sequence. Only the timestamp, signature,
and attempt header change. A configuration revision changes identity of future admissions, never an
already-stored delivery.

There is no global ordering promise. Automatic first attempts preserve endpoint sequence order, and a
delivery waiting in backoff does not block later events. Retries and manual retries may arrive late.
Receivers must tolerate gaps. For room reconciliation, `messageSequence` is the original room position
(unchanged by edits) and `revision` decides which version of one message is newer.

## Events and source rules

| Event | Source identity | Notes |
| --- | --- | --- |
| `chat.turn.completed` | first `generation_runs` transition to `finished`; `turn:<runId>` | Interactive durable LLM turns only. `length` and content-filter count; tool calls/waiting do not. Includes approval resumptions. Explicit Continue is a new run. |
| `chat.turn.failed` | `turn:<runId>` | Only `generation_error` or startup `interrupted`. Cancellation is silent. |
| `schedule.run.completed` | reply + terminal status transaction; `schedule:<invocationId>` | Requires a nonempty response and successful logical finish, including external agent targets. |
| `schedule.run.failed` | same transaction as the terminal failure; same invocation | `empty_response`, `timeout`, `run_error`, or startup `interrupted`. No prompt or partial answer. |
| `channel.message.created` | human insert; or successful assistant settlement | Assistant placeholders/checkpoints and failed/cancelled/interrupted replies emit nothing. |
| `channel.message.edited` | successful human revision CAS | New text only. Older unsent text copies for that message are cancelled and scrubbed. |
| `channel.message.deleted` | tombstone; each affected message | Metadata only; includes cascade-tombstoned human thread replies at their incremented revision. |
| `channel.mention` | human insert | Only a structured mention of the room owner by another author, one per message. No edit-added mentions. |
| `archive.export.finished` | export preparing→ready or active→failed | Ready means prepared, not downloaded. `chatCount` is the selected count on success, zero on failure. |
| `archive.import.finished` | chats + job done commit, or active→failed | Review-ready is not completion. Quota refusal back to ready, cancellation, and expiry are silent. |

Temporary chats, comparison panes, API-access generations, delegates/research workers, utility calls,
background memory, and historical imports emit nothing. Local voice using the regular durable turn
qualifies. Chats whose target is an external agent use a separate terminal ledger, so they do not emit
interactive chat events in this cycle; their scheduled runs are still covered by schedule events.

All source context is explicit server context: `turnOrigin` is stored in the generation receipt config
and falls back to no event for legacy receipts. Source keys never include the outcome, so one reply
cannot emit both completed and failed. A repeated terminal write is ignored.

### Text opt-in

`includeMessageText` defaults false. When on, it covers only completed chat/scheduled visible answer
text and human/terminal assistant room create/edit/mention text. It never includes prompts, user
messages, reasoning, tool inputs/results, usage, context, files, artifacts, archives, models, titles, or
error prose. Text is the actual text parts joined with `\n`, bounded to 8,192 UTF-8 bytes without
splitting a code point; `truncated` is true past that. Text remains untrusted display data and is never
executed. Turning text off cancels old-revision work; its stored bodies are hidden immediately and
scrubbed by maintenance.

## Endpoints and permissions

Limits: 10 endpoints/account, 1,000 endpoints/process (disabled included), name 1–80 characters, URL at
most 2,048 bytes. Only `https` on port 443, no credentials, no fragment, no localhost/reserved name, and
no obviously private literal address. Saving performs no DNS or network call; every send validates and
pins addresses through `publicFetch`, including admin-triggered tests. Admins get no private-network
bypass.

URL and custom headers are stored together (AES-256-GCM) in `config_enc`; the HMAC signing secret is
stored separately encrypted. The owner's detail returns the saved URL and header **names**, never header
values or the secret. Lists return a parsed hostname only. A secret is shown once in the create/rotate
response (`Cache-Control: private, no-store`); losing it requires rotation. Rotation disables the
endpoint, cancels unsent work, and starts a clean key cut with no dual-key overlap.

Custom headers: at most 8 case-insensitive distinct ASCII token names, values 1–2,048 bytes and 4,096
combined. CR/LF/NUL and other controls are refused. `host`, `connection`, `content-length`,
`transfer-encoding`, `content-type`, `accept`, `accept-encoding`, `cookie`, `set-cookie`, `origin`,
`referer`, `user-agent`, `expect`, `trailer`, `te`, `upgrade`, `proxy-*`, `sec-*`, `forwarded`,
`x-forwarded-*`, `idempotency-key`, and `x-okaychat-*` are server-owned. `Authorization` and private API
key headers are allowed. A URL change requires a complete `replaceHeaders` set; an unchanged URL uses
`headerChanges` to keep/update/remove values. These rules stop a hijacked session from silently
forwarding an existing credential to another origin.

The all-model feature `outgoingWebhooks` defaults true and has no dependency on web tools or models.
Management create/update/rotate/test/retry require it; read/list/delete/disable/clear-logs remain
available for cleanup when it is denied. Channel events also require `channels`, schedule events
`schedules`. No model policy is borrowed as permission to send. Shared-knowledge restrictions are
rechecked at admission and dispatch; restricted chat/schedule payloads are suppressed entirely.

## Signing and transport

```text
Content-Type: application/json
Accept: application/json
User-Agent: okaychat-webhooks/1
Idempotency-Key: <deliveryId>
X-Okaychat-Event-Id: <eventId>
X-Okaychat-Delivery-Id: <deliveryId>
X-Okaychat-Attempt: <1..10>
X-Okaychat-Key-Id: <keyId>
X-Okaychat-Timestamp: <integer Unix seconds>
X-Okaychat-Signature: v1=<64 lowercase hex>
```

Signature input is UTF-8(`timestamp + '.' + deliveryId + '.'`) concatenated with the exact stored body
bytes. HMAC-SHA256 uses the UTF-8 bytes of the **entire secret string** (including the `okc_wh_v1_`
prefix), not a decoded suffix.

Receiver procedure:

1. Look up the current key by `X-Okaychat-Key-Id`; reject an unknown id.
2. Reject a timestamp outside ±300 seconds.
3. Compute the HMAC over the raw request bytes exactly as above and compare with a constant-time
   comparison.
4. Atomically deduplicate the delivery id before performing side effects. Authentication precedes
   dedupe. A valid replay inside five minutes still needs dedupe; the timestamp alone does not prevent it.
5. Sender clocks must be synchronized.

Worked vector (also in `outgoing-webhooks.test.ts`):

```text
secret:      okc_wh_v1_testsecret
timestamp:   1700000000
deliveryId:  whd_vector
body:        {"specVersion":1,"eventId":"whe_vector","deliveryId":"whd_vector","sequence":"7","occurredAt":1700000000000,"type":"webhook.test","data":{"testId":"wht_vector","sample":true}}
signature:   709e0bbb6588a6672cc6f61c6816ece514c8d1bc4d61175ae84e0c9cc560e09a
```

One attempt is one `publicFetch(url, { method: "POST", headers, body, redirect: "manual", signal })`
under a 10-second whole-attempt deadline. `publicFetch` validates DNS at connection time, pins the
checked addresses, and refuses private/loopback/link-local/tailnet ranges. A 3xx fails permanently and
its `Location` is never inspected. 2xx succeeds on headers. Every response body is cancelled without
being read; no response headers, text, `Retry-After`, or cookies are stored or shown. Errors map to the
sanitized delivery error codes, never to `error.message`.

## Delivery lifecycle, limits, retention

States: `queued → sending → succeeded | backoff | dead`; policy/config removal yields `cancelled`.
Prepared tests live in a separate table.

- One active request per endpoint, 2 per account, 16 per process. A pump selects at most 64 eligible
  rows, one per account per round, in due-time/sequence order.
- The attempt count and attempt log increment durably before the network call. A claimed attempt that
  dies still counts. Settlement requires the same row version, attempt number, and endpoint revision.
- Automatic budget: 6 total attempts. Retry only network/DNS/timeouts and HTTP 408/425/429/500–599.
  Delay before retry n is uniform in `[floor(B/2), B]`, `B = min(900000, 30000 * 2^(n-1))`, persisted
  once. `Retry-After` is ignored. No automatic retry for tests or any 2xx.
- Manual retry is one additional attempt for a `dead` delivery, never a new automatic budget. It needs
  the endpoint enabled at the original revision, live source access, age under 24 hours, fewer than 10
  attempts, and a version CAS. The body and ids are reused; current source text is not regenerated.
- At 24 hours every nonterminal row becomes dead `expired`; an active request is aborted. On restart a
  `sending` row with attempts left becomes `backoff` due at startup + 30 s (outcome uncertain); an
  exhausted/expired row becomes dead. Attempt counts are never reset. A test becomes dead, never retried.
- Endpoint stats keep the last production attempt (time/status/HTTP code/duration/delivery id),
  cumulative failed attempts, the consecutive failure streak, and the automatic-disable time. Ten
  consecutive failed attempts auto-disable the endpoint, bump its revision, and cancel remaining work.
  Success resets the streak. Tests update their own log only.
- Admission caps: 100 active rows/endpoint, 500/account, 10,000/process; 300 production deliveries per
  account per UTC minute. Dispatch: 30/endpoint/minute and 120/account/minute, persisted fixed windows.
  If either window is full the row stays queued without spending an attempt or the other window.
  Throttled admissions increment the endpoint's drop counter with `quota|capacity|rate|projection`.
- Every admitted delivery reserves 32,768 bytes through `assertStorage`; a body ≤12 KiB plus at most 10
  bounded attempts fits. Only unconsumed test preparations are charged separately. Endpoints charge
  encrypted config/secret/name bytes plus a fixed 2 KiB for stats. A drop never fails the source action.
- Retention: rows for 7 days; bodies cleared at 24 hours; at most 1,000 terminal and 100 dead rows per
  account and 100,000 delivery rows/process. Active rows are never evicted for space. Maintenance runs
  every 60 s and aborts an expired active request before marking it dead; old rate windows and prepared
  tests are removed.
- A revision change (name, URL, headers, subscription, room scope, text switch, enabled, rotation) cancels
  queued/backoff rows, aborts active sends, invalidates unused tests, clears the failure streak, and starts
  future admissions at the new revision. Re-enabling never replays missed events. Already-sent data cannot
  be recalled.

## Storage

Migration `outgoing-webhooks` appends four tables and two `schedules` columns. `config_enc` plaintext is
`{url, headers}`. Delivery source ids deliberately have no foreign keys: deleting a source must cancel or
scrub exports, not recreate the source or block cleanup. Endpoint and delivery reservations are part of
`storageUsedSql`; see `docs/implementation/storage-quota.md`.

Startup order in `index.ts`: source reconciliation (`interruptOpenRuns`, archive reset, schedule
invocation recovery) → worker start → maintenance. The worker recovers interrupted `sending` rows before
its first claim.

## Settings and API

Settings → Webhooks is a lazy section. The list shows name, hostname, enabled/auto-disabled state,
pending/dead/drop counters, and the last production delivery. The editor keeps URL/header drafts in
component memory only; the signing secret is displayed once and never restored. A test is Save → Prepare
preview → Send. Polling exists only while the log is mounted (2 s with active rows, 15 s otherwise),
paused when hidden, one request in flight, and discarded on account change.

API under authenticated `/api/webhooks`: list/create/detail/patch/delete, `rotate-secret`,
`test/prepare`, `test/send`, delivery list/detail/retry, and terminal-log deletion. Bodies are capped at
16 KiB, responses are private/no-store, reads never contact a destination, and management writes are
limited to 60/account/minute (tests 5/account/minute, one outstanding preparation or active test). The
admin endpoint `GET /api/admin/webhooks` exposes counts and states only, and
`POST /api/admin/webhooks/:id/disable` records the reason in the existing permission audit. No admin
test, resend, enable, or secret retrieval exists.

## Operating recovery

- Original `okaychat.db` and `OKAYCHAT_SECRET` are required to decrypt pending work. Losing the key means
  disabling/recreating endpoints, not guessing credentials.
- A receiver should keep delivery-id dedupe history beyond 7 days when it restores an older backup, since
  a server restore may replay old accepted deliveries.
- In-flight requests can complete remotely after local disable, rotation, revocation, or shutdown.
- Drop counters are lifetime per endpoint and are not cleared by log deletion.
- There is no history backfill, replay after a revision change, bulk retry, member-room/DM export, channel
  attachment/reaction/typing event, edit-added mention, custom signing algorithm, dual-key grace,
  endpoint verification challenge, payload template, model/tool event, archive download event, public
  replay API, response inspector, broker, notification kind, or environment secret configuration.
