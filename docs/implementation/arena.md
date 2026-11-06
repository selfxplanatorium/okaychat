# Arena foundation

Arena is not available in the application yet. This increment adds internal contracts and storage;
it does not register HTTP routes, provider execution, navigation, a public leaderboard, or UI.
Existing comparison and evaluations keep their own storage and execution paths.

## Implemented

- `src/shared/arena.ts` defines separate blind and revealed DTOs, lifecycle states, and limits.
- One append-only migration adds model identities, battles, two assignments, encrypted contents,
  immutable votes, a rating revision, and nullable usage linkage. No historical usage is backfilled
  or billed. `OKAYCHAT_TEST_FAIL_MIGRATION=arena` fails inside the migration transaction.
- `arena/models.ts` fingerprints resolved connection metadata without credentials, retains personal
  identities across label changes, checks public epoch collisions, parses strict bounded publication
  configuration, and samples a pair with `crypto.randomInt` plus a separate assignment bit.
  Publication parsing/registration is an internal primitive, not a configured active publication service.
- `arena/store.ts` reserves quota before content insertion, requires an admitted credit capability
  for a new battle, hashes normalized start input with a domain-separated HMAC, and retains mutation
  tombstones. Same-input replays return the original battle; changed inputs conflict.
- Owner projections allowlist A/B fields until an owned committed vote exists. Text and launch
  snapshots are encrypted. Empty answers use an empty column because the existing decrypt helper
  rejects ciphertext with an empty payload. No model reasoning is accepted by the storage API.
- Pane completion reads usage and cost from an owned reported credit receipt and its usage row,
  with matching battle/side context. It does not accept client-provided accounting. Unknown pricing
  remains a null cost even when the ledger contains zero. Without a matched reported receipt the
  pane fails and the battle cannot be voted on. No production executor can create these receipts yet.
- Voting inserts a ballot, transitions ready to voted, and increments revision in one synchronous
  transaction. Same-choice replay precedes live feature/expiry checks. Other choices conflict.
  Account deletion increments revision in the same transaction as the existing user cascade.
- Content discard and bounded expiry purge ciphertext and release the reservation without retracting
  a vote or removing assignment/idempotency metadata. Startup interrupts open battles after credit
  recovery and before listening. Content expiry is an internal bounded helper, not yet on a ticker.
- `arena/rating.ts` replays compact ballots in authoritative sequence order. Both ratings start at
  1000, K is always 32, ties and both-bad are relative draws, and pair updates use old ratings.
  Both-bad also increments its own counter. Ratings stay unrounded. Fewer than 20 battles is
  provisional; only non-provisional rows receive ordinal ranks. Stable ties use ASCII model keys.

## Integration gates still open

This foundation must remain unexposed until the following are implemented and tested together:

1. The account/exact-model Arena permission, live catalog/entitlement resolution, active public
   publication reconciliation, safe eligibility errors, and contextual/output policy limits.
2. Atomic two-slot/two-lease admission and two simultaneous `createModel` calls under one Arena
   credit root, both drains settled before root release, deadline/cancel/disconnect bounds, and
   no retries or redispatch on reads/replays. Extend the closed credit origin/kind/context registries
   and middleware settlement to populate the reserved usage linkage columns.
3. Mask every unrevealed Arena usage projection, including grouped summaries and Go windows,
   while leaving actual credit accounting unchanged. Do not enable paid execution before this gate.
4. Strict authenticated routes, bounded SSE, publication-aware compact ballot snapshots, rating
   worker/caches, revision invalidation, and aggregate-only anonymous public reads.
5. UI, navigation, keyboard commands, all six locale catalogs, safe image-free Markdown, responsive
   and reduced-motion handling, followed by real metered HTTP and Playwright acceptance.

The store currently takes the trusted caller's live account feature decision for voting; it does not
resolve that future feature itself. Reveal availability defaults conservatively to false pending live
catalog integration. Purged launch configuration is unavailable; retained registry identity, usage,
finish reason and cost remain. No admin or public content routes exist.

Unit fixtures cover storage and math, not provider concurrency, credit metering, transport privacy,
public read isolation or browser acceptance. Those remain release gates, not implied test coverage.
