# Calendar

Private personal events with optional in-app reminders. Calendar events are records, never scheduled
prompts: they make no provider call, are not sent to a model, and are not part of a project prompt,
memory, share, archive, or message search. Text is ordinary account text at rest (not encrypted).

## Time model

`src/shared/calendar-time.ts` is pure and uses native `Intl` only.

- A **timed** event stores absolute `startAt`/`endAt` epoch milliseconds (minute-aligned) plus the IANA
  `timeZone` it was entered in. The server never infers an instant from a local clock string.
- An **all-day** event stores `startDate`/`endDate` as strict `YYYY-MM-DD`, with `endDate` exclusive.
  Its derived UTC bounds are the first valid minute of each local date in the event zone. A 23- or
  25-hour civil day stays one day; a skipped midnight starts at the transition minute; a wholly
  skipped date is rejected rather than shifted.
- `resolveLocalCandidates(zone, civil)` enumerates every whole-minute UTC offset in `[-1440, +1440]`,
  formats each candidate back in the zone, and keeps exact civil round trips. Zero candidates is a
  spring gap; two is an autumn fold. Results are cached (100 tuples). The resolver runs only on
  explicit resolution, never per grid cell.
- `canonicalZone` accepts UTC and recognized named zones and refuses numeric offsets and
  `UTC+1`-style identifiers. The server stores the canonical name.
- `firstValidMinuteOfDate` binary-searches the ±26-hour window around nominal midnight, so a skipped
  date costs a handful of formats instead of a minute-by-minute scan.

The server's `/api/calendar/resolve-time` is authoritative for editing. It returns candidate instants
and numeric offset labels, rate-limited to 20 requests per account per minute with a bounded
in-process window (429 + `Retry-After`; no LLM bucket).

## API and storage

`src/server/calendar/store.ts` + `routes.ts`, mounted at `/api/calendar`.

| Route | Notes |
| --- | --- |
| `GET /calendar/events` | required `from`/`to` epoch ms (positive half-open interval, max 93 days), `limit`, `cursor`, optional `q`, `projectId` (`none`), `threadId` (`none`) |
| `POST /calendar/events` | create, idempotent by `requestId` |
| `GET/PUT/DELETE /calendar/events/:id` | full read, revision CAS, CAS delete |
| `POST /calendar/resolve-time` | `{ timeZone, startLocal, endLocal }` → candidates |

Range overlap is `effective_start_at < to AND effective_end_at > from`; results sort by
`effective_start_at ASC, id ASC`. The cursor binds the full range and filters. Search uses the same
literal token compiler against title/description/location (URL excluded). All-day events are placed by
civil date in the UI; the fetch window is expanded by 26 hours on each side so an event in another
zone is not lost.

Limits: 10,000 events/account (past included, no automatic deletion); title required, trimmed, 200
code points/800 bytes; description 20,000 code points/64 KiB (whitespace preserved); location 500
code points/2 KiB; URL 2,048 bytes, empty or absolute http(s) without credentials; 0–5 unique integer
reminder offsets 0–40,320 minutes, sorted; duration positive and at most 366 days. Create/update
bodies are 128 KiB. `effective_*` is always derived server-side.

Thread and project links are owned; a linked chat must not be temporary or a comparison pane. Deleting
a thread/project nulls the link without a revision or `updated_at` change. Foreign and missing ids are
the same 404.

Storage counts title + description + location + URL bytes; reminder ledger, links, zone, offsets,
hashes, and FTS copies are bounded metadata and are not charged. Deletes and shrinks work over quota.

## Reminder ledger and ticker

`calendar_reminders` is the durable terminal state, separate from notices. One row per
`(event, reminder_revision, offset)` with `due_at = effective_start_at - offset*60000` and
`pending|delivered|suppressed`.

- On create, a due instant before the mutation time or an event already ended is inserted
  `suppressed`; offset 0 may be pending exactly at `now`. Creating an old event never delivers a
  backlog.
- On update, the schedule signature `(effectiveStartAt, timeZone, allDay, startDate, sortedOffsets)`
  decides. Unchanged → ledger and `reminder_revision` retained (title/end/link edits do not re-notify).
  Changed → revision increments, old ledger rows and notices for that event are deleted, and the
  ledger is rebuilt. Removing all reminders clears both. A no-op write changes nothing.
- `src/server/calendar/reminders.ts` processes at most 200 due rows per batch, ordered by
  `due_at, event_id, offset`, up to five batches per tick, with a re-entrancy guard. Each row opens one
  synchronous transaction: reread the still-pending row and matching event revision, resolve the
  account `calendar` feature live, suppress permanently when denied/invalid, ended, or due more than
  seven days ago, otherwise call `notify` and mark `delivered` in the same transaction. A failure rolls
  both back; the next tick retries.
- `src/server/calendar/maintenance.ts` runs one startup batch after migrations and every 30 seconds
  with an unref timer. It is started only from `src/server/index.ts`; tests import stores without
  timers.

Notices use `kind = "calendar"`, `titleKey = "calendar.reminder"`, `bodyKey = "calendar.openEvent"`,
empty params, `calendarEventId`, and `actionPath = /calendar?event=<id>`. Source key
`calendar:<event>:<revision>:<offset>` adds SQL-level dedupe; dismissing or pruning a notice never
re-arms the ledger. Feature eligibility is evaluated at delivery time; disabling and re-enabling
between ticks is not tracked retrospectively.

## UI

`src/web/components/calendar/` (page, toolbar, agenda/month/week, event card/dialog, time fields, zone
picker, reminder offsets, conflict dialog) and `src/web/state/calendar.ts`. Calendar opens on agenda on
phones and month on desktop when the URL omits a view; an explicit view is never rewritten by a media
query. The month grid is a fixed 42-cell Monday grid with one roving tab stop (arrows by day/week,
Home/End, PageUp/PageDown, Enter opens the day agenda, Space creates). Week has an all-day lane, a
24-hour scroll grid, explicit transition offsets, and an always-available list. Agenda groups by civil
date. Every event stays reachable as an accessible button.

New timed events use the chosen grid/anchor date with a rounded clock default (including an
end on the next civil day when it crosses midnight).

The dialog is explicit-save (date and reminder edits have timed consequences). Timed fields are local
clock strings resolved through the server after a short debounce; a gap disables Save, a fold requires
a radio choice, and a stored event reopens on its exact instant. Resolution results are bound to the exact
zone/local-clock inputs; Save waits for a matching result and ignores responses invalidated by an
input change or dialog close. Closing with changes asks Keep
editing/Discard. 409 keeps the local form and offers Reload/Save as a new event/Copy. No autosave or
local outbox. Background focus/online refresh updates the range summaries only; the open editor
keeps its original record and CAS revision until explicit Reload or reopening.

The display zone and last view/date are stored per account in `localStorage` (no event content). The
server ticker is independent of page lifetime. Dense ranges stop paging at 600 summaries and point at
agenda; month/week show three event buttons per cell plus the exact loaded count and More.

Tests: `src/server/calendar.test.ts`, `src/server/calendar-time.test.ts`,
`src/web/lib/calendar-layout.test.ts`, and the migration suite.

Deferred: recurrence, attendees, external calendars/ICS, tasks, drag/resize, multiple calendars,
colors, natural-language parsing, Web Push, email/SMS reminders, snooze, guaranteed second-level
delivery, multi-writer locks, and timezone-database hot rewrites of stored all-day bounds.
