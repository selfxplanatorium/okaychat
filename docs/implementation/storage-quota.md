# Storage quota

Each account has one limit: `OKAYCHAT_STORAGE_LIMIT` bytes (default 1 GiB), overridden by nullable
`users.storage_limit` through the admin API/UI. `GET /api/storage` returns `{ used, limit, defaultLimit }`.

Notes count their stored title and body bytes; calendar events count title, description, location, and
URL bytes. Tags, FTS copies, source pointers, reminder ledger rows, zones, offsets, and hashes are
bounded metadata and are not charged. Creates charge the full payload, edits charge net growth in the
same transaction, and deletes/shrinks work over quota.

## Accounting

`src/server/quota.ts` computes usage from the owning account's rows:

- Persistent original attachment bytes in `uploads`, including images, text/code, binary files, and project attachments.
- Every artifact version: UTF-8 source bytes plus built document bytes.
- Generated images (`images.size`, backed by files on disk; MIME comes from the stored image metadata); pre-quota images are stat'ed at startup to backfill their size.
- Durable `sandbox_files.data`; scratch workspaces are outside account storage.
- Uploaded fonts, account avatar, encrypted memory bytes (facts and summaries), and extracted project-file text.
- Skill names, descriptions, instructions, reference paths and reference contents, counted as UTF-8 bytes across `skills` and `skill_files`.
- Raster image originals in the file-backed media store (`media.size`), once per account however many uploads, run outputs, forks, or the avatar point at them. Their previews in `media-cache/` are a regenerable cache and do not count (see `media.md`).
- Saved prompt text: UTF-8 bytes of `saved_prompts.name`, `shortcut`, and `body`. Prompt edits charge net growth; bookmarks and annotation metadata are not charged.
- The encrypted comment of private answer feedback (`message_feedback.comment_enc`). A removed rating clears the ciphertext and frees its bytes; the tombstone row itself is bounded fixed metadata and is excluded.
- Stored message translations (`message_translations.translated`), UTF-8 bytes only: `lang`, hashes, and timestamps are bounded metadata. Deleting a language frees its bytes on the next `storageUsed`; deleting the chat cascades them. See `message-translation.md`.
- Message JSON (`messages.bytes`), without inline `data:` URLs, which are charged once as uploads, plus the encrypted first original of an edited assistant reply (`messages.original_enc`). The original is retained after Undo. Branching charges the copied message and original. Existing rows are backfilled by a migration.

Settings, provider/MCP credentials, skill-source credentials, editable email drafts (`email_drafts`,
bounded by 100 per chat and 2,000 per account) and other small configuration rows do not count. Retained speech recordings (`speech_recordings`, only when an admin sets a retention period) do not
count either: the admin chose to keep them, and the purge bounds them (see `speech.md`). Message JSON is charged after stripping inline file data URLs; the owned original attachment
is charged once rather than counting those bytes again in the message. Stored chats now hold `okaychat-upload:` references
instead of inline images (user attachments and provider image output in assistant replies); legacy inline images are moved to the media store and referenced by a resumable background
migration (`media.md`). Existing files are grandfathered even if migration puts an
account over quota; subsequent growth is refused.

## Enforcement and deletion

`assertStorage(userId, incoming)` throws `QuotaError`, an HTTP 413 exception, for positive net growth
that would exceed the limit. Replacement avatars, sandbox outputs and skills subtract their old
stored bytes; shrinking or equal-size replacements remain possible after an admin lowers a limit. For
avatars and sandbox outputs `chargeReplacement()` (`media/store.ts`) computes what the replaced row frees:
its BLOB, plus its media original only when no other upload, output, or avatar still points at it. New
bytes that deduplicate to media the account already holds are never refused. The old original is released
only after the transaction commits (`afterCommit()` in `db.ts`), so a rollback never leaves a reference to a
deleted file.
New artifact versions retain their predecessors and therefore charge the entire new version. Repeated
writes during the same turn overwrite that turn's version and charge only net growth.
Checks and SQLite writes have no intervening asynchronous work. Multi-skill imports and message
attachment materialization use transactions; nested helpers use SQLite savepoints.

Enforcement covers upload storage/extraction, project original bytes plus extracted text, memory
writes/imports, avatars, fonts, artifact/document versions, generated images, and every skill creation,
edit, source install or import. Attachment adapters propagate failures, including native PDF, image,
text and binary storage failures; they cannot silently continue with only a browser copy.

