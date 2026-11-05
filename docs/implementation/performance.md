# Performance

This file records the measured server-side performance changes and the budgets they were checked
against. It is deliberately narrow: it documents what shipped and what is still unmeasured. Re-run the
SQL microbenchmarks with `npm run perf:sql`; the script is synthetic, never imports app modules, and
never opens the application database.

## What shipped

### Search indexing (migration 36)

The old `messages_fts_*` triggers found a message's FTS row by scanning the virtual table's two
`UNINDEXED` metadata columns (`thread_id`, `message_id`). That made every UPDATE and DELETE of a message
corpus-linear. The new shape:

- `message_search_keys` maps `(thread_id, message_id)` to an explicit `INTEGER PRIMARY KEY AUTOINCREMENT`
  `search_id`. The explicit integer key survives `VACUUM`; `messages.rowid` cannot be used because the
  table has a composite TEXT primary key.
- The FTS table keeps its columns, tokenizer, ranking, and snippet behaviour. Each FTS row is inserted at
  `rowid = search_id`, so delete and update address it in one indexed equality lookup.
- The update trigger only fires when the content blob and the extracted text both change
  (`old.content IS NOT new.content AND <old text> IS NOT <new text>`). A metadata-only write or a resend
  with the same text does no inverted-index work.
- The delete trigger is `BEFORE DELETE` and removes the FTS row by key before the key row itself is
  cascaded away. Thread and account deletions cascade through the same trigger.
- On migration the keys are populated in deterministic `(thread_id, created_at, id)` order and the FTS
  table is rebuilt inside the same transaction.

`appendMessage` also treats a resend of the identical `(content, parent_id, format)` as a no-op: after
the edited-reply guard and after `normalizeImages` has charged or mapped genuinely new bytes, it returns
the stored content without an UPSERT, search-index write, or `threads.updated_at` bump. A metadata-only
change still updates the row; the trigger suppresses the text work.

### Selected-connection model resolution

`resolveModel` no longer calls `listModels`, which enumerates every enabled connection and can wait on
an unrelated cold custom `/models` endpoint (8 s timeout). It resolves models for the selected connection
only, through the same helper `listModels` uses. Live audience and model-policy checks still run on the
same request, `createModel` keeps its independent entitlement recheck, and nothing is cached across
accounts or requests.

The models.dev catalog loads from disk in a single flight across concurrent cold callers, keeps the
network refresh separate and single-flight, and backs off failed background refreshes at 5 s, 15 s,
60 s, then 5 minutes (reset on success). The stale catalog stays usable. Generic live `/models` caches
keep their 15-minute TTL and are now an LRU bounded to 256 settled entries; in-flight requests are not
evictable, and connection mutation clears obsolete entries.

### History reads

- `messages_thread_time` on `messages(thread_id, created_at)` serves the history query's
  `ORDER BY created_at, rowid` without a temporary B-tree. `rowid` remains the tie-breaker; message ids
  are never used for ordering.
- `listThreads` selects explicit summary columns, not `t.*`, so a long chat's `compaction_json` is not
  read or shipped to the sidebar. Only `getThread` selects and parses it.
- History ownership uses `SELECT 1 FROM threads WHERE user_id = ? AND id = ?` instead of parsing the
  summary and compaction state. Missing and foreign threads still answer `[]`.
- `ancestry` walks parent links into an array and reverses once; `createsCycle` skips the walk when the
  stored parent is unchanged, rejects a direct self-parent immediately, and otherwise uses one recursive
  CTE scoped to the thread with `UNION` to terminate a pre-existing cycle.
- `listMessagesJson` still splices stored JSON; it does not parse and re-serialize message bodies.

### Web

- Liberation `@font-face` declarations use `font-display: swap`, so a slow local font file cannot hide
  text at startup.
