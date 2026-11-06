# Knowledge base and retrieval

Account-owned collections of documents that a chat can attach. Answers can cite the exact passage,
and retrieval runs through SQLite and JavaScript only: no external vector service and no vector
library. Code lives in `src/server/knowledge/`; the shared types are in `src/shared/knowledge.ts`.

## Data model

| Table | Holds |
| --- | --- |
| `knowledge_collections` | Owner, name, description, optional `project_id`, embedding choice, status, `vectors_revision` (retrieval cache version) |
| `knowledge_sources` | Owner, collection, original `upload_id`, kind (`file`/`paste`/`url`), extracted `text`, byte counts, status/progress/error, `generation` |
| `knowledge_chunks` | Owner, source, collection, ordinal, heading title, `start`/`end` character offsets into the extracted text, text, token estimate, normalized float32 `embedding` |
| `knowledge_chunks_fts` | FTS5 index over chunk text, kept in sync by triggers keyed by `rowid` |

`threads.knowledge_ids` is a JSON array of attached collection ids. `turn_context.knowledge` and
`turn_context.knowledge_ids` store each turn's retrieved block so later requests replay the same bytes.
Those per-turn bytes count against the owner's storage quota (see below), like chunks and memories.
Foreign-key cascades remove chunks and sources with their collection or account. The delete paths also
remove the original uploads and release their quota.

A collection is usable from a chat when it belongs to the account and either has no project or is bound
to the chat's own project. Ids on the thread are re-checked on every tool execution and again after any
awaited retrieval, so detaching, deleting, or moving a collection revokes a tool already offered to a
running model and drops passages from a collection that disappeared mid-query.

## Sources and extraction

- Upload: PDF, DOCX, XLSX/XLSM, PPTX/PPSX (slide text and speaker notes), EPUB (spine order), HTML,
  ODT, raster images, and text/code. The original bytes are stored in `uploads` through `storeUpload`
  (25 MB cap, quota charged) before anything is parsed; there is no server-side extension allowlist.
  Extraction is the shared `src/server/extraction/` module: content decides the parser, and refused or
  damaged files fail in the queue with a specific message while the original stays
  (`docs/implementation/extraction.md`).
- OCR: images (PNG, JPEG, WebP, GIF first frame, BMP, TIFF, HEIC/HEIF) and PDFs without a text layer are read
  through the code sandbox's fixed-input `/ocr` route (`src/server/ocr.ts`). It needs the sandbox service,
  not the account's `code` feature. Without a configured or reachable sandbox the source fails with an
  actionable message matching `/OCR/`, keeps its original, and Retry extracts again once it is back.
  `knowledge_sources.extraction` records `text` or `ocr` (null for pasted text and older rows), and the
  page shows an OCR badge. `GET /knowledge/capabilities` reports `{ocr:{available,reason}}` from the
  service registry without probing an unconfigured sandbox.
- Paste: the text is stored as an original upload plus the extracted text.
- URL: exactly one public `http(s)` page fetched once through `publicFetch` (pinned public DNS, every redirect
  revalidated, 20 s deadline, 10 MB body cap). The **original response bytes** (HTML, PDF, or text) are stored
  in `uploads`; readable content is extracted separately with Readability/turndown for HTML, `extract()` for
  PDF, and UTF-8 decoding for text. A PDF without a text layer is stored as a queued source with no text,
  and the job OCRs the stored original; a PDF over 1,000 pages or 400,000 characters is refused before a
  source exists. Unsupported MIME types and HTTP errors fail visibly before anything is queued.
  There is no Scrapling/browser fallback and no crawl; links inside the page are not followed. Nothing is
  truncated just because `web_fetch` would page a long reply.
- Empty, binary, and oversized extraction results become a visible per-source error; failed sources can
  be retried after fixing or without changes.

## Chunking

`chunker.ts` walks the document as blocks: headings, paragraphs, fenced code, and Markdown tables. Blocks
are packed to a target of ~800 estimated tokens (4 characters per token) and split at sentence, line, or
whitespace boundaries when a single block is too large. A split always lands at or before the ceiling, so a
single giant sentence, line, or punctuation run cannot produce an unbounded chunk; only the deliberate
overlap extends a chunk past the ceiling. Consecutive chunks overlap by ~12% so a passage that crosses a
boundary is retrievable from both sides.

