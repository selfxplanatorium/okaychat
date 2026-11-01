# Image media

How okaychat stores, previews, serves, and sends raster images. Code: `src/server/media/` (`sniff.ts`,
`store.ts`, `variants.ts`, `refs.ts`, `stream.ts`, `maintenance.ts`), `src/web/lib/media.ts`, and
`src/web/components/ui/owned-image.tsx`.

## Storage

| What | Original bytes | Metadata |
| --- | --- | --- |
| Uploaded images (chat attachments, project/knowledge/email uploads that sniff as raster) | `dataDir/media/<userId>/<mediaId>.<ext>` | `media` row; `uploads.media_id`, `uploads.data` is an empty BLOB |
| Saved run_code images | same | `media` row; `sandbox_files.media_id` |
| Profile picture | same (server re-encoded, see below) | `media` row; `user_avatars.media_id` |
| Generated and MCP images | `dataDir/images/<userId>/<imageId>.png` (any format; `images.mime` is authoritative) | `images` row, `image_threads` references |
| Everything else (PDF, DOCX, text, SVG, audio, non-raster outputs) | SQLite BLOB as before | unchanged |

- `media` holds owner, SHA-256, sniffed MIME, byte size, and header dimensions. Identical bytes are stored once
  **per account** (`putMedia` looks up `(user_id, sha256, size)`); accounts never share a media row.
- Originals are written with temp file + fsync + rename before the row is inserted. A failed insert removes the
  file; a rolled-back outer transaction leaves an orphan file that GC removes.
- Types come from magic bytes (`sniffRaster`): PNG, JPEG, WebP, GIF, AVIF. A declared `image/*` that does not
  sniff is stored as an opaque `application/octet-stream` BLOB; SVG stays an `image/svg+xml` BLOB that is only
  ever served as an attachment. SVG is never decoded or rasterized in the app.
- Header dimensions above 100 megapixels are refused before anything is written.
- `media_id` columns have no foreign key (so the columns stay droppable in migration tests). Lifetime is
  explicit: `releaseMedia(id)` deletes the row, original, and variants once no `uploads`, `sandbox_files`, or
  `user_avatars` row points at it; GC catches whatever a crash or cascade left behind. Inside `tx()` the
  release waits for the outermost commit (`afterCommit()` in `db.ts`) and is dropped on rollback, so a
  restored reference never points at a deleted file.

## Validation

| Source | Check | A damaged file |
| --- | --- | --- |
| Uploads, run_code outputs, legacy migration | Magic bytes and the header pixel bound, synchronously in `putMedia` (no decode) | Stored losslessly; previews answer 422 and the web shows the fallback |
| Generated and MCP images (`storeImage`) | `inspectRaster()`: every pixel of every frame decoded | Refused (`null`), nothing stored |
| Profile pictures | Full decode and re-encode (`normalizeAvatar`) | 422 |

`inspectRaster()` opens the input with `animated: true` and `failOn: "error"`, refuses more than
`MAX_FRAMES` (1,000) frames, and lets `limitInputPixels` bound all frames together (100 MP). It then runs
`stats()`, which must read every pixel inside libvips and returns only per-channel numbers, so no raw buffer
reaches JS. A truncated JPEG, PNG, WebP, or AVIF fails there. libvips accepts a GIF cut off between frames,
so a GIF must also end with its trailer byte. The work runs in the shared processing queue. The input is
never changed.

## Processor

`sharp` (libvips) 0.35.x. Chosen because it is maintained, decodes every format we accept with bounded
`limitInputPixels`, applies EXIF orientation (`autoOrient`), strips metadata, keeps alpha in WebP, and ships
prebuilt binaries (`@img/sharp-<platform>`, bundling libvips) for glibc linux-x64/arm64, which the
`node:22-bookworm-slim` build and app stages use. `npm ci` in the build stage installs the binary for the build
platform and the app stage copies `node_modules`, so no compiler, apt package, or extra Dockerfile step is
needed. Costs: about 20 MB of native code in the image, and libvips memory while a job runs. Mitigations:
loaded lazily on the first image job (`variants.ts`), `sharp.cache(false)`, `sharp.concurrency(1)`, and an
in-process queue of `OKAYCHAT_MEDIA_CONCURRENCY` jobs (default 2) with single-flight per variant file. A musl
(Alpine) base would need the `linuxmusl` package instead. The pure-JS alternatives (jimp and similar) decode
everything into JS memory and lack AVIF, orientation, and animated-frame handling.

