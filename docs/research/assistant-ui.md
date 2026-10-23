# assistant-ui research for okaychat

Source: `/tmp/research/assistant-ui` at commit `1a3359e`. Versions read from `package.json` in that clone:
`@assistant-ui/react` 0.15.29, `@assistant-ui/ai-sdk` 0.0.13, `@assistant-ui/react-ai-sdk` 1.4.18, `assistant-ui` CLI 0.0.124.
AI SDK packages: `ai` ^7.0.101 (peer), `@ai-sdk/react` ^4.0.133 (dependency of `@assistant-ui/ai-sdk`).

Unverified: no `node_modules` in the clone, so no test run and no type check against `ai@7`. Statements come from source and docs.

## Summary

- Sidebar chat titles show the full name in a tooltip after an 800 ms hover, only when the rendered title overflows. Overflow is measured when opening so hover actions, title updates, and sidebar sizing are accounted for. The tooltip is portaled outside the list's scroll mask.
- Use `@assistant-ui/ai-sdk` directly. `@assistant-ui/react-ai-sdk` only re-exports it.
- Own-DB threads: wrap `useChatRuntime()` in `useRemoteThreadListRuntime({ runtimeHook, adapter })`. `useChatRuntime` has no adapter option of its own.
- Per-request model id: register it as model context `config.modelName`. It arrives in the request body as `config`.
- UI: copy-based shadcn registry (`npx assistant-ui@latest add thread thread-list`). Files ending `.aui.tsx` are the runtime-bound ones.

## 1. Package for AI SDK v7

Use `@assistant-ui/ai-sdk`. Its `package.json` peers `ai ^7.0.101`. The v7 docs (`apps/docs/content/docs/runtimes/ai-sdk/v7.mdx`) import only from this package.

`@assistant-ui/react-ai-sdk` 1.4.18 has the same peer and `src/index.ts` is `export * from "@assistant-ui/ai-sdk"`. Its README says new code should depend on `@assistant-ui/ai-sdk`.

Exports from `@assistant-ui/ai-sdk` (`packages/ai-sdk/src/index.ts`):

- `useChatRuntime`, `UseChatRuntimeOptions`
- `useAISDKRuntime` (takes a `useChat` instance)
- `AssistantChatTransport`
- `frontendTools` (re-exported from `assistant-stream/ai-sdk`)
- `injectQuoteContext`
- `useThreadTokenUsage`, `getThreadMessageTokenUsage`, `ThreadTokenUsage`
- `useAISDKChat`, `useAISDKError`
- `AISDKChat`, `AISDKThreads` (Vue docs use these. React use is unverified.)
- `generativeTools`, `AISDKToolkit`
- `createResumableSessionStorage`, `RESUMABLE_STREAM_ID_HEADER`

Install (from `v7.mdx`):

```sh
npm i @assistant-ui/react @assistant-ui/ai-sdk ai@^7 @ai-sdk/react@^4 @ai-sdk/openai zod
```

Backend pattern from `v7.mdx`: `convertToModelMessages` is async in v7. Use `createUIMessageStreamResponse({ stream: toUIMessageStream({ stream: result.stream }) })`. Those names come from the docs. Unverified against `ai@7` types.

## 2. Threads in own DB, request body

### Wiring

`useChatRuntime` (`packages/ai-sdk/src/runtime/useChatRuntime.ts`) always builds its thread list from `useCloudThreadListAdapter` (`cloud` option). For your DB, wrap it. Inner `useChatRuntime` runs as a no-op list because of `allowNesting: true`.

```tsx
import { AssistantRuntimeProvider, useRemoteThreadListRuntime } from "@assistant-ui/react";
import { useChatRuntime } from "@assistant-ui/ai-sdk";
import { threadListAdapter } from "./thread-adapter";

const runtime = useRemoteThreadListRuntime({
  runtimeHook: () => useChatRuntime({ transport }), // transport: see section 2b
  adapter: threadListAdapter,                       // RemoteThreadListAdapter
});
<AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
```

`RemoteThreadListAdapter` (`packages/core/src/runtimes/remote-thread-list/types.ts`) has `list`, `initialize`, `rename`, `archive`, `unarchive?`, `delete`, `fetch`, `generateTitle`, and `unstable_useAdapters?`. `unstable_useAdapters` returns `{ history }` per thread. Use it to inject the history adapter.

