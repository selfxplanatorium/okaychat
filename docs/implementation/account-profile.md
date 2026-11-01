# Account profiles and pictures


Account settings reuse the existing settings layout and controls. A user can change their display name, upload or replace a picture, and remove it. Email is displayed read-only. Pictures update immediately in the account page and sidebar; display-name edits have an explicit save action. Normal chat messages do not currently have avatars, so their layout is preserved.

The browser accepts PNG, JPEG, and WebP files up to 5 MiB and 16 megapixels. It reads the pixel size from the loaded image before drawing it, scales its longest edge to at most 512 pixels, and exports WebP (PNG where the browser cannot encode WebP). Object URLs are revoked after decoding. The server does not rely on this: it fully decodes the upload with sharp within 16 megapixels, applies orientation, strips metadata, bounds it to 512 px, and stores WebP; a corrupt file is 422 (see `media.md`).

The API independently limits request size, checks file size, identifies raster format from bytes, reads dimensions, and rejects empty, unsupported, oversized, or implausible images. PNG/JPEG/WebP header checks bound dimensions to 8192 pixels on either side and 16 megapixels overall; they are not a full server-side image decoder. SVG is not accepted.

`user_avatars` points at a file-backed `media` row (legacy BLOB rows are moved by the media migration); rows cascade on account deletion and the files are removed with the account's media directory. A replacement releases the previous original. `/api/account/avatar` always resolves the authenticated account and never accepts another user's ID. Responses use `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-cache`, and a digest `ETag` that is compared only after the account lookup, so account switching can never reuse another account's picture. The web shows the `thumb` variant (256 px). `Me.avatarUrl` has a monotonically changing version query after replacement. The profile and auth APIs return the same `Me` shape.

## API

All endpoints require the normal authenticated session:

- `GET /api/account`: current profile.
- `PATCH /api/account` with `{ "name": "Display name" }`: trimmed name of 1–80 characters; returns updated profile.
- `PUT /api/account/avatar`: multipart `file`; returns updated profile.
- `GET /api/account/avatar`: authenticated picture bytes, or 404 when unset.
- `DELETE /api/account/avatar`: remove own picture and return updated profile.