sharp also links librsvg. The app never passes SVG to it: every decode is behind `sniffRaster`, and
`inspectRaster` additionally rejects any format sharp reports outside PNG/JPEG/WebP/GIF/HEIF(AVIF). Every
decode (variants, validation, avatars) goes through the same queue.

## Variants

A fixed set, by long edge, never upscaled: `thumb` 256, `medium` 640, `large` 1280. Requested as
`?variant=<name>` on the original's own URL; any other value is 400, so the cache cannot grow by arbitrary
sizes.

- Static WebP (thumb q70, medium q78, large q80, alpha q90), orientation applied, metadata stripped, sRGB.
- Animated GIF/WebP originals get a static first-frame preview; the original keeps every frame.
- When the encoded variant is not smaller than the original, the original is served and an empty `.orig`
  marker remembers that without a second encode.
- A decode failure (corrupt, truncated, over the pixel bound) answers 422; the web shows a fallback with Retry
  and Open original. A preview never silently becomes the original.
- Files: `dataDir/media-cache/<userId>/<key>.<variant>.webp` (key = media id or generated image id). They are
  regenerable and **not** charged to the user's quota. GC trims the cache to `OKAYCHAT_MEDIA_CACHE_MB`
  (default 1024) oldest first and removes previews of deleted originals.

Measured on the test fixtures (`media.test.ts`, run with `MEDIA_SIZES=1`):

| Fixture | Original | thumb | medium | large |
| --- | --- | --- | --- | --- |
| 2560×1600 UI screenshot, PNG | 999 KB | 3.5 KB | 37 KB | 181 KB |
| 2400×1600 photo, JPEG q92 | 1.29 MB | 2.0 KB | 6.3 KB | 56 KB |

## Serving and caching

`serveImage()` (`variants.ts`) serves originals and variants for `/api/uploads/:id/file`, `/api/images/:id`,
`/api/sandbox/:threadId/stored`, `/api/account/avatar`, and the public share image routes.

- Callers authorize first (owner lookup, or live share + visible branch). Only then is `If-None-Match`
  compared, so a 304 is never answered for a foreign or revoked asset.
- `Cache-Control: private, no-cache` and an `ETag` (media digest or immutable generated-image id, plus the
  variant). The browser revalidates every reuse with a cheap 304; an account switch, deletion, or share
  revocation applies immediately. No `immutable`/`max-age` on owned or shared images.
- `Content-Length` is set; a missing original is 404 before any stream starts.
- Uploads keep `Content-Security-Policy: default-src 'none'; sandbox` and `nosniff`; sandbox outputs keep their
  download headers (inline only with `preview=1` for safe types).

## Chat messages

Stored chats reference images as file parts with `url: "okaychat-upload:<uploadId>"`, optionally followed by
`#sha256=<digest>` when the server made the reference. The web `StoredImageAttachmentAdapter` uploads the
file to `/files/store` first (the server returns the sniffed MIME; anything that is not PNG/JPEG/WebP/GIF/AVIF
is refused as an image) and sends only the reference plus the `<attachment … file_id>` text part. History
loads and chat requests therefore carry no base64 for attachments.

- The scheme is absolute on purpose: assistant-ui wraps relative paths into data URLs
  (`toMediaWireUrl`), and a custom scheme is not fetchable by anyone. The web strips the fragment when it
  builds the preview URL.
- `appendMessage` runs `normalizeImages` on user and assistant messages: any inline raster data URL in a
  file part (legacy clients, Save to history of a temporary chat, provider image output in a reply) is
  stored losslessly as an upload and rewritten to a reference before the row is compared or charged.
- Identity is the content digest. A resent inline part whose bytes match a reference already in the stored
  row keeps that reference, even when its upload was deleted in the Library (the digest is in the URL), so a
  stale tab cannot recreate a deleted file. Different bytes in a part are a real replacement and are stored.
  A reference without a digest whose upload is gone is matched by position and file name instead, since its
  bytes can no longer be compared.