Library deletion immediately releases the deleted upload, generated image, sandbox output, or skill
package's charged bytes (including skill references). Deleting an original project attachment leaves
its separately charged pinned text intact. Project/chat deletion does not remove persistent uploaded
originals; those last until Library deletion or account deletion. Chat deletion cascades artifact and
sandbox-output rows and removes its generated images. Account deletion cascades all owned SQLite
files and removes the generated-image directory.

`run_code` copies each returned output up to 50 MiB before returning a durable URL. Files exceeding
that cap, failing to copy, or exceeding quota have a `storageWarning` and only a scratch download URL;
they are not durable and disappear with the workspace. Quota rejection preserves the previous durable
copy when an attempted replacement cannot fit.

Temporary attachment extraction/storage (`temporary=1`) bypasses persistence and quota. `tmp_` chats
cannot create stored files or run persistent tools. Explicitly saving a temporary chat to normal
history stores its inline images once in the media store (enforcing quota) and rewrites those parts to
references; other inline files are materialized as uploads with their message parts unchanged.

## UI and checks

The account page shows a storage meter; the chat notice warns at 90% and reports full storage at
100%. Dismissal is scoped to the account and browser session. Usage refreshes after API mutations,
chat completion, page focus, and account-page entry; the initial storage request starts with the
shell's other startup requests. Admins see usage and can set/reset per-user limits.

Tests cover ownership, UTF-8 accounting, every principal write path, replacement deltas, failed-import
rollback, temporary non-persistence, durable outputs, legacy migration/restart behavior, and Library
deletion freeing capacity for another write.

## n8n agents

n8n definitions charge name/description/avatar/config ciphertext to the owner; encrypted sessions and transcript hashes charge the chatting account. Request rows are bounded operational counters, without prompts or response text. See [n8n agents](n8n-agents.md).

## Wave 2 additions

- Assistant preset name/description/config bytes and each thread's `assistant_json`/`imported_assistant_json`
  count. Replacement writes charge net growth, so clearing or shrinking stays possible over quota.
- A generation receipt reserves a fixed 64 KiB (`RUN_RECEIPT_BYTES`) plus its `config_json` before upstream,
  covering numeric usage/status and at most 100 deduped segments. This keeps the final accounting write
  possible after a provider was already paid.
- Archive staging is disk-bounded separately (512 MiB global, 256 MiB/job, 30 minutes) and is not charged to
  the account. Final imported messages, uploads/media, artifacts, and inactive assistant settings count
  through the normal sums when confirmed.

## Evaluations

- Dataset name/description, case text and the tag JSON, run label/target/judge config/safe error text,
  result output/error text/case snapshots, and score comment/rationale bytes count. Judge usage columns
  are inside the per-result reservation.
- A launch reserves 48 KiB per result plus the snapshot bytes before any provider request, so the final
  result write cannot fail after the model was paid. The storage sum retains this floor for every
  result (including completed results), with output, errors, and judge rationale consuming the same
  reservation rather than being charged twice. Deleting the run releases it. Case writes, dataset edits,
  manual comments, and judge configs charge net growth; deleting a dataset or run frees its bytes.

## Wave 3 additions

- A frozen share snapshot charges `snapshot_json` plus `snapshot_assets_json` bytes to the link's owner.
  Switching the link back to live, refreshing it, or revoking it frees those bytes; a refresh charges
  only the net growth.
- Tags, tag filter presets, notification rows, and comparison group/pane metadata are not charged.
  Comparison pane threads and their messages count exactly like normal chats; deleting the group frees
  them.

## Team channels

Room metadata (name, description, reduced AI binding), every member's message bodies, run config and
encrypted frozen input, a 1 KiB run receipt, and an open run's 64 KiB output reservation count against
the current room owner. Body bytes are counted once; an open run only tops the reservation up to 64 KiB.
Transfer checks the target owner's full limit before changing `owner_id`. Events, rate windows, members,
read cursors, reactions, audit rows, notices, and FTS copies are bounded operational metadata and are not
charged. See `docs/implementation/channels.md`.


## Custom tools

Each custom definition charges its name, description, icon, schema, base key and encrypted config/secrets once. Every execution row reserves a fixed 128 KiB; deletion cascades runs and counters.
## External API keys

Each retained `api_keys` row reserves exactly 1,024 bytes. Requests, audit, rate windows, and the `api`
usage ledger are bounded operational metadata and are not charged. Revoking or editing a key cannot grow
the reservation, so it works when storage is full; pruning a tombstone frees 1 KiB. Generation writes no
transcript or files, so an API call does not require spare content storage.
