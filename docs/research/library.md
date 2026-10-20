# Library

The Library (`/library`) lists every file the agent received or produced for the current account:
uploaded attachments, generated images (`generate_image`), and the latest version of each artifact
(documents and text artifacts). Only the current user's items appear; anonymous (`tmp_`) chats create
no stored data, so nothing from them can show up.

## What is catalogued

There is no dedicated library table. `GET /api/library` (`src/server/library.ts`) is a UNION over the
existing stores, each with its own quirks:

| Source | Table | Name | Size | Thread / project |
| --- | --- | --- | --- | --- |
| Generated image | `images` | The prompt (truncated in the UI by CSS) | Stat'ed from disk per page (not stored in the table) | Own `thread_id` |
| Upload | `uploads` | Original filename | `length(data)` | Recovered from the message text: the most recent chat whose stored JSON content mentions the upload id (uploads carry no thread column). `LIKE '%' || u.id || '%'` — the id is unique, and the JSON-escaped `file_id="..."` form never appears literally |
| Artifact (latest version) | `artifacts` | Title | `size` for documents, `length(content)` for text artifacts | Via the owning thread (artifacts have no `user_id`; the join enforces isolation) |

Kinds are computed in SQL per source and normalized to `image`, `pdf`, `document` (Word),
`spreadsheet`, `code` (all text artifacts), and `other` (uploads that are none of the above, such as
CSV or text files).

Not in the library, on purpose:

- **`run_code` outputs.** Sandbox files live only in the sandbox container and are served through
  `/api/sandbox/:threadId/files`; nothing about them is stored in SQLite, so there is nothing durable
  to list. See `docs/research/code-sandbox.md`.
- **Uploaded images.** `SimpleImageAttachmentAdapter` sends them as data URLs; they never reach the
  server as bytes.
- **Old uploads.** `uploads` is a 7-day import cache (`files.ts` prunes it), so attached PDFs/DOCX
  files drop out of the library when the model can no longer import them.

## Query and pagination

`listLibrary` builds the UNION as a subquery and applies filters outside it: `kind`, `source`
(`uploaded`/`generated`), `thread`, `project`, `q` (name search with `%`/`_`/`\` escaped, `ESCAPE '\'`),
`from`/`to` (ms, inclusive), `sort` (`newest`, `oldest`, `name`, `size`), and `limit` (default 50, max 100).

Pagination is keyset: the cursor is base64url JSON `{ v, key }` where `v` is the last row's sort value
(created_at, name, or size) and `key` the unique row key, so ties and equal names cannot skip or
repeat rows. A malformed or stale cursor reads as "no more pages" instead of erroring. The image
sizes for a page are filled in by `fs.stat` after the rows are fetched — never inside the query.

## Serving and deletion

- Uploads had no serving endpoint; `GET /api/uploads/:id/file` (`files.ts`) serves the bytes to the
  owner. Images and PDFs go `inline` (the browser's own viewers); everything else downloads with
  `Content-Disposition: attachment` plus a `sandbox` CSP, so a model-crafted HTML upload cannot run
  script on the app origin.
- Images use the existing `/api/images/:id`; documents use the existing artifact
  `/threads/:id/artifacts/:aid/file` (+ `/preview` for spreadsheets), both already auth-checked.
- `DELETE /api/library/image/:id` and `DELETE /api/library/upload/:id` delete the row (and, for
  images, the file on disk), scoped by `user_id`. **Artifacts are not deletable from the library:**
  they belong to the chat history, and removing a version would break the messages referencing it.

## Web

`src/web/components/library/LibraryPage.tsx` replaces the placeholder in `NavigationPage`. It loads
lazily with the navigation chunk (`preloadable()`), keeps the grid/list choice in
`localStorage["okaychat:library-view"]`, and renders:

- **Grid**: image thumbnails (`<img>`, lazy) or kind icons; **list**: name, type, size, chat, date.
  Sizing uses `pointer-coarse:` variants per `docs/research/mobile-pwa.md`.
- **Filter bar**: kind chips, source select, project select (from the `useData` store), debounced
  name search, sort select.
- **Preview dialog**: images inline; PDFs in the browser viewer; DOCX through the shared
  `DocxPreview`; artifact documents through `DocumentPreview` and text artifacts through
  `frameDocument`/`SimpleMarkdown`, exactly like the chat's artifact panel. Actions: download (bytes
  or, for text artifacts, the latest version's content), open the source chat (reload thread list →
  navigate → `switchToThread`, same as ScheduleSettings), and a two-step delete for deletable items.
- **Loading/empty states** with skeletons, infinite scroll via IntersectionObserver plus a real
  "Load more" button, and a request-id guard so a filter change cannot mix pages from an in-flight
  response.

Depth comes from `depth-primary`, `depth-canvas`-style token shadows
(`shadow-[var(--depth-highlight),var(--shadow-raised)]`), and theme tokens only — no hardcoded colors.
