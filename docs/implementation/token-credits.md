# Token allowances

An administrator can give an account a manual token allowance. `credit_tokens` NULL is unlimited
(the default for every new and migrated account); an integer is the total allowance for the current
period, and zero is exhausted. Tokens measure activity, not money: one unit is one input or output
token, cached input and reasoning count once as part of those totals, and estimated cost stays a
separate display. There is no automatic refill, calendar period, or rollover: a period starts at
migration or account creation and advances only on an explicit audited Reset.

## Storage

The append-only `token-credits` migration adds `token_credit_accounts` (counters, period, CAS
`version`), `token_credit_roots` (one row per admitted operation), `token_credit_requests` (one
receipt per provider invocation, identifiers-only `context_json` ≤ 2 KiB), `token_credit_audit`,
and `usage.credit_request_id` (unique, no FK). It replaces the unique `usage_channel_run` index with a
non-unique one, because a channel reply may span several metered steps. Historical usage keeps a
NULL linkage and never counts against a period. Failure seam: `OKAYCHAT_TEST_FAIL_MIGRATION=token-credits`.

Counters, audit rows and terminal receipts are kept for the account's lifetime and are outside the
storage quota. Deleting content never refunds tokens; deleting the account cascades its credit rows;
deleting an administrator clears only `actor_id` in other accounts' audit. Back up and restore the
database atomically with `usage`; never rebuild counters from the retained usage window.

## Admission and the model boundary

`credits/store.ts` holds the synchronous transactions; `credits/admission.ts` the async lifecycle.

- `admitCreditRoot(userId, origin)` creates a root. A finite account is refused, in this order, for
  unreported usage (`token_credit_usage_unknown`), `consumed >= credit` (`token_credit_exhausted`),
  or any other active root (`token_credit_busy`, no queue). Unlimited roots are non-exclusive, so
  unlimited accounts keep their concurrency.
- The returned `CreditPermit` is a module-private capability (WeakMap), bound to payer, root and
  period, and dead once its row closes. It is never serialized or accepted from a client.
- `createModel()` requires `creditPermit` and `usageContext: { kind, threadId?, … }`; there is no
  optional fallback and no unguarded factory export. It installs `creditModelMiddleware` innermost,
  next to the raw adapter (including native Ollama and ChatGPT login transports).
- The middleware writes a receipt before each raw generate/stream invocation, marks it dispatched,
  captures raw `LanguageModelV4Usage` from the result or the stream's `finish` part before forwarding
  it, and settles exactly once: `reported` (debit = input + output), `rejected` (explicit HTTP
  400/401/403/404/413/422/429), `not_dispatched`, or `unknown` (timeout, disconnect, missing or
  invalid totals, partial stream). Settlement writes the receipt, the counter and the one usage row
  in one transaction. Aggregate `recordUsage` calls in chat, compaction, research, delegates, memory,
  translations, channels, API and evaluations were removed; their totals are display only.
- For finite accounts the provider fetch makes one attempt (no transport retry), because a retried
  ambiguous request could hide a second billable generation inside one receipt.
- `endCreditRoot()` aborts the root's signal, waits for every in-flight request to settle, then
  closes the row. A request that cannot settle keeps the root (and a finite account) busy until
  startup recovery. Any unknown in a finite period also stops new requests inside the admitted root.

Admitted operations may overshoot; the next one is refused. Usage summaries now count provider
invocations, so "Requests" includes background and per-step calls.

### Roots per entry point

