# Chat runtime and interface

The runtime uses `@assistant-ui/react` and `@assistant-ui/ai-sdk`. The maintained components live in `src/web/components/assistant-ui/elements/`; no upstream source snapshot is kept in the repository.

## Runtime and persistence

`runtime/RuntimeProvider.tsx` wraps `useChatRuntime` in `useRemoteThreadListRuntime` with the app's thread adapter. The per-thread history adapter stores encoded messages as `ai-sdk/v6` rows with a parent chain. Messages are persisted by that adapter, not by `/api/chat`; server-side schedule runs write their own rows.

`AssistantChatTransport` sends the thread id as `id` and model context as `config`. `ModelContextBridge` registers `config.modelName`, `config.reasoningEffort`, and `config.webSearch`. Message metadata may be nested under `metadata.custom` by assistant-ui; server-side raw AI SDK messages carry those fields at the top level.

`useAuiState` selectors must return primitives or stable references to avoid repeated rendering. Tool cards live in `components/chat/tool-ui.tsx`; generative UI uses the browser toolkit documented in `generative-ui.md`.

## Message cache

`runtime/threadCache.ts` keeps a read-only IndexedDB copy (`okaychat-thread-cache`, one store keyed by thread id, a `savedAt` index) of the raw `GET /threads/:id/messages` rows, never decoded messages. This makes reloads, PWA cold starts, and `/?thread=` deep links paint at once. Switching between chats inside a session is already instant: assistant-ui keeps every loaded thread in memory and never calls `history.load()` for it again, so the cache does not affect it.

- **What is stored:** the newest 20 messages of the current branch (the newest row and its ancestors), with the first kept row's `parent_id` set to `null` so assistant-ui does not drop the tail as orphans. Only chats whose `lastMessageAt` is within 7 days are written. Older or unknown ones are deleted instead, and a read of an entry older than that is a miss.
- **Cache-first paint:** `load()` starts the fetch (prefetched or fresh), then returns the cached rows when an entry exists. Without an entry it waits for the fetch, as before.
- **Swap:** when the fetch succeeds, the rows are written back, and if their id sequence differs from what was painted, `aui.thread.importExternalState({ messages })` replaces the mounted messages. It takes the same AI SDK repo `load()` returns and resets the head to the newest server message, so the next reply is parented on it. The import waits until the thread's `isLoading` is false, because a prefetched response can arrive before assistant-ui has applied the cached rows, which would then overwrite the import. It also waits until the chat is the open one (`threads.mainThreadId`): a background chat re-applies its loaded history when it is opened again, which would undo an import made while it was away. It runs at most once at a time per chat. Drafts, scroll position, and mounted message nodes survive it.
- **Deferred swap:** if a run is streaming when the rows arrive (a stream resumed after a reload), the swap waits for `isRunning` to turn false, then for the chat's in-flight message writes (so the reply is stored), then fetches the rows again. It imports them only if they contain every message on screen, and the chat stays `pending`, not `stale`, the whole time: the server was reached.
- **Re-persist guard:** assistant-ui persists every settled message its own loader did not see, so after a swap it calls `append` for the server's rows. `append` skips ids the server returned for that chat (`serverIds`), because a real append always carries a new id.
- **Send barrier:** while cached rows are on screen, `state/thread-sync.ts` holds `pending` for the chat. The composer turns off Enter-to-send and the send button, the dictation send waits, "Create skill from this chat" is disabled, and so are Retry on user and assistant messages, Edit, and the edit composer's Update (button and Enter). A rerun names its parent explicitly, but from a cached copy that parent may no longer be the newest message. Enter types a newline while sending is blocked (`submitMode: "none"`). `useChatRuntime` does not forward `isSendDisabled` to the external store, so the gate lives in our controls. `update()` also throws while the chat is `pending` or `stale`, so a caller that slips past the UI cannot store a stale parent; assistant-ui keeps the message unpersisted and writes it on a later settle. `append()` has no such guard, because the reply of a resumed stream is stored while the deferred swap still holds `pending`.
- **Offline:** if the fetch fails with an entry painted, the chat stays read-only as `stale`, and the composer says it shows a saved copy that could not be synced and to reload. Without an entry the existing "Failed to load message history" path is unchanged.
- **Invalidation:** every successful `append`/`update` deletes the chat's entry. Nothing is merged.
- **Cap:** each write prunes through a cursor over the `savedAt` index, deleting the oldest entries beyond 30 and any past the 7-day window.
- **Sign-out:** `lib/sign-out.ts` (`signOut()`, used by the account menu and the `app.logout` command) calls `clearThreadCache()`, which closes the connection and deletes the database. Other tabs close their connection on `versionchange` so the delete is not blocked.
- **Failures:** every IndexedDB error resolves as a miss. Temporary (`tmp_`) chats never touch the cache.

