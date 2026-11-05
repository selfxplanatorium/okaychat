# External conversation transfer core

The text-only transfer foundation is implemented in `src/server/conversation-import/`.
It is **not exposed through HTTP or Settings**. The durable spool/job runner, lifecycle recovery,
upload admission, result API and settings flow are not implemented; do not expose the low-level
commit/export functions as routes without those controls. The existing native ZIP archive contract
and routes are separate and unchanged.

## Formats and worker boundary

`shared/chat-import.ts` defines portable JSON v1 (`okaychat.conversations`), the normalized mapping
adapter (`mapping-v1`), warning codes and bounds. The adapter validates the whole parent/children
graph, then retains only the ancestry of `current_node`. Duplicate source identities invalidate all
occurrences. Unknown roles and unsupported textual content become quarantine; tool history is inert.
No source settings, URLs, references, files, models, usage, receipts or credentials are activated.

`json.ts` scans UTF-8 JSON before parsing, iteratively bounding nesting, decoded strings, object
members and tokens. It rejects duplicate decoded keys, dangerous property names, invalid UTF-8,
unpaired surrogates, NUL and non-finite numbers. `formats.ts` accepts only the documented mapping
subset or strict portable v1. `text.ts` strips HTML outside code, removes active embedded images
and unsafe Markdown destinations, and normalizes controls without fetching anything.

`worker-pool.ts` isolates validation and portable serialization in fixed worker entries: two running,
four waiting, 256 MiB old-generation heap, 4 MiB stack, and a 60-second running deadline. Abort,
timeout, worker failure and explicit shutdown terminate the worker and release its slot. Development
registers the existing TypeScript loader inside each worker; production uses emitted ESM JavaScript.
The worker imports no storage, network, model or tool code. The low-level pure parsers are test and
worker interfaces, not request handlers.

## Storage foundation

An append-only migration creates `conversation_import_jobs`, `conversation_import_items`, and
`conversation_source_ids`, with one active job/account and one identity/thread. These tables are
currently populated only by synthetic tests. The migration rewind suite drops them when rewinding.

`commitConversation` consumes an owned importing job and pending selected item. One synchronous
transaction rechecks state/cancellation/expiry/project, revalidates normalized payload/hash, checks
account-scoped identity, transfers the quota reservation, and writes a fresh thread, parent-linked
messages, source receipt and item outcome. An exception rolls the whole conversation back. Equal
source identity skips instead of merging or overwriting; changed content reports `source_changed`.
Quarantine uses one inert data record per normalized part; a missing-content record carries only its
allowlisted kind/name beside empty text, preserving portable order without retaining a pointer.
Imported threads disable memory and pin their last retained message as the initial head/cursor.

Quota includes message JSON, 2 KiB plus UTF-8 title bytes per source identity, and job reservations.
Title updates change the title charge transactionally. No existing native title is charged until it
receives an export identity. Ordinary appends cannot mint import provenance or rewrite imported rows;
dedicated assistant editing preserves stored provenance. Forks copy message provenance but receive no
source identity. Runtime hydration orders parents before children, independently of source dates.

`export.ts` snapshots the active branch without reading asset bytes and allocates persistent native
portable identities. Imported identities and message keys survive export. This is a low-level core,
not a downloadable job; export admission/reservation and lifecycle are still required before exposure.
The current projection omits native actionable tools, unsupported data, reasoning and file bodies.

## Trust and verification

Quarantine is absent from model projections. Transcript/tool/missing-content text is wrapped as
`past_chat` data before both trimmed and untrimmed model conversion, memory review and title generation.
The projection leaves stored display text unchanged and is idempotent. Existing archive tool projection
also now covers trimmed history. No model is called by normalization, commit or snapshot/export.

Synthetic parser tests cover syntax/caps, graphs and active branches, roles, times, strict portable
shapes, duplicate identity and normalization round trip. Core tests exercise actual worker entry,
abort, atomic commit, account isolation/dedupe, quota transfer/rollback, FTS quarantine exclusion,
zero receipts/usage, portable round trip, provenance stripping, and trimmed model projection.
Lifecycle/cancel/restart/TTL/stream-admission tests require the unimplemented job engine; there is no
claim that these release gates have passed.