### History adapter and `withFormat`

`ThreadHistoryAdapter.withFormat(fmt)` is required for `useChatRuntime`. Its type is in `packages/core/src/adapters/thread-history.ts`. The `format` is `"ai-sdk/v6"` (`packages/cloud/src/ai-sdk/index.ts`, `aiSDKV6FormatAdapter`). The docs say it stays `"ai-sdk/v6"` on AI SDK v7.

Row shape: `{ id, parent_id, format, content }`. `content` is the `UIMessage` minus `id`, so it includes `parts` and `metadata`.

```tsx
const history = useMemo<ThreadHistoryAdapter>(() => ({
  async load() { return { messages: [] }; },   // required by type, unused by useChatRuntime
  async append() {},
  withFormat: (fmt) => ({
    async load() {
      const { remoteId } = aui.threadListItem.getState();
      if (!remoteId) return { messages: [] };
      const rows = await fetch(`/api/threads/${remoteId}/messages`).then((r) => r.json());
      return { messages: rows.map((row) => fmt.decode({
        id: row.id, parent_id: row.parentId, format: row.format, content: row.content,
      })) };
    },
    async append(item) {
      const { remoteId } = await aui.threadListItem.initialize(); // thread row must exist first
      await fetch(`/api/threads/${remoteId}/messages`, { method: "POST", body: JSON.stringify({
        id: fmt.getId(item.message), parent_id: item.parentId,
        format: fmt.format, content: fmt.encode(item),
      }) });
    },
    // optional: update(item) for paused tool approvals
  }),
}), [aui]);
```

Source of the snippet: `apps/docs/content/docs/integrations/persistence/custom-adapter.mdx`. The doc uses Drizzle, so `row.parentId` is camelCase there. Map it to your column name.

Drizzle schema in that doc: `threads(id, userId, title, status, custom, ...)` and `messages(id, threadId, parentId, format, content jsonb, createdAt)`.

`content` must be what `fmt.encode` produced. Hand-written rows that pass the column types can fail on reload.

Gotchas from the docs:
- Await `aui.threadListItem.initialize()` before the first write.
- Key the provider by account id (`<MyProvider key={accountId}>`) so a user switch remounts the runtime.
- `update` is optional. Without it, a message paused for tool approval is not persisted until the run ends.
- Call `aui.threads.reload()` after async auth resolves.

### 2b. Per-request body

`AssistantChatTransport` (`packages/ai-sdk/src/transport/AssistantChatTransport.ts`) extends AI SDK's `DefaultChatTransport`. Constructor options are `AssistantChatTransportInitOptions`: the AI SDK `HttpChatTransportInitOptions` plus `resumable?`. Options the code reads or the docs show: `api`, `body`, `headers`, `credentials`, `fetch`, `prepareSendMessagesRequest`, `prepareReconnectToStreamRequest`.

Body that the transport sends on every request:

- Its own: `callSettings`, `system`, `config`, `tools` (JSON Schema), `id`, `messages`, `trigger`, `messageId`, `metadata`
- `id` is the thread's `remoteId` after `initialize()`. With the adapter above, this is your DB thread id.
- Your static `body` is merged in. The transport's fields are added last, so `body` cannot override them. Source: `apps/docs/content/docs/vue/(runtimes)/ai-sdk.mdx` (the merge rule is documented there, not unit-tested here).
- `prepareSendMessagesRequest(options)` runs after the merge. Its return value replaces the body if it sets `body`. In that case you must include `id`, `messages`, `trigger`, `messageId` yourself.

Selected model id: register it as model context. `ModelSelector` does the same (`apps/docs/content/elements/model-selector.mdx`):

```tsx
const aui = useAui();
useEffect(() => aui.modelContext.register({
  getModelContext: () => ({ config: { modelName: selectedModelId } }),
}), [aui, selectedModelId]);
```

Server: read `const { messages, id, config } = await req.json()`, then call `openai(config?.modelName ?? "...")`.

`config` also accepts `reasoningEffort`, `apiKey`, `baseUrl` (`packages/core/src/model-context/types.ts`).