Known gap: the swap skips assistant-ui's tool-data restore (`__aui_toolArtifacts`, `__aui_toolInteractions`, `__aui_toolApprovalResponses` in message metadata), so swapped-in messages carrying those keys render without them until the next reload.

## Greetings and titles

New-chat greetings live in `components/chat/welcome-lines.ts`. Selection combines general lines with the current time-of-day pool and skips personalized lines when the account has no name. Sidebar titles show a tooltip after an 800 ms hover only when the rendered title overflows.

## Resumable streams

`chat.ts` wraps the AI SDK SSE response body with `createResumableStreamContext`
from `assistant-stream/resumable`. The producer uses a separate AbortController,
so disconnecting the HTTP request leaves generation running. Each stream is bound
to its authenticated user; resume and cancel check that owner. `GET
/api/chat/resume/:streamId` replays from the beginning and then follows live chunks;
204 means no retained stream. `POST /api/chat/:streamId/cancel` aborts generation.

The client uses one `createResumableSessionStorage` per thread transport, keyed by
remote thread id. `initialThreadId` and `onThreadIdChange` on the outer remote
thread runtime preserve the selected chat in sessionStorage per account. Without
this, reload mounts an empty new chat and never finds the pending stream.
`AssistantChatTransport` clones preserve the resumable options automatically.

Stop explicitly calls cancel and clears the checkpoint, including when stopping
a resumed stream (the id comes from the resume URL). Page unload does neither.
The transport clears the checkpoint when it reads the SSE finish marker. Messages
still persist through the client's history adapter after replay finishes.

Retention is in memory with a 15-minute TTL refreshed by appended chunks and
finalization. A server restart loses pending streams; closing the tab loses its
sessionStorage. This is reload recovery, not durable background message storage.
Browser verification covered live reload/replay, completion and checkpoint cleanup,
and Stop sending cancel with no checkpoint left. The dev server needed a restart
before its new response header appeared; absence of a checkpoint alone does not
imply a transport-cloning bug.

## Temporary threads

The top-right ghost button starts a new temporary thread in the in-memory `chat-privacy` store. `RemoteThreadListAdapter.initialize(localId)` binds it to a generated `tmp_` remote id without calling `/threads`. History load/append/update, remote metadata operations, title generation, selected-thread storage, and resumable checkpoints skip those ids. The sidebar filters them from its indexed rows. Reload mounts a fresh normal chat, not the discarded temporary conversation.

The thread adapter owns attachments through `unstable_useAdapters`. Do not override it with a global `attachments` runtime option: AI SDK gives explicit options precedence over context adapters, which would bypass temporary document extraction. The adapter resolves privacy lazily from its own `threadListItem` so background or switched threads use the correct mode.

Once a temporary chat has content, the ghost offers Save to history. Saving copies its current branch through the normal message API, materializes inline attachments, and switches to the new stored thread. Usage is not backfilled. Personalization can be enabled through chat options while temporary; it reads global memory and custom instructions only.

## Model defaults and composer overrides