Chunk ids are deterministic: `k_` plus a truncated SHA-256 of source id, start, end, and text. Offsets index
the **exact** stored extracted text, including CRLF, so `text.slice(start, end)` always equals the chunk and a
citation can show the real passage. Headings provide the citation title. `excerpt()` cuts only at a full
UTF-16 surrogate pair.

## Embeddings

The embedding choice is per collection, selected when it is created or edited (and changing it triggers a
reindex):

| Provider | Setting | Transport |
| --- | --- | --- |
| None | `{ provider: "none" }` | Lexical BM25 only; no key required |
| OpenAI | `{ provider: "openai", model }` | `POST /embeddings` on the account's OpenAI connection |
| Google | `{ provider: "google", model }` | `:batchEmbedContents` with the Google connection |
| Ollama | `{ provider: "ollama", model }` | Existing native `/api/embed` helper |
| OpenAI-compatible | `{ provider: "compatible", providerId: "custom-…", model }` | `/embeddings` on the custom connection |

Non-admin custom endpoints go through `publicFetch`, exactly like chat. Keys are read server-side from
the encrypted connection store, never returned to the browser and never logged. Requests are batched in
groups of 16, each input capped at 8,000 characters. Every backend request (including Ollama's native
helper) combines the caller's abort signal with a 30 s deadline. The knowledge-owned OpenAI/Google
transports cap successful and error bodies before parsing.
Ollama retains the existing native helper's response parsing; its request has the same deadline but no
additional knowledge-specific response byte cap.
Vectors must be finite, non-zero, at most 16,384 dimensions, the same dimension across a batch, and not
overflow when squared (a `[Number.MAX_VALUE, …]` row is rejected rather than normalized to NaN); they are
normalized to unit length and stored little-endian float32. OpenAI-compatible responses may carry `index`
values: when any row has one, every row must have a unique in-range index and the rows are sorted into
request order. Providers that omit indexes keep their response order. 429 and 5xx responses retry with
exponential backoff up to four attempts; a provider `Retry-After` is honored up to a two-minute bound
rather than being shortened to the 8 s backoff cap, and the request's abort signal cancels the wait. A
provider outage fails the source visibly instead of storing unusable vectors. A provider request that
exceeds its 30 s deadline fails the source with "The embedding provider did not respond in time." It is a
failure, not a cancel: only the job's own signal (cancel, delete, or a newer generation) marks a source
`cancelled`.

Provider HTTP errors and native Ollama failures go through the shared provider error taxonomy before
their safe message and fix are stored in source status. Raw response bodies can echo credentials or
document passages and must never appear in ingestion status or its management UI.
Unexpected management writes reach the central error handler unchanged, so database details stay in
the log behind a reference; they must not be promoted to user-visible validation text. A failed source
insert still removes its just-created upload and releases the quota.

Ingestion and URL failures store and return only messages from `KnowledgeInputError` (this module's
validation text), `EmbeddingError`, and `HTTPException`. Any other error is logged and replaced with
"Ingestion failed.", and a URL transport error becomes "Could not read that page."

## Retrieval

`searchKnowledge()` only sees the attached, accessible collections:

1. FTS5 `MATCH` over quoted query words supplies up to 120 lexical candidates (BM25 order). A malformed
   expression falls back to an empty lexical list instead of failing.
2. Each collection's query vector is embedded once per distinct model. Cosine similarity is computed
   over a bounded per-collection cache (`VECTOR_CACHE_LIMIT`, 4,000 chunks, with a 64 MB total bound and
   least-recently-used eviction) plus the indexed vectors of lexical candidates that fall outside the
   cache. The cache is keyed by `vectors_revision`, which every chunk write, reindex, and delete bumps.
   An optional `sourceIds` filter is applied to candidates **before** ranking, so a requested document
   cannot be pushed out by unrelated top hits.
3. Vector hits from all attached collections are merged globally by cosine score before fusion; a
   per-collection concatenation would systematically favor whichever collection was attached first. The
   two ranked lists then fuse with reciprocal rank fusion (`1 / (60 + rank)`), overlapping passages from the
   same document collapse to the better one, duplicate chunk ids are removed, and the result is cut to the
   requested `k` and a token budget (2,400 by default, 12,000 maximum).
4. The result is labelled `hybrid` when at least one vector list was produced and `lexical` otherwise.
   `degraded: true` marks a collection that has an embedding setting but produced no query vector (missing
   connection, provider outage, or timeout). The management search test shows the degraded label, the
   tool payload carries `mode`/`degraded`, and automatic per-turn context records the retrieval mode,
   document id, title, and per-hit score. A collection with no embeddings, or a provider failure, therefore
   degrades honestly to keywords.