Per-send body: `apps/docs/content/docs/runtimes/ai-sdk/v7.mdx` does not document it. The Vue docs say the transport `body` is "merged with any body passed on the send". Unverified in this repo.

## 3. Reading message metadata

Server (`v7.mdx`, "Token usage"):

```ts
toUIMessageStream({
  stream: result.stream,
  messageMetadata: ({ part }) => {
    if (part.type === "finish") return { usage: part.totalUsage };
    if (part.type === "finish-step") return { modelId: part.response.modelId };
    return undefined;
  },
});
```

Client mapping (`packages/ai-sdk/src/converters/convertMessage.ts`): keys in the `THREAD_METADATA_KEYS` set (`timing`, `steps`, `submittedFeedback`, `modality`, `custom`, ...) stay at top level. Every other key moves to `metadata.custom`. So `usage` and `modelId` land in `metadata.custom`.

Hooks and selectors (exported from `@assistant-ui/react` unless noted):

- `useAuiState((s) => s.message.metadata.custom)`: inside a message scope. Replaces the removed `useMessage` (`apps/docs/content/docs/migrations/v0-15.mdx`).
- `useAuiState((s) => s.message)`: full message state.
- `useAui()`: actions and `aui.modelContext`.
- `useMessageTiming()`: `metadata.timing`.
- `useThreadTokenUsage()` (`@assistant-ui/ai-sdk`): usage of the newest assistant message that has any.
- `getThreadMessageTokenUsage(message)` (`@assistant-ui/ai-sdk`): reads `metadata.usage`, then `metadata.custom.usage`, then sums `metadata.steps`.

```tsx
const usage = useAuiState((s) => s.message.metadata.custom?.usage as ThreadTokenUsage | undefined);
const modelId = useAuiState((s) => s.message.metadata.custom?.modelId as string | undefined);
```

## 4. UI components

Source of truth: `packages/ui/src/components/react/assistant-ui/elements/`. Registry entries: `apps/registry/src/registry.ts`. The build (`apps/registry/scripts/build-registry.ts`) serves them at `r.assistant-ui.com`. `packages/ui` is not published.

File suffix convention (`packages/ui/AGENTS.md`):
- `X.tsx`: props only, no runtime
- `X.aui.tsx`: bound to the assistant-ui runtime (what you want)
- `X.radix.tsx` and `X.aui.radix.tsx`: Radix variants
- Base UI is the default flavor. Radix variants exist only for some files.

| Component | Registry item | Source file (`elements/`) | npm deps (registry) | Internal deps |
|---|---|---|---|---|
| Thread | `thread` | `thread.aui.tsx` | `@assistant-ui/react`, `lucide-react` | `button`, `skeleton`, `attachment.aui`, `file`, `follow-up-suggestions.aui`, `image`, `markdown-text`, `reasoning.aui`, `tool-fallback.aui`, `tool-group.aui`, `tooltip-icon-button` |
| Thread list | `thread-list` | `thread-list.aui.tsx` (props-only: `thread-list.tsx`) | `@assistant-ui/react`, `lucide-react` | `button`, `input`, `skeleton` |
| Markdown | `markdown-text` | `markdown-text.tsx` | `@assistant-ui/react`, `@assistant-ui/react-markdown`, `lucide-react`, `remark-gfm` | `tooltip-icon-button`, `hooks/use-copy-to-clipboard` |
| Tool fallback | `tool-fallback` | `tool-fallback.aui.tsx` | `@assistant-ui/react`, `lucide-react`, `tw-shimmer` (CSS `@import "tw-shimmer"`) | `collapsible-root`, `button`, `textarea` |
| Reasoning | `reasoning` | `reasoning.aui.tsx` (imports `reasoning.tsx`) | `@assistant-ui/react` | `markdown-text`, `elements-reasoning` |
| Attachment | `attachment` | `attachment.aui.tsx` | `@assistant-ui/react`, `lucide-react` | `dialog`, `tooltip`, `avatar`, `tooltip-icon-button`, `hooks/use-attachment-src` (uses `zustand`) |
| Tooltip icon button | `tooltip-icon-button` | `tooltip-icon-button.tsx` (Radix: `.radix.tsx`) | none (shadcn primitives only) | `tooltip`, `button` |

