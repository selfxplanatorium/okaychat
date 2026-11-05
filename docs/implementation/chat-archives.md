# Portable conversation archives

A native ZIP archive that carries every branch of selected chats, their message text and reasoning, durable
files, and artifact versions. Import creates new chats and inert historical tool records; it never connects
services, runs tools, or changes an existing chat.

## Wire format (v1)

`okaychat.zip` entries are only `manifest.json` and `assets/<sha256>` (no extension). Export uses method 0
(stored) for predictable bounds; import accepts 0 and 8, rejects encryption, ZIP64, split volumes, and extra
paths. The manifest is `{format:"okaychat.chat-archive",version:1,exportedAt,chats,assets}`:

- chat: `{key,title,createdAt,updatedAt,status,modelRef,selectedLeaf,messages,artifacts,assistant}`;
- message: `{key,parentKey,createdAt,role,parts,generation?}` and may form multiple roots/siblings;
- part: text, reasoning, file (`asset|null` + `missing`), source (http/https only), or an inert tool record
  with input/output and structural asset/artifact references;
- artifact: versioned source plus an optional built-file asset;
- assets: `{key:<sha256>,size,mime,name}`.

`ArchiveGeneration` is display-only and allowlisted. Run ids, provider options, approvals, credentials,
project/memory context, annotations, drafts, schedules, share tokens, and Undo history are never exported.

## Bounds

`shared/chat-archive.ts` holds the limits. The server enforces compressed upload size, expanded sum
(128 MiB), per-entry bytes, entry count, asset/chat/message/part counts, graph depth, JSON nesting, string
bytes, artifact versions, and timestamps. `archive-format.ts` reads the ZIP with fflate's streaming `Unzip`
and aborts as soon as output crosses a cap, so a lying header cannot allocate unbounded memory. Every
declared size and SHA-256 is rechecked against actual bytes; hash equality is corruption detection, not
origin trust.

Uploads remain bounded by the application's 100 MiB request cap, which is stricter than the archive's
128 MiB ceiling. Staging lives under `dataDir/archive-staging/<user>/<job>/`, mode 0700/files 0600, with one
active job per account, a 30 minute lifetime, and a 512 MiB global / 256 MiB per-job budget. Jobs never
resume: startup fails open work and removes staging.

## API and lifecycle

- `POST /api/chat-archives/exports` `{threads:[{id,selectedLeaf?}]}` → 202 `{jobId,expiresAt}`. Ownership is
  checked as a batch; a busy chat is refused. Preparation reads the stored rows in one pass and writes the
  ZIP to staging before the job becomes ready.
- `GET /api/chat-archives/:jobId` returns state, a safe summary (counts, bytes, structured warning codes),
  and the result of a completed import. A foreign id is 404; an expired job is 410.
- `GET /api/chat-archives/:jobId/download` serves a ready export with `application/zip`, an attachment name,
  and `private, no-store`. Repeated downloads are allowed until expiry.
- `POST /api/chat-archives/imports` accepts a raw `application/zip` body, spools and validates it, and returns
  202. Invalid files become failed jobs with `invalid_archive`.
- `POST /api/chat-archives/:jobId/confirm` `{chatKeys}` commits the selection. The same keys on a done job
  return the same result; a different selection is 409. Quota failures leave the job ready, and every write
  is one transaction: no partial chats.
- `DELETE /api/chat-archives/:jobId` cancels preparable work and removes staging. A completed import keeps its
  chats and returns `{ok:true,imported:true}`.

## Import mapping

Validation builds index maps and rejects cycles, duplicate keys, dangling parents, invalid parts/references,
missing selected leaves, and non-contiguous artifact versions. Commit allocates fresh owned ids for threads,
messages, uploads, and artifacts.

- File assets become owned uploads. Raster originals go through `putMedia` (deduped per account, charged
  once); other bytes become upload `data` BLOBs. Imported generated images are byte identities, not generator
  provenance.
- Artifact versions keep their content, built bytes, kind, and version numbers under a remapped id.
- Tool records become `data-imported-tool` parts. They are inert in the UI (`ImportedToolRecord.tsx`) and
  converted to enveloped user-data text by `importedHistoryText()` before model conversion; they never
  become tool calls, approvals, drafts, widgets, or installs.
- Threads have no project, shares, compaction, or memory use; `messages.imported=1` marks the origin.
  `threads.preferred_head` selects the archived leaf until the first new native message, and
  `threads.memory_cursor` starts there.
- Historical usage stays display-only and never enters the dashboard, context totals, or Continue eligibility.
- `threads.imported_assistant_json` keeps portable assistant settings as inactive review data. They are not
  activated by opening or sending.

## Deliberate limits

- Single-chat/sidebar entry points currently use the command `chat.exportArchive` and Settings → Account →
  Chat data; a dedicated sidebar selection toolbar action is not added.
- The import review has no "Review imported assistant" screen yet; the settings are stored inactive.
- Artifact HTML/JS links to old application URLs are not rewritten; the review warns that embedded links may
  require repair. Archives are plaintext and do not promise credential removal from transcript text.

Archive outcomes can feed outgoing webhooks (see `docs/implementation/outgoing-webhooks.md`): an export
emits when preparation reaches `ready`, and an import emits only when the selected chats and the job result
commit (or an active job fails). Review-ready, download, expiry, cancellation, and a quota refusal back to
ready are silent. The wire payload has only the job id, selected count, outcome, and a sanitized failure
code.
