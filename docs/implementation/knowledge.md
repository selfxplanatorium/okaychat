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
Foreign-key cascades remove chunks and sources with their collection or account. The delete paths also
remove the original uploads and release their quota.

A collection is usable from a chat when it belongs to the account and either has no project or is bound
to the chat's own project. Ids on the thread are re-checked on every tool execution, so detaching,
deleting, or moving a collection revokes a tool already offered to a running model.

## Sources and extraction

- Upload: PDF (text layer only), DOCX, XLSX/XLSM, and text/code. The original bytes are stored in
  `uploads` through `storeUpload` (25 MB cap, quota charged); extraction reuses `files.ts`/`documents`
  helpers. Scanned PDFs fail with an honest "no OCR" message. Images are rejected: this build has no
  OCR path.
- Paste: the text is stored as an original upload plus the extracted text.
- URL: exactly one page through `webFetch` (`publicFetch`, redirects revalidated, response caps,
  Readability), never a crawl. Links inside the page are not followed.
- Empty, binary, and oversized extraction results become a visible per-source error; failed sources can
  be retried after fixing or without changes.

## Chunking

`chunker.ts` walks the document as blocks: headings, paragraphs, fenced code, and Markdown tables. Blocks
are packed to a target of ~800 estimated tokens (4 characters per token) and split at sentence, line, or
whitespace boundaries when a single block is too large. Consecutive chunks overlap by ~12% so a passage
that crosses a boundary is retrievable from both sides.

Chunk ids are deterministic: `k_` plus a truncated SHA-256 of source id, start, end, and text. Offsets
index the exact normalized extracted text (CRLF becomes LF), so a citation can show the passage and a
client slice matches the stored text. Headings provide the citation title.

## Embeddings

