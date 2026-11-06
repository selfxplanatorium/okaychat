# Arena

Arena provides a separate blind, text-only, single-turn Battle boundary.
Existing comparison and evaluations keep their own storage and execution paths.

## Implemented

- `src/shared/arena.ts` defines separate blind and revealed DTOs, lifecycle states, and limits.
- One append-only migration adds model identities, battles, two assignments, encrypted contents,
  immutable votes, a rating revision, and nullable usage linkage. No historical usage is backfilled
  or billed. `OKAYCHAT_TEST_FAIL_MIGRATION=arena` fails inside the migration transaction.
- `arena/models.ts` fingerprints resolved connection metadata without credentials, retains personal
  identities across label changes, checks public epoch collisions, parses strict bounded publication
  configuration, and samples a pair with `crypto.randomInt` plus a separate assignment bit.
  Active publication reconciliation uses these primitives against shared connections.
- `arena/store.ts` reserves quota before content insertion, requires an admitted credit capability
  for a new battle, hashes normalized start input with a domain-separated HMAC, and retains mutation
  tombstones. Same-input replays return the original battle; changed inputs conflict.
- Owner projections allowlist A/B fields until an owned committed vote exists. Text and launch
  snapshots are encrypted. Empty answers use an empty column because the existing decrypt helper
  rejects ciphertext with an empty payload. No model reasoning is accepted by the storage API.
- Pane completion reads usage and cost from an owned reported credit receipt and its usage row,
  with matching battle/side context. It does not accept client-provided accounting. Unknown pricing
  remains a null cost even when the ledger contains zero. Without a matched reported receipt the
  pane fails and the battle cannot be voted on. The executor reads these snapshots after both provider streams settle.
- Voting inserts a ballot, transitions ready to voted, and increments revision in one synchronous
  transaction. Same-choice replay precedes live feature/expiry checks. Other choices conflict.
  Account deletion increments revision in the same transaction as the existing user cascade.
- Content discard and bounded expiry purge ciphertext and release the reservation without retracting
  a vote or removing assignment/idempotency metadata. Startup interrupts open battles after credit
  recovery and before listening. Content expiry runs in batches of 100 on a six-hour ticker.
- `arena/rating.ts` replays compact ballots in authoritative sequence order. Both ratings start at
  1000, K is always 32, ties and both-bad are relative draws, and pair updates use old ratings.
  Both-bad also increments its own counter. Ratings stay unrounded. Fewer than 20 battles is
  provisional; only non-provisional rows receive ordinal ranks. Stable ties use ASCII model keys.

## Execution and HTTP

`arena/worker.ts` admits two hard turn slots and two policy turn leases atomically, then one
`arena` credit root before saving content. Both `createModel` handles use that permit and live
account/exact-model/connection/entitlement guards. Their final-text streams run concurrently with
no SDK or HTTP transport retries (including unlimited accounts), no tools/history/memory, a 120-second deadline and a 32 KiB output bound per pane.
Only nonempty answers ending in a normal `stop`, with reported matching receipt snapshots, allow voting.
A `length` finish retains partial text and billing but fails the pair and cannot receive a new vote.
The vote-time check also refuses truncated panes saved as ready by older builds.
The root and both leases survive until both
drains settle. Failures and missing telemetry make the pair unvoteable; Stop aborts both.

`arena/routes.ts` provides private no-store owner APIs for options, idempotent creation/mutation
lookup, reads, SSE attach, Stop, vote and content discard. Next is a fresh creation, never a retry.
The stream has one attachment, a 15-second attach/consumer deadline and a 64 KiB producer queue.
Stored snapshots pull in 8 KiB chunks; live frames contain side-only final text and safe state.
Disconnect aborts both calls. Reads never redispatch. Provider error prose is not forwarded or logged.

Credit origins/kinds/context allowlists include Arena. Middleware settlement alone writes usage with
battle/side linkage. Every session usage grouping and Go window excludes rows without an owned
committed vote; the response separately reports hidden dispatched request count/incomplete totals.
Options also report finite-credit refusal states without allocating work. The actual credit counters stay unchanged. Failed, expired and discarded unvoted rows remain hidden.
Admin usage is outside the blindness boundary.