- Edited replies (`edited_at` or `original_enc`): normalization only maps resent bytes back to the row's own
  references and never stores new ones. A stale tab resending the reply's own image is not a conflict; new
  image bytes are, and the refused write leaves no upload or media row. Edit and Undo change only text parts,
  so a reference survives both.
- An assistant part that fails validation (over the pixel bound) stays inline rather than block the reply
  from being saved; it is then charged as message bytes. A user message with such a part is refused (422).
- Live streaming: `stream.ts` materializes supported provider image chunks before they reach the browser or
  resumable stream buffer. The live tab receives the owned reference too, so subsequent requests do not
  resend the original. Storage failures become safe stream errors rather than an inline-data fallback.
- Message writes acknowledge canonical image parts as small patches (`shared/media.ts`). The browser applies
  them before caching an acknowledged row; normalization never leaves base64 images in IndexedDB while the
  server has a reference. Other file bytes (such as inline PDFs) are not echoed in the acknowledgement.
- Temporary chats are never normalized: their images stay inline in memory and are never stored.
- Model boundary: `resolveImageRefs` (in the `prepare` step of `historyMessages`, used by chat turns and
  compaction) replaces each reference with the **owner's original bytes** as a data URL. A reference the
  account does not own, a deleted upload, or a non-image upload becomes a short text note. Any other non-data
  file URL is replaced with a note too, so the AI SDK never downloads a client-chosen address and providers
  never receive an app URL. Display previews never reach a model.
- Shares, PDF export, and forks treat references in assistant replies like attachments: the share serves the
  upload only while its branch shows it, export embeds a preview, and a fork keeps the reference (uploads
  outlive chats).
- Context estimates (`estimateTokens`) count every data URL or `okaychat-upload:` reference as
  `FILE_TOKENS` (1,500), not as characters. Provider-reported usage replaces the estimate after the reply.

## Lifetime

- Library deletion removes the upload row and, when unshared, the original and previews. Chats that showed
  it render the image fallback and the model gets "no longer available". Nothing recreates it.
- Thread deletion leaves uploads in the Library (unchanged rule). Generated/MCP images live while any chat
  references them: `image_threads` gets a row for the generating chat and for every fork whose copied
  messages show the image (`copyImagesForBranch`), and `deleteThreadImages` deletes only images with no
  reference left. Shares accept an image of the shared thread or one referenced by it.
- Forks also get `sandbox_files` rows for the stored run images their messages show, pointing at the same
  media (no new bytes, no new charge). `RunFiles` rewrites stored-output URLs to the chat being shown, so the
  fork keeps working after the source is deleted. Non-image run outputs stay with the source chat.
- A run that overwrites a path points the row at a new media row and releases the old one; the new digest
  changes the validator.
- Account deletion removes `media/<userId>`, `media-cache/<userId>`, and `images/<userId>`; the rows go by
  cascade.

## Quota

Originals count once per account through `SUM(media.size)`; the empty `data` BLOBs count zero. Identical
uploads, a fork's shared run images, and re-saved legacy messages add no bytes. Replacing an avatar or a
run_code output is charged by net growth through `chargeReplacement()`: the new unique bytes minus what the
replaced row frees, which is its BLOB plus its original only when no other row holds that original. A new
image that deduplicates to media the account already has writes nothing and is never refused, and the
image/non-image direction of the replacement does not matter. Generated images count
`images.size` as before. Previews do not count (regenerable cache, bounded by its own budget). The profile
picture counts its re-encoded size.

## Migration and GC

`startMediaMaintenance()` (called from `index.ts`, never on import) runs `migrateMediaBatch()` in small steps
between other work, then GC, then GC every six hours.

1. `uploads`, `sandbox_files`, `user_avatars` rows with a non-empty BLOB that sniffs as raster: write the file,
   then in one transaction record `media_id`, the sniffed MIME, and an empty `data`. One row in memory at a
   time.
