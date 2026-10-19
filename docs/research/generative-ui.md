# Generative UI

Source: npm `generative-frame` 0.0.6 and `@assistant-ui/generative-ui` 0.0.5, read from the published tarballs on 2026-10-19.

## What we use

`generative-frame` only. It ships both renderers the roadmap asked for:

| Tool | Renders | Where |
| --- | --- | --- |
| `render_spec` | Flat spec (`{ root, elements, state }`) streamed as JSON Patch lines, against a catalog of our own React components | `src/web/components/genui/catalog.tsx` |
| `show_widget`, `edit_widget` | HTML fragment or SVG, streamed into a sandboxed iframe, morphed in place | `generative-frame` `<Widget>` |
| `read_me` | Returns widget and spec guidance on demand, so the system prompt stays small | built in |
| `preview_widget` | Offscreen render with errors and screenshot | built in |

`buildWidgetInstructions` adds a "choosing how to answer" section: Markdown by default, `render_spec` for structured content, `show_widget` for interactive tools and custom visuals.

## Why not `@assistant-ui/generative-ui`

Its built-in vocabulary renders unstyled markup with ~100 `data-aui="…"` hooks and ships no CSS. Our catalog is 21 components styled with the app theme tokens, so specs look native in every theme. `toSpecCatalog()` from that package is the drop-in if we ever want its vocabulary.

## Wiring

- Client: `createWidgetToolkit({ widget: { opaqueOrigin: true }, widgetId: false, spec: createSpecToolkit(catalog, { components }) })`, spread into our toolkit in `RuntimeProvider`. `useWidgetInstructions` registers the instructions as model context `system`.
- Execution is `frontend` (default). The browser runs the tools, so `show_widget` / `edit_widget` return a render report (errors, blank flag, height) and the model can repair. The server forwards their schemas with `frontendTools(body.tools)` from `assistant-stream/ai-sdk` and appends `body.system` last in the system prompt.
- `useChatRuntime` needs `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls`. Without it, a browser tool result is stored locally and the turn stops after the first tool call.
- `opaqueOrigin: true` renders in a `null`-origin sandbox instead of Safe Content Frame's hosted origin (`*.auiusercontent.com`), so a self-hosted instance does not depend on a third-party frame host. It cannot be combined with `id`, so `widgetId: false`. Widgets get no persistent storage.
- Default widget CSP blocks `fetch`/XHR/WebSocket and allows scripts only from cdnjs, jsDelivr, unpkg, esm.sh.
- Theme: `useAssistantUiThemeTokens` reads shadcn variables (`--background`, `--primary`, …), which our theme defines, so widgets follow light/dark and custom themes live.
- Setting `generativeUI` (Settings → General) gates the server side: when off, `/api/chat` ignores `tools` and `system` from the client.

## Gotchas

- Tool calls collapse into a "N tool calls" group. `show_widget`, `edit_widget`, `render_spec` have `"tool-call:<name>": []` entries in `messageGroupBy` so they render inline.
- `edit_widget` replays edits from thread history on the client, so a reload renders the edited widget without server state.
- A spec's shared context (user choices from `updateModelContext`) also arrives in `system`. It changes only on interaction, and it is the last part of the system prompt, but it still invalidates the prompt cache from that point.