The 20k-chunk test seeds twenty thousand chunks and asserts a query stays under a loose five-second bound
using the FTS prefilter and the bounded cache. Retrieval never scans the whole table per query.

## Citations

Every hit carries `{ collectionId, documentId, title, chunkId, offset, url?, score }`. The tool instructions and
the per-turn passage block ask the model to cite as `[1](oknowledge:<chunkId>)`. The chat Markdown
renderer parses the scheme with `parseKnowledgeCitation()`: only `k_` plus 24 lowercase hex characters is
accepted, malformed percent escapes and forged ids render as inert text, and a malformed citation can never
throw inside Markdown. A valid citation opens `KnowledgeCitationHost`, which fetches the owned passage from
`GET /api/knowledge/chunks/:id` and shows the source name and character range. The knowledge tool card
lists the same passages as buttons, so a citation is usable even when the model writes no marker.
`oknowledge:` links are inert in `SimpleMarkdown`; public shares never mount the citation panel, and no
source text is added to the share by this feature.

## Ingestion jobs

`jobs.ts` is an in-process queue with rows as durable state:
`queued → extracting → embedding → ready`, or `failed` / `cancelled`. At most two jobs run per account
and three overall; one job per collection at a time (and never two for the same source). There is no idle
timer: work starts when a source is created and resumes from the database at startup
(`resumeKnowledgeIngestion()`), keeping state across a restart. Startup recovery walks unfinished rows in
keyset batches of 500 (`created_at`, `id`) and loads the next batch as the queue drains, so any number of
pending rows recovers without an idle timer or a stranded tail.

- Progress is stored as 0–1 and refreshed by the UI while a source is processing: `extracting` 0.04, then
  0.05–0.5 across pages/slides/chapters (0.3 while OCR runs), `embedding` 0.55–0.95, `ready` 1, and 0 for
  `failed`/`cancelled`. Writes are throttled to steps of 0.05 or 250 ms and never go backwards.
- Retry keeps extracted text and rebuilds chunks; reindex rebuilds a source or a whole collection. Neither
  re-extracts a source that has text, so neither calls OCR again and an `ocr` label survives. A source with
  no text (a failed extraction) extracts again on Retry.
- Cancel aborts fetch, embedding, and retry waits, removes queued work, and bumps `generation`, so a
  late write from the aborted job is ignored. Ownership is checked before touching a running controller,
  so a forged source id from another account cannot cancel that account's job.
- Delete and reindex also bump `generation`; `replaceChunks` and text writes check it inside the
  transaction, so a stale job can never write rows or bypass quota after a race.
- Changing a collection's embedding provider/model clears chunks and queues every source. When that
  happens while a job is running, the queue keeps exactly one pending replacement for the new generation,
  aborts the old job, and starts the replacement only after the old job releases its slot. A retry during
  an active job behaves the same way; the same generation is never restarted.
- `take()` removes queued entries that became cancelled, ready, failed, or superseded, so a stale queue
  entry cannot resurrect old work.

## Quota and limits

Originals count as uploads. Extracted source text, duplicated chunk text, and embedding blobs count in
`knowledge_chunks`/`knowledge_sources` through `storageUsedSql`. Retrieved passages stored in
`turn_context.knowledge`/`knowledge_ids` are charged to the owner too; `saveTurnContext` asserts the net
growth in the same transaction, so replaying or rewriting a block charges only what changed, and a rejected
write leaves the previous block intact. Every growth path calls `assertStorage` inside the same synchronous
transaction as its write; replacement writes (reindex, retry) charge only the net growth, and deleting a
source or collection releases its bytes. OCR text is charged by `setSourceText` on net growth like any
extracted text; a quota rejection fails the source with the quota message and keeps the original. Limits:
25 MB per upload, 10 MB per fetched URL, 400,000 characters per document (an extraction that hits the
character, 1,000-page, 300-slide, or 500-section cap fails instead of indexing part of a file), 2,000 sources per collection, 20 attached collections per chat,
and 12 passages per chat tool call.

## Chat integration and prompt caching

