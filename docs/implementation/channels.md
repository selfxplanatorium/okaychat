# Team channels

Shared rooms are a separate aggregate from private chats. A room, its messages, runs, reactions, read
state, and events reference no `threads`, `messages`, generation receipt, upload, artifact, knowledge,
memory, project, share, schedule, or Library row.

## Model and authority

- `channels` owns the name, description, icon, immutable visibility, reduced AI binding, revision, and
  room-local `next_seq`. Changing visibility is not supported.
- `channel_members` holds exactly one `owner` per room (partial unique index), moderators, members,
  `read_seq`, and `notify_mode` (`all`, `mentions`, `none`).
- `channel_invites` is the pending invitation. Public/group self-join is immediate; private rooms are
  invitation-only. `channel_exclusions` survives removal and blocks public/group rejoining until a
  moderator clears it.
- Group rooms require live membership in at least one selected group. That check runs on every REST
  request, every replayed event frame, and every AI checkpoint/pump. Losing the group closes the room
  even for its owner; an admin must repair the audience.
- Ordinary routes require the account-level `channels` feature and then room eligibility/membership.
  Unknown, inaccessible, removed, and private-nonmember ids all answer the same 404. Role failures are
  403 only after room authorization. Admin moderation uses the separate `/api/admin/channels` routes
  and never fabricates membership.

## Storage and FTS

The appended migration creates every `channel_*` table, expands notification kinds by rebuilding the
table, and adds `usage.channel_id`/`channel_run_id` with a unique index per run. The event singleton
holds an epoch generated with `newId` and a monotonic floor.

`channel_search_keys(search_id, message_id)` addresses `channel_messages_fts` by integer rowid. Triggers
index inserts, body/tombstone updates, and deletes; the `BEFORE DELETE` trigger on the key table removes
the FTS row first, so a channel cascade cannot leave stale text. Search authorization (membership,
group eligibility, optional room) is inside the SQL before its limit.

## REST

All ordinary responses return `Cache-Control: private, no-store`; SSE also preserves `no-transform`. Bodies are strict Zod objects; the channel router
caps bodies at 128 KiB and individual ordinary reads use 48 KiB. Lists are keyset paged; history uses
sequence cursors and never timestamps. Create and message client ids are durable idempotency keys with
canonical request hashes; an exact replay returns the stored projection, while a reused id with
different text is a 409. Rooms, members, invitations, mentions, reactions, messages, run outputs, and
request ids are bounded in `src/shared/channels.ts`.

## Events and SSE

`channel_events` is an append-only invalidation log, not a body transport. `afterCommit` only wakes
subscribers; every frame is read from SQLite and re-authorized against live feature, room, group, and
membership state.

- Event high-water comes from SQLite’s durable AUTOINCREMENT sequence, so room cascades and pruning
  cannot move it backwards. Open streams check the pruning floor again, and frames are re-authorized
  after any backpressure wait. Epoch changes reset before same-epoch future-sequence validation.
- Cursors are base64url `{v,epoch,seq,userId}` with an HMAC derived from `OKAYCHAT_SECRET`. Tampered,
  wrong-user, and future cursors are 400 before headers. A pruned floor or another epoch sends
  `event: reset` with `history_expired`.
- `GET /api/channels/events` sends `ready`, optionally `reset`, then id-bearing invalidations and a
  15-second heartbeat. `Last-Event-ID` wins over `?cursor=`. A missing cursor starts at the current
  high-water and sends an initial reset. Maximum lifetime is 5 minutes; two streams per account and 256
  per process are allowed (429 beyond); frames are capped at 256 KiB and 256 signals; a stalled consumer
  times out without advancing its undelivered cursor.
- `GET /api/channels/changes` is the polling fallback: at most 1,000 raw rows scanned, 200 emitted, and
  the cursor advances through every scanned row. `GET /api/channels/sync` reads joined summaries,
  invitations, and its cursor in one synchronous snapshot.
- Groups, permission changes, account deletion, and room deletion publish a generic `sync`; the web
  transport then refetches and drops caches for rooms that vanished. One transport runs per tab; the
  server allows two streams per account across tabs. Hidden tabs close the stream after 30 s and poll
  once a minute.

## AI replies

A binding is either a model or a reduced preset snapshot of `{name,modelRef,instructions,reasoningEffort,
sampling}`. Preset origin ids, knowledge, tool policies, projects, and every personal field are dropped
at save. The owner must accept the reduced-snapshot notice; later edits to the preset do not change the
room. Every requester still needs their own authorized connection to the bound model.