Shadcn primitives used (`packages/ui/src/components/react/ui/base/`, Base UI flavor): `button` (`@base-ui/react/button`, `class-variance-authority`), `tooltip`, `avatar`, `dialog`, `input`, `textarea`, `skeleton`. Radix equivalents: `ui/radix/`.

`@/lib/utils` is `packages/ui/src/lib/utils.ts`, which contains `export { cn } from "cn";`. The `utils` registry item installs the same file with the `cn` npm package.

Alias mapping for a Vite project (`@/` is your alias):

- `components/react/assistant-ui/elements/X` becomes `@/components/assistant-ui/elements/X`
- `components/react/assistant-ui/utils/X` becomes `@/components/assistant-ui/utils/X`
- `components/react/ui/base/X` becomes `@/components/ui/X`
- `hooks/X` becomes `@/hooks/X`
- `lib/utils.ts` becomes `@/lib/utils`

Install with the CLI. The CLI runs `shadcn add` against `r.assistant-ui.com` (`packages/cli/src/commands/add.ts`, `lib/utils/registry.ts`):

```sh
npx assistant-ui@latest init                       # existing project
npx assistant-ui@latest add thread thread-list     # pulls markdown-text, reasoning, tool-fallback, attachment, tooltip-icon-button through registryDependencies
```

Without the CLI, the plain shadcn call (`apps/docs/content/docs/(getting-started)/installation.mdx`):

```sh
npx shadcn@latest add https://r.assistant-ui.com/base/thread.json          # Base UI (default style)
npx shadcn@latest add https://r.assistant-ui.com/thread.json               # Radix
```

Style rule from `installation.mdx`: `components.json` style starting with `base-` gets Base UI. Other styles get Radix. Preferred `components.json` registry entry: `"@assistant-ui": "https://r.assistant-ui.com/styles/{style}/{name}.json"`.

Vite: no extra step for these components. `@assistant-ui/vite` (`aui()` plugin) is needed only for `"use generative"` files.

Thread API: `Thread({ components?, autoFocus? })`. `components` takes `AssistantMessage`, `Welcome`, `ToolFallback`, `ToolGroup`, `ReasoningGroup`, `TaskGroup`.

Files I could not find: none of the requested names were missing.

## 5. Copied files

Location: `/home/fabio/workspace/projects/okaychat/docs/research/aui-components/`. Each file is byte-identical to the clone (checked with `cmp`). Paths below are relative to `packages/ui/src/`.

Requested:
- `components/react/assistant-ui/elements/thread.aui.tsx`
- `components/react/assistant-ui/elements/thread-list.aui.tsx`
- `components/react/assistant-ui/elements/markdown-text.tsx`
- `components/react/assistant-ui/elements/tool-fallback.aui.tsx`
- `components/react/assistant-ui/elements/reasoning.aui.tsx`
- `components/react/assistant-ui/elements/attachment.aui.tsx`
- `components/react/assistant-ui/elements/tooltip-icon-button.tsx`

Shadcn primitives (Base UI): `components/react/ui/base/{button,tooltip,avatar,dialog,input,textarea,skeleton}.tsx`

Added because the requested files import them. Without these, the copy does not compile:
- `components/react/assistant-ui/elements/{reasoning,collapsible-root,file,image,media-player,follow-up-suggestions.aui,tool-group.aui,surfaces}.tsx`
- `components/react/assistant-ui/utils/{href.ts,useIsomorphicLayoutEffect.ts}`
- `hooks/{use-copy-to-clipboard,use-attachment-src}.ts`
- `lib/utils.ts`

Total: 27 files. Scope note: I copied the full import closure of the requested set, not only the listed names. Drop the extra files if you do not need thread.

External requirements not copied: `@assistant-ui/react-markdown/styles/dot.css` (imported by `markdown-text.tsx`), the `tw-shimmer` CSS, and Tailwind v4 config.

## 6. Tool UI and generative UI

### Tool UI registration

Current API: `defineToolkit` plus `Tools({ toolkit })` inside `AuiConfig`, passed as `config` to `AssistantRuntimeProvider`:

```tsx
const config = AuiConfig({ tools: Tools({ toolkit }) });
<AssistantRuntimeProvider runtime={runtime} config={config}>
```

Each toolkit entry can set `execute`, `render({ args, result, status })`, and `renderText`. For a tool that runs on the backend and needs only a renderer, use a plain `"use client"` toolkit with `type: "backend"` and `render` (`apps/docs/content/docs/tools/defining-tools.mdx`, "Render-only tools").

`makeAssistantToolUI`, `useAssistantToolUI`, `makeAssistantTool`, `useAssistantTool` are deprecated (`migrations/toolkit-tools.mdx`). In a `"use generative"` file, write `execute: externalTool()` instead of `type: "backend"`.

### Generative UI packages

- `@assistant-ui/generative-ui` (0.0.5, `packages/generative-ui`): framework-neutral tree (`{ _type, ...props }`) and normalizer. Main React entry: `@assistant-ui/generative-ui/react` exporting `JSONGenerativeUI`, `defineGenerativeComponents`, `defaultGenerativeUILibrary`. You declare the components the model may emit, then add `generative.present({ display: "standalone" })` to a toolkit. Subpaths for `slack`, `teams`, `a2ui`, `spec`, `vue`. Peers: `@assistant-ui/react` ^0.15, `zod` ^4.
- `@assistant-ui/react-generative-ui` (0.1.4, `packages/react-generative-ui`): re-export shim of the package above. Its README says new code should depend on `@assistant-ui/generative-ui` directly.
- `generative-frame` (0.0.6, `packages/generative-frame`): streams model-written HTML and SVG widgets into Safe Content Frames under a strict CSP. Host bridge (`sendPrompt`, `openLink`, `callTool`), theme sync, diagnostics, and a repair loop. Model-side tools: `show_widget`, `edit_widget`, `preview_widget`, `read_me`, `render_spec`. assistant-ui entry: `generative-frame/assistant-ui` exporting `createWidgetToolkit`, `useWidgetInstructions`, `useAssistantUiThemeTokens`. Depends on `safe-content-frame` only.
- `safe-content-frame` (0.0.34, `packages/safe-content-frame`): framework-free vanilla JS. Renders untrusted HTML, PDF, or Blob in an iframe on a per-content origin (`scf.auiusercontent.com`). Entry: `new SafeContentFrame("my-app")`, then render into a container.

### Examples

- `examples/with-generative-ui`: `app/present-toolkit.tsx` builds `JSONGenerativeUI` with a custom `DashboardHeader` component and exposes `present`. `app/present/page.tsx` pairs it with `useChatRuntime` and `AssistantChatTransport({ api: "/api/present" })`. `app/page.tsx` uses `generative-frame/assistant-ui` widgets (`createWidgetToolkit`, `useWidgetInstructions`).
- `examples/with-artifacts`: `app/toolkit.tsx` defines an `artifact` entry with `unstable_interactableTool({ description, stateSchema, render })`. Its state is read with `unstable_useInteractable`. Interactables are unstable API (`apps/docs/content/docs/tools/interactables.mdx`). The example renders HTML artifacts in its own surface and does not use `generative-frame`.

## Unverified

- `ai@7` API names used in the docs (`stepCountIs`, `zodSchema`, `createUIMessageStreamResponse`, `toUIMessageStream`, `messageMetadata`).
- `AssistantChatTransport` body merge behavior at send time (documented in Vue docs, no React test read).
- React usage of `AISDKThreads` through `AuiConfig`. Only Vue docs show it.
- Whether `adapters.history` in `useChatRuntime({ adapters })` (Vue/v7 docs) or `unstable_useAdapters` (custom-adapter guide) is the preferred route for history in React. The custom-adapter guide uses `unstable_useAdapters`.
- Whether `tw-shimmer` is required at runtime or only for its styles.

## 7. Resumable streams (implemented and browser verified)

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

## 8. Anonymous threads

The top-right chat menu marks a new local thread anonymous in the in-memory `chat-privacy` store. `RemoteThreadListAdapter.initialize(localId)` binds it to a generated `tmp_` remote id without calling `/threads`. History load/append/update, remote metadata operations, title generation, selected-thread storage, and resumable checkpoints skip those ids. The sidebar filters them from its indexed rows. Reload mounts a fresh normal chat, not the discarded anonymous conversation.

