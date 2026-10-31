# Chat runtime and interface

The runtime uses `@assistant-ui/react` and `@assistant-ui/ai-sdk`. The maintained components live in `src/web/components/assistant-ui/elements/`; no upstream source snapshot is kept in the repository.

## Runtime and persistence

`runtime/RuntimeProvider.tsx` wraps `useChatRuntime` in `useRemoteThreadListRuntime` with the app's thread adapter. The per-thread history adapter stores encoded messages as `ai-sdk/v6` rows with a parent chain. Messages are persisted by that adapter, not by `/api/chat`; server-side schedule runs write their own rows.

`AssistantChatTransport` sends the thread id as `id` and model context as `config`. `ModelContextBridge` registers `config.modelName`, `config.reasoningEffort`, and `config.webSearch`. Message metadata may be nested under `metadata.custom` by assistant-ui; server-side raw AI SDK messages carry those fields at the top level.

`useAuiState` selectors must return primitives or stable references to avoid repeated rendering. Tool cards live in `components/chat/tool-ui.tsx`; generative UI uses the browser toolkit documented in `generative-ui.md`.

Markdown images use `ProtectedMarkdownImage` (`components/ui/protected-markdown-image.tsx`): app-owned image routes render, remote URLs show a host and wait for Load image, and every other scheme or path is blocked. Chat and `SimpleMarkdown` (public shares, artifact and memory previews) share the policy in `lib/markdown-image-policy.ts`; the button is the `chat.loadImage` command. Tool results flagged by the server scanner show `InjectionBadge` on the real card and on the folded work-log group, never a modal. See `prompt-injection.md`.

The context meter uses the latest assistant reply's reported context size. After trimming, it immediately uses `compaction.trim.tokensAfter` until an assistant message after `trim.lastMessageId` reports a new count. Both trim boundaries must be on the current branch and the trim must extend beyond any summary boundary; otherwise its estimate does not apply. Refreshing thread metadata after a manual trim or a completed run updates the meter without rewriting historical message usage.

Thread metadata (`state/thread-meta.ts`: compaction, usage, memory switch, fork source) has one owner: `ThreadMetaSync`, mounted once in `ChatView`, refreshes the open chat when it opens and when its run ends. `useThreadMeta()` only reads, so the compaction marker under every message, the meter, the banner, and the chat options menu send no requests of their own. Opening a chat shares a request already in flight for it, including the one the thread list adapter's `fetch()` sends for a chat missing from the list. An explicit `refresh(threadId)` after a compaction, trim, or memory switch, and the refresh after a run, always start a new request, because one already in flight may predate the change. Answers apply in request order, so a slower older answer never replaces a newer one. A reload or `/c/<id>` link therefore sends two `GET /threads/:id` (the adapter's, then the owner's once the chat view mounts) and a switch sends one.

## Message cache

`runtime/threadCache.ts` keeps a read-only IndexedDB copy (`okaychat-thread-cache`, one store keyed by thread id, a `savedAt` index) of raw message rows in the `GET /threads/:id/messages` shape, never decoded messages. It lets a reload, PWA cold start, `/c/<id>` link, or the first switch to a chat in a session paint before the server answers. A chat already opened in the session never reaches it: assistant-ui keeps its runtime in memory and never calls `history.load()` for it again. Its message components still remount when it is shown again (the thread view is shared), which costs render time but no request and no skeleton.