- The service worker keeps shell and hashed assets in separate caches and bounds the asset cache to 256
  entries, pruned FIFO through `cache.keys()` on writes in `event.waitUntil`. Cache writes are
  best-effort: a quota failure returns the network response. Activation only deletes this app's
  `okaychat-*` caches. A successful same-origin HTML navigation refreshes the cached `/` shell; `/api/*`
  is still never cached.

## Measurements

Node v26.13.0, Linux x64, AMD Ryzen 7 5700X. These are synthetic SQLite microbenchmarks, not HTTP
latency or user telemetry. Query cases are in-memory with warmed statements; the rebuild case is
file-backed WAL with 1 KiB of text per message. They are useful for comparing shapes, not as release
budgets for a deployment. A second run reproduced the FTS update/delete and rebuild figures within about
15%. The 1,000-row history case ranged 1.2–1.8 ms before the index and 0.77–0.83 ms after it, so treat
the individual history medians as indicative.

### FTS update and delete, median ms

| Messages | Old identical update | New identical update | New changed update | Old delete | New delete |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 0.2194 | 0.0024 | 0.0402 | 0.2533 | 0.0255 |
| 10,000 | 1.4427 | 0.0025 | 0.0413 | 1.8801 | 0.0245 |
| 50,000 | 6.9656 | 0.0024 | 0.0404 | 16.1261 | 0.0254 |

Before the change, the same benchmark on the same host reported 0.2079 / 1.4400 / 7.2581 ms for the
identical update (direct rowid addressing measured 0.0164 / 0.0162 / 0.0176 ms). The lookup plans are
`SCAN messages_fts VIRTUAL TABLE INDEX 0:` before and `... INDEX 0:=` after. The mapping lookup itself
costs about 0.0013 ms. The old delete grows with the whole corpus; the new delete stays flat. Part of
the gain is that identical updates are now skipped entirely.

### History query, 1,000 rows in one thread, median ms

| Total messages | Before index | After index | Plan after |
| ---: | ---: | ---: | --- |
| 1,000 | 1.2251 | 0.7728 | index lookup, no temp sort |
| 10,000 | 1.0107 | 0.8586 | index lookup, no temp sort |
| 50,000 | 1.0364 | 0.7610 | index lookup, no temp sort |

Stored-JSON splicing was 0.22–0.67 ms on the same rows and is unchanged work.

### Ancestor check, median ms

| Depth | Prepared-get loop | Recursive CTE |
| ---: | ---: | ---: |
| 10 | 0.0146 | 0.0217 |
| 100 | 0.1367 | 0.0902 |
| 1,000 | 1.4974 | 1.0061 |
| 10,000 | 16.3720 | 11.9525 |

The CTE is a few microseconds slower at depth 10, where it also runs only when a parent actually
changes, and wins from depth 100 up. The unchanged-parent skip removes the common case entirely.

### One-time FTS rebuild, file-backed WAL

| Messages | Rebuild | File size after rebuild |
| ---: | ---: | ---: |
| 50,000 | 613.5 ms | 141.8 MB |
| 200,000 | 2,524.8 ms | 565.4 MB |

This is a maintenance event inside the migration transaction, not steady-state startup. Take a backup
before upgrading a large database; a downgrade requires restoring it because old code cannot read the
new trigger shape. The rebuild holds a write lock for its duration.

## Explicitly not measured here

- HTTP phase timing, event-loop delay, CPU/RSS/heap, streaming relay, or reconnect behaviour: no
  instrumentation suite was added in this pass.
- Browser traces, long tasks, paint budgets, font CLS, and service-worker deploy-with-old-tab behavior.
- Build-id-versioned asset caches (keeping the current and previous release explicitly) and an
  IndexedDB/LRU metadata index for the service worker; the shipped cache is a single 256-entry FIFO.
- A full 200k-row application fixture (the rebuild uses synthetic rows).
- Media queue waits, knowledge ingestion, resumable replay bytes, and provider TCP reuse.

Those remain follow-up work; do not quote the tables above as whole-app latency guarantees.
