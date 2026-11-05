# Notifications

Durable in-app notices for scheduled runs and archive jobs, with unread state and opt-in system
notifications while the page is open. The bell lives in the sidebar header and in the chat header
when the phone drawer is closed.

## Calendar reminders

`calendar` is a fifth kind. A reminder notice carries only the allowlisted
`calendar.reminder`/`calendar.openEvent` keys, empty params, `calendarEventId`, and
`/calendar?event=<id>`. Visibility composes the existing channel predicate with a calendar predicate
(account feature allowed and the event still owned); list, unread count, mark read/unread, and dismiss
all use the composed condition. The durable state is the `calendar_reminders` ledger, not the notice:
dismissing or pruning a notice never re-arms it, and delivery marks the ledger `delivered` in the same
transaction as `notify`. See `docs/implementation/calendar.md`.

## What creates a notice

| Source | Kind/level | Title/body keys | Action |
| --- | --- | --- | --- |
| Scheduled run succeeded | `schedule` / `success` | `schedule.ok` / `okBody` | `/c/<threadId>` |
| Scheduled run failed or returned nothing | `schedule` / `error` | `schedule.error` / `errorBody` | the chat, else `/scheduled` |
| Scheduled run skipped (feature or model revoked) | `schedule` / `error` | `schedule.skipped` / `skippedBody` | `/scheduled` |
| Archive export ready | `export` / `success` | `export.ready` / `readyBody` | `/library` |
| Archive export failed | `export` / `error` | `export.failed` / `failedBody` | `/library` |
| Archive import finished | `import` / `success` | `import.done` / `doneBody` | `/library` |
| Archive import failed | `import` / `error` | `import.failed` / `failedBody` | `/library` |

A cancelled archive job creates no success or failure notice. A comparison run never notifies. Every
call site wraps `notify()` in `try/catch`, so a notice can never fail a run.

## Authoring rules

- Only allowlisted `title_key`/`body_key` values are written; an unknown key is dropped (logged once
  per user and key, never with content).
- `params` are sanitized: at most 12 keys, names `\w{1,40}`, strings ≤ 500 characters, finite numbers
  only. Schedules pass the schedule's title, the chat title, a safe error sentence, or the skip
  reason — never the prompt or model output.
- `action_path` must start with `/`, must not start with `//` or contain `://`, and is ≤ 300
  characters; anything else is stored as null.
- `source_key` dedupes retries: `schedule:<id>:<startedAt>`, `schedule:<id>:skip:<nextRun>`,
  `archive:<kind>:<jobId>`. The unique partial index makes `INSERT OR IGNORE` a no-op on a retry.
- Pruning runs in the same transaction: rows older than 90 days go, then everything beyond the newest
  200 for that account.
- `thread_id` deliberately has no foreign key: deleting a chat must not erase the record that its run
  or import finished. The notice's Open action then lands on a missing chat, which the chat view
  handles.

## Routes

All owner-scoped and `Cache-Control: private, no-store`:

| Route | Response |
| --- | --- |
| `GET /api/notifications?before=<createdAt>:<id>&limit=30` | `{items, unread, nextCursor}` |
| `POST /api/notifications/read-all` | `{unread}` |
| `DELETE /api/notifications/read` | `{unread}` |
| `POST /api/notifications/:id/read` | `{unread}` |
| `POST /api/notifications/:id/unread` | `{unread}` |
| `DELETE /api/notifications/:id` | `{unread}` |

Static paths are registered before `/:id`, as Hono matches in registration order.

## Client

`state/notifications.ts` starts from `NotificationCenter` with the account id, drops late answers for
a previous account, keeps one request in flight, and polls every 60 seconds while the page is open
(also hidden). It refreshes on `online` and when the tab becomes visible. `stop()` clears the timer
and listeners; sign-out calls `resetNotifications()`.

System notifications are shown only when the account turned them on, the browser granted permission,
the notice was created within the last five minutes of this page's lifetime, and its id is not in the
bounded per-user `localStorage` set (last 200 ids). At most one system notification per poll: one new
notice uses its title and body, several use the plural "N new notifications" with the newest title as
the body. A successful schedule run notifies only with `scheduleSuccess` on; failures always do.

`registration.showNotification` is used when a service worker is registered, with `new Notification`
as the fallback. The service worker's `notificationclick` focuses an existing same-origin window and
navigates it, or opens a new one. The in-app center always works.

There is **no Web Push**: with the app closed no system notification arrives; the notice is waiting
in the center on the next visit. This needs a push subscription service and VAPID keys, deliberately
out of scope for this wave.

## Settings

Settings → General → Notifications has `Desktop notifications` and `Also notify me when a schedule
succeeds` (disabled unless desktop notifications are on). The permission request runs in the
switch's click handler; a denial saves `browser: false` and shows the blocked sentence. The whole
object is saved through `PATCH /settings`; a rejected save restores the previous switch state.

## Deferrals

No email digests, per-device preferences, quiet hours, grouping of notices, notifications for
individual (non-archive) exports or comparisons, or notification actions beyond Open.

## Team channels

Channel notices use the `channel` kind and generic title/body keys with empty params: no room name,
sender, text, filename, or private id appears in a displayed string. Structured mentions win over a plain
message; `all` adds posts by others and terminal AI replies; `none` suppresses them; invitations always
notify. A DM notice uses `channel.dmMessage` for every other member whose mode is `all` or who is mentioned
(DMs default to `all`). A thread reply uses `channel.threadReply` and notifies only the root author and
structured mentions; `notify_mode='all'` does not apply, and a viewer whose thread cursor already covers
the reply is skipped. Edits, reactions, and read cursors never create notices. The server stores
`channel_id`, `channel_message_id`, and `channel_root_id`, filters list and unread counts against live
membership/eligibility/feature, purges on ACL mutation and tombstones, marks matching notices read when
the room cursor advances, and marks reply notices read through a thread cursor. Source keys are
`channel:invite:<room>:<user>:<time>`, `channel:message:<message>:<user>`,
`channel:thread:<reply>:<user>`, and `channel:ai:<run>:<requester>`. `channel_root_id` deliberately has no
foreign key: `channel_id` already cascades on room deletion, and a per-message FK would make a hard message
delete fail or drop unrelated notices.

The channel panel link uses `settingsHref("notifications")`; the General settings browser-notification row
carries `setting-notifications` for that deep link.
