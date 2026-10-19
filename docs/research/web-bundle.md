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