`chat.ts` calls `conversationKnowledge()` after the memory/skills blocks. For a new user message it
retrieves once, stores the block in `turn_context` beside that message, and replays it verbatim later.
The attached collection names are repeated only when an earlier block did not already name the same
ids. Nothing per-chat or per-turn enters system message 1; the stable prefix therefore keeps working.
Continuations and retries reuse the stored block. A detached collection's block is not replayed, and if
no attached collection remains the tools are not offered. After retrieval awaits an embedding request,
the chat's attachments are read again: hits from a collection detached or moved during the wait are
dropped, earlier replay blocks are gated again after retrieval, and a collection attached mid-flight
is not added to that turn's scope.

`search_knowledge(query, collections?, k?)` and `read_knowledge_chunk(chunkId)` are read-only and need no
approval. The `collections` argument can only narrow the thread's attachments. Both tools re-read the
thread on execution, and `search_knowledge` re-reads it again after retrieval so a detach cannot leak
passages; `read_knowledge_chunk` verifies the chunk's collection is still in scope. Tool hits carry
`documentId`, `title`, `score`, and the result's `mode`/`degraded` label, in both the card payload and the
enveloped model output.

## Prompt injection and security

Knowledge text is third-party data. `toModelOutput` wraps tool results in the deterministic provenance
envelope, scans them for instruction-shaped phrases, and keeps the raw result for the card. The per-turn
retrieved block is enveloped at delivery by `turn-context.ts`, and the turn is tainted before approval
decisions, so a destructive or outbound action after knowledge content is gated by the existing rule.
`search_knowledge` and `read_knowledge_chunk` are in `UNTRUSTED_TOOL_NAMES` for replayed history.
Management routes are authenticated, every query carries `user_id`, bodies are bounded with zod and the
route body limit, and retrieval is owner- and project-scoped.

## UI

`/knowledge` keeps the chat sidebar. The list shows status, source/chunk counts, byte size, project, and
embedding choice, with a retry action when the request fails. A collection page shows its name and current
embedding choice (wrapping safely at 360 px) and can be edited: name, description, project, provider, and
model reuse the same form as creation. An unavailable saved provider stays selectable so renaming does not
force a reindex; choosing a different provider or model warns that every source will be reindexed and the
queue starts immediately. The page adds files (drag/drop or picker), pastes text, or fetches one URL; each
source shows status, progress, error, retry/cancel/reindex/delete. A chunk browser and search-test box open
the same passage panel as a chat citation; the test label distinguishes keyword-only, hybrid, and a
provider outage. Knowledge is a default sidebar shortcut. The companion collection button beside its page link lists
attachable collections with checkmarks and a Manage link on desktop and phones; it no longer appears
in the composer or its plus menu. The collection keyboard command opens the sidebar before its menu. Counts use the locale formatter. The selector narrows to the open chat's
own project (read from thread metadata, not the sidebar filter), and the selection is PATCHed to the thread,
bound to a new chat's remote id only after the server accepts it, and hydrated from the thread list/detail.
Every action added here has a command (`knowledge.editCollection`, `knowledge.pasteSource`,
`knowledge.addUrl`, `knowledge.previewChunks`, `knowledge.retryLoad`, plus the existing add/search/reindex)
and touch/focus-visible sizing.

## Tests

- `knowledge/chunker.test.ts`: structure, determinism, offsets, overlap, long code/tables/paragraphs,
  exact CRLF slices, bounded giant sentences/lines, and surrogate-safe excerpts.
- `knowledge/embeddings.test.ts`: normalization, dimension/overflow limits, float32 round-trip,
  retry/Retry-After (including long provider waits), malformed provider responses, index ordering,
  request timeouts/cancellation, response byte caps, lexical-only mode.
- `knowledge/knowledge.test.ts`: auth and cross-account isolation (including forged cancellation), paste/
  file/URL ingestion (original vs extracted bytes, size and HTTP failures), hybrid and lexical search,
  deterministic global vector ordering, source filtering, degraded labels, citation offsets, reindex/
  model change during an active job, failure/retry/cancel, retry during an active job, stale-generation
  guard, quota release on delete and per-turn context quota, restart resume beyond one 500-row batch,
  attachment/project scoping, detach during retrieval, tool narrowing, the 20k-chunk performance guard,
  PPTX/PPSX/EPUB/HTML/ODT uploads with exact chunk offsets, image and scanned-PDF OCR through a fake
  extractor (quota, media release, retry after the sandbox returns), reindex without OCR, the
  capabilities route, malformed/legacy/zip-bomb/unsupported uploads, quota rejection during extraction,
  and the `/files/extract` status mapping.
