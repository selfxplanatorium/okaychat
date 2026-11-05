# Room archives

One ZIP contains exactly one **room**: never a DM, a personal chat, a Library object, AI settings or
credentials. Import always creates a new private room, owned and joined only by the importer. Historical
text, order, timestamps, quotes, mention spans, reactions, one level of replies and attachment bytes are
preserved; memberships and roles are documentary and grant no access.

## Contract and format

`src/shared/room-archive.ts` is the pure wire contract: the `.okaychat-room.zip` suffix, `application/zip`,
every request/job/summary/warning/error type, and the hard limits. The manifest is exactly
`okaychat.room-archive` version 1 with `room`, `selection`, `identities`, `members`, `messages`, `assets`.
`src/server/channels/archive/format.ts` validates it as closed, ordered data: strict objects, dense
message order, one owner, resolved roots/quotes/mentions/reactions, safe names, canonical text, timestamp
bounds, and every count/size cap. A lexical pass rejects duplicate JSON keys, excessive depth, lone
surrogates and a raw BOM before `JSON.parse`. Personal chat manifests are `wrong_format`; another room
version is `unsupported_version`.

`src/server/archive-zip.ts` is the strict container reader/writer. It checks the EOCD (no comment or
trailing bytes), central and local headers, split/ZIP64/encryption flags, methods 0/8, regular entries,
UTF-8 names with no traversal/backslash/NUL/directories, duplicate and overlapping ranges, declared
sizes, per-entry and total expanded caps, and CRC on read. The writer emits stored entries only and is
used by room export.

## Authority and snapshot

Owner export requires a live owner role plus the channels feature and a room (not a DM). The admin route
requires a live admin role, selects only `kind='room'`, and writes an audit row before returning. Both
charge staging to the requesting account. A ready export rechecks its original authority mode on every
job read and download; losing it cancels the job and answers 404. Room deletion and owner transfer mark
affected owner exports cancelled in the same transaction and clean their stage after commit.

The snapshot runs in one synchronous SQLite transaction: reauthorize, refuse a queued/running room AI run,
validate the selection, read allowlisted rows, and copy referenced attachment bytes. Tombstones are
excluded. A quote whose target is outside the selection becomes `quote:unavailable` with no id or author.
The transaction is released before ZIP compression. A missing or truncated original fails the whole
export.

## Jobs and storage

`room_archive_jobs` is the durable queue: one active job per account, one executing worker, four waiting,
six admissions per account per hour and thirty globally, plus read/confirm buckets. Admission reserves
256 MiB against both the account quota and the shared 512 MiB staging budget (personal chat staging
counts too) before the first byte. Stage directories live under
`dataDir/room-archive-staging/<userId>/<jobId>/` with server-generated names only. Every transition is a
compare-and-set; cancellation and expiry set a durable flag and abort the worker. Export stays ready
until cancel or the 30-minute TTL. A failed unlink keeps the reservation and blocks the next admission
until the janitor retries.

`recoverRoomArchiveJobs()` runs before the listener starts: open jobs become `failed/interrupted`,
uncommitted promotion directories named by trusted journals are removed, and stale stage folders are
swept. `startRoomArchiveMaintenance()` then expires jobs, retries cleanup and prunes bounded terminal
receipts. Nothing resumes.

## Import

Upload is a raw `PUT` buffered under a 64 MiB actual-byte cap, then written to `upload.zip`.
A 60-second deadline and job cancellation cancel the body reader, releasing stalled upload slots. Validation reads the
container once, hashes each asset, sniffs magic bytes, decodes rasters under the existing pixel limits,
refuses SVG, and writes a server-normalized plan (`snapshot.json`) plus stripped manifest. Emails are
counted for review and discarded; they are never stored or matched. The review computes a digest over the
normalized plan, identity resolution and final name. Confirm requires that exact digest and
`acceptWarnings: true`; a changed digest is `409 review_changed`.

Promotion journals each raster attachment reference before writing its original, and reuses that same
attachment id in the database (even when several references share one asset hash). It writes into a
fresh `channel-media/<newRoom>/` directory, then commits in one synchronous transaction: new private
room, importer as sole owner/member, identity rows, messages in dense sequence order, imported provenance
JSON, attachments bound to the new message ids, derived thread state/cursors, one invalidation event,
audit and the done receipt. A quota or capacity failure rolls everything back, removes the promoted
directory and returns the job to `ready` so the review can be retried. A committed room is never deleted
by cleanup.

## Identity and historical projections

`identity.ts` derives a base64url HMAC proof over the local account id with a domain-separated key from
`OKAYCHAT_SECRET`. It recognizes an account only when the proof matches, the account exists and the
channels feature is live. Imported rows always keep `author_id = NULL`; the validated link lives only in
`channel_import_identities`, so recognition never grants edit rights or "mine". Deleting the account sets
the link null and projections become neutral immediately.

Messages store historical mentions/reactions in `channel_messages.imported_json`, never in the operational
mention/reaction tables. Timeline, quote and roster projections expose a discriminated historical author
(`known` with the current local name, or `unknown`), separate read-only reaction counts, and an imported
roster that never increases member counts, enters mention pickers, or shows presence. Native edit routes
answer `409 imported_read_only`; room AI refuses an imported source (`imported_source`); moderators may
tombstone imported human or AI messages.

## Quota

Imported room metadata, message provenance, a fixed 1,024-byte reservation per identity row, and
attachment reference sizes count against the room owner, matching `channelStorageBytes`. A job's
`reservation_bytes` counts against its account until the stage is gone. Conversion subtracts the job's own
reservation before adding final bytes and retained stage, so another account's hold is never ignored.

## Web

`state/room-archives.ts` discards late replies using a monotonic account generation, including when
switching away and back to the same account. It holds one account-bound job and recovers it with `GET /room-archives`; nothing is
stored in browser storage. `RoomArchiveDialog.tsx` covers whole-room or selected-root export, optional
emails, upload, review with warnings/roster/quota, progress, explicit cancel and the imported-room link.
`RoomArchiveRoster.tsx` pages the historical roster. The room list has the import entry, room settings has
the owner-only export action, and the member panel separates the imported roster from current members.

## Deferred

Admin operational job list/cancel UI (the audited API exists), multi-room ZIPs, DM export, merging or
replacing an existing room, live membership/role restoration, arbitrary reply subsets or deeper threads,
public archive links, remote URL imports, passwords/encryption, cross-install identity linking, PII
scrubbing, AI settings/runs, historical notifications, and partial imports.
