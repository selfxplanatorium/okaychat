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

The first appended migration creates every `channel_*` table, expands notification kinds by rebuilding
the table, and adds `usage.channel_id`/`channel_run_id` with a unique index per run. The event singleton
holds an epoch generated with `newId` and a monotonic floor. A second appended migration (`channels-v2`)
adds `channels.kind`/`dm_key`, `channel_messages.thread_root`, `channel_thread_state`,
`channel_thread_reads`, `channel_attachments`, `channel_dm_blocks`, `channel_events.root_id`, and
`notifications.channel_root_id` without rebuilding any existing table.

`channel_search_keys(search_id, message_id)` addresses `channel_messages_fts` by integer rowid. Triggers
index inserts, body/tombstone updates, and deletes; the `BEFORE DELETE` trigger on the key table removes
the FTS row first, so a channel cascade cannot leave stale text. Search authorization (membership,
group eligibility, optional room) is inside the SQL before its limit. Global search adds
`c.kind = 'room'`; a per-room search of a DM still works for its members. Thread replies are indexed like
any other message and carry `threadRootId` in each hit.

## Attachments

A message may carry up to five files. `POST /api/channels/:id/attachments` is a separate multipart router
mounted before the JSON channel router, so its own 10 MiB ceiling applies instead of the 128 KiB JSON
limit. The room owner is charged at upload; the row records that `owner_id`, and binding to a message
requires the live owner to still match. Raster images (sniffed from magic bytes, never the declared MIME)
live as files under `dataDir/channel-media/<channelId>/`; everything else is an opaque BLOB in the row.
SVG is refused. A declared image that is not a raster is stored as `application/octet-stream`.

Attachments are immutable after send: editing a message changes only its text. A tombstoned message's
attachments answer 404 immediately but keep their bytes for 30 days before a bounded purge; a pending
upload older than one hour is removed with its file. `GET /api/channels/:id/attachments/:attachmentId`
rechecks membership and the live message on every request. Raster previews are generated under the
`ch-<channelId>` cache namespace and answered `private, no-cache`; non-raster files are `no-store`
downloads with `nosniff` and a sandbox CSP. Room deletion removes the media directory after commit.

## Threads

Exactly one level of replies exists. A reply names its top-level `thread_root`; a reply to a reply attaches
to the same root and records the specific target in `reply_to`. Threads share the room's `seq`, so the room
timeline filters `thread_root IS NULL` and cursors, FTS, and idempotency keep working unchanged. The write
transaction validates that the root is top-level, live, and in the same room; a reply id can never be a
root, and a top-level post quoting a reply joins that reply's thread.

`channel_thread_state` holds denormalized counts and the newest reply; `channel_thread_reads` is the
per-viewer cursor. A root tombstone removes the state row, tombstones its live replies, and emits one
`message.changed` per reply with `rootId`; a reply tombstone recomputes the counters. A thread holds at
most 500 live replies. `GET /api/channels/:id/messages/:messageId/thread` pages replies (50 max, 30
default) and returns `focusId` when the requested id was a reply. Reply edits carry `rootId` on their
invalidation. The web invalidation pump refreshes both thread projections and room messages, filtering
replies out of the room cache so they cannot affect room reads. The room dot uses the newest reply only,
so your own newest reply hides it; the thread's own unread count is exact.

Replies never enter the room AI transcript, and neither entry point can start a run on a reply or with
`threadRootId` (`thread_ai`). Thread notices go only to the root author and structured mentions; the
room's `notify_mode='all'` does not apply.

## Direct messages

A DM is a `channels` row with `kind='dm'`, `visibility='private'`, an empty name, and a `dm_key` over the
sorted member ids. Membership, ACL, events, read state, and quota keep working; the DM appears in `sync`
with `kind`, `dmMembers`, and `threadsUnread`. Creating the same member set returns the existing row
(200) or `dm_left` when the caller had left. Adding members rekeys the row to the new set, or clears the
key when another DM already holds it, so the original pair's next request opens its own 1:1. New DMs and new memberships require a shared group unless
the caller is an admin, reject either direction of a person-level block, and refuse an unknown or
channel-disabled account with the same 422.

