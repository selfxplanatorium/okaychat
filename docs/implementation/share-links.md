# Share links

A chat can have several public read-only links. Each link is **live** (it shows the chat's current
branch) or **frozen** (it replays a capture), may expire, and may require a password. Only text,
generated images, artifacts, uploads, and generative UI are exposed: reasoning, tool inputs, usage,
and costs never are.

## Storage

`shares` holds one row per link: `token` (32 random bytes, base64url), owner, thread, `label`,
`mode`, `expires_at`, `password_hash`, the frozen payload (`snapshot_json`), its asset allowlist
(`snapshot_assets_json`), `snapshot_at`, and the view counters. `shares_user_time`, `shares_thread`,
and a partial index on `expires_at` serve the owner list. Before wave 3 the table held one link per
chat; the migration copies every existing row into the new shape as a live link with no expiry and
no password.

Frozen snapshots count against the per-account storage quota (payload plus allowlist bytes). Live
links hold no bytes of their own.

## Live vs frozen

- **Live** reads `currentBranch(user, thread)` on every request, so new messages, edits, and
  compaction changes appear. A scheduled run that writes to the chat updates its live links too.
- **Frozen** reads the capture. Messages added later are invisible, and artifact previews are pinned
  to the newest version the capture shows. `Refresh snapshot` recaptures from the current branch.
  Switching back to live deletes the capture and frees its bytes.
- A capture is refused while a reply is streaming (`threadBusy`): that reply is not stored yet, so a
  snapshot would silently omit it. Live creation is allowed while busy.

## Expiry, password, revoke

`expires_at` is either null or between "now" and one year from now. An expired link answers the same
404 sentence as a revoked one; the owner's manager shows it under **Expired**. Revoking deletes the
row, which also ends every cookie.

A password is 8–200 characters, hashed with the same scrypt helper as account passwords, and never
returned. `POST /api/public/shares/:token/unlock` sets an HttpOnly cookie:

- name `okc_share_<sha256(token)[0:16]>`, path `/api/public/shares/<token>`, `SameSite=Lax`,
  `Secure` on HTTPS;
- value `v1.<issuedAt>.<mac>`, where the HMAC covers the token, the current `password_hash`, the
  expiry, and the issue time;
- lifetime `min(12 h, expires_at - now)`.

Changing the password, the expiry, or the row invalidates every old cookie automatically. Unlock is
limited to 10 attempts per link and client address per 15 minutes; the attempt is recorded before the
scrypt run so parallel guesses cannot all pass, and a successful attempt gives its attempt back.
Changing a link's content settings requires the `sharing` feature; renaming a label and revoking do
not, so an admin switch-off never traps a link.

## Routes

| Owner (session) | Behavior |
| --- | --- |
| `GET /api/threads/:id/shares` | links of one chat + `sharingDisabled` |
| `POST /api/threads/:id/shares` | create (10 per chat, 100 per account) |
| `PATCH /api/shares/:token` | label, mode, expiry, password, `refreshSnapshot` |
| `DELETE /api/shares/:token` | idempotent revoke |
| `GET /api/shares?state=active\|expired\|all&cursor=…&limit=30` | account manager pages |

The pre-wave-3 `/api/threads/:id/share` endpoints remain as a single-link compatibility shim.

Public (`/api/public/shares`, no session): payload, unlock, `artifacts/:id`, `artifacts/:id/file`,
`artifacts/:id/preview`, `images/:id`, `uploads/:id`. JSON is `no-store`; images keep
`private, no-cache` and an ETag. Every asset request re-checks the link, expiry, the owner's current
`sharing` permission, the unlock cookie, and membership in the live branch or the capture. A
comparison pane cannot be shared until it is promoted to a normal chat.

The payload GET bumps `view_count`/`last_viewed_at` at most once per link per minute; assets never
bump it.

## What is not exposed

The shared message projection keeps text, inline images, generated-image URLs, uploaded-image
references, artifacts, generative-UI code/specs, and tool names. Reasoning, tool inputs and outputs,
usage, costs, attachment text, tags, and the raw stored message JSON never leave the server.

## Limits

- Links die with the chat (`ON DELETE CASCADE`); a frozen snapshot does not outlive its chat.
- No custom slugs, QR codes, per-link analytics beyond the count, comments, or watermarking.
- No Web Push or scheduled expiry notices.
