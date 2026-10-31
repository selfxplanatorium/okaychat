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

- Upload: PDF (text layer only), DOCX, XLSX/XLSM, and text/code. The original bytes are stored in
  `uploads` through `storeUpload` (25 MB cap, quota charged); extraction reuses `files.ts`/`documents`
  helpers. Scanned PDFs fail with an honest "no OCR" message. Images are rejected: this build has no
  OCR path.
- Paste: the text is stored as an original upload plus the extracted text.
- URL: exactly one public `http(s)` page fetched once through `publicFetch` (pinned public DNS, every redirect
  revalidated, 20 s deadline, 10 MB body cap). The **original response bytes** (HTML, PDF, or text) are stored
  in `uploads`; readable content is extracted separately with Readability/turndown for HTML, `unpdf` for PDF,
  and UTF-8 decoding for text. Unsupported MIME types and HTTP errors fail visibly before anything is queued.
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
provider outage fails the source visibly instead of storing unusable vectors.

Provider HTTP errors and native Ollama failures go through the shared provider error taxonomy before
their safe message and fix are stored in source status. Raw response bodies can echo credentials or
document passages and must never appear in ingestion status or its management UI.
Unexpected management writes reach the central error handler unchanged, so database details stay in
the log behind a reference; they must not be promoted to user-visible validation text. A failed source
insert still removes its just-created upload and releases the quota.

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

- Progress is stored as 0–1 and refreshed by the UI while a source is processing.
- Retry keeps extracted text and rebuilds chunks; reindex rebuilds a source or a whole collection.
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
source or collection releases its bytes. Limits: 25 MB per upload, 10 MB per fetched URL, 400,000
characters per pasted or fetched document, 2,000 sources per collection, 20 attached collections per chat,
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
provider outage. The composer's Knowledge menu lists attachable collections with checkmarks and a Manage
link; phone layouts reach it from the plus menu, and the keyboard command opens that visible submenu rather
than the hidden desktop trigger. Counts use the locale formatter. The selector narrows to the open chat's
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
  attachment/project scoping, detach during retrieval, tool narrowing, and the 20k-chunk performance guard.
- `web/state/chat-knowledge.test.ts`: optimistic attachment binding, server hydration, failed initial PATCH
  rollback, and the one-passage citation store.
- `web/lib/knowledge-citation.test.ts`: valid ids, malformed percent escapes, forged ids, and inert
  rendering decisions for non-chat Markdown.
- `chat-knowledge.test.ts`: tool offer, per-turn envelope, stable system prefix, byte-for-byte replay,
  revocation, and temporary chats.

## Known limits

- Scanning a source is one job at a time; a huge PDF can take a while and only progress is shown.
- No OCR for scanned PDFs or images, no crawling, and no re-ranker. Keyword retrieval misses pure
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
- URL PDFs without a text layer are rejected before storing the source, just like uploaded scanned PDFs;
  oversized declared URL bodies are cancelled before returning an error.
- Knowledge text is stored unencrypted in SQLite (the original files are in `uploads` too). A copied
  database exposes it just like chat history; `OKAYCHAT_SECRET` covers provider keys and memory, not
  knowledge.
