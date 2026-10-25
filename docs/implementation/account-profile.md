# Account profiles and pictures


Account settings reuse the existing settings layout and controls. A user can change their display name, upload or replace a picture, and remove it. Email is displayed read-only. Pictures update immediately in the account page and sidebar; display-name edits have an explicit save action. Normal chat messages do not currently have avatars, so their layout is preserved.

The browser accepts PNG, JPEG, and WebP files up to 5 MiB and 16 megapixels. It decodes the file before sending it, scales its longest edge to at most 1024 pixels, and exports a PNG. This strips original photo metadata and avoids storing large camera images. Object URLs are revoked after decoding. No image-processing dependency is added.

The API independently limits request size, checks file size, identifies raster format from bytes, reads dimensions, and rejects empty, unsupported, oversized, or implausible images. PNG/JPEG/WebP header checks bound dimensions to 8192 pixels on either side and 16 megapixels overall; they are not a full server-side image decoder. SVG is not accepted.

`user_avatars` holds one SQLite BLOB per user and cascades on account deletion, keeping the existing single-volume backup model. `/api/account/avatar` always resolves the authenticated account and never accepts another user's ID. Responses use the detected image MIME type, `X-Content-Type-Options: nosniff`, and `Cache-Control: private, no-store` so account switching cannot reuse another account's cached picture. `Me.avatarUrl` has a monotonically changing version query after replacement. The profile and auth APIs return the same `Me` shape.

## API

All endpoints require the normal authenticated session:

- `GET /api/account`: current profile.
- `PATCH /api/account` with `{ "name": "Display name" }`: trimmed name of 1–80 characters; returns updated profile.
- `PUT /api/account/avatar`: multipart `file`; returns updated profile.
- `GET /api/account/avatar`: authenticated picture bytes, or 404 when unset.
- `DELETE /api/account/avatar`: remove own picture and return updated profile.
