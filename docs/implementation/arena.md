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
no SDK retries, no tools/history/memory, a 120-second deadline and a 32 KiB output bound per pane.
Only reported matching receipt snapshots allow voting. The root and both leases survive until both
drains settle. Failures and missing telemetry make the pair unvoteable; Stop aborts both.

`arena/routes.ts` provides private no-store owner APIs for options, idempotent creation/mutation
lookup, reads, SSE attach, Stop, vote and content discard. Next is a fresh creation, never a retry.
The stream has one attachment, a 15-second attach/consumer deadline and a 64 KiB producer queue.
Stored snapshots pull in 8 KiB chunks; live frames contain side-only final text and safe state.
Disconnect aborts both calls. Reads never redispatch. Provider error prose is not forwarded or logged.

Credit origins/kinds/context allowlists include Arena. Middleware settlement alone writes usage with
battle/side linkage. Every session usage grouping and Go window excludes rows without an owned
committed vote; the response separately reports hidden dispatched request count/incomplete totals.
The actual credit counters stay unchanged. Failed, expired and discarded unvoted rows remain hidden.
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

The web surface is integrated in the following phase, with browser acceptance recorded separately.
Storage, rating, metered local-provider integration, credit/policy rejection, cancellation, duplicate
start/vote, public privacy and leaderboard filter/replay tests live under `server/arena/`.
No external service or runtime dependency is added.