The thread adapter owns attachments through `unstable_useAdapters`. Do not override it with a global `attachments` runtime option: AI SDK gives explicit options precedence over context adapters, which would bypass anonymous document extraction. The adapter resolves privacy lazily from its own `threadListItem` so background or switched threads use the correct mode.

## Model defaults and composer overrides

Each stored conversation keeps its own model in `threadModels`, keyed by thread id: a pick in its composer is stored there and PATCHed to `threads.model_ref`, and the thread list and `fetch()` seed it from the server without overwriting picks made in the page. A new conversation without a thread uses the in-memory `selectedModel`, which `initialize()` copies to the new thread id. Switching chats therefore never carries a model from one chat to another. Do not restore the legacy `okaychat:selected-model` local-storage key: it otherwise silently wins over a newly saved account default. `onThreadIdChange(undefined)` signals a fresh optimistic thread and clears the override; initialization later emits the remote id and must preserve a model chosen before the first send. Saving the account default also clears the override. Active model resolution is the chat's choice → active project default → account default → first available model; unavailable references fall through. Title generation and anonymous-chat saving use the same resolver.

Settings menus contain explicit fallback items with the empty-string UI value: First available model, Same as chat model, Same as utility model, and Use account default model. Their callbacks persist JSON `null` to clear an override; `undefined` would disappear in JSON and leave the old value stored. Project switches clear composer overrides, including when leaving a project with its own default. Schedule models remain explicit because scheduled jobs need a concrete model.

## Composer search toggle

`state/chat-search.ts` mirrors the model override: one in-memory boolean per chat, defaulting to the account's `webTools` setting. `RemoteThreadListAdapter.initialize` binds a choice made on the optimistic local id to the new remote id. `ModelContextBridge` sends it as `config.webSearch`; `turnStream` passes it to `webTools({ search })`, which omits only `web_search`, leaving `web_fetch`. The account setting remains the master switch, so the toggle is hidden when `webTools` is off or the model cannot call tools.

Reasoning effort `none` renders as **Instant** with a lightning icon. On coarse pointers the desktop effort and search controls are hidden; the attachment plus button becomes a menu holding Reasoning (submenu), Search, and Attach. The desktop plus button still opens the file picker directly.

The sub-agent menu also has a separate Same as chat model option, persisted as the reserved `subagentModel: "chat"` value (model refs contain a provider/model separator). It makes the chat model the preferred delegate even when a separate utility model is configured. Following the utility model uses null and inherits its normal chat-model fallback. `subagentModelRefs()` resolves this choice before filtering for tool-capable models.


## Sidebar navigation and search

The sidebar's New chat, Scheduled, Library, Plugins, and Projects shortcuts share one quiet row treatment. Search lives in the header (Ctrl/Cmd+K also opens it) and uses a focus-trapped spotlight dialog with arrow-key selection, title matches, and debounced full-text message matches. Search spans all projects; choosing a result clears the active project filter before switching threads. Recent/title results use the existing `/threads` endpoint's 500-thread limit; message matches use `/search` independently.

Scheduled (`/scheduled`) and Projects (`/projects`) reuse their settings management screens with the chat sidebar retained. Plugins (`/plugins`) exposes MCP management and per-account Skills. Library (`/library`) lists the account's files (see `docs/research/library.md`). The project switcher’s Manage projects / Create a project action also opens `/projects`, so it keeps the same sidebar. Only explicit Settings / Account actions enter the settings rail; feature shortcuts must never link to `/settings/*`. Settings routes remain supported. These destination pages load lazily through `NavigationPage`.

General settings stores `sidebarItems` per account through the validated settings API. Missing or invalid legacy values show all shortcuts; an empty array hides all five. Search, the account menu, settings, and the chat/project history filter remain accessible. Visibility controls shortcuts, not route access or tool availability.

## Turn scroll inset

`thread.aui.tsx` keeps `turnAnchor="top"`, but user message roots have `3em` of top padding and a matching negative top margin. This moves the measured anchor above the bubble without changing spacing between messages. The built-in reserve consequently stops short turns with the bubble `3em` below the scroll viewport's top (48 px at the default font size), including when manually scrolling to the end. Nonempty threads use the same initial top padding. Long assistant replies still scroll to their natural end.