Each stored conversation keeps its own model in `threadModels`, keyed by thread id: a pick in its composer is stored there and PATCHed to `threads.model_ref`, and the thread list and `fetch()` seed it from the server without overwriting picks made in the page. A new conversation without a thread uses the in-memory `selectedModel`, which `initialize()` copies to the new thread id. Switching chats therefore never carries a model from one chat to another. Do not restore the legacy `okaychat:selected-model` local-storage key: it otherwise silently wins over a newly saved account default. `onThreadIdChange(undefined)` signals a fresh optimistic thread and clears the override; initialization later emits the remote id and must preserve a model chosen before the first send. Saving the account default also clears the override. Active model resolution is the chat's choice → active project default → account default → first available model; unavailable references fall through. Title generation and temporary-chat saving use the same resolver.

Settings menus contain explicit fallback items with the empty-string UI value: First available model, Same as chat model, Same as utility model, and Use account default model. Their callbacks persist JSON `null` to clear an override; `undefined` would disappear in JSON and leave the old value stored. Project switches clear composer overrides, including when leaving a project with its own default. Schedule models remain explicit because scheduled jobs need a concrete model.

## Composer search toggle

`state/chat-search.ts` mirrors the model override: one in-memory boolean per chat, defaulting to the account's `webTools` setting. `RemoteThreadListAdapter.initialize` binds a choice made on the optimistic local id to the new remote id. `ModelContextBridge` sends it as `config.webSearch`; `turnStream` passes it to `webTools({ search })`, which omits only `web_search`, leaving `web_fetch`. The account setting remains the master switch, so the toggle is hidden when `webTools` is off or the model cannot call tools.

Reasoning effort `none` renders as **Instant** with a lightning icon. On coarse pointers the desktop effort and search controls are hidden; the attachment plus button becomes a menu holding Reasoning (submenu), Search, and Attach. The desktop plus button still opens the file picker directly.

The sub-agent menu also has a separate Same as chat model option, persisted as the reserved `subagentModel: "chat"` value (model refs contain a provider/model separator). It makes the chat model the preferred delegate even when a separate utility model is configured. Following the utility model uses null and inherits its normal chat-model fallback. `subagentModelRefs()` resolves this choice before filtering for tool-capable models.


## Sidebar navigation and search

The sidebar's New chat, Scheduled, Library, Plugins, and Projects shortcuts share one quiet row treatment. Search lives in the header (Ctrl/Cmd+K also opens it) and uses a focus-trapped spotlight dialog with arrow-key selection, title matches, and debounced full-text message matches. Search spans all projects; choosing a result clears the active project filter before switching threads. Recent/title results use the existing `/threads` endpoint's 500-thread limit; message matches use `/search` independently.

Scheduled (`/scheduled`) and Projects (`/projects`) reuse their settings management screens with the chat sidebar retained. Plugins (`/plugins`) exposes MCP management and per-account Skills. Library (`/library`) lists the account's files (see `docs/implementation/library.md`). The project switcher’s Manage projects / Create a project action also opens `/projects`, so it keeps the same sidebar. Only explicit Settings / Account actions enter the settings rail; feature shortcuts must never link to `/settings/*`. Settings routes remain supported. These destination pages load lazily through `NavigationPage`.

General settings stores `sidebarItems` per account through the validated settings API. Missing or invalid legacy values show all shortcuts; an empty array hides all five. Search, the account menu, settings, and the chat/project history filter remain accessible. Visibility controls shortcuts, not route access or tool availability.

## Turn scroll inset

`thread.aui.tsx` keeps `turnAnchor="top"`. On desktop, user message roots have `3em` of top padding and a matching negative top margin. This moves the measured anchor above the bubble without changing spacing between messages. The built-in reserve stops short turns with the bubble `3em` below the scroll viewport's top (48 px at the default font size), including when manually scrolling to the end. Nonempty threads use the same initial top padding. Long assistant replies still scroll to their natural end.

On mobile, the initial padding and user-message anchor inset are `6rem`, with matching negative margin, to place messages below the top fade. Desktop uses the `3em` inset above. The viewport's tall-message clamp is `13em` / `9em`. Do not add an offset only to `scrollTo`: it would leave an unwanted scroll range available to wheel, touch, and the scroll-to-bottom button.