- `extraction/formats.test.ts`, `extraction/bounds.test.ts`, `ocr.test.ts`: see
  `docs/implementation/extraction.md`.
- `web/state/chat-knowledge.test.ts`: optimistic attachment binding, server hydration, failed initial PATCH
  rollback, and the one-passage citation store.
- `web/lib/knowledge-citation.test.ts`: valid ids, malformed percent escapes, forged ids, and inert
  rendering decisions for non-chat Markdown.
- `chat-knowledge.test.ts`: tool offer, per-turn envelope, stable system prefix, byte-for-byte replay,
  revocation, and temporary chats.

## Known limits

- Scanning is bounded to two sources per account and three overall (`MAX_JOBS_PER_USER`/`MAX_JOBS_TOTAL`), one
  per collection; a huge PDF can take a while and only progress is shown.
- OCR needs the code sandbox and reads only its installed languages (`eng`, `ita`); no handwriting, layout,
  confidence, or AVIF. No crawling and no re-ranker. Keyword retrieval misses pure
  paraphrases in lexical-only mode.
- Embedding batches are bounded by character/token estimates rather than provider tokens; an unusual
  document can still approach a provider's per-request limit.
- The vector cache covers the first 4,000 chunks per collection; older chunks still reach results through
  FTS and their indexed vectors, which is approximate rather than exhaustive. Vector candidates are capped
  globally before RRF (`MAX_VECTOR_CANDIDATES`), deliberately bounded rather than an ANN index.
- Citation markers depend on the model copying the requested link form; the tool card always lists the
  real passages when it does not. A malformed marker stays inert text.
- The Library can delete an upload that a knowledge source still references (the foreign key sets
  `upload_id` to NULL). Existing extracted text and chunks stay searchable and reindex from that text; a
  source whose job failed before extraction reports that the original is gone and must be added again.
- URL sources accept HTML, PDF, and text only; Office, EPUB, and ODT files must be downloaded and uploaded.
  Oversized declared URL bodies are cancelled before returning an error.
- Knowledge text is stored unencrypted in SQLite (the original files are in `uploads` too). A copied
  database exposes it just like chat history; `OKAYCHAT_SECRET` covers provider keys and memory, not
  knowledge.

## Shared team knowledge (read-only collections)

Owners publish a global collection to everyone or to selected users/groups through the existing
`share_audiences`/`share_users`/`share_groups` system with kind `knowledge`. This is not a team-room
feature: channels remain a separate aggregate, and no collection, source, chunk, audience, or dependency
row references a channel, room message, or room attachment.

- **Authority.** Every read resolves live rows: the viewer exists, the owner exists, both accounts may use
  knowledge, and the collection is either the viewer's own or `visibility='shared'` with
  `audienceIncludes("knowledge", id)` for that viewer. No audience row means everyone only while the
  collection is shared; a private collection is never published by an absent row. Selected-empty means no
  readers. Group membership is live. Admin status is not a passage-reading grant.
- **No shared project.** A shared collection must have `project_id IS NULL`; publishing a project-bound
  collection returns 409 and setting a project on a shared one does too. A reader may attach a shared
  global collection to any of their own chats, including one in their own project.
- **Reader projections.** `GET /knowledge/collections?scope=owned|shared|attachable` pages by
  `(updated_at,id)`. Shared rows omit bytes, project, embedding settings/providers/models, audience,
  owner email/photo, and access revision. Reader source lists use `KnowledgeSourceSummary` only: no URL,
  bytes, mime, progress, error, or upload id. Detailed failures stay owner-only.
- **Readers retrieve lexically.** A reader query never constructs an embedder, reserves an owner
  operation, or calls the owner's endpoint, even when the reader has the same provider/model or a shared
  provider grant. Results carry per-collection `{collectionId,mode,degraded,reason}`; shared rows report
  `shared_lexical` (or `not_configured`) and intentional shared lexical is not "degraded". Cross-account
  vector queries are deferred.