The viewport's tall-message clamp uses `13em` / `9em`: the original `10em` / `6em` plus the same inset. Keep these values aligned with the root padding. Do not add an offset only to `scrollTo`: it would leave the unwanted extra scroll range available to wheel, touch, and the scroll-to-bottom button. Verified with the actual Thread component and a local streaming runtime at desktop and mobile widths.

Attachment adapters live in `runtime/attachments.ts`: images, native/extracted documents, text/code,
then a binary fallback. Every non-anonymous send persists original bytes and propagates quota errors.
Image/PDF message data URLs remain unchanged; file_id headers link the durable originals. Saving
anonymous messages into normal history also stores inline files, without changing message parts.

## Chat context menu API

`threads.updated_at` means last message activity: only `appendMessage` bumps it. `updateThread` (rename, pin, archive, move, model, memory toggle, generated title) leaves it unchanged, so the sidebar's date groups do not jump to Today on a metadata edit.

- `PATCH /api/threads/:id` accepts `title`, `status`, `memoryDisabled`, `pinned`, and `projectId` (`null` removes the project). A project the user does not own returns 404 `Project not found`. Moving needs no memory cleanup: offered memory tools re-check `thread.projectId` on every call.
- `GET /api/threads?status=regular|archived` filters by status and combines with `project`. Without it both statuses are listed.
- `POST /api/threads/:id/title` takes optional `text`. Without it the title is derived from the user text parts of the stored current branch (attachment headers skipped, 4000 chars). Foreign threads return 404; `tmp_` ids still return "Anonymous chat".
- `GET /api/threads/:id/export?format=markdown|pdf` exports the current branch (`src/server/export.ts`): `# title`, then `## You` / `## Assistant` with text parts and `_Attachment: name_` lines. Reasoning, tool, and data parts are omitted. PDF renders that Markdown with `react-markdown` + `remark-gfm` (raw HTML escaped) and prints it with the shared Chromium (`htmlToPdf`); 503 if Chromium is unavailable. Responses are `attachment` downloads with `Cache-Control: private, no-store`. 404 for foreign threads, 400 for `tmp_` ids or another format.

## Sidebar row menu (client)

`ThreadListItemMenu` is a Base UI `ContextMenu` around the whole row, opened by right-click or a 500 ms long press on touch; its popup reuses `MenuContent` (`components/ui/menu.tsx`) because assistant-ui's `ThreadListItemMorePrimitive` has no submenus. There is no menu button. On fine pointers the row's hover button pins/unpins, and while Shift is held it becomes a trash button that deletes without confirmation (`useShiftHeld` shares one window key listener across rows). Items: Pin/Unpin, Share (dialog around `SharePanel`), Move to (No project + every project), Open in New Tab, Rename, Regenerate Title, Export (Markdown/PDF), Archive, Permanently Delete (`DeleteChatDialog`). Every mutation goes through `aui.threadListItem` (`updateCustom`, `rename`, `archive`, `delete`) so runtime state stays consistent. Rename and the dialogs suppress the menu's focus return, which would otherwise blur the rename field. Regenerate and export show the row's running spinner while they work.

- The adapter maps `pinned` and `projectId` into `custom`; `updateCustom` PATCHes both (undefined fields drop out, `tmp_` ids are skipped). A chat created in this session has no `custom` yet and counts as belonging to the project that was active.
- `useThreadListGroups` puts pinned chats in a leading "Pinned" group, then Today / Yesterday / Last 7 Days / Older. Labels and rows render as flat keyed siblings, so a chat changing groups keeps its DOM node and state. Entry animations (`rise-in`, label `fade-in`) drop their class after playing once, since moving a node restarts a CSS animation; `useFlip` slides only the rows and labels whose `offsetTop` changed, and `GlideHighlight` slides its card with a selected row that moved. With a project filter, a chat moved elsewhere leaves the list immediately.
- `/?thread=<id>` deep-links a chat: `RuntimeProvider` uses it as `initialThreadId` ahead of the tab's saved selection, then removes it with `history.replaceState`. `preloadData` prefetches its messages.
