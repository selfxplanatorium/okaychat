# Web bundle boundaries

Verified with the installed Vite 8.3.4 / Rolldown build on 2026-10-19.

## Loading

`App.tsx` loads only authentication, shared primitives, and the appearance engine.
The authenticated `ChatShell.tsx` and public `SharePage.tsx` are separate lazy
entries. Settings remain lazy inside the shell. `Brand.tsx` is separate from
`Sidebar.tsx`: importing the brand on sign-in or public shares must not pull in
the sidebar's assistant-ui runtime. The runtime stays mounted across chat/settings
navigation, preserving its current conversation.

Vite's native `rolldownOptions.output.codeSplitting.groups` separates React,
assistant-ui core, assistant-ui adapters, AI SDK, Markdown, Base UI/Floating UI,
and generative widgets. `entriesAware` prevents a shared library group from
forcing its chat-only modules onto sign-in. `includeDependenciesRecursively:
false` keeps the groups bounded; `strictExecutionOrder: true` preserves module
initialization across these boundaries. These options were checked against the
installed Rolldown type declarations, not Rollup's deprecated manualChunks API.

## Startup path

Measured against a production build on 2026-10-20. Before, startup ran as a chain:
session check, appearance, shell chunk, then a 300 ms React Suspense hold, then
account data, then the chat list, then the restored chat's messages.

Now `/auth/status` returning a user starts everything at once (`App.tsx`):
`Shell.preload()`, `prefetch("/appearance")`, and `preloadData()` (account data,
chat list, and the messages of the chat `RuntimeProvider` will restore). Consumers
take the prefetched promise once through `takePrefetched` / `takePreloadedData`. Prefetches
expire after 10 s, so a screen that mounts later never shows old data.

- `lib/preloadable.tsx` wraps lazy routes. React.lazy suspends on first render even
  when the chunk has arrived, and React then holds the fallback up to 300 ms
  (`FALLBACK_THROTTLE_MS`). A preloaded component renders directly. Settings and the
  navigation pages preload when the chat is idle.
- `AppLoading` (`components/AppLoading.tsx`) is the only startup state. Its label
  fades in after 700 ms, so normal loads show only the themed background.
- `thread-meta.ts` coalesces refreshes within one frame. Each compaction marker
  calls `useThreadMeta`, which used to send one `GET /threads/:id` per message.

Production serving: `scripts/compress-web.mjs` writes `.br`/`.gz` copies at build
time and `serveStatic({ precompressed: true })` sends them (7.15 MB to 2.66 MB).
`/assets/*` is `immutable` for a year. `index.html`, `sw.js`, and the manifest are
`no-cache`.

Server: `warmCatalog()` loads models.dev and the OpenCode Go list at boot. Both
caches serve stale data and refresh behind the request instead of blocking it.
Before, a reload more than 15 minutes after the last one waited about 0.5 s for
opencode.ai, and every 6 hours it waited for the 6 MB models.dev catalog.

Warm reload into a restored 18-message chat, same machine: all data arrived by
155 ms, the shell mounted at 240 ms, and messages rendered by about 500 ms. Before,
the chat list alone finished at 595 ms. Most of the remainder is rendering
(the message list is one 170 ms task).

## Measurements

Before: one main JavaScript chunk of 1,865,597 bytes (about 571 KB gzip), plus a
lazy settings chunk. Sign-in downloaded the entire chat implementation.

After: the entry's static import closure is about 573 KB (184 KB gzip), a 69%
reduction in JavaScript before authentication. The largest individual chunk is
about 326 KB. Signed-in chat still needs its runtime; splitting does not make
that code disappear. It lets sign-in/public shares avoid it and lets browsers
cache the libraries independently of app changes.

`build.manifest` is enabled. For accurate startup totals, traverse `imports`
from `index.html` in `dist/web/.vite/manifest.json` and sum unique `.file` entries;
exclude `dynamicImports` until that route opens. Do not report only the tiny
entry wrapper as the initial payload. Gzip figures are compressed file totals,
not a claim about the deployment's HTTP compression configuration.

## Long chats

Measured on 2026-10-24 with a 200-message chat (each reply has a code block and a table), production
build: opening it took 1.0 to 1.27 s in one blocking task. With the message window it paints in 200 to
240 ms, and the newest 80 messages are mounted by about 0.75 s in slices mostly under 50 ms. Scrolling
holds 60 fps.

`WindowedMessages` (`thread.aui.tsx`) renders the list with `ThreadPrimitive.MessageByIndex` instead of
`ThreadPrimitive.Messages`. Only rendering is windowed: the runtime holds every message, so chat
requests, branching, and export still see the whole history.

- Opening a chat mounts its newest `FIRST_PAINT` (16) messages. A different first message id (another
  thread or branch) reopens the window; messages appended at the end never change it.
- After each paint, `REVEAL_STEP` (8) older messages mount, back to `AUTO_REVEAL` (80) messages from
  the end. Beyond that, "Show earlier messages (N more)" adds `MANUAL_REVEAL` (50) per click, revealed
  in the same slices. Browser find-in-page cannot see messages that are not yet mounted.
- Each slice records the distance from the bottom before it mounts and restores it with an instant
  `scrollTo` after, so the text being read stays still in browsers without scroll anchoring.
- Slices wait 150 ms after user scrolling: wheel, keys, touch, mouse drags on the scrollbar, and
  scroll events up to 1 s after a finger lifts. Restoring `scrollTop` mid-fling would stop it. Plain
  scroll events do not count, since the restore and the viewport's autoscroll fire them too.
- When the last click removes the button, focus moves to the next control, as in `ThreadLoadEarlier`.

Other long-chat costs:

- Every `TooltipIconButton` is a trigger of one shared Base UI tooltip (`sharedTooltip` in
  `components/ui/tooltip.tsx`, rendered once by `App`). A provider, root, and popup per button meant
  hundreds of tooltip states per long chat.
- Code blocks register their sticky-toolbar sentinel with `watchStuck()` (`code-block.tsx`). One frame
  finds every pending block's scrollport and one `IntersectionObserver` serves each scrollport. Walking
  `getComputedStyle` per block inside effects restyled the page once per block.
- A table's right-click copy menu mounts on first use.
- `AssistantMessage` reuses module-level grouping functions, so its `groupBy` memo holds.

Per mounted message, Markdown parsing (about a fifth of the time) and assistant-ui's scaffolding remain.
Typing into the composer cost about 12 ms per keystroke with all 200 messages mounted, because every
store change runs each mounted message's selectors. Merging this app's selectors did not measurably change it.

## Verification

Use `npm run typecheck`, `npm test`, and `npm run build`. Production smoke tests
use `vite preview` bound to the tailnet, proxying `/api` to the dev API. Confirm:

- Sign-in does not request chat runtime, AI SDK, or Markdown chunks.
- Chat renders streaming Markdown and saves/reloads the finished history.
- Reload during generation resumes the stream.
- Settings and custom themes load, save, and restore across independent browser profiles.
- Unsaved appearance edits persist after a failed PATCH and retry after reload/reconnect.
- Public shares render without the authenticated chat runtime.

The chat smoke test can use a local OpenAI-compatible fixture provider to avoid
spending provider credit. The production flow was tested with that fixture;
this does not re-verify every external provider or MCP server.