A run exists only after an explicit composer chip or message action. Admission is transactional: it
rechecks membership, feature, model grant, binding, source, room capacity, rates, quotas, and the one
open run per room/requester. It freezes up to 60 recent messages ending at the source sequence, excludes
unfinished AI output, removes the source body from the transcript, encrypts the snapshot, and allocates
the AI placeholder sequence and 64 KiB output reservation before committing. The request hash makes an
exact duplicate free.

The worker is an in-process FIFO: two executing, 20 queued, 60 s queue expiry, 120 s deadline. It holds
the requester's existing turn slot and `llm.call` lease. It sends only:

1. the resolved `dataSafety` and `channelReply` system prompts;
2. reduced assistant instructions and room metadata, both enveloped as untrusted data;
3. a JSON transcript envelope plus the current request.

Admission rechecks live membership, eligibility, archive state, binding, source and owner quota inside
the write transaction after asynchronous model resolution. Room metadata and author names remain in
the frozen, untrusted prompt envelopes. Admin update reasons are validated before any mutation.

No tools, MCP, memory, knowledge, projects, skills, files, RAG, delegates, images, compaction, or title
generation are available. Text checkpoints are durable at most every 500 ms or 1 KiB, capped at 64 KiB
and a valid code point. Cancellation aborts the provider and keeps the partial body. Restart marks open
runs `interrupted` and never retries. Membership removal, leaving a room, and audience changes abort
idle providers after commit; revoked access settles as `failed`/`forbidden`, while an explicit stop is `cancelled`. Hard deletion retains the
worker slot until the provider task releases its turn and operation lease. Revision checks precede
archive/delete cancellation, including admin moderation.

Final usage is written once with the unique `channel_run_id`; a provider that reports no usage stores
`NULL` and the UI says so.

## Read state and notices

Unread is the live count of undeleted messages after `read_seq` that the member did not author; AI
placeholders count. Mentions unread joins structured mention spans. Opening a room, SSE, and history
never advance the cursor. The client advances only while visible and at the bottom, throttled, plus an
explicit mark-read action. The cursor is monotonic and marking it also marks matching channel notices
read.

Notices are generic: title/body keys with empty params. A structured mention wins over a plain message;
`all` adds posts by others and terminal AI replies; `none` suppresses them. Invitations always notify.
No notice is created by an edit, reaction, read, or unread state. Listing and counting additionally
filter the live room ACL and feature, and ACL mutations purge affected notices.

## Quota and limits

The current owner pays for room metadata, every member's message bodies, run config, encrypted frozen
input, a 1 KiB run receipt, and an open run's 64 KiB output reservation (counted once as body bytes
grow). Transfers check the target owner's full limit before changing `owner_id`. Events, rate windows,
read cursors, memberships, reactions, audit rows, notifications, and FTS copies are bounded operational
metadata, not charged user content.

## Web workspace

`/channels` and `/channels/:channelId` lazy-load `ChannelsPage`. The sidebar item is account-customisable
and appends once to older saved lists. The page keeps joined/discover/invitation lists, one room, at
most 300 cached messages per room, and drafts only in memory. The composer is text-only; images and
`okaychat-upload:` references are rejected on the server and image nodes never render in the Markdown
component. Mobile shows the list at `/channels` and a full-width room with a back button at a room URL.
The desktop member/settings panels are sheets. All strings come from `channels.*`, shortcut commands
from the central catalog, and dots/deep links use the existing semantic utilities.

## Deferred

File/image upload, remote/inline images, nested replies or separate threads, DMs, guests, federation,
presence/typing, custom emoji, everyone/group mentions, rich text, pins, room export/import/sharing,
schedule targets, tools/MCP/knowledge/memory/delegation in room AI, autonomous AI triggers, in-place
regeneration/continuation, owner credential lending, custom room prompts beyond the reduced snapshot,
retention/legal hold, edit history/undo, delivery receipts, offline send, push digests, multiple app
writers, cross-tab leader election, and a global search union.

## Verification

`channels.test.ts` exercises authenticated REST, SSE ready/reset/heartbeat/revoked frames and slot
release, live notification ACL filtering, stale mutation cancellation, AI admission, streamed worker
settlement and usage, idle-provider revocation, event pruning/high-water, and restart recovery. Worker
provider calls use a deterministic mocked HTTP transport through the real AI SDK.
