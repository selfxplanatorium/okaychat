# Token credit accounting foundation

This is an internal foundation, not an enabled allowance feature. There are no credit HTTP routes,
admin controls, user balance cards, or production credit admission. `createModel` still uses its
existing signature. Do not configure finite accounts directly in SQLite: dispatch paths do not
currently enforce them. All migrated and newly created accounts are unlimited.

## Implemented

The append-only migration adds account counters, operation roots, per-invocation receipts and
administrator audit rows. Backfill starts one new manual period at migration time; historical
usage is retained with null credit linkage and never counted against that period. New accounts
create their unlimited row in the same transaction as the user. Reads/admission repair absent rows.
The migration failure seam is `OKAYCHAT_TEST_FAIL_MIGRATION=token-credits`.

`credits/store.ts` provides synchronous transactions on the existing single Node/SQLite writer:

- Finite admission rejects unknown usage, exhaustion, then a competing active root. Unlimited
  admission preserves concurrency. Capabilities use a private WeakMap, cannot be cloned, are bound
  to a payer/period, and stop working when their persisted root closes.
- Each request records identifiers only, bounded to 2 KiB, with bounded provider/model identifiers.
  Temporary roots reject thread identifiers. No transcript or credentials enter credit receipts.
- Settlement atomically finalizes an open receipt, increments counters and writes one linked usage
  row. Terminal callbacks are no-ops. Missing/invalid totals become unknown; valid zero is reported.
  Input plus output is the debit; cache and reasoning details are clamped subsets. Overflow fails
  closed in SQLite and rolls back. A receipt insertion/ledger failure leaves the root held.
- An admitted root may overshoot; the next finite operation is refused. Unknown finite usage blocks
  new dispatches and admission until an audited reset or clearing the allowance.
- Set/clear preserve consumed/unknown counters. Reset advances the manual period and requires an
  acknowledgement when forgiving unknown usage. Live administrator checks, version CAS, mutation
  idempotency, idle-root checks and audit insertion share a transaction. Same-value edits are no-ops.
- Closing a root is idempotent but refuses open requests. The caller must finish or cancel every
  child before closing; the store does not own asynchronous work.

`credits/model.ts` is an independently tested raw-adapter middleware, not yet installed in `llm.ts`.
It validates raw v4 usage without inventing missing totals, records each generate/stream invocation,
and persists stream finish usage before forwarding the finish. Cancellation/EOF without finish is
unknown; known HTTP rejection is free. A settlement persistence failure keeps the receipt open and
prevents cleanup from replacing known usage with unknown. Cancellation aborts the passed upstream
signal and cancels the reader. It does not buffer or tee output. Integration still needs aborts
without a consuming reader and ambiguous transport retry handling, together with root ownership.

`credits/recovery.ts` provides an explicit startup recovery operation. It converts open dispatched
requests to unknown, undispatched requests to free terminal receipts, then interrupts active roots,
atomically and repeatably. It is not invoked by production startup yet; once dispatch is integrated,
it must run before all other receipt recovery, workers and the listener. Never invoke it during live
traffic.

## Integration gate

Finite configuration must stay unexposed until all production model calls require a capability,
all aggregate usage writers become display-only, and each independent paid path admits a root.
This includes pre-history schedules, pre-SSE API calls, each evaluation case/judge, translations,
channel requesters, background memory, compaction, titles, research/delegates, temporary chat,
comparisons and local voice replies. Stream roots must outlive consumption and child cleanup, end
at approval waiting boundaries, and never be retained for subsequent input.

Unmetered work also needs root tracking while unlimited so configuration cannot race dispatch.
Finite embeddings, images/video generation, remote agents/tools, cloud speech and Realtime must
be refused at executors and approval replay. Local speech, keyword-only knowledge and existing
video downloads remain available. These executor restrictions are not implemented yet.

Remaining release work includes strict bounded/rate-limited session/admin routes, wire error
mappings, the finite-only balance card, CAS/reset/audit UI and all six locale catalogs, startup
integration, and the complete cross-entry-point acceptance matrix. Existing aggregate usage paths
remain unchanged during this internal phase. No allowance enforcement is claimed.

## Operating limits

Token allowances measure activity, not money or provider invoices. One bounded admitted operation
can substantially overshoot. Missing telemetry cannot be guessed or reconciled automatically.
Counters and audit/terminal receipt identities are retained for account lifetime and excluded from
storage quota. Deleting content never refunds consumption; deleting the account cascades its
credit rows, while deleting an audit actor clears only that actor reference. Retained usage may
outlive receipt detail, so its unique credit request linkage intentionally has no foreign key.

Back up and restore the database atomically with usage; never reconstruct counters from the
retained usage window. Terminal receipt retention grows the database. This design requires one
writer process; multi-process deployment needs writer serialization before reads.
