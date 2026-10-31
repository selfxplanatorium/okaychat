# Library

`/library` shows durable files belonging to the signed-in account. `GET /api/library` unions the
existing stores; there is no duplicate catalog table.

| Source | Store | Size | Association |
| --- | --- | --- | --- |
| Attachments (images, documents, text/code and arbitrary binary files) | `uploads.data` | Original bytes | Explicit thread for materialized inline attachments; otherwise the latest owning chat mentioning `file_id`; pinned originals also link through `project_files.upload_id` |
| Generated images | PNGs on disk + `images` | Stored `images.size` (legacy sizes backfilled at startup) | Owning thread and project |
| Artifact/document | Latest `artifacts` version, selected explicitly by maximum version | UTF-8 source + built bytes | Owning thread and project |
| `run_code` outputs | `sandbox_files.data` | Durable copied bytes | Owning thread and project |
| Skills | `skills` + `skill_files` | Stored UTF-8 instructions, metadata and references | Account; conversation-created skills are generated, manual/source skills are uploaded |

All queries restrict ownership, including thread joins and file routes. Temporary chats produce no
Library entries. Explicitly saving one into normal history stores its inline attachments at that point.

## Attachment lifetime

Every accepted non-temporary attachment is stored independently of sandbox configuration. Images keep
their existing data URL parts, with an additional attachment header carrying the stored `file_id`.
Native PDFs, extracted documents, text/code and the binary fallback also retain original bytes;
storage failures block sending instead of being swallowed. Unsupported binary formats are made
available to tools by `file_id` rather than decoded as text.

Uploads are persistent until Library or account deletion. There is no seven-day pruning, and deleting
a chat or project does not remove its uploaded originals. Temporary extraction remains non-persistent.
A transactional migration materializes existing base64 inline attachments up to the 25 MiB upload
limit without rewriting chat content, preserving provider prompt prefixes. It runs once, so deleted
files cannot reappear at restart. Identical message replays likewise cannot restore deleted copies.

## Filtering and pagination

Kinds: `image`, `pdf`, `document`, `spreadsheet`, `code`, `other`. Filters: `kind`, `source`
(`uploaded`/`generated`), `thread`, `project`, literal name search `q`, inclusive timestamps `from`/`to`.
Sorts: `newest`, `oldest`, `name`, `size`. Page size defaults to 50 and is capped at 100.

Keyset cursors are base64url JSON `{ v, key }`. Name comparisons use NOCASE for both ordering and tie
breaking; unique keys break equal values. Sizes are available before sorting, including generated
images. Artifact source kind is retained separately from the Library category so HTML/SVG/Markdown
previews use the correct renderer. Malformed cursors return an empty page.

Skeletons appear only for loads slower than 400 ms (`Delayed` in `components/ui/skeleton.tsx`, a timer
because reduced motion zeroes animation delays). `state/library-cache.ts` keeps each filter set's first
page for the session: a repeat visit shows it at once and refreshes it in place, and hovering, focusing,
or pressing the sidebar Library link prefetches the default page when nothing is cached. Deletions clear
the cache. Account changes clear cached pages and revoke in-flight requests before startup data loads, so one account cannot see another account's cached file list. Deletions also revoke in-flight requests so they cannot restore removed entries. A filter, sort, or search change keeps the current items on screen until the new first page
arrives (they dim only if it takes over 300 ms). Files and Archived chats stay mounted and are hidden
with `hidden`, so switching sections never refetches behind a skeleton.

## Downloads, previews and deletion

- `GET /api/uploads/:id/file` serves owned originals. Raster images and PDFs can be inline; SVG and
  other active content download. Every upload receives `nosniff`, a sandbox CSP, and `private, no-store`.
- Durable sandbox outputs use `/api/sandbox/:threadId/stored?path=...`. Downloads remain attachments;
  `preview=1` permits only PDF/raster inline viewing with the same security headers. Scratch proxy URLs
  are only a fallback when copying failed or exceeded the 50 MiB cap/quota.
- `/api/library/{upload|sandbox}/:id/preview` returns bounded JSON text or spreadsheet preview data.
  React renders text literally; HTML is never executed. DOCX uses the shared client renderer. Artifact
  previews retain their existing sandboxed frame/document renderers.
- Skills have `/api/library/skill/:id/preview` (instructions and reference index) and `/file` (a ZIP
  containing SKILL.md plus references). These resolve account ownership before reading any files.
- Generated images and artifact documents use their existing owner-checked routes. Image MIME metadata is authoritative even when the stored filename ends in `.png`.
- `DELETE /api/library/{upload|image|sandbox|skill}/:id` deletes owned data and frees quota. Skill deletion
  includes its references. Artifact versions remain part of chat history and are removed with the chat.

The lazy navigation page provides grid/list layouts, filters, debounced search, infinite pagination
with a Load more button, previews, download/open-chat actions, and confirmed deletion. Everything here is served
from SQLite and works without any sidecar; when the code sandbox is down the page shows a quiet note that new code
execution is unavailable while saved outputs still download (`docs/implementation/service-health.md`). Failed requests
show errors. Deletion refreshes storage usage. Tests exercise ownership of listings, previews, downloads
and deletes, latest-version selection, name/size pagination, persistence, and quota reclamation.
Test fixtures use distinct, deterministic creation timestamps so newest-first assertions do not depend
on wall-clock timing.

## Archived chats

The page switches between Files and Archived chats. The archived view lists `GET /api/threads?status=archived`
(all projects) with project name and last activity. Restore PATCHes `status: regular` and reloads the
runtime thread list; Open also clears the project filter, navigates to `/`, and selects the chat. Export uses
`/api/threads/:id/export`; Delete permanently confirms first. The view refetches whenever the runtime's
active thread ids change, so a sidebar Archive shows up without a reload. `LibraryPage` renders inside
`RuntimeProvider`, so `useAui` is available.

## Multi-selection

Files and Archived chats each have a Select/Done toggle beside the section switch. In selection mode a
card or row is a checkbox (Shift+click extends from the last click), and a floating bar offers Select all
plus bulk actions: Download and Delete for files, Restore and Delete for archived chats. Select all on Files
fetches the remaining pages first, so it covers every match of the current filters, not only the loaded
pages. Filter changes clear the selection. Artifacts are not deletable here; the delete dialog says how many
selected items stay. Bulk actions fan out over the existing per-item endpoints, four at a time (downloads
one at a time, since browsers drop bursts); failures stay selected with a summary. Escape leaves selection
mode and Ctrl/Cmd+A selects all, except while typing or while a dialog or menu is open. Shared pieces live
in `components/ui/selection.tsx` and `lib/selection.ts`.