| Path | Root |
| --- | --- |
| Stored, temporary and comparison chat, local voice reply (`/api/chat`) | `turnStream()` admits before compaction/research/dispatch; `creditOwnedStream` owns it until EOF or cancel. An abort reaches the turn through the root signal; a consumer that stops pulling is cut off after 15 s. Temporary usage keeps no thread id. Approval or browser-tool waits end the stream and the root; a continuation is admitted again. |
| Compaction, research, delegates | Children of the turn's permit. Standalone compaction admits its own root. |
| Titles | An optional root of their own; busy or exhausted keeps the fallback title. |
| Schedules | Admitted before any thread or prompt is written; a refusal is a skipped occurrence with the next one calculated normally. |
| `/v1` | Admitted after validation, before the receipt and SSE headers; refusals are JSON (`permission_error`, busy is `rate_limit_error` 409). |
| Channel AI | Requester pays; admitted at worker dispatch after the membership/binding checks. |
| Memory | One root per review or summary job, admitted only when the model is needed. A refused review is left for a later tick, and accounts that are spent or held are excluded from the tick query. |
| Translations | One root per generated translation; cached reads are free. |
| Evaluations | One root per case attempt (a rate-limit retry is a new root) and per judge call. Finite accounts run at concurrency 1 (the requested value stays in the run). A refusal skips the remaining cases with the credit code. |

## Unpriced services

Images, new video submissions and retries, outside agents (n8n), cloud speech engines, OpenAI
Realtime, MCP tool/resource/prompt calls, custom HTTP tools, and remote embeddings have no token
telemetry. For finite accounts they are refused with `token_credit_unmetered` at the executor
(including replayed approvals and queued video jobs, which fail as `credentials_changed` before
submission), and MCP/image/video tools are not offered in finite turns. Knowledge retrieval surfaces
the refusal instead of silently degrading to keyword search; the remedy is a keyword-only collection.

While the account is unlimited, each such call holds a non-exclusive `unmetered` root for its remote
lifetime (a Realtime session holds one until the call ends), so an administrator cannot set or reset
an allowance while unpriced work is in flight. Local Whisper/Piper, sandbox Python, keyword-only
knowledge, and polling/downloading already submitted videos stay available.

## Routes

`credits/routes.ts`, all `Cache-Control: no-store`, reads 120/min and mutations 20/min per account:

- `GET /api/credits`: the session account's `TokenCreditBalance`, readable without any model or
  feature permission.
- `GET|PATCH /api/admin/users/:id/credits`, `POST …/credits/reset`, `GET …/credits/audit?before&limit`:
  live admin role, strict ≤ 4 KiB bodies (unknown keys 400; `creditTokens: null` clears, omission is
  invalid), version CAS (`conflict` 409), any active root (`token_credit_busy` 409), idempotent
  `mutationId` replay, reason required. Same-value edits are no-ops without audit. Reset keeps the
  allowance, zeroes used/unknown, advances the period, and needs `acknowledgeUnknown` when forgiving
  unreported usage.
- `GET /api/admin/users` adds `tokenCredits` from one indexed pass.

Credits are never written by `PATCH /settings`, `/v1`, or the permissions workspace.

## Web

`TokenCreditBalanceCard` (Usage and Account) renders only for finite accounts: exact remaining,
used, allowance, period start, manual reset, overshoot, the active-operation note, and "Balance
incomplete" with reported figures when usage is unknown. It fetches on mount and focus and polls
every 15 s only while visible with an active operation; a failed load shows Retry, never zero or
unlimited. `TokenCreditAdminDialog` (Admin → Users, gauge button) shows the snapshot, the
restrictions above, set/clear with reason, a separate Reset confirmation, and the cursor-paged audit;
conflicts keep the administrator's draft. Strings are in the `credits` namespace in all six locales;
the four error codes map to identical copy in `errors` and recover through Usage/contact admin.

## Startup and limits

`recoverCreditOperations()` runs in `index.ts` before the listener and every other recovery: open
dispatched requests become unknown, undispatched ones `not_dispatched`, active roots `interrupted`.
It is idempotent. A crash after the dispatch marker conservatively holds a finite account until an
administrator resets it.

This is a soft allowance: one admitted operation (research, delegates, tool loops) can exceed the
remaining balance substantially, provider telemetry can be missing or wrong, and token totals do not
track dollars, images, audio, or third-party tool costs. There is no reconciliation of unknown usage,
no server default allowance, and no multi-process writer support.

Deferred: exposing the effective evaluation concurrency in the run view, hiding custom HTTP tools (they
are refused at execution), titles as children of a still-open turn root, and API/channel terminal
receipts sharing the settlement transaction.