- **Embedding pin.** New non-lexical collections pin `(scope, createdAt, endpointHash)` for the exact
  connection. The resolver never falls back between an own and a shared row. Every ingest batch and every
  retrieval re-resolves and requires the same pin, a live owner, the owner's knowledge feature, and a
  currently allowed endpoint/model. Legacy non-lexical rows keep their vectors (keyword retrieval still
  works) but have no pin: ingestion refuses until the owner runs an explicit `POST /collections/:id/reindex`
  (optionally with a new embedding setting). `PATCH` cannot change the embedding while sources exist.
  A vector dimension mismatch fails that source instead of mixing spaces.
  For a custom connection with default query parameters, `endpointHash` also covers a keyed digest of the
  query names and values, so changing `api-version` stops retrieval until an explicit reindex; a connection
  without configured query keeps its old hash. Active ingest and query operations additionally compare a
  server-only transport fingerprint (key, auth mode, headers, query): any change, including key rotation,
  aborts the running batch, but only an endpoint or query change requires a reindex. A fixed deployment
  base URL (`…/openai/deployments/<id>`) requires the collection model to equal that deployment id. See
  [providers](providers.md).
- **Storage payer.** The owner pays originals, extracted text, chunks, vectors, ingestion operations, and
  provider billing. A reader pays only their own chat context (bounded retrieved blocks/tool results),
  messages, and generation. Retrieval itself writes nothing for a non-owner. Audience/dependency/audit
  rows are operational metadata and are not charged.
- **Durable restricted chats.** Attaching another account's collection inserts a
  `knowledge_thread_dependencies` row (no FK, so deleting the collection leaves a deny-all tombstone), caps
  a chat at 20 lifetime dependencies, disables automatic memory learning, and requires
  `acceptSharedRestrictions: true` on the first transition. Detaching, archiving, or changing the model
  never removes a dependency. While every dependency resolves, the chat may use only
  `search_knowledge`/`read_knowledge_chunk`: no MCP, web, delegation/research, code, images, artifacts,
  email, drafts, skills, custom tools, widgets, memory writes, agent targets, schedules, comparisons,
  branching, shares, exports, archives, or copies into notes/drafts. If any dependency becomes unreadable,
  the whole chat is locked: list rows keep only id/status/pinned/timestamps with a generic translated
  title, detail returns metadata without title/tags/attachments/compaction, and history, edit, undo,
  translation, bookmark, feedback, search, memory-recall, share, export, archive, and scheduled runs
  refuse. Deletion and archiving remain allowed. A regrant restores it; a deleted collection never does.
- **Revocation.** `knowledge/revocation.ts` keeps live registrations for retrievals, restricted turns, and
  owner ingests. Permission revisions, group edits/deletes, collection publication/private/delete,
  source deletion/reindex, provider connection changes, and account/demotion paths abort affected work.
  Retrieval rechecks before FTS/vector access, after each await, and before returning; chat holds a lease
  that aborts the provider stream and rechecks before every step; ingestion rechecks its exact pin and
  source generation before each batch. Aborting a reader's work never cancels legitimate owner indexing.
  Resumable stream registrations retain the thread id: resume checks live content access before and after
  opening the buffer and before each emitted chunk. Manual compaction holds a dependency lease and checks
  access again before saving or returning its summary. Embedding calls also hold a lease: each 16-input
  batch checks the live model grant and exact connection pin, including whether the owner now requires
  guarded public-host transport; demotion aborts a captured unguarded connection.
- **Citations.** `GET /knowledge/chunks/:id` resolves chunk → source → collection with matching owner
  columns and then the live predicate. Unknown, deleted, revoked, and forged ids all answer the same
  `Passage not found`. The UI revalidates while open and every 2 s, clears the passage first, and shows a
  generic unavailable notice; this is a UI courtesy, not a recall of already delivered bytes.
- **Admin cleanup.** `GET /admin/knowledge` lists shared metadata only (id, owner id, visibility, status,
  counts, bytes, revision) and `DELETE /admin/knowledge/:id` requires a 1–500 character reason, rejects
  private/unknown rows, and writes the audit row before deleting. There is no passage inspector and no
  private collection inventory. Owner deletion removes index/originals/audience and leaves dependent
  tombstones.
- **Upgrade behavior.** The migration defaults every existing collection to private and leaves all pin
  columns NULL. No historical turn context, tool result, or chat is republished. Existing non-lexical
  collections show the reindex-required notice; their vectors/text are preserved.
- **Shared content is untrusted.** Collection names, descriptions, source titles/URLs, and passages keep
  the deterministic `wrapUntrusted` envelope, `scanForInjection`, and taint gate. A shared attachment
  taints the turn up front; scanner results never substitute for an ACL check. Knowledge text is still
  plaintext in SQLite; this increment does not add encryption at rest.
