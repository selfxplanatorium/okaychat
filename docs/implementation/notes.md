# Notes

Private, durable Markdown documents owned by one account. Notes are ordinary account text at rest
(like chats and saved prompts): **not encrypted**, never sent to a model on their own, and never part
of a project prompt, knowledge collection, memory, share, export, or chat search. See
`docs/implementation/security.md` for the volume-level threat model.

## Storage

`notes`, `note_tags`, and the external-content FTS table `notes_fts` (addressed through
`notes.search_id`). Source pointers (`source_kind`, `source_thread_id`, `source_item_id`,
`source_version`) have no foreign key: deleting a chat or artifact leaves the copied note intact.
`sourceAvailable` is recomputed with an owned-row lookup on every read. Project links use
`ON DELETE SET NULL`; that metadata change does not bump the note revision or `updated_at`.

`create_key` is the client UUID v4 (`requestId`), unique per account. `create_hash` is the lowercase
SHA-256 of a canonical JSON payload excluding the request id, with an operation kind so an ordinary
create and a source copy never share a retry identity. A retry with the same hash returns the current
note (200); a different hash is 409 `reason:request_reused`. Deletion ends retry identity.

## API

`src/server/notes/store.ts` + `routes.ts`, mounted at `/api/notes`.

| Route | Notes |
| --- | --- |
| `GET /notes` | `q`, `favorite`, `pinned`, `projectId` (`none`), repeated `tag`, `tagMatch`, `limit`, `cursor` |
| `GET /notes/tags` | owned counts, count DESC then tag ASC |
| `POST /notes` | create, idempotent by `requestId` |
| `POST /notes/from-source` | message text or one exact Markdown artifact version |
| `GET/PUT/DELETE /notes/:id` | full read, revision CAS, CAS delete |

Every route sets `Cache-Control: private, no-store` before the account feature guard. Store functions
repeat `assertFeature("notes")`, so the route is not the only boundary. Foreign and missing ids answer
the same 404. Unknown query names, duplicate scalar parameters, malformed cursors, and invalid limits
are 400. Full writes are strict (unknown fields fail).

Search compiles at most 20 Unicode letter/number tokens, quotes each as an FTS literal with a prefix
wildcard, and joins `notes_fts` by rowid. No user text becomes FTS grammar. Filters AND together; tag
`any`/`all` only changes the tag predicate. The cursor is base64url JSON bound to a SHA-256 of the
normalized filters (not the page size) and follows the strict `pinned DESC, updated_at DESC, id DESC`
tuple. A summary never carries the body; its excerpt is the first 160 code points with whitespace
collapsed.

## Source copy

A message source must be an owned stored message on a non-temporary, non-comparison chat with no
running/waiting turn. Only user/assistant `text` parts are joined with two newlines; reasoning, tool
input/output, attachments, metadata, and historical imported tool records are omitted. The title is
the first nonempty line with Markdown heading markers stripped, clipped to 200 code points/800 bytes.
An artifact source requires `artifacts` permission, the exact displayed version, and `kind =
"markdown"`. Other kinds are refused with an explanation; no conversion or media copy exists.

The copy is a new snapshot and is charged in full even though the source is already stored. A later
source edit never refreshes the note.

## Editor and autosave

`src/web/components/notes/` (page, list, editor, preview, filters, tags, conflict dialog, source
actions, save-note menu items, composer handoff) and `src/web/state/notes.ts`.

`lib/note-autosave.ts` debounces every editable field together for 600 ms, writes one captured payload
at a time, and acknowledges only the newest edit sequence. 409 stops automatic writes and opens the
compare dialog (local/server plain text, Reload, Save as a new note, Copy local). 404 is terminal.
413 keeps the draft and points at storage; 403 stops writes and hides content behind the recovery
controls. There is no merge or force overwrite.

The editor persists each dirty snapshot synchronously before navigation can unmount it. Disposed
controllers ignore late responses so an old acknowledgement cannot clear a newer draft. Recovery
restores every local field before comparing the base revision; a mismatch opens the conflict path
without writing. Background refresh updates the list and tags only; it does not unmount an open
editor on a remote deletion or replace its CAS base.

`lib/note-outbox.ts` keeps unsaved text as plaintext under
`okaychat:note-outbox:<accountId>:<noteId>`, at most 20 entries and 2 MiB, evicting only acknowledged
entries. If storage is unavailable the editor says the draft is only in this tab and warns on
`beforeunload`. The outbox is never read for another account.

Preview uses `SimpleMarkdown` (GFM, math, Mermaid, no raw HTML). Remote images go through
`ProtectedMarkdownImage`; links are limited to http(s) and same-origin relative paths. Note-to-chat is
an explicit client-only handoff (`state/note-chat-handoff.ts`): account-bound, single-use, five-minute
TTL, inserts `# title` plus body into a **new** composer, appends rather than overwrites existing text,
and never submits.

## Limits and privacy

5,000 notes per account; title 200 code points/800 UTF-8 bytes; body 200,000 code points/512 KiB;
10 flat tags per note using `normalizeTag`; list pages 1–100 (default 50); search 200 code
points/800 bytes and 20 terms. Create/update bodies are capped at 1 MiB, source copies at 4 KiB.

Storage counts `length(CAST(title AS BLOB)) + length(CAST(body AS BLOB))` in the same transaction as
the write. Tags, FTS copies, source pointers, revisions, and hashes are bounded metadata and are not
charged. Deletes and shrinks work over quota.

Tests: `src/server/notes.test.ts`, `src/server/calendar-time.test.ts` for shared time helpers,
`src/web/lib/note-autosave.test.ts`, `src/web/state/note-chat-handoff.test.ts`, and the migration suite.

Deferred: sharing, collaboration, per-note permissions, admin browsing, folders, rich text,
attachments, history/trash, bulk actions, model tools, RAG/memory ingestion, and non-Markdown artifact
conversion.