2. Stored user and assistant messages containing `data:image/`: rewrite raster file parts to references,
   reusing the upload that already holds the same bytes (the older inline-attachment migration created
   those). Other parts and `original_enc` are untouched; edited replies get references too, which their
   conflict check accepts because resent bytes match by digest. `messages.bytes` is recomputed with
   `messageBytes()`, the same accounting as `appendMessage`, so a remaining inline PDF (charged in `uploads`)
   is not billed again.

Progress cursors (`server_settings` `media_migration:<table>`) are rowids, so a restart resumes and a
rewritten row is never selected again. Rows that do not sniff as raster are skipped and stay as they are.
A row that fails validation for good (a legacy raster over 100 megapixels) keeps its BLOB, the cursor moves
past it, and the server logs only the table, rowid, and reason (the first 20, then one summary line); in a
message, such a part stays inline and the rest of the message moves. Any other failure (disk full, I/O, a
locked database) rolls back with the cursor and the step is retried a minute later, so no original is
dropped before its copy exists.

GC (`collectMediaGarbage`): unreferenced media rows older than one hour; files in `media/` and `images/` with
no row (and `.tmp-` leftovers) older than one hour; whole directories of deleted users; previews of deleted
originals; then the preview budget. The one-hour grace protects a write between its file rename and its
commit.

SQLite does not shrink when BLOBs move out. Once the server logs `[media] legacy image migration finished`,
reclaim space offline: stop the app, back up `okaychat.db`, and run `sqlite3 okaychat.db 'VACUUM'` (it needs
free disk about the size of the database). Backups must now include `dataDir/media/` and `dataDir/images/`
together with the database; `media-cache/` can be excluded.

## Web surfaces

`OwnedImage` loads a variant lazily with `decoding="async"`, reserves the aspect ratio when the size is
known, uses `srcset` only where the original's size is known (a variant's real width follows from it), and
shows Retry / Open original on failure. Its loading state belongs to one `src` (the component is keyed by
it), so a failure never sticks to the next image. Callers pass `href` rather than wrapping it in a link: the
link wraps only the loaded image, and the fallback's controls are never inside another interactive element.
Inside a control (the Library grid tile button) it gets `controls={false}` and shows the fallback without
controls; the Library preview it opens has them. Retry is the `chat.retryImage` command.

Used by generated-image cards (`large` + srcset), MCP image results (`medium`), run_code images (`large`),
assistant image output in replies (`MessageFile`, `large`), Library grid (`thumbUrl`) and preview
(`previewUrl`, the `large` variant), the attachment dialog (`large`, plus an Open original link), and the
public share page. Attachment tiles use `thumb` with the avatar fallback icon. Owned Markdown images
(`markdown-image-policy` `app` kind) load the `large` variant; remote Markdown images keep their consent,
`no-referrer`, and `srcSet` stripping unchanged. Avatars use `thumb`. Opening, downloading, copying, or
zooming via a link fetches the original.

## Profile pictures

The browser reads the pixel size from the loaded header before drawing (no forced full decode), refuses more
than 16 megapixels, scales to at most 512 px, and uploads WebP (PNG where the browser cannot encode WebP).
The server does not trust that: it checks the header, fully decodes within 16 megapixels, applies
orientation, strips metadata, bounds to 512 px, and stores WebP. A corrupt file is 422.

## Image edits

`generate_image` `reference_image_ids` accepts generated image ids and the `file_id` of the account's own
image attachments. References are the originals: `images/` files, or media files whose extension matches the
type, which Codex needs for staging.

## Export

Markdown export lists images as `_Image: name_` lines. PDF export embeds this account's own images
(attachments and generated/MCP images on the branch) as `large` previews in the document as data URLs, at
most 40 images and 30 MB, so the offline browser render never fetches anything. Remote URLs are never
followed; what does not fit becomes a name line.

## Known limits

- Uploads are not fully decoded when stored; a damaged upload is kept and only its previews fail.
- Non-image run outputs and their `fileId`s still belong to the source chat of a fork.
- Each model request reads the referenced originals from disk and base64-encodes them; no in-memory cache.
- The provider-independent image token estimate is a constant, not each provider's pixel formula.
- HEIC and BMP are accepted as files but not as images (browsers cannot show HEIC; nothing converts it).