DMs have no AI binding, invites, roles, archive, audience, or metadata edits; every room-only route answers
403. They never appear in discover, global search, or `/api/admin/channels`, and admin inspect, patch,
delete, and moderate answer 404 before a reason check. No audit row names a DM. Leaving transfers ownership
to the oldest remaining member after checking that member’s storage quota; a failed transfer rolls back
the leave or block, including membership, payer changes, and the block row. The last member deletes the
row, its attachments, and its media directory.
Blocking leaves every two-member DM between the pair but keeps group DMs.

## REST

All ordinary responses return `Cache-Control: private, no-store`; a raster attachment preview keeps
`private, no-cache` because the authorization check runs before every conditional request. SSE also
preserves `no-transform`. Bodies are strict Zod objects; the channel router caps bodies at 128 KiB and
individual ordinary reads use 48 KiB. Lists are keyset paged; history uses sequence cursors and never
timestamps. Create and message client ids are durable idempotency keys with canonical request hashes; an
exact replay returns the stored projection, while a reused id with different text is a 409. A message hash
also covers `threadRootId` and the sorted attachment ids, so a retried send with the same files is a
replay and a different set is a 409. Rooms, members, invitations, mentions, reactions, messages, run
outputs, attachments, thread replies, DMs, blocks, and request ids are bounded in `src/shared/channels.ts`.

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
  times out without advancing its undelivered cursor. Heartbeats run on a 15-second deadline, never
  after every wake, so activity traffic cannot multiply keepalives.
- `?ephemeral=1` opts a stream into presence/typing. Its `ready` adds
  `{ephemeral:{v:1,connectionId,activityLeaseMs:75000,typingLeaseMs:6000}}`; a client that does not opt
  in sees the unchanged `{"v":1}`. Ephemeral frames use the event name `ephemeral`, carry **no** `id`,
  never enter `channel_events`, `/changes`, `/sync`, or any durable cursor, and are therefore never
  replayed after a reconnect. A malformed or unknown-version frame clears only indicators.
- `GET /api/channels/changes` is the polling fallback: at most 1,000 raw rows scanned, 200 emitted, and
  the cursor advances through every scanned row. `GET /api/channels/sync` reads joined summaries,
  invitations, and its cursor in one synchronous snapshot.
- Groups, permission changes, account deletion, and room deletion publish a generic `sync`; the web
  transport then refetches and drops caches for rooms that vanished. One transport runs per tab; the
  server allows two streams per account across tabs. Hidden tabs close the stream after 30 s and poll
  once a minute.

## Presence and typing

Presence and typing are advisory, ephemeral, and process-local. They describe an account connected to
okaychat's channel transport, not which conversation it is reading, and they are never delivery or read
receipts. Nothing is stored: a restart shows everyone offline, and the same empty view follows a
reconnect. No activity path writes SQLite; a keystroke never becomes a row.

The two account preferences live in `user_settings.json` as
`channelActivity: {sharePresence, shareTyping}` (missing or invalid means both true). They are
independent: hiding presence can still share typing. Hidden presence projects as `offline`, which the UI
labels "Offline or not sharing status"; no hidden flag, setting value, or last-online time is sent to
another account. Turning either switch off removes the account's contributions at once and needs a fresh
activity update (presence) or new input (typing) to come back.

