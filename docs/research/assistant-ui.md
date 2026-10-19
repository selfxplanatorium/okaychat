# assistant-ui research for okaychat

Source: `/tmp/research/assistant-ui` at commit `1a3359e`. Versions read from `package.json` in that clone:
`@assistant-ui/react` 0.15.29, `@assistant-ui/ai-sdk` 0.0.13, `@assistant-ui/react-ai-sdk` 1.4.18, `assistant-ui` CLI 0.0.124.
AI SDK packages: `ai` ^7.0.101 (peer), `@ai-sdk/react` ^4.0.133 (dependency of `@assistant-ui/ai-sdk`).

Unverified: no `node_modules` in the clone, so no test run and no type check against `ai@7`. Statements come from source and docs.

## Summary

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