`OKAYCHAT_ARENA_PUBLIC_MODELS` is a JSON array of `{ref,label,epoch}` entries (at most 100).
Public mode is default-off. Every entry must resolve against a live shared connection. Invalid
configuration disables public mode without interrupting ordinary chat. An own connection override
cannot enter Public. An endpoint/model/format fingerprint change under the same epoch requires a
new epoch; rotating credentials does not. Publication reconciliation is bounded/coalesced and cached
for ten seconds. Removing either model excludes a whole ballot from current public replay.

`/api/public/arena/leaderboard` is anonymous, read-only and aggregate-only, before session auth;
Mine remains session-owned. A single numeric worker replays compact ballot snapshots in seq order;
30-day snapshots use UTC minute starts and reset the baseline inside that window. Revision checks,
two concurrent build slots, coalescing and a 100-entry LRU bound recomputation. Rank precedes
search/provisional filters and paging. No prompts, answers, endpoints or individual ballots enter a board.

The new `arena` permission defaults to allow through the existing registry semantics. Both account
and exact-model checks apply to starts, while only the account gate applies to new votes. Replayed
committed votes remain readable after expiry/revocation. Board viewing consumes no credits.

## Web and verification status

The lazy `/arena` workspace has Personal/Public setup, an eligible pool picker, final-text streaming
panes, immutable voting/reveal, clear-content review, Next and Mine/Global board controls.
`/arena/leaderboard` is a lazy standalone anonymous page and loads no session models/settings.
The sidebar entry is configurable with the existing sidebar settings. Commands live in the central
catalog; Alt+Shift+1/2/3/4 vote only when the enabled Arena controls are visible and never while
editing text, composing IME, repeating keys or in a modal. Next focuses setup without dispatch.

The client keeps only an account-scoped device mode and an opaque pending mutation id in localStorage.
It recovers uncertain starts by mutation lookup and retains the same choice while a vote is uncertain.
Leaving/unmounting aborts its stream. Failed loads are separate from empty boards; stale rows stay
labelled after a failed refresh. Safe Markdown uses an image-free renderer, including reference and
nested image syntax. Desktop panes scroll independently; mobile content/reveal scroll as one document,
with both panes mounted and the vote bar in flow/sticky at the bottom. Reduced-motion controls suppress
spinner movement. The Arena namespace is complete in all six shipped locales and in the RTL ratchet.

`test/acceptance/arena-fixture.mjs` runs an isolated compiled app with two local streaming models and
real SQLite/session/CSRF/catalog/credit paths. It prints a private temp directory; it does not expose a
production bypass. After building, run it on an unused loopback port, configure Tailscale Serve for that
port, then run `ARENA_FIXTURE_MANIFEST=<dir>/fixture.json ARENA_BASE_URL=<https URL with port>
node test/acceptance/arena.mjs`. The Playwright runner writes screenshots and its JSON result outside the
repository in the fixture directory. It checks concurrent finite-root dispatch, masking/reveal, immutable
votes/reload, Next, mobile/reduced-motion, public API isolation/ranks using authorized ballots, controlled
failure/Stop and all locales. Stop fixture processes and remove only their Serve ports after use.
Storage, rating, metered local-provider integration, credit/policy rejection, cancellation, duplicate
start/vote, public privacy and leaderboard filter/replay tests live under `server/arena/`.
No external service or runtime dependency is added.

## Limits

This is single-process, text-only preference data. Prompts/answers/individual ballots are never public.
Model self-identification, recognizable writing style and timing may suggest an identity; server/database
operators and deliberately modified clients are outside the metadata-blindness guarantee. Ratings are
self-selected and not calibrated intelligence, confidence intervals or certified opponent connectivity.
Known model upgrades require a new public epoch; mutable upstream aliases cannot be detected reliably.
No per-pane retry, vote editing, cross-instance registry, tools, attachments or chat promotion is added.

The anonymous limiter uses the transport socket address (60 reads/minute), never forwarded IP headers;
a reverse proxy may therefore share one bucket across its clients. Private reads are 120/minute and
mutations 20/minute per account. Deadline tests shorten only an in-process test seam, never an HTTP
parameter. The mock-model fixture and Playwright runner are test-only modules, not production routes.
