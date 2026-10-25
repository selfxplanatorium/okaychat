# AGENTS.md

Guide for any agent (human or AI) working in this repo.

**Keep this file current.** When you change the stack, add a module, learn a non-obvious fact, or make a decision that the code alone does not explain, update this file (or the relevant doc under `docs/`) in the same change. Stale guidance is worse than none.

## What this is

okaychat is a self-hosted AI chat app meant to replace LibreChat and Open WebUI. Goals: polished UI, every provider, OpenCode Go as the primary connection, MCP that just works, good prompt-cache behavior, usage and context tracking, and compaction.

- Self-hosted, Docker, multi-user capable (each user has their own keys, MCP servers, and settings).
- Lightweight stack. Avoid adding heavy dependencies without a reason written down here.

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Runtime | Node 22+ | `node:sqlite` is built in, so there are no native deps to compile in Docker |
| Server | Hono + `@hono/node-server` | Small, fast, Web-standard `Request`/`Response` |
| LLM | AI SDK v7 (`ai`) + `@ai-sdk/openai`, `anthropic`, `google`, `openai-compatible` | Covers all four OpenCode Go wire formats |
| MCP | `@ai-sdk/mcp` | Streamable HTTP, SSE, stdio clients |
| DB | SQLite via `node:sqlite` | One file, one volume |
| Web | Vite + React 19 + Tailwind v4 | No SSR needed |
| Chat UI | assistant-ui (`@assistant-ui/react`, `@assistant-ui/ai-sdk`), components copied into `src/web/components/assistant-ui/elements/` | Required by the product brief. Copied (shadcn-style) so we can add slots |
| UI primitives | Base UI (`@base-ui/react`), lucide icons, zustand stores | Same primitives the assistant-ui registry uses |
| Math / diagrams | `remark-math` + KaTeX, Mermaid, both lazy-loaded on first use | Chat Markdown renders LaTeX and ```` ```mermaid ```` blocks. See `docs/research/code-blocks.md` |
| Generative UI | `generative-frame` (spec mode + sandboxed widgets) | Both renderers, streaming, render reports for repair. See `docs/research/generative-ui.md` |
| Files | `unpdf` (PDF), `mammoth` (DOCX) | Pure JS, no native deps |
| Browser worker | Separate `browser` container (`src/browser/`): Playwright Chromium + Scrapling, egress proxy, per-uid firewall | Keeps Chromium and untrusted pages away from app data and secrets. See `docs/research/browser-worker.md` |
| Images | Codex CLI, AI SDK image providers (`@ai-sdk/xai`, `black-forest-labs`, `fal`, `replicate`, `togetherai` plus openai/google) | Small packages on the same provider-utils. See `docs/research/image-generation.md` |
| Web | `linkedom` + `@mozilla/readability` + `turndown`; SearXNG sidecar for search | Free, no keys. See `docs/research/web-search.md` |
| Theming | Port of T3Code appearance settings (MIT) | Required by the product brief |
| Depth | `theme/depth.css`: lit surfaces, tinted shadows, accent gradients derived from theme tokens | Matches the brand icon. See `docs/research/visual-depth.md` |

## Layout

```
src/server/
  index.ts            Hono app, static files in production
  routes.ts           REST API (threads, providers, MCP, usage, settings)
  chat.ts             /api/chat and turnStream() (one turn, shared with schedules), auto-compaction, titles
  appearance.ts       Validated per-user appearance API (preferences + custom themes inside user_settings)
  account.ts          Account display name and private PNG/JPEG/WebP profile pictures (SQLite BLOBs)
  memory.ts           Encrypted account/project memories, BM25 retrieval, summaries in the prompt, past-chat search, model tools, import/export
  memory-learn.ts     Background memory worker: reviews idle chats into fact operations, rewrites scope summaries
  skills.ts           Agent Skills: per-account SKILL.md packages, sources (GitHub/raw), model tools, approval
  projects.ts         Projects: instructions, pinned files, system prompt section
  admin.ts            Admin API: users, groups, sign-up switch, system prompts, server-wide provider keys and their audiences
  groups.ts           User groups and share audiences (everyone, or chosen groups/users) for shared providers and MCP servers
  prompts.ts          Every server system prompt: defaults, admin overrides (server_settings `prompt:<key>`), `{placeholder}` filling
  shares.ts           Public read-only links (/api/public/shares, no auth)
  search.ts           Full-text search over messages (FTS5, synced by triggers in db.ts)
  schedules.ts        Scheduled prompts: next-run math, 30 s ticker, server-side runs
  artifacts.ts        Artifact and document tools, versions table, panel/file API
  quota.ts            Per-user storage quota: used-byte SQL, limits, assertStorage for every write path
  attachment-storage.ts Materializes legacy/saved temporary inline files without changing history
  public-fetch.ts     Address-checked fetch for user/model-chosen URLs: pinned public DNS, revalidated redirects, body caps
  browser.ts          Client for the browser worker: job calls, health, the worker token the app generates
  skill-fetch.ts      Skill-source HTTP transport on top of public-fetch: port, HTTPS-downgrade, and token safeguards
  export.ts           Chat export (Markdown, PDF via the browser worker)
  library.ts          Library: persistent uploads, sandbox outputs, generated images, latest artifacts, skill packages; owned previews/deletes
  documents/          PDF (browser worker), DOCX creation + OOXML editing, XLSX read/write/preview
  codex.ts            Codex CLI login (device code), per-run CODEX_HOME with encrypted credentials, token refresh for chat
  llm.ts              Model factory per wire format, cache breakpoints, OpenCode headers
  catalog/            models.dev catalog + provider connections (encrypted keys)
  mcp/                MCP connection manager, OAuth provider, storage
  tools/              Built-in tools: web_search, web_fetch (+ Scrapling fallback), generate_image (Codex or image APIs), delegate_task (sub-agents), run_code (sandbox client)
  turn-context.ts     Stores each turn's memory/skills block and replays it so later requests keep the cached prefix
  compaction.ts usage.ts files.ts fonts.ts (uploaded font files, SQLite BLOBs) threads.ts settings.ts auth.ts db.ts