| Item | Bound |
| --- | --- |
| Connection registry | The existing 256 streams, two per account; one activity entry per opted-in stream |
| Presence lease | Client activity accepted at most every 30 s while active; online for 60 s, `away` until 75 s |
| Idle declaration | 60 s without trusted input; the client sends `idle` once and does not refresh |
| Hidden tab | Idle and typing stop on hide; the durable stream closes after 30 s and no indicators run |
| Disconnect grace | A closed but valid contribution bridges rotation for 10 s; it can never type or publish |
| Typing lease | 6 s; refresh no faster than 3 s and only after more input; stop after 4 s of silence |
| Watches per stream | One channel plus an optional live root; published typing is one scope at a time |
| Output | One replaceable dirty marker per stream, at most one frame per 2 s, a full snapshot every 30 s |
| Frame | 64 KiB UTF-8, 200 presence entries, 400 typing entries; overflow sends `clear` and disables ephemeral output only for that stream |
| Requests | Strict JSON under 4 KiB, identifiers 1–128 URL-safe characters, positive safe sequence |
| In-memory rates | Account 12 activity + 60 typing + 72 combined per aligned minute; connection 8 + 24; 1,024 buckets, 120 s idle expiry, saturation refused with 429 |

`POST /api/channels/activity` replaces the whole connection state
`{connectionId, seq, state, watch}`. The connection id exists only while its stream is live and is bound
to the account **and** the exact session token hash, so a second session cannot drive it; it is never a
credential on its own and never enters storage. Equal or lower `seq` is a successful no-op that renews
nothing. A watch must be a live membership; private/foreign/guessed rooms, bad roots, and a root on a DM
all share one 404. Archived rooms keep presence but ignore the root and expose no typing. The response
is `{acceptedSeq, watchRevision}`; a watch change clears that connection's typing and forces a snapshot.

`POST /api/channels/typing` accepts only the connection's current scope, requires a live active lease,
and answers `409 archived` for an archived room. Disabled sharing or a stale lease accepts as a no-op
after removing the connection's own contribution, so preferences are never disclosed through an error.
Stop is idempotent and only affects that connection: another tab keeps its own lease. A successful human
post clears its author's contributions in the resolved scope after commit, including a top-level quote
that resolves into a thread; an exact idempotent replay does not, and a rolled-back send never does.
Root deletion, room archive, deletion, leaving, removal, and blocking clear affected typing after commit.

Frames are strict unions in `src/shared/channel-activity.ts`: `snapshot` (all currently eligible members
with `online|away|offline`, plus live typing in the watched scopes), `patch` (presence entries and whole
typing scopes replaced), and `clear` (no identifiers at all). Entries are sorted by account id. The
projection checks, for every subject/viewer pair, the live account feature, membership, group
eligibility, archive/root state, and a block in either direction; suppressed presence is `offline` with
no reason. Admin rights grant nothing here, and a status shown in a room never implies a DM. Watches are
indexed by channel, fan-out touches at most the registered watchers, and projection is serialized again
after any backpressure wait, so a revoked identifier is never emitted.

The web keeps one controller per tab (`state/channel-activity.ts`): it starts with the transport, merges
activity and typing to the latest intent, sends one serial request at a time, and keeps no payload,
token, or state in browser storage. Input means trusted keydown, pointerdown, touch, wheel, or scrolling
in the app — never mousemove, animation, synthetic events, or a restored draft. The controller publishes
typing only from the focused composer on real text input (paste, dictation, and IME included) and never
submits on a composition Enter. A frame older than 45 s clears indicators and asks the transport to
reconnect; any bytes reset the separate stall deadline. Polling, offline, hidden, and revoked streams
clear everything and publish nothing. Only the open member panel and a pair DM header show status;
there are no room counts, all-DM subscriptions, or status sorting.

## AI replies

A binding is either a model or a reduced preset snapshot of `{name,modelRef,instructions,reasoningEffort,
sampling}`. Preset origin ids, knowledge, tool policies, projects, and every personal field are dropped
at save. The owner must accept the reduced-snapshot notice; later edits to the preset do not change the
room. Every requester still needs their own authorized connection to the bound model.