Attachment adapters live in `runtime/attachments.ts`: images, native/extracted documents, text/code,
then a binary fallback. Every non-temporary send persists original bytes and propagates quota errors.
Image/PDF message data URLs remain unchanged; file_id headers link the durable originals. Saving
temporary messages into normal history also stores inline files, without changing message parts.

## Chat context menu API

`threads.updated_at` means last message activity: only `appendMessage` bumps it. `updateThread` (rename, pin, archive, move, model, memory toggle, generated title) leaves it unchanged, so the sidebar's date groups do not jump to Today on a metadata edit.

- `PATCH /api/threads/:id` accepts `title`, `status`, `memoryDisabled`, `pinned`, and `projectId` (`null` removes the project). A project the user does not own returns 404 `Project not found`. Moving needs no memory cleanup: offered memory tools re-check `thread.projectId` on every call.
- `GET /api/threads?status=regular|archived` filters by status and combines with `project`. Without it both statuses are listed.
- `POST /api/threads/:id/title` takes optional `text`. Without it the title is derived from the user text parts of the stored current branch (attachment headers skipped, 4000 chars). Foreign threads return 404; `tmp_` ids still return "Temporary chat".
- `GET /api/threads/:id/export?format=markdown|pdf` exports the current branch (`src/server/export.ts`): `# title`, then `## You` / `## Assistant` with text parts and `_Attachment: name_` lines. Reasoning, tool, and data parts are omitted. PDF renders that Markdown with `react-markdown` + `remark-gfm` (raw HTML escaped) and prints it through the browser worker (`htmlToPdf`); 503 if rendering is unavailable. Responses are `attachment` downloads with `Cache-Control: private, no-store`. 404 for foreign threads, 400 for `tmp_` ids or another format.

## Sidebar row menu (client)

`ThreadListItemMenu` is a Base UI `ContextMenu` around the whole row, opened by right-click or a 500 ms long press on touch; its popup reuses `MenuContent` (`components/ui/menu.tsx`) because assistant-ui's `ThreadListItemMorePrimitive` has no submenus. There is no menu button. On fine pointers the row's hover button pins/unpins, and while Shift is held it becomes a trash button that deletes without confirmation (`useShiftHeld` shares one window key listener across rows). Items: Pin/Unpin, Share (dialog around `SharePanel`), Move to (No project + every project), Open in New Tab, Rename, Regenerate Title, Export (Markdown/PDF), Archive, Permanently Delete (`DeleteChatDialog`). Every mutation goes through `aui.threadListItem` (`updateCustom`, `rename`, `archive`, `delete`) so runtime state stays consistent. Rename and the dialogs suppress the menu's focus return, which would otherwise blur the rename field. Regenerate and export show the row's running spinner while they work.

Select in a row's menu starts sidebar multi-selection (`state/thread-selection.ts`). Visible row order drives Shift ranges and Select all; bulk Pin/Move/Archive/Delete call the existing runtime item actions. Rows leaving the visible order drop out of the selection. Shared selection controls are also used by the Library.

- The adapter maps `pinned` and `projectId` into `custom`; `updateCustom` PATCHes both (undefined fields drop out, `tmp_` ids are skipped). A chat created in this session has no `custom` yet and counts as belonging to the project that was active.
- `useThreadListGroups` puts pinned chats in a leading "Pinned" group, then Today / Yesterday / Last 7 Days / Older. Labels and rows render as flat keyed siblings, so a chat changing groups keeps its DOM node and state. Entry animations (`rise-in`, label `fade-in`) drop their class after playing once, since moving a node restarts a CSS animation; `useFlip` slides only the rows and labels whose `offsetTop` changed, and `GlideHighlight` slides its card with a selected row that moved. With a project filter, a chat moved elsewhere leaves the list immediately.
- `/?thread=<id>` deep-links a chat: `RuntimeProvider` uses it as `initialThreadId` ahead of the tab's saved selection, then removes it with `history.replaceState`. `preloadData` prefetches its messages.
