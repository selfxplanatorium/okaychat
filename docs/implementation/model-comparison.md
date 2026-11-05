# Model comparison

`/compare` sends one prompt to two or three models and shows the answers side by side. Every pane is
a **real chat**, not a parallel transport: it runs `/api/chat` → `turnStream()` exactly like the main
composer, so tools, permissions, prompt caching, compaction, usage, cancellation, and branching
semantics are the chat's own.

## Hidden pane threads

A comparison is a `comparison_groups` row plus `comparison_panes` rows (position, thread id, model
ref). Each pane is a normal `threads` row with `compare_group_id` set, a normal model, messages,
compaction, generation receipts, and usage.

`listThreads()` excludes `compare_group_id IS NOT NULL` unless asked for a group explicitly, so panes
never appear in the sidebar, `/threads` pickers, archive export selection, or schedule targets.
`searchMessages()` excludes them too. Tags are refused on a pane.

`threads.compare_group_id` has no foreign key (SQLite cannot drop a column that carries one); group
deletion is explicit in `compare.ts`. Pane rows cascade from both the group
and the thread.

## Creation

`POST /api/compare {prompt, models: [{ref, effort?}], projectId?, sourceThreadId?}`

- Prompt 1–20,000 characters; 2–3 unique model refs; every ref must resolve to a language model and
  pass `assertModelAllowed` before any write. Agents are refused.
- 20 groups per account.
- Group title = the first 60 characters of the prompt.
- With `sourceThreadId`: the pane is a `branchThread()` copy of that chat's current branch (history,
  settings, artifacts, images, tags), then retitled and marked with the group.
- Without: a fresh thread in the optional project.
- The group and panes are inserted in one outer `tx`; `branchThread`/`ensureThread`/`updateThread`
  use nested savepoints, so a failure rolls back every pane.

## A pane turn

`/api/chat` checks `isCompareThread(user, id)` before the normal stored-chat branch. The pane branch:

1. reserves a turn slot (the same account-wide limit; three panes use three),
2. marks the thread busy,
3. stores the last user message with `appendMessage` (`persistCompareUserMessage`),
4. runs `turnStream({ interactive: false, unattended: true, signal: request signal })`,
5. tees the stream: the client gets one branch; `persistCompareReply` drains the other and stores the
   final assistant message with `parent_id = userMessageId`,
6. releases the slot when the stream ends or the request aborts.

This is the same server-side persistence shape schedules use. A stopped or aborted pane stores no
partial reply, so the user message remains and Retry answers it. A failed turn also keeps the user
message. The user message append is idempotent for a retry (it keeps its stored parent). There is no
`/turns` route and no wire change; a client cannot opt a normal thread into server persistence.

Compare streams are **not resumable**: leaving the page aborts the pane (the request signal aborts
`turnStream`). Reloading shows whatever was stored.

## Promote and delete

`POST /api/compare/:id/panes/:threadId/promote` refuses while the pane is busy. It removes the pane
row, clears the thread's `compare_group_id`, and returns the now-normal `ThreadSummary`. If fewer than
two panes remain, the remaining threads are cleared too and the group is deleted; a comparison with
one pane is no comparison. The client navigates to `/c/<id>` after promoting.

`DELETE /api/compare/:id` refuses while any pane is busy, deletes the group (panes cascade), then
deletes each pane thread with its generated images and sandbox workspace.

A six-hour maintenance timer (`startCompareMaintenance`, `unref`) deletes groups whose `updated_at`
is older than 30 days through the same delete path. `updated_at` moves when a pane stores a message.

## Client

`state/compare.ts` holds the saved group, recent group summaries, and which panes are running. Each
`ComparePane` owns a `useChat` with `DefaultChatTransport`, seeded with the pane's stored branch and
sending the normal `{id, messages, config}` body. The page sends the creation prompt once per pane;
the shared composer sends a follow-up to every pane. Panes are a grid at `lg` and a tab strip below.

Pane text is rendered with `SimpleMarkdown` from the streamed messages; tool use is a quiet line, and
actions are Stop, Retry, Copy, Open as chat, and a menu with delete. Approvals, elicitation, artifact
panels, and attachments are not rendered in a pane: Open as chat covers them.

## Limits and deferrals

No more than three panes, no per-pane follow-up composer, no merging, judging, comparison sharing,
schedules targeting panes, resumable streams, or non-text modalities. Pane messages count against the
storage quota like any chat; deleting the comparison frees them.
