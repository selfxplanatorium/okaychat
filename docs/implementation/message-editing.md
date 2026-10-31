# Editing assistant replies

Settings → General → Editing → "Edit assistant messages" is per account and **off by default**. When it is on, a completed assistant reply in a stored chat gets a pencil in its action bar. The pencil opens an inline editor that reuses the composer surface; Save and Cancel, Ctrl/⌘+Enter saves, Escape cancels.

Only text parts change. The message id, parent, created time, position in the branch, every child, and every reasoning, tool, file, source, and data part stay byte-for-byte as stored. The reply's provider item metadata is dropped from the edited text parts, because it describes the model's original output item and could make a provider replay that item instead of the edited text.

## Turning it on

The switch opens one confirmation dialog that names every consequence:

- in later turns the model sees the edited text as its own past reply;
- the original reply stays on the server for auditing and Undo, but is no longer used;
- the chat's prompt cache re-primes on the next turn, so that reply may cost more;
- exports, public shares, and search show the edited text;
- tool calls and reasoning in the reply cannot be edited.

Turning it off takes effect immediately. Existing edits still show their badge and Undo keeps working, so turning the setting off never traps an edit.

## Data model

`messages` gains two nullable columns (one append-only migration, bumped with the migration transaction):

- `edited_at`: milliseconds of the latest edit, `NULL` when the reply currently holds its original text.
- `original_enc`: the **first** original text parts, encrypted with `OKAYCHAT_SECRET` (`AES-256-GCM`). It is written once, reused by later edits, and kept after Undo. Only Undo uses it. It never leaves the server; `GET /threads/:id/messages` returns `edited_at` only.

The encrypted original counts toward the user's storage quota, together with the message JSON. Undo keeps charging it until the message or chat is deleted. Forking a chat copies the current text, `edited_at`, and `original_enc` into the fork (and charges the original again); the fork can Undo independently.

## API

- `PATCH /api/threads/:id/messages/:messageId` with either `{ "text": "..." }` (a reply with one text part) or `{ "parts": [{ "type": "text", "text": "..." }, ...] }` (one per text part, in order). The body is strict: unknown fields, non-text parts, empty text, more than 200 text sections, or more than `MAX_EDITED_TEXT` (200,000) characters are rejected. A reply cannot be made empty.
- `DELETE /api/threads/:id/messages/:messageId/edit` is the explicit Undo. It does not require the account setting, but still checks ownership, the latest branch, active runs, and the summary boundary.
- Both answer `{ message, editedAt }` with the stored row and the new `edited_at` (`null` after Undo). `editedAt` also rides on the row as `edited_at`.

Checks shared by edit and Undo:

- the session owns the thread (`404` otherwise), the thread is stored (`tmp_` ids are refused), the message exists and is an assistant reply on the **current branch** (newest message and its ancestors);
- no interactive turn or scheduled run is writing in the chat. `thread-runs.ts` tracks both; a scheduled run marks its chat busy until its reply is appended, not just until the stream ends;
- no tool part is still waiting for a result;
- a summary boundary does not cover the reply.

## Compaction, trims, and context

A summary replaces the messages through `boundaryMessageId`. Editing or undoing at or before that boundary would never reach the model and the summary would still describe the old text, so both are refused with `409`. A trim is different: it keeps text and drops only reasoning, tool results, and file contents, so edits inside a trimmed head still reach the model.

After an edit or Undo that changes text after a summary and up to the trim's `lastMessageId`, `tokensAfter` is shifted by the rough token delta of the changed text (messages appended after the trim are counted separately). The client refreshes the thread metadata after saving, so the context ring and the trim marker do not keep an estimate that is no longer true. `tokensBefore` stays historical.

## Requests, cache, and exports

`withStoredEdits()` in `chat.ts` replaces the parts of every reply that has ever been edited (`original_enc IS NOT NULL`) in each turn's request with the server's copy. A tab that still shows text from before an edit (or before an Undo) therefore cannot send stale text to the model. Retry, regenerate, and later turns all use the edited text. The changed assistant message changes the prompt prefix, so the next request starts a new cache prefix there.

`appendMessage` refuses to change a row that has `edited_at` or `original_enc` unless the incoming JSON is identical. A stale client re-persisting an old reply gets `409` instead of silently undoing the edit. The `messages_fts` trigger on `UPDATE OF content` reindexes the edited text, and export and public shares read the stored branch, so they show the edit as well.

## Client

`components/chat/AssistantMessageEditor.tsx` holds the form; `runtime/message-edit.ts` has the pure gating and runtime-state helpers. The pencil is hidden unless editing is enabled, the chat is stored, the message is a completed assistant reply with non-empty text, and it has a remote thread id. It is disabled with an explanatory tooltip while any turn is running, while cached history is pending or stale, or when a summary covers the reply.

Saving updates three places:

1. the server row (through the normal edit route);
2. `serverRows` and the IndexedDB message cache, as an acknowledged write (`edited_at` included, `sameRows()` compares it), so a reload paints the edited text and badge;
3. the runtime, by exporting its external state, replacing only that message's parts, and importing it with the same head and every other message, so the branch does not fork and no other message loses metadata. The request captures a runtime bound to the owning thread; if the user switches chats or starts a run before the response arrives, the import waits until that thread is visible and idle.

`state/message-edits.ts` remembers `edited_at` per `<thread> <message>` from loaded rows and from the cache. The badge shows a locale-formatted relative time (full date/time in its title) and an Undo button. Undo has a registered message command (`message.undoEdit`) and is available even when the setting was turned off; switching chats or turning the setting off closes an open editor. There is no cross-tab live push: another tab's edit appears on its next history load.

Commands: `message.editReply` (Y while a message has focus, also in the message command list) and `message.undoEdit`. Ctrl/⌘+Enter and Escape are local to the editor.

## Limits and non-goals

- User messages keep their existing edit-and-resend flow; `message.edit` is unchanged.
- Tool outputs, reasoning, files, and sources are never editable.
- Editing a reply does not regenerate it, create a branch, or change its model metadata or usage. Usage and cost stay attached to the original generation.
- A compacted summary always describes the text that was summarized; reply editing cannot rewrite the summary.
