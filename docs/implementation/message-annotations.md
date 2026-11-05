# Message annotations

Private per-message bookmarks and answer feedback. They live beside messages and never enter message content,
prompts, `turn_context`, FTS, exports, or public shares. See `src/shared/message-annotations.ts`,
`src/server/message-annotations.ts`, `src/web/state/message-annotations.ts`, and
`src/web/components/chat/MessageBookmark.tsx` / `MessageFeedback.tsx`.

## Storage and API

Both tables use `(thread_id, message_id)` as the key and a composite foreign key to `messages`, so a message,
thread, or account deletion cascades. There is no `user_id`: ownership comes from the thread. Message ids repeat
across forks, so no store or query may key on the id alone. Forking copies neither table.

- `GET /api/threads/:id/annotations` → `ThreadAnnotations`. One request per chat, no message excerpts. Feedback
  tombstones are included so clients know the current revision.
- `PUT`/`DELETE /api/threads/:id/messages/:messageId/bookmark` are idempotent. A repeat PUT keeps the original
  `created_at`. At most 100 per chat; only stored `user`/`assistant` rows in `ai-sdk/v6` format qualify.
- `PUT .../feedback` takes `{rating, comment, expectedRevision}`. A missing row is revision 0; every write,
  including removal, increments. Stale revisions are 409. A null rating clears the encrypted comment and keeps
  only the bounded tombstone.

Annotations use `requireUser`, return private uncached responses, check the owned thread before the message id,
and make a foreign thread, an absent thread, and an absent message indistinguishable. Writes re-check
`threadBusy()` after ownership, so a scheduled or interactive run in progress refuses them. Annotations never
change `threads.updated_at` or message content.

Comments are encrypted with the account secret, limited to 2,000 code points, and charged to the storage quota by
ciphertext bytes. Bookmarks and bounded metadata are not charged. A comment without a rating is refused; removal
is the only operation that writes `{rating:null, comment:null}`.

## Persistence gate

History is persisted asynchronously by the client after a turn ends, so "not running" is not proof that the server
stores the message. `runtime/message-persistence.ts` records ids from a trustworthy GET and from acknowledged
appends/edits; it never infers from the IndexedDB cache. `useStoredMessage` reads that set through
`useSyncExternalStore`. Write controls also require a saved owned thread, idle runtime, no history load or stale
sync, and no open editor for that reply. Server checks remain authoritative. A not-yet-stored message says
"Saving message…"; gates return a translated reason otherwise.

## Bookmarks and jump

The assistant and user More menus contain Bookmark/Remove bookmark; a saved mark leaves a persistent
`aria-pressed` button in the footer. The header chat options entry shows `Bookmarks ({count})` and opens the
current branch's jump list. Rows are full-width jump buttons with a sibling remove button, ordered by conversation
order and limited to 100. Marks elsewhere in the chat are counted, not called deleted. A jump request
(`state/message-jump.ts`) resolves only against the runtime's displayed branch; `WindowedMessages` lowers both
window bounds when needed, focuses the registered message root, scrolls it into view, and shows a short outline
highlight. It never switches branches. A missing id reports that the message is no longer in the displayed branch.

## Feedback

One More entry opens the shared dialog: Helpful / Not helpful (`aria-pressed`), an optional plain-text comment,
Save, Cancel, and Remove when rated. Nothing is saved by choosing a thumb. The form keeps its text on network,
quota, or conflict failures; a conflict offers reload or explicit retry against the refreshed revision. A saved
rating leaves a thumb in the footer named "Edit feedback: Helpful/Not helpful". The dialog says once that feedback
stays private to the account.

Feedback stores the target's `edited_at` at save time. If the reply is edited or undone later, the rating is kept
and the dialog shows "This reply changed after you left feedback". Historical usage still describes the original
generation. Schedules create ordinary replies that can be rated once stored and idle; schedules never submit
feedback themselves.

## Client state

`state/message-annotations.ts` holds per-account, per-thread maps, per-key pending state, and request epochs. One
GET per chat is shared. Writes apply only the confirmed server answer; an older GET cannot clobber an acknowledged
write. Focus refreshes run only while the chat's annotation sync is mounted and no write is pending. Chat deletion
drops its state; sign-out and account changes clear everything.