- **What is stored:** the newest 20 messages of the current branch (the newest row and its ancestors), with the first kept row's `parent_id` set to `null` so assistant-ui does not drop the tail as orphans. Only chats whose `lastMessageAt` is within 7 days are written. Older or unknown ones are deleted instead, and a read of an entry older than that is a miss.
- **Cache-first paint:** `load()` starts the fetch (prefetched or fresh) and reads the entry. Whichever settles first decides: rows that are already here (the startup prefetch usually lands before the chat runtime loads) are returned directly, with no read-only phase and no swap; an entry read first is painted; a miss waits for the fetch. `preloadData()` opens the database alongside the messages prefetch so the read does not pay for opening it.
- **Swap:** when the fetch succeeds, the rows are written back, and if they differ from what was painted (ids, parents, format, or content; `sameRows()`), `aui.thread.importExternalState({ messages })` replaces the mounted messages. It takes the same AI SDK repo `load()` returns and resets the head to the newest server message, so the next reply is parented on it. The import waits until the thread's `isLoading` is false, because a prefetched response can arrive before assistant-ui has applied the cached rows, which would then overwrite the import. It also waits until the chat is the open one (`threads.mainThreadId`): a background chat re-applies its loaded history when it is opened again, which would undo an import made while it was away. It runs at most once at a time per chat. Drafts, scroll position, and mounted message nodes survive it.
- **Deferred swap:** if a run is streaming when the rows arrive (a stream resumed after a reload), the swap waits for `isRunning` to turn false, then for the chat's in-flight message writes (so the reply is stored), then fetches the rows again. It imports them only if they contain every message on screen, and the chat stays `pending`, not `stale`, while it waits: the server was reached. If a message on screen is missing from the server (its write failed), the import is skipped and the chat becomes `stale`, because a reply would otherwise be parented on a message the server never stored.
- **Re-persist guard:** assistant-ui persists every settled message its own loader did not see, so after a swap it calls `append` for the server's rows. `append` skips ids the server returned for that chat (`serverIds`), because a real append always carries a new id.
- **Send barrier:** while cached rows are on screen, `state/thread-sync.ts` holds `pending` for the chat. The composer turns off Enter-to-send and the send button, the dictation send waits, "Create skill from this chat" is disabled, and so are Retry on user and assistant messages, Edit, and the edit composer's Update (button and Enter). A rerun names its parent explicitly, but from a cached copy that parent may no longer be the newest message. Enter types a newline while sending is blocked (`submitMode: "none"`). `useChatRuntime` does not forward `isSendDisabled` to the external store, so the gate lives in our controls. `update()` also throws while the chat is `pending` or `stale`, so a caller that slips past the UI cannot store a stale parent; assistant-ui keeps the message unpersisted and writes it on a later settle. `append()` has no such guard, because the reply of a resumed stream is stored while the deferred swap still holds `pending`.
- **Offline:** if the fetch fails with an entry painted, the chat stays read-only as `stale`, and the composer says it shows a saved copy that could not be synced and to reload. Without an entry the existing "Failed to load message history" path is unchanged.
- **Writes:** `ServerRows` holds, per chat, the rows of the last trustworthy GET plus every write the server acknowledged since (an upsert keeps its row's place, a new id goes last, as the server orders by write time). Once no write of the chat is in flight, the entry is rewritten from it, so a chat stays cached after a send, retry, edit, or tool result without another history fetch. The cached content is the exact JSON body that was posted. A GET started while a write was in flight, or before one started, is not trusted: its answer may lack that write. A failed write drops the entry and makes the chat unknown until its next trustworthy GET; writes to an unknown chat drop the entry instead of storing it. A chat created in this page starts known and empty. Another tab or a schedule writing to the same chat makes the entry older than the server, which the swap corrects.
- **Cap:** each write prunes through a cursor over the `savedAt` index, deleting the oldest entries beyond 30 and any past the 7-day window.
- **Sign-out:** `lib/sign-out.ts` (`signOut()`, used by the account menu and the `app.logout` command) calls `clearThreadCache()`, which closes the connection, deletes the database, and turns the cache off until the page navigates away, so a write acknowledged afterwards cannot recreate it. Other tabs close their connection on `versionchange` so the delete is not blocked.
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

Every chat-model choice uses `ModelList` (`components/chat/ModelPicker.tsx`): search, favorites, then providers with OpenCode Go first. The composer shows it full size with context and price; settings, projects, and schedules use `ModelSelect` (select-style trigger, compact rows, optional non-model choices like "Same as chat model"); the branch menu's "Switch model…" opens the compact list anchored to the branch button.

The sub-agent menu also has a separate Same as chat model option, persisted as the reserved `subagentModel: "chat"` value (model refs contain a provider/model separator). It makes the chat model the preferred delegate even when a separate utility model is configured. Following the utility model uses null and inherits its normal chat-model fallback. `subagentModelRefs()` resolves this choice before filtering for tool-capable models.


## Sidebar navigation and search

The sidebar's New chat, Scheduled, Library, Plugins, and Projects shortcuts share one quiet row treatment. Search lives in the header (Ctrl/Cmd+K also opens it) and uses a focus-trapped spotlight dialog with arrow-key selection, title matches, and debounced full-text message matches. Search spans all projects; choosing a result clears the active project filter before switching threads. Recent/title results use the existing `/threads` endpoint's 500-thread limit; message matches use `/search` independently.

Scheduled (`/scheduled`) and Projects (`/projects`) reuse their settings management screens with the chat sidebar retained. Plugins (`/plugins`) exposes MCP management and per-account Skills. Library (`/library`) lists the account's files (see `docs/implementation/library.md`). The project switcher’s Manage projects / Create a project action also opens `/projects`, so it keeps the same sidebar. Only explicit Settings / Account actions enter the settings rail; feature shortcuts must never link to `/settings/*`. Settings routes remain supported. These destination pages load lazily through `NavigationPage`.

General settings stores `sidebarItems` per account through the validated settings API. Missing or invalid legacy values show all shortcuts; an empty array hides all five. Search, the account menu, settings, and the chat/project history filter remain accessible. Visibility controls shortcuts, not route access or tool availability.

The sidebar is one panel for chat and settings (`layout/Sidebar.tsx`). Its surface holds two layers: the chat list and the settings rail (`settings/SettingsNav.tsx`, kept light because the settings pages load lazily). Entering settings pushes the rail in from the right while the chat list recedes left, and the page slides the same way (`data-direction` on the route wrapper); Back reverses both. Settings forces the panel open on desktop and hides it on phones, which use the settings index. Appearance > Sidebar (`sidebarStyle` in the appearance preferences, `html[data-sidebar]`) picks `floating` (default, an inset glass panel) or `docked` (full height against the window edge with a hairline). Switching morphs the one surface: margin, size, corners, fill, and shadow transition together, and both shadow lists keep the same shape so each layer interpolates. Motion lives in `motion/shell.css` and scales with the panel animation duration. The width is per device (`layout/sidebar-width.tsx`, `localStorage` `okaychat:sidebar-width`, `--sidebar-width` on `<html>`, default 288 px, 220 to 520 px and at most half the window); the separator on the right edge resizes by drag or arrow keys, double-click restores the default, and transitions are off while dragging.

## Turn scroll inset

`thread.aui.tsx` keeps `turnAnchor="top"`. On desktop, user message roots have `3em` of top padding and a matching negative top margin. This moves the measured anchor above the bubble without changing spacing between messages. The built-in reserve stops short turns with the bubble `3em` below the scroll viewport's top (48 px at the default font size), including when manually scrolling to the end. Nonempty threads use the same initial top padding. Long assistant replies still scroll to their natural end.

On mobile, the initial padding and user-message anchor inset are `6rem`, with matching negative margin, to place messages below the top fade. Desktop uses the `3em` inset above. The viewport's tall-message clamp is `13em` / `9em`. Do not add an offset only to `scrollTo`: it would leave an unwanted scroll range available to wheel, touch, and the scroll-to-bottom button.

Attachment adapters live in `runtime/attachments.ts`: images, native/extracted documents, text/code,
then a binary fallback. Every non-temporary send persists original bytes and propagates quota errors.
Image/PDF message data URLs remain unchanged; file_id headers link the durable originals. Saving
temporary messages into normal history also stores inline files, without changing message parts.

The AI SDK converter lifts only `file` parts into message attachments; `<attachment>` text parts stay in the
user message content. `runtime/message-attachments.ts` separates them for display: the bubble renders only typed
text (Markdown, single newlines kept as line breaks), text attachments become file tiles that open their text,
and the user Copy button copies typed text only. The edit composer rebuilds attachments from those parts
(`EditComposerRestore`), rejoining an image/PDF header to its file, so edits resend them unchanged. Pasting
2,000+ characters or 30+ lines attaches `Pasted text.txt` with a "Paste inline" undo
(`components/chat/long-paste.tsx`); Ctrl/⌘+Shift+V always pastes inline.

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
- Chat-row activation calls `switchWithHighlight()` (`GlideHighlight.tsx`): the card moves to the requested row immediately, then the runtime switch starts in a timer after two animation frames (one establishes the transition, the next advances it), giving the browser a paint before message rendering. The card has its own transform layer so that rendering does not stall its slide. This visual preview does not change the row's actual selected state. Once the switch settles (including failure), the card follows the runtime again. A newer activation cancels a switch still waiting for that paint; keyboard activation follows the same path. Programmatic switches and row reordering still follow the selected-row observer.
- `useThreadListGroups` puts pinned chats in a leading "Pinned" group, then Today / Yesterday / Last 7 Days / Older. Labels and rows render as flat keyed siblings, so a chat changing groups keeps its DOM node and state. Entry animations (`rise-in`, label `fade-in`) drop their class after playing once, since moving a node restarts a CSS animation; `useFlip` slides only the rows and labels whose `offsetTop` changed, and `GlideHighlight` slides its card with a selected row that moved. With a project filter, a chat moved elsewhere leaves the list immediately.
- Every stored chat has its own URL, `/c/<id>` (`chatPath()`/`chatIdFromPath()` in `state/data.ts`), and the tab title is `<chat title> · okaychat`. `ChatUrlSync` (`ChatShell.tsx`, mounted only on the chat route) keeps both in step. The open chat drives the URL: switching chats pushes an entry (so Back returns to the previous chat), while entering the route, a reload, or a new chat receiving its id replaces it. A URL it did not write (back/forward, a pasted link, a reload) drives the chat through `switchToThread`; until that chat is open the URL is left alone, and an unknown id falls back to `/`. Code that opens a chat from elsewhere calls `showChat(navigate)` after switching, never `navigate("/")`: inside the chat route a push of `/` would race the sync and reopen the previous chat. New and temporary chats stay at `/`. `RuntimeProvider` uses the path as `initialThreadId` ahead of the tab's saved selection, and `preloadData` prefetches its messages. The old `/?thread=<id>` form still works and is removed from the URL.
