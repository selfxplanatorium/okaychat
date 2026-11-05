# Thread tags

Flat private labels for chats, with a sidebar filter and saved filter presets that sync per account.
Tags are metadata: they never enter prompts, memory, search, exports, archives, shares, or
notifications.

## Rules

- `thread_tags` is `(thread_id, tag)` with the creation time. Tags are stored lowercase.
- `normalizeTag` trims, collapses inner whitespace to one space, lowercases, and requires
  `^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,23}$`: letters, numbers, spaces, dot, dash, underscore; 24
  characters at most. Invalid text is rejected by `PATCH /threads/:id` rather than silently dropped.
- At most 10 tags per chat, 20 per filter, 50 saved presets, 40 characters per preset name.
- Temporary chats and hidden comparison panes cannot be tagged (400).
- `PATCH /threads/:id {tags}` replaces the chat's set with `normalizeTags(tags)`, inside `tx`.
  Tagging never bumps `threads.updated_at`; that stays last message activity.
- Branching copies the source's tags in the same transaction. A fork's later tag edits never reach
  the source.
- Deleting a chat cascades its tags.

## Routes

| Route | Behavior |
| --- | --- |
| `GET /api/tags` | `{tags: [{tag, count}]}` over owned, non-archived, non-comparison chats; count desc then tag |
| `GET /api/tag-filters` | the account's presets |
| `POST /api/tag-filters` | `{name, filter}` (409 on a duplicate name or the 50-preset cap) |
| `PATCH /api/tag-filters/:id` | `{name?, filter?}` |
| `DELETE /api/tag-filters/:id` | owned delete |

`filter` is `{tags: string[], match: "any" | "all"}` parsed by `parseTagFilter`. The database enforces
`UNIQUE (user_id, name)` with `NOCASE`.

## Sidebar

`useThreadListGroups` ANDs three filters: the project filter, the title search, and
`matchesTagFilter(tags, filter)`. An empty tag filter matches everything. When a tag filter hides
every chat the list says so instead of "No titles match".

`TagFilterBar` (below the project switcher) shows the active chips and a popup with search, per-tag
counts, Any/All, saved presets (apply, rename inline, delete), "Save this filter", and Clear. The
filter lives in `localStorage` under `okaychat:tag-filter:<userId>` and is validated on read, so a
malformed entry means "no filter". Presets come from the server, so another device sees them.

Rows show up to two `#tag` chips after the title on a fine pointer; touch rows show a tag icon and
count. The row menu opens a tag submenu (toggling applies immediately) plus `New tag…`, and the
selection bar's fifth action edits tags for every selected chat: adding a tag adds it everywhere,
removing one removes it everywhere, and each chat keeps its other labels.

## Mobile and keyboard

Touch targets follow `pointer-coarse:` sizing; the filter popup and tag editor use the standard
dialog/scroll-area primitives. `tags.filter` (via the trigger's `data-command`) opens the filter
menu; `chat.tags` opens the editor for the open chat. Enter adds a typed tag, Escape closes, and
Backspace on an empty input removes the last chip.

## Deferrals

No hierarchy, colors, global rename/merge, automation rules, tags in exports/archives/search, or
per-tag sharing.