src/web/
  App.tsx             Auth gate and lazy entry points (wouter)
  ChatShell.tsx       Authenticated shell, onboarding, chat and settings routes
  runtime/            assistant-ui runtime: thread list, history, attachments, model context
  components/chat/    Composer controls, context meter, tool renderers
  components/artifacts Artifact card, side panel, sandboxed frame documents
  components/genui    Generative UI catalog (render_spec components) and widget toolkit
  components/settings Settings pages; theme/ holds the T3Code theme library, editor panel, color picker, inspector
  components/share    Public share page and share button
  theme/              T3Code theme engine port (see its README); bundled-fonts.ts lists the shipped font families; depth.css holds the depth utilities
  fonts/              Bundled Liberation TTFs and their CSS (see docs/research/bundled-fonts.md)
  state/              zustand stores (data, appearance, fonts, thread meta); appearance-sync.ts handles account cache and outbox
src/browser/          Browser worker (own container): job server, Playwright renderer and viewers, Scrapling client, egress proxy
docker/               SearXNG settings, browser worker entrypoint and firewall
sandbox/              Code sandbox container: runner.py (stdlib HTTP service), Dockerfile, pinned requirements.txt
src/shared/types.ts   Types shared by both sides
src/shared/appearance.ts  Appearance schema and shared types
docs/                 Reusable documentation (see below)
```

## Documentation

`docs/` holds knowledge that outlives a single task. Read the relevant file before working on an area, and update it when you learn something.

- `docs/ROADMAP.md`: what is built, what is next.
- `docs/research/opencode-go.md`: OpenCode Go endpoints, headers, catalog, limits.
- `docs/research/prompt-caching.md`: cache strategy per wire format.
- `docs/research/mcp.md`: `@ai-sdk/mcp` usage and reliability rules.
- `docs/research/assistant-ui.md`: runtime, thread list, history, components.
- `docs/research/code-blocks.md`: lazy syntax highlighting, per-block wrapping, sticky toolbars, HTTP clipboard fallback, KaTeX math, and Mermaid diagrams.
- `docs/research/t3code-appearance.md`: what we ported from T3Code and how, including appearance sync.
- `docs/research/visual-depth.md`: depth tokens and utilities, where each is applied, and the rules for adding more.
- `docs/research/web-bundle.md`: lazy route boundaries, library chunks, and production load verification.
- `docs/research/web-search.md`, `docs/research/scrapling.md`: keyless search and page fetching.
- `docs/research/bundled-fonts.md`: fonts shipped in the picker, their licenses, and the Liberation source.
- `docs/research/codex-images.md`: image generation through the Codex CLI, login, credential handling.
- `docs/research/codex-chat.md`: chatting with the user's ChatGPT plan through the Codex backend: endpoint, headers, body rules, token refresh.
- `docs/research/image-generation.md`: image services (Codex, OpenAI, Gemini, xAI, Together, FLUX, fal, Replicate), key reuse, service choice.
- `docs/research/generative-ui.md`: `generative-frame` widgets and spec mode, browser-executed tools.
- `docs/research/documents.md`: PDF/DOCX/XLSX tools, the HTML subset, in-place editing, Chromium lifecycle.
- `docs/research/library.md`: the Library page and API: what is catalogued, upload thread recovery, pagination, previews.
- `docs/research/memory.md`: Claude/ChatGPT and agent-memory research (Mem0, Letta, Mastra), the summary/review/retrieval design, controls, and transfer formats.
- `docs/research/skills.md`: the Agent Skills format, sources, tools, approval flow, and caching.
- `docs/research/account-profile.md`: profile photo validation, resizing, storage, and private serving.
- `docs/research/step-limits.md`: independent agent/search limits and shared delegated-search budgets.
- `docs/research/code-sandbox.md`: the `run_code` sandbox container, its per-run jail, installed tools, and the runner API.
- `docs/research/browser-worker.md`: the browser worker container, its job API, token, egress firewall, and rendering policies.
- `docs/research/storage-quota.md`: what counts against the per-user storage quota and where it is enforced.
- `docs/research/security.md`: threat model, the controls per area, and the known residual risks. Read before changing auth, outbound requests, rendering, or tool approval.
- `docs/research/mobile-pwa.md`: manifest, service worker, install requirements, safe areas, touch sizing, drawer gestures.

Add a new file under `docs/research/` whenever you research an external API or library.

## Working with subagents

You can delegate to smaller-model subagents (for example Haiku) for specialized, well-bounded tasks: researching one library and writing a doc, porting a file, mechanical refactors, writing tests for a known interface. Give them the exact files, the target path, and the acceptance check. Keep architecture decisions and cross-cutting changes with the main agent, and review subagent output before relying on it.

## Conventions

- TypeScript strict. ESM only.
- Server code never imports from `src/web`. Shared types live in `src/shared`.
- Secrets (provider keys, MCP tokens) and memory content are encrypted at rest with `OKAYCHAT_SECRET` (AES-256-GCM). This protects a copied database file only, not a compromised server, which holds the key. See the threat model in `docs/research/memory.md`. Never log secrets.
- Match the surrounding code style. Comments explain why, not what.
- Commits: no co-author lines.

## Non-obvious facts

- assistant-ui puts unknown message metadata keys under `metadata.custom`. Server-side code that reads raw AI SDK messages sees them at the top level. `metadataOf()` and `currentContextTokens()` handle both.
- `useAuiState` selectors must return primitives or stable references, or React re-renders forever.
- The model is per chat. A stored chat uses `threadModels[threadId]` (picked in its composer and PATCHed to `threads.model_ref`, or loaded from the thread list); a new chat uses the in-memory `selectedModel`, cleared for fresh chats and copied to the thread when it is created. Read it in chat components with `useChatModel()` and elsewhere with `getActiveModel(remoteId)`. Never restore the legacy `okaychat:selected-model` local-storage key, which masked account defaults. Resolution is chat choice → active project → account default → first available model. Settings fallback menu items persist `null` to clear overrides (`undefined` disappears from JSON). See `docs/research/assistant-ui.md`.
- The composer's Search toggle is an in-memory per-chat override (`state/chat-search.ts`), sent as `config.webSearch` and keyed by thread id, bound to the remote id when a thread is created. It only hides `web_search`; `web_fetch` stays, and the account's `webTools` setting still disables both. On touch devices and below the `sm` breakpoint the reasoning and search controls move into the plus-button menu, which also triggers attachments. "Instant" is the label for `none` reasoning effort.
- The chat request body comes from `AssistantChatTransport`: thread id is `id`, model and effort are `config.modelName` / `config.reasoningEffort` (registered in `ModelContextBridge`).
- models.dev lists embedding, rerank, and speech models with text output and most image models with text+image output. The chat model list drops models whose output is anything but text, and ids/families matching `NON_CHAT_ID` in `catalog/models-dev.ts` (live and custom-provider lists too).
- The `chatgpt` provider is the Codex login (`codex_auth`), not a key. `readConnections()` adds it as a virtual connection while the login exists; a `provider_connections` row only stores its on/off switch, and it can never be shared by an admin. `catalog/chatgpt.ts` lists its models from the Codex backend and wraps fetch: bearer token from `codexAccess()` (refreshed in the same per-user queue as CLI runs, because the refresh token rotates), `stream: true`, `store: false`, no `temperature` or `prompt_cache_breakpoint`. See `docs/research/codex-chat.md`.
- Shared provider connections and shared MCP servers have an audience (`groups.ts`). No `share_audiences` row means everyone; a row restricts the resource to the users in `share_users` plus members of the groups in `share_groups`. Readers filter with the `audienceIncludes()` SQL condition (bind the user id twice). Deleting the resource must call `clearAudience()`, because provider ids repeat and a stale restriction would apply to a re-added key. A restricted provider does not reach the admin either unless they are in its audience.
- OpenCode Go ids missing from models.dev inherit the wire format of a sibling in the same family (`qwen3.6-plus` uses Anthropic like `qwen3.8-max`).
- Documents are artifacts with bytes: `content` is the HTML/JSON source and `data`/`size` the built file. `edit_document` with source edits rebuilds; with `ops` it edits the binary and clears the source so a rebuild cannot undo it. Imported attachments are only editable with `ops`.
- Chromium runs only in the browser worker container (`src/browser/`), never in the app. In the container each part is its own user: the job API (`jobs`, holds the token, no browser), one render slot per concurrent job (exits after each job), the fetch server with Scrapling over stdio (`scrape`), and the egress proxy (`egress`); the firewall allows each only the connections in `docs/research/browser-worker.md`. `npm run dev` runs all of it in one process (role `all`). It starts on the first job, shares one process across fresh contexts, and closes 60 s after the last one. Renders are offline (only the document and staged files) except HTML/React previews, which may load `FRAME_NETWORK_HOSTS` through the worker's egress proxy. A timed-out or abandoned job has its context closed (browser killed if wedged) before its slot is released. The app talks to it through `browser.ts` with a token it generates into `OKAYCHAT_BROWSER_TOKEN_FILE`; there is no `.env` entry. See `docs/research/browser-worker.md`.
- `tsconfig.server.json` includes the DOM lib because `linkedom`/`@xmldom/xmldom` types refer to `Element`/`Document`. Use the xmldom aliases (`XmlElement`, `Document as XmlDocument`) in OOXML code.
- `view_artifact` renders in the browser worker and returns a screenshot to the model. The image is injected once by `prepareStep` as a synthetic user message, never inside the tool result (OpenAI-compatible APIs stringify tool content). Only vision models get the tool, six screenshots per reply, and nothing image-related is persisted. PDF pages come from pdf.js, DOCX from docx-preview, XLSX from the preview JSON.
- DuckDuckGo HTML endpoints return 202 (bot wall) from many servers and Bing serves junk to scrapers. Search goes SearXNG, then Brave HTML, then DuckDuckGo lite.
- Context fill uses the last step's input + output tokens, not the turn total.
- `generate_image` offers every connected image service the account left on. OpenAI/Gemini/xAI/Together reuse the chat provider connection; image-only keys are `image-<service>` provider connections. With several services the tool requires a `service` and tells the model to ask the user first. Generated images may be JPEG/WebP/GIF: `images.mime` is authoritative, the file name stays `<id>.png`. See `docs/research/image-generation.md`.
- `threads.updated_at` is last message activity, bumped only by `appendMessage`. `updateThread` (rename, pin, archive, move, title) must not touch it, or the sidebar's date groups jump. See `docs/research/assistant-ui.md`.
- Depth (highlights, tinted shadows, accent gradients) comes from `depth-*` utilities in `theme/depth.css`, derived from semantic tokens with `color-mix`. Use them instead of `shadow-*`/`bg-primary` on primitives, and never hardcode colors there or theme switches break. See `docs/research/visual-depth.md`.
- Sidebar multi-selection starts from a row's "Select" menu item. State lives in `state/thread-selection.ts` (rows render inside assistant-ui's list); `ThreadListItemGroups` publishes the visible order, used for Shift ranges and Select all, and ids leaving it drop from the selection. Bulk Pin/Move/Archive/Delete go through `aui.threads.item({ id })`, so the runtime list stays in sync. The Library uses the same helpers (`components/ui/selection.tsx`); see `docs/research/library.md`.
- Sidebar shortcuts are configurable per account (`sidebarItems` in General settings). Search is a global spotlight dialog (Ctrl/Cmd+K), independent of the project filter; selecting a result clears that filter. `/scheduled`, `/projects`, `/library`, and `/plugins` retain the chat sidebar and lazy-load `NavigationPage`; Plugins holds MCP servers and Skills. See `docs/research/assistant-ui.md` and `docs/research/library.md`.
- Skills are Agent Skills (SKILL.md + optional files), stored per account. The enabled-skills index is injected beside the latest user message, never in the system prefix; `load_skill`/`read_skill_file` fetch bodies on demand. `install_skill`/`create_skill` always require approval, exist only for non-temporary chats with the preference on, and never reach delegates — `turnSkills()` returns a read-only `subTools` pair for them. Every skill-tool execution re-checks the captured preference revision, so switching skills off revokes tools mid-run. Normal skill CRUD does not bump the revision; tools read live tables. Source installs recheck revocation after fetching. Skill sources use pinned public DNS and revalidated redirects, 30 s/20 MB download bounds and bounded ZIP expansion and their content is stored as text — never executed. See `docs/research/skills.md`.
- System prompts live in `prompts.ts`, not next to their callers. Read them with `promptText(key, values)`; a new prompt needs a `PromptKey` in `shared/types.ts` and a `DEFS` entry, and then shows up on the admin page. Overrides are server-wide and replace the default text entirely; saving text equal to the default stores no override. Unknown `{name}` tokens stay literal (the artifact prompt contains `{page}`).
- Hono matches routes in registration order: static paths (e.g. `/skills/sources`) must be registered before parameterized ones (`/skills/:id`) or they are shadowed.
- A `never`-returning helper only drives control-flow narrowing as a function *declaration* (or an arrow without defaulted params). `const invalid = (msg, status = 400): never => …` silently fails narrowing under `noUncheckedIndexedAccess`; `skills.ts` declares it as a function for this reason.
- Icon motion is global: `motion/icons.ts` (installed in `main.tsx`) sets `data-icon-motion="hover"|"press"` on lucide icons inside the control being hovered or focused (after a 1 s settle delay) or clicked (immediately), and clears it when the animations finish. Gestures live in `motion/icons.css`, keyed by lucide's `lucide-<name>` class and child order; unknown icons get a generic lift and pop. Spinners are skipped; opt a subtree out with `data-icon-motion-off`. Sidebar selection uses `GlideHighlight` (rows opt in with `data-glide`).
- Tool calls collapse into a "N tool calls" group by default. Tools whose card must stay visible get a `"tool-call:<name>": []` entry in `messageGroupBy` (`thread.aui.tsx`). Once a reply is `complete`, `foldWork()` moves everything except its outcome into one collapsed "Worked in N steps" group: the outcome is all parts after the last tool call plus the last card per result (`resultKey()`: artifact id, widget title, spec, run_code, each image). A new card tool needs a `resultKey` case. Artifact versions count turns, not tool calls: `saveVersion` overwrites the version the current turn already saved (`INSERT OR REPLACE`, quota charges net growth), and continuation requests recover the turn's ids with `artifactsInCurrentTurn()`. Sandbox outputs follow the same rule: `SandboxTurn` tracks files first stored this turn, and when the answer ends (`onEnd`, not abort) it deletes those the last file-writing `run_code` did not produce.
- Menu, select, and model-picker popups scroll through `components/ui/scroll-area.tsx` (Base UI ScrollArea), which draws its own thumb inset from the rounded border. Native scrollbars cross the border, and Firefox ignores `::-webkit-scrollbar`. Pass only a `max-h-*` to `MenuContent`, never `overflow-y-auto`.
- Artifact frames have an opaque origin (no `allow-same-origin`), so `localStorage` throws. `frame.ts` injects in-memory storage before any artifact code runs.
- Web code must not use `crypto.randomUUID()`: it is missing on plain-HTTP origins (the tailnet dev URL), and assistant-ui swallows the resulting attachment errors. Use `generateId` from `ai`.
- Browser-executed tools need `sendAutomaticallyWhen` on `useChatRuntime`, or the turn stops after the first one. The server merges their schemas from the request body with `frontendTools`.
- Tools can stream progress: an `async function*` execute yields preliminary outputs the UI renders live. `toModelOutput` controls what the model sees (sub-agents send only the report).
- MCP goes beyond tools (`docs/research/mcp.md`): image results are saved like generated images and injected once for vision models; resources use one shared `mcp_list_resources`/`mcp_read_resource` pair; prompts fill the composer; elicitation forms stream as preliminary outputs of the generator `execute`, with a pausable call timeout; MCP Apps render in our own null-origin frame (`McpApp.tsx`), not assistant-ui's hosted-shim renderer. `toolsForUser()` returns `tools` (interactive) and `subTools` (sub-agents: no approval tools, elicitations declined). Admins can share a server with everyone or chosen groups and users: viewers keep their own switch, tool toggles, and OAuth tokens; network rules follow `ownerId`.
- Appearance has its own validated `/api/appearance` endpoint. Generic settings forms must not overwrite it. Only changed top-level appearance fields are patched; custom theme libraries travel with the preferences. First-device migration uses PUT without replacing an existing snapshot.
- Chat reload recovery uses assistant-ui resumable session storage per thread and `initialThreadId` to restore selection per tab/account. The server retains SSE replay in memory for 15 minutes after the last update; Stop calls an explicit cancel endpoint, while page unload leaves generation running. See `docs/research/assistant-ui.md`.
- Branching always forks into a new chat; it never reruns the current one. `POST /threads/:id/branch` copies the chosen message and its ancestors (message ids are kept, keys are per thread), the source's settings, and compaction only when its boundary is inside the copy; `threads.branched_from` drives the "Branched from" link. A fork that must answer (user-message branch, or any model switch) is queued in `pendingRuns` (`components/chat/branch.tsx`) and started with `thread.startRun` once its history loads. Retry on a user message is an in-place `startRun({ parentId })`. The branch menu wraps itself in `ActionBarMorePrimitive.Root` for its interaction lock, or the hover-only action bar unmounts the open menu.
- Schedules (`schedules.ts`) target one chat (`thread_mode` `same`, the default) or a new chat per run (`new`, `thread_id` is the latest run's chat). In `same` mode, `thread_attached` marks a chat the user picked: runs use the schedule's model without overwriting the chat's (`keepThreadModel`), and if that chat is deleted the schedule turns off instead of recreating it. A due run waits while an interactive turn streams in its chat (`threadBusy()` in `chat.ts`), because the client stores that turn only when it ends.
- Messages are persisted by the client's history adapter, not by `/api/chat`. A chat sent with curl leaves the thread empty. Drive the UI to test persistence. Server-side writers (schedules) store `{ role, parts, metadata }` with format `ai-sdk/v6` and a `parent_id` chain; the current branch is the newest message and its ancestors.
- Memory is opt-in and stored separately from chats. `turnStream()` injects bounded global/current-project facts and exposes save/search/forget tools only when enabled for the account and chat. Automatic saves are model-selected; with automatic saving off, mutations require approval. The top-right chat options menu disables memory use and writes for a normal chat while keeping its history. Manual deletion/editing, reset, preference changes, and tool-based forgetting revoke already-offered memory tools through a revision counter. Changing a thread's project also revokes its old memory tools. No subagent receives the memory-writing tools. Retrieved facts sit immediately before the user message they were retrieved for; stored chats keep that block in `turn_context` and replay it in later turns (see the prompt-caching fact below). The system prefix holds the policy (`memory` prompt) and the scope summaries, pinned per thread in `threads.memory_snapshot_enc` so a background rewrite does not churn a running chat's cache. A summary is used only while its revision matches the account's, and user-requested deletions/edits drop it, so text derived from a removed fact is never sent again. `memory-learn.ts` reviews chats idle for 10 minutes (cursor `threads.memory_cursor`) and rewrites stale summaries, with the utility model, at most a few jobs per minute; it starts from `index.ts`, not on import, so tests never tick.
- Memory transfers use reviewed text/Markdown or okaychat JSON; they do not connect to Claude/ChatGPT accounts. Content is encrypted with `OKAYCHAT_SECRET`. JSON preserves project scope for the same account; unavailable scopes become global only in the review preview, with a warning. Chat deletion does not delete saved memories.
- Temporary chats use reserved `tmp_` ids and never create a thread, messages, usage records, uploads, artifacts, or memory entries. They have no replay buffer or browser storage checkpoint; reload discards them. `RuntimeProvider` skips history/title APIs and the sidebar hides them. The ghost button in the top-right starts and ends them with personalization off. Once a temporary chat has messages, the ghost offers "Save to history", which copies the current branch into a new stored thread through the normal messages API (no usage is backfilled); optional personalization (in the chat options menu) reads only global memory and custom instructions, never writes memories or includes project context. `DocumentAttachmentAdapter` must use `/files/extract?temporary=1`; its per-thread adapter comes from `unstable_useAdapters` (a global runtime attachment override would silently bypass this). Temporary tools are limited to web search/page reading and optional read-only memory search; persistent tools and compaction are unavailable.
- `maxSteps` (default 20) and `maxSearches` (default 5) are independent. A turn and all its delegates share ONE `SearchBudget` and the same built-in web tools object; create it before constructing either tool set. Browser-tool continuations recover search counts from current-turn tool history. Page reads do not consume search queries.

- Startup requests start in parallel from `App.tsx` once `/auth/status` returns a user. A new startup request belongs there (`prefetch` + `takePrefetched`), not in a mount effect, or it adds a round trip. Lazy routes use `preloadable()`, not bare `React.lazy`, which holds its fallback for up to 300 ms. See `docs/research/web-bundle.md`.

- The service worker registers only in production builds and only on secure origins, so the plain-HTTP tailnet dev URL is never installable. It never handles `/api/*`. Touch sizing uses `pointer-coarse:`, not breakpoints. See `docs/research/mobile-pwa.md`.

- Model code never runs in the app container. `run_code` calls the `sandbox` container, which has no app secrets, no `/data`, and no network but the internal one to the app. One workspace per chat, each with its own uid; every process of that uid dies after each run. The container wipes workspaces ~30 min after the last run (`SANDBOX_IDLE_MINUTES`) and everything on runner start; `run_code` outputs are copied into `sandbox_files` (SQLite) right after each run and served from `/api/sandbox/:threadId/stored`, so the sandbox is never the source of truth. Read `docs/research/code-sandbox.md` before changing either side.
- Storage is quotaed per user (`src/server/quota.ts`, `docs/research/storage-quota.md`): uploads, artifact versions (source + built bytes), generated images, sandbox outputs, fonts, avatar, memories, project originals/text, and skill metadata/bodies/references. Replacement writes charge net growth. `assertStorage` throws `QuotaError` (HTTP 413 on routes, a tool error for the model). Default limit `OKAYCHAT_STORAGE_LIMIT` (1 GiB), per-user override in nullable `users.storage_limit` set via the admin API. `/api/storage` returns `{ used, limit, defaultLimit }`; the chat shell warns from 90% (`StorageNotice`).
- Attachments are persistent original bytes in `uploads`, independent of sandbox configuration; no age pruning. Image/PDF data URL parts remain unchanged, alongside a `file_id` header. Storage failures block sends. Temporary extraction/storage stays temporary; explicitly saving a temporary chat materializes inline files. An executable, transactional migration does the same for legacy inline attachments up to 25 MiB, without rewriting history or re-creating Library-deleted files on restart. Upload originals survive chat/project deletion until Library/account deletion. The Library includes sandbox outputs and complete skill ZIP packages. See the storage/library docs.
- Auth hardening (`auth.ts`, `index.ts`): `hono/csrf` guards every `/api/*` write, so cross-site form posts (including login) get 403. Failed logins are limited in memory per email (10) and per socket + last `X-Forwarded-For` hop (50) for 15 minutes. Unknown emails still run scrypt against a dummy hash. Sign-up hashes the password before reading the user count, so concurrent first sign-ups cannot both become admin. The MCP OAuth redirect origin is `OKAYCHAT_PUBLIC_URL`, else learned per user from that user's own signed-in requests, so a forged `Host` only misdirects the sender's own codes. The OAuth callback page escapes all text. Unexpected 500s return a generic message with a log reference; throw `HTTPException` for messages the user should see. Every response gets `frame-ancestors 'self'`, `nosniff`, and a referrer policy; a script CSP is impossible because srcdoc artifact frames inherit it. `/api/*` bodies are capped at 100 MB, and `PATCH /settings` drops unknown keys. Emails are stored lowercase; login matches `lower(email)` for older mixed-case rows. The Docker image starts as root only to chown `/data`, then runs as `node`.
- Outbound requests to URLs a user or model chose go through `publicFetch` (`public-fetch.ts`): DNS is checked at connection time, every redirect is revalidated, and private, loopback, link-local, and tailnet ranges are refused. This covers `web_fetch`, non-admin provider base URLs (`Connection.guarded`), image-model lists, and non-admin MCP servers (`mcpFetch`). Admins may use local hosts (Ollama, LAN MCP servers), and only admins' stdio servers run. Scrapling and the worker's Chromium connect only through the worker's egress proxy (`src/browser/egress-proxy.ts`), which applies the same check to every hop and picks a policy by the connecting socket's uid; the worker's firewall blocks everything else. Tests that point a mock provider at a local or mocked URL must make the user an admin. Changing a provider base URL or MCP URL to another origin requires re-entering the key/header values and clears MCP OAuth tokens, so a hijacked session cannot redirect stored secrets.
- Model-written HTML never gets an open network. Artifact frames carry a meta CSP (`artifact-frame.ts`: scripts, styles, fonts, images, and connections only from `FRAME_NETWORK_HOSTS`, no form posts), and the server renderer additionally blocks WebSockets, WebRTC, service workers, and DNS for other hosts. See `docs/research/documents.md`.
- Abuse limits: 4 concurrent chat turns per account (`reserveTurn` in `chat.ts`), 50 schedules, 30 MCP servers. Users change their password under Account (current password required, 10 failures per 15 min, other sessions revoked) and can sign out other devices; `c.get("session")` is the current session's token hash.
- Provider caches match exact prefixes, and DeepSeek-style templates put tools after the first system message. Every request of a chat must extend the previous one byte for byte. System message 1 is identical for every chat of the account (nothing per chat or per day); project and memory summary go in system message 2; the date, new memory facts, and skills index go in a per-turn block stored per user message (`turn-context.ts`), replayed verbatim, and holding only what earlier blocks do not show. Its memory text is encrypted and replayed only while the account's memory revision is unchanged. The tool list never changes within a turn (the final step sends `toolChoice: "none"`; `web_search` rejects calls past its budget). Cache routing (`x-opencode-session`, `prompt_cache_key`) is one hashed value per account (`cacheAffinity()`), and GPT-5.6+ get an explicit breakpoint on system message 1. Temporary chats store nothing and keep only the latest block. See `docs/research/prompt-caching.md`.
- Compaction has two forms in one `CompactionState` (`compaction.ts`): a summary replacing messages through `boundaryMessageId`, and a trim (`trim.throughMessageId`) after which earlier messages are sent text-only. `trimMessage()` drops reasoning and provider-executed tools, replaces tool results, long tool arguments, attachment bodies, and file parts with placeholders, and strips provider item ids (OpenAI would reject function calls whose reasoning items are gone). The trim boundary is always the message before the newest user message, so the latest exchange stays complete. The trimmed head converts without `tools`, since tools' `toModelOutput` cannot read placeholder strings. Replies older than the trim report untrimmed sizes; `contextTokens()` uses the trim's estimate until a newer reply reports. Auto-compaction trims first only with `trimBeforeCompact` on. Trimmed chats get `read_attachment`.
- Long chats render through a message window (`WindowedMessages` in `thread.aui.tsx`): the newest 16 messages first, older ones in slices after each paint back to 80, then "Show earlier messages" adds 50 per click. The runtime still holds every message. Do not switch back to `ThreadPrimitive.Messages`, which mounts the whole history in one task. See `docs/research/web-bundle.md`.
- Server memory: an idle server holds about 150 MB RSS. Heavy libraries load on first use: exceljs/pdf-lib/docx (via `documents/lazy.ts`), linkedom/Readability/turndown (web reads), mammoth, and the image-only AI SDK providers. Keep new heavy imports lazy, and keep tool schemas in light modules (`documents/schemas.ts`). The models.dev catalog is compacted to the fields `RawModel` lists. `GET /threads/:id/messages` splices the stored JSON rather than parsing it.
- DB migrations are append-only SQL or synchronous functions, each wrapped with its own version update in one transaction. `tx()` uses savepoints so multi-skill imports and nested storage helpers roll back atomically.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Server (tsx watch, 127.0.0.1:8787) + Vite (tailnet IP:5173, proxies `/api`) + browser worker (127.0.0.1:8791, own process, no firewall) |
| `npm run typecheck` | Both tsconfigs |
| `npm test` | Node tests (appearance, account pictures, storage quota, tool limits, library, memory, skills, sandbox, and streamed chat integration) |
| `npm run build` / `npm start` | Production build and server |

**Dev servers always run on the tailnet.** The user wants every dev server reachable over Tailscale. Vite binds to `tailscale ip -4` (override with `OKAYCHAT_DEV_HOST`) and allows `*.ts.net` hosts. Share the MagicDNS URL (`http://<host>.<tailnet>.ts.net:5173`), not localhost. Do not bind to `0.0.0.0`.

Local dev needs `.env` with `OKAYCHAT_SECRET` (see `.env.example`). Web tools in dev need two helpers, or search fails (Brave 429, DuckDuckGo 202 from this host):

- SearXNG container `okaychat-dev-searxng` on `127.0.0.1:8888` (`OKAYCHAT_SEARXNG_URL`). Command in `.env.example`.
- Scrapling via `scripts/dev-scrapling.sh`, which runs it from the `okaychat-browser:latest` image (`OKAYCHAT_SCRAPLING_COMMAND`, read by the dev browser worker). Build it first: `docker build --target browser -t okaychat-browser:latest .`.

Code execution in dev: set `OKAYCHAT_SANDBOX_TOKEN` and `OKAYCHAT_SANDBOX_URL=http://127.0.0.1:8790` in `.env`, then run `scripts/dev-sandbox.sh` (container `okaychat-dev-sandbox`). Unlike compose, the dev sandbox has internet access.

The server reads `.env` only at start. Restart `npm run dev` after editing it.
