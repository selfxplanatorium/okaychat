# External conversation transfer core

The text-only transfer engine accepts one locally extracted JSON file through the private
`/api/conversation-imports` family. It never reads an account ZIP, resolves imported URLs, calls a
model, or executes imported tools. The native ZIP archive format and routes stay separate.

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
`conversation_source_ids`, with one active job/account and one identity/thread. The migration rewind suite drops them when rewinding. A later append adds upload byte counters, a
physical-staging marker and import/export identity origin, so native export hashes can refresh without
changing an imported dedupe receipt.

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
portable identities. Imported identities and message keys survive export. Export runs as a reserved durable job. Native tools become inert historical text summaries.
Reasoning, unsupported data, off-branch content and file bodies are omitted. Preview/download always
warn that JSON is a lossy text-only transfer. SQL projection selects file descriptors without loading
inline file URLs or reading asset stores. Explicit selected leaves are supported.

## Trust and verification

Quarantine is absent from model projections. Transcript/tool/missing-content text is wrapped as
`past_chat` data before both trimmed and untrimmed model conversion, memory review and title generation.
The projection leaves stored display text unchanged and is idempotent. Existing archive tool projection
also now covers trimmed history. No model is called by normalization, commit or snapshot/export.

Synthetic parser tests cover syntax/caps, graphs and active branches, roles, times, strict portable
shapes, duplicate identity and normalization round trip. Core tests exercise actual worker entry,
abort, atomic commit, account isolation/dedupe, quota transfer/rollback, FTS quarantine exclusion,
zero receipts/usage, portable round trip, provenance stripping, and trimmed model projection.
Durable lifecycle tests additionally cover restart checkpoints, quota pause/resume, cancellation,
staging tamper and expiry. All tests use synthetic data and temporary storage.

## Durable jobs and API

Upload is a raw `application/json` or `application/octet-stream` request to
`POST /api/conversation-imports`. Compression and compressed-container magic are rejected. The server
reserves 80 MiB of account quota and the shared 512 MiB archive disk budget before reading a byte.
One active job per account, two running jobs and four waiting jobs per process bound work. Unknown-length
bodies bypass Hono's buffering middleware only for this family; the upload reader enforces 32 MiB,
120 seconds, disconnect cancellation and private 0700/0600 staging. Control bodies have a separate
128 KiB/5-second bound and strict schemas. All routes retain normal session auth and CSRF checks.

Upload is fsynced and atomically renamed before its hash and validating state are published. Parsing
runs in the bounded worker. Normalized per-conversation envelope files and a hashed manifest are
fsynced before a ready preview is published. Raw bytes are then removed. Preview rows contain only
bounded metadata, counters and warning codes. Estimated stored bytes include provenance and identity
charges; staging file sizes are separately checked against the 48 MiB normalized limit.

- `GET /api/conversation-imports` lists the account's newest twenty retained jobs.
- `GET /:id` returns phase, counts, warnings, dates, model/target and allowed actions.
- `GET /:id/items?after&limit` pages previews/results using owner/job-bound authenticated cursors.
- `POST /:id/confirm` accepts unique valid item keys and an owned project (or null), snapshots the
  account default model and persists a canonical confirmation hash. Identical confirmations are
  idempotent; different selections conflict. The target is rechecked in every conversation transaction.
- `POST /:id/resume` explicitly resumes a quota-paused job with the same selection/model/target.
- `DELETE /:id` durably records cancellation before aborting a parser or stopping further commits.
  Completed chats remain. Closing a client dialog does not call this endpoint.
- `POST /exports` snapshots owned, idle, unrestricted chats and reserves the same staging capacity.
  `GET /:id/download` serves only a ready, hash-checked JSON output as an attachment.

Every response is private/no-store. Foreign and nonexistent jobs return the same 404; expired jobs
return 410. Error details in this family project only authored reason codes, an optional owned job id,
and numeric quota requirements, never source text or exception messages. No admin content route,
notification with transcript text, webhook event, provider call or paid path is introduced.

Each import transaction yields to the event loop before the next conversation. Quota exhaustion rolls
back the current conversation and leaves it pending in a paused job. Cancellation never undoes a
committed conversation. Physical disk reservation stays at 80 MiB while staging exists even as the
account reservation transfers into stored content. Successful terminal cleanup releases the remainder;
failed deletion retains the reservation for retry.

Startup recovery runs before listening. Incomplete receiving jobs fail; validating uploads restart from
zero after checking their durable input hash. Ready reviews stay ready. Confirmed queued/importing
jobs verify the manifest, file/payload hashes and selection before resuming pending items only. Paused
jobs stay paused. Missing, tampered or incompatible staging fails closed. The 24-hour TTL starts at
admission and never extends. Maintenance every 60 seconds expires work, retries cleanup and retains
terminal metadata seven days. Startup also sweeps orphan directories; account deletion aborts its work
and removes staging. One app writer/process is supported.
