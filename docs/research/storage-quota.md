# Storage quota

Built 2026-10-20. Every byte a user owns counts against one per-user limit; the server rejects writes that would pass it.

## What counts

`storageUsedSql` in `src/server/quota.ts` sums, per user:

- `uploads.data` (attachments kept for import)
- artifacts: `length(CAST(content AS BLOB)) + size` — the source text plus the built file, for **every version**
- `user_fonts.data`, `user_avatars.data`, `memories.content_enc`, `project_files.content`
- `sandbox_files.data` (run_code outputs copied out of the sandbox, see `code-sandbox.md`)
- `images.size` (generated PNGs live on disk, not in SQLite; the column records their size)

Not counted: config-sized rows such as provider keys, MCP tokens, codex auth, and settings.

## Limits and enforcement

- Default limit: `OKAYCHAT_STORAGE_LIMIT` bytes (default 1 GiB, see `.env.example`).
- Per-user override: nullable `users.storage_limit` column, set by an admin in Admin settings (entered as MB/GB; empty resets to the default).
- `assertStorage(userId, incoming)` throws `QuotaError` when `used + incoming > limit`.
- HTTP write paths (`/files/store`, `/files/extract`, `/fonts`, `/account/avatar`) answer **413** with a JSON `{ error }` the UI shows.
- Tools (artifacts and documents via `saveVersion`, `generate_image`, run_code output import) throw and the model sees the quota message as the tool error. `run_code` is best effort: files that cannot be stored keep a direct sandbox URL and the result carries a `storageWarning`.

Versioning note: artifact versions accumulate by design, so every version's bytes count — an edit does not free the old version's space.

## UI

- `GET /api/storage` returns `{ used, limit, defaultLimit }`.
- Account settings shows a bar and numbers (`StorageMeter`).
- The chat shell shows a dismissible warning notice from 90% (`StorageNotice`), dismissed per browser session; at 100% it becomes an error notice and reopens.
- Admin settings lists each user's usage and limit and can set or reset the per-user limit.

## Tests

`src/server/quota.test.ts` covers the sum across all counted tables, the `/api/storage` reply, 413 enforcement on uploads/fonts/avatars, the artifact tool error, and the admin set/reset path.