A run exists only after an explicit composer chip or message action, and only on a top-level human message
in a room. A DM, a threaded reply, or an attachment-only source is refused before model resolution
(`dm_ai`, `thread_ai`, `attachments_only`). Admission is transactional: it rechecks membership, feature,
model grant, binding, source, room capacity, rates, quotas, and the one open run per room/requester. It freezes up to 60 recent top-level messages ending at the source sequence,
excludes unfinished AI output and every thread reply, removes the source body from the transcript,
encrypts the snapshot, and allocates the AI placeholder sequence and 64 KiB output reservation before
committing. The request hash makes an exact duplicate free.

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
input, a 1 KiB run receipt, an open run's 64 KiB output reservation (counted once as body bytes grow), and
every channel attachment at its upload size. Transfers check the target owner's full limit before changing
`owner_id` and move every attachment row to the new payer. Events, rate windows, read cursors,
memberships, reactions, audit rows, notifications, thread state/cursors, blocks, and FTS copies are
bounded operational metadata, not charged user content. Pending and tombstoned-until-purged attachment
bytes still count.

## Web workspace

`/channels`, `/channels/:channelId`, and `/channels/:channelId/thread/:rootId` lazy-load `ChannelsPage`. The
sidebar item is account-customisable and appends once to older saved lists. The page keeps joined/discover/
invitation lists, one room, at most 300 cached messages per room, at most three open threads, and drafts,
chips, and DM names only in memory. The composer attaches raster previews and files, accepts a drop and a
clipboard paste, and disables send while a file is uploading. A message renders its attachments and a
reply chip; the thread panel reuses the message row and composer with AI hidden. The list has Joined,
Direct messages, Discover, Invites, and Archived tabs; a DM title is built from `dmMembers` with
`formatList`. Mobile shows the list at `/channels` and a full-width room or thread with a back button; the
desktop thread panel and member/settings panels are sheets. All strings come from `channels.*`, shortcut
commands from the central catalog, and dots/deep links use the existing semantic utilities.

## Deferred

Multiple reply levels, thread renaming/participant lists, thread-level AI or summaries, attachment editing
or add/remove on an existing message, image annotation, camera capture, client-side compression, per-room
attachment byte caps beyond the owner quota, deduplication of identical attachment bytes, virus scanning,
PDF thumbnails, audio/video playback, per-DM AI bindings, DM topics/names/icons/invite links/
discoverability/cross-room search/retention/admin inspection/export, blocking scoped per DM, read
receipts, forwarding, guests, federation, custom emoji, everyone/group mentions, rich
text, pins, room export/import/sharing, schedule targets, tools/MCP/knowledge/memory/delegation in room AI,
autonomous AI triggers, in-place regeneration/continuation, owner credential lending, custom room prompts
beyond the reduced snapshot, retention/legal hold, edit history/undo, delivery receipts, offline send,
push digests, multiple app writers, cross-tab leader election, and a global search union.

## Verification

`channels.test.ts` exercises authenticated REST, SSE ready/reset/heartbeat/revoked frames and slot
release, ephemeral negotiation and idless-frame isolation, live notification ACL filtering, stale mutation cancellation, AI admission, streamed worker
settlement and usage, idle-provider revocation, event pruning/high-water, and restart recovery.
`attachments.test.ts` covers owner charging, authorization on every read, tombstone retention, pending TTL,
binding guards, SVG/fake types, caps, quota, and room deletion. `threads.test.ts` covers placement,
paging, read cursors, the room dot, AI exclusion, notices, and the reply cap. `dms.test.ts` covers
creation/idempotency, shared-group and block rules, member changes, leaving/deletion, admin exclusion,
room-only refusals, AI refusal, and notices. Worker provider calls use a deterministic mocked HTTP
transport through the real AI SDK.

`activity.test.ts` covers the 60/75-second boundaries, sweep/grace/rotation, two-tab typing, scope
switches, opt-outs, blocks, rate windows, frame overflow, rollback-safe hooks, and the no-SQL
invariant. `activity-routes.test.ts` covers auth/session binding, strict bodies and CSRF, uniform 404,
archives, 429, admin non-membership, and stream negotiation. The web suites cover batching, refresh
thresholds, coalescing, stale generations, and the poll-loop/cooldown regression.

A thread jump may name the reply to land on (`?focus=`). Without a cursor the server bounds the page at
that reply, so an old reply opens on its own page instead of the newest page where it does not appear.