The embedding choice is per collection, selected when it is created (and changing it triggers a
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
groups of 16, each input capped at 8,000 characters. Vectors must be finite, non-zero, and the same
dimension across a batch; they are normalized to unit length and stored little-endian float32.
429 and 5xx responses retry with exponential backoff up to four attempts, honoring `Retry-After` and the
request's abort signal. A provider outage fails the source visibly instead of storing unusable vectors.

## Retrieval

`searchKnowledge()` only sees the attached, accessible collections:

1. FTS5 `MATCH` over quoted query words supplies up to 120 lexical candidates (BM25 order). A malformed
   expression falls back to an empty lexical list instead of failing.
2. Each collection's query vector is embedded once per distinct model. Cosine similarity is computed
   over a bounded per-collection cache (`VECTOR_CACHE_LIMIT`, 4,000 chunks, with a 64 MB total bound and
   least-recently-used eviction) plus the indexed vectors of lexical candidates that fall outside the
   cache. The cache is keyed by `vectors_revision`, which every chunk write, reindex, and delete bumps.
3. The two ranked lists fuse with reciprocal rank fusion (`1 / (60 + rank)`), then overlapping passages
   from the same document collapse to the better one, duplicate chunk ids are removed, and the result is
   cut to the requested `k` and a token budget (2,400 by default, 12,000 maximum).
4. The result is labelled `hybrid` when at least one vector list was produced and `lexical` otherwise.
   A collection with no embeddings, or a provider failure, therefore degrades honestly to keywords.

The 20k-chunk test seeds twenty thousand chunks and asserts a query stays under a loose five-second bound
using the FTS prefilter and the bounded cache. Retrieval never scans the whole table per query.

## Citations

Every hit carries `{ collectionId, documentId, title, chunkId, offset, url? }`. The tool instructions and
the per-turn passage block ask the model to cite as `[1](oknowledge:<chunkId>)`. The chat Markdown
renderer recognizes that scheme and opens `KnowledgeCitationHost`, which fetches the owned passage from
`GET /api/knowledge/chunks/:id` and shows the source name and character range. The knowledge tool card
lists the same passages as buttons, so a citation is usable even when the model writes no marker.
`oknowledge:` links are not fetchable from a public share; shares render through `SimpleMarkdown`, which
never mounts the citation panel, and no source text is added to the share by this feature.

## Ingestion jobs

`jobs.ts` is an in-process queue with rows as durable state:
`queued → extracting → embedding → ready`, or `failed` / `cancelled`. At most two jobs run per account
and three overall; one job per collection at a time (and never two for the same source). There is no idle
timer: work starts when a source is created and resumes from the database at startup
(`resumeKnowledgeIngestion()`), keeping state across a restart.

- Progress is stored as 0–1 and refreshed by the UI while a source is processing.
- Retry keeps extracted text and rebuilds chunks; reindex rebuilds a source or a whole collection.
- Cancel aborts fetch, embedding, and retry waits, removes queued work, and bumps `generation`, so a
  late write from the aborted job is ignored.
- Delete and reindex also bump `generation`; `replaceChunks` and text writes check it inside the
  transaction, so a stale job can never write rows or bypass quota after a race.
- Changing a collection's embedding provider/model clears chunks and queues every source.

## Quota and limits

Originals count as uploads. Extracted source text, duplicated chunk text, and embedding blobs count in
`knowledge_chunks`/`knowledge_sources` through `storageUsedSql`. Every growth path calls `assertStorage`
inside the same synchronous transaction as its write; replacement writes (reindex, retry) charge only the
net growth, and deleting a source or collection releases its bytes. Limits: 25 MB per upload, 400,000
characters per pasted or fetched document, 2,000 sources per collection, 20 attached collections per chat,
and 12 passages per chat tool call.

## Chat integration and prompt caching

`chat.ts` calls `conversationKnowledge()` after the memory/skills blocks. For a new user message it
retrieves once, stores the block in `turn_context` beside that message, and replays it verbatim later.
The attached collection names are repeated only when an earlier block did not already name the same
ids. Nothing per-chat or per-turn enters system message 1; the stable prefix therefore keeps working.
Continuations and retries reuse the stored block. A detached collection's block is not replayed, and if
no attached collection remains the tools are not offered.

`search_knowledge(query, collections?, k?)` and `read_knowledge_chunk(chunkId)` are read-only and need no
approval. The `collections` argument can only narrow the thread's attachments. Both tools re-read the
thread on execution, and `read_knowledge_chunk` verifies the chunk's collection is still in scope.

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
embedding choice. A collection page adds files (drag/drop or picker), pastes text, or fetches one URL;
each source shows status, progress, error, retry/cancel/reindex/delete. A chunk browser and search-test
box open the same passage panel as a chat citation. The composer's Knowledge menu lists attachable
collections with checkmarks and a Manage link; phone layouts reach it from the plus menu. The selection
is PATCHed to the thread, bound to a new chat's remote id, and hydrated from the thread list/detail.

## Tests

- `knowledge/chunker.test.ts`: structure, determinism, offsets, overlap, long code/tables/paragraphs.
- `knowledge/embeddings.test.ts`: normalization, float32 round-trip, retry/Retry-After, malformed provider
  responses, lexical-only mode.
- `knowledge/knowledge.test.ts`: auth and cross-account isolation, paste/file ingestion, hybrid and
  lexical search, citation offsets, reindex/model change, failure/retry/cancel, stale-generation guard,
  quota release on delete, restart resume, attachment/project scoping, tool narrowing, replay revocation,
  and the 20k-chunk performance guard.
- `chat-knowledge.test.ts`: tool offer, per-turn envelope, stable system prefix, byte-for-byte replay,
  revocation, and temporary chats.

## Known limits

- Scanning a source is one job at a time; a huge PDF can take a while and only progress is shown.
- No OCR for scanned PDFs or images, no crawling, and no re-ranker. Keyword retrieval misses pure
  paraphrases in lexical-only mode.
- Embedding batches are bounded by character/token estimates rather than provider tokens; an unusual
  document can still approach a provider's per-request limit.
- The vector cache covers the first 4,000 chunks per collection; older chunks still reach results through
  FTS and their indexed vectors, which is approximate rather than exhaustive.
- Citation markers depend on the model copying the requested link form; the tool card always lists the
  real passages when it does not.
- Knowledge text is stored unencrypted in SQLite (the original files are in `uploads` too). A copied
  database exposes it just like chat history; `OKAYCHAT_SECRET` covers provider keys and memory, not
  knowledge.
