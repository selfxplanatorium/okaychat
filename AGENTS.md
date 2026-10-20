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
| Generative UI | `generative-frame` (spec mode + sandboxed widgets) | Both renderers, streaming, render reports for repair. See `docs/research/generative-ui.md` |
| Files | `unpdf` (PDF), `mammoth` (DOCX) | Pure JS, no native deps |
| Web | `linkedom` + `@mozilla/readability` + `turndown`; SearXNG sidecar for search | Free, no keys. See `docs/research/web-search.md` |
| Theming | Port of T3Code appearance settings (MIT) | Required by the product brief |

## Layout

```
src/server/
  index.ts            Hono app, static files in production
  routes.ts           REST API (threads, providers, MCP, usage, settings)
  chat.ts             /api/chat and turnStream() (one turn, shared with schedules), auto-compaction, titles
  appearance.ts       Validated per-user appearance API (preferences + custom themes inside user_settings)
  account.ts          Account display name and private PNG/JPEG/WebP profile pictures (SQLite BLOBs)
  memory.ts           Encrypted account/project memories, model tools, reviewed import and portable export
  projects.ts         Projects: instructions, pinned files, system prompt section
  admin.ts            Admin API: users, sign-up switch, server-wide provider keys
  shares.ts           Public read-only links (/api/public/shares, no auth)
  search.ts           Full-text search over messages (FTS5, synced by triggers in db.ts)
  schedules.ts        Scheduled prompts: next-run math, 30 s ticker, server-side runs
  artifacts.ts        Artifact and document tools, versions table, panel/file API
  documents/          PDF (Chromium), DOCX creation + OOXML editing, XLSX read/write/preview
  codex.ts            Codex CLI login (device code) and per-run CODEX_HOME with encrypted credentials
  llm.ts              Model factory per wire format, cache breakpoints, OpenCode headers
  catalog/            models.dev catalog + provider connections (encrypted keys)
  mcp/                MCP connection manager, OAuth provider, storage
  tools/              Built-in tools: web_search, web_fetch (+ Scrapling fallback), generate_image (Codex), delegate_task (sub-agents)
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
  theme/              T3Code theme engine port (see its README); bundled-fonts.ts lists the shipped font families
  fonts/              Bundled Liberation TTFs and their CSS (see docs/research/bundled-fonts.md)
  state/              zustand stores (data, appearance, fonts, thread meta); appearance-sync.ts handles account cache and outbox
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
- `docs/research/t3code-appearance.md`: what we ported from T3Code and how, including appearance sync.
- `docs/research/web-bundle.md`: lazy route boundaries, library chunks, and production load verification.
- `docs/research/web-search.md`, `docs/research/scrapling.md`: keyless search and page fetching.
- `docs/research/bundled-fonts.md`: fonts shipped in the picker, their licenses, and the Liberation source.
- `docs/research/codex-images.md`: image generation through the Codex CLI, login, credential handling.
- `docs/research/generative-ui.md`: `generative-frame` widgets and spec mode, browser-executed tools.
- `docs/research/documents.md`: PDF/DOCX/XLSX tools, the HTML subset, in-place editing, Chromium lifecycle.
- `docs/research/memory.md`: official Claude/ChatGPT memory research, okaychat memory controls, and transfer formats.
- `docs/research/account-profile.md`: profile photo validation, resizing, storage, and private serving.
- `docs/research/step-limits.md`: independent agent/search limits and shared delegated-search budgets.

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
- The chat request body comes from `AssistantChatTransport`: thread id is `id`, model and effort are `config.modelName` / `config.reasoningEffort` (registered in `ModelContextBridge`).
- OpenCode Go ids missing from models.dev inherit the wire format of a sibling in the same family (`qwen3.6-plus` uses Anthropic like `qwen3.8-max`).
- Documents are artifacts with bytes: `content` is the HTML/JSON source and `data`/`size` the built file. `edit_document` with source edits rebuilds; with `ops` it edits the binary and clears the source so a rebuild cannot undo it. Imported attachments are only editable with `ops`.
- The PDF renderer never starts at boot: `documents/render.ts` launches Chromium on the first job, shares it, and closes it 60 s after the last one. Every request except the injected document is aborted, so model HTML cannot reach the network or `file://`.
- `tsconfig.server.json` includes the DOM lib because `linkedom`/`@xmldom/xmldom` types refer to `Element`/`Document`. Use the xmldom aliases (`XmlElement`, `Document as XmlDocument`) in OOXML code.
- `view_artifact` renders in the shared Chromium and returns a screenshot to the model. The image is injected once by `prepareStep` as a synthetic user message, never inside the tool result (OpenAI-compatible APIs stringify tool content). Only vision models get the tool, six screenshots per reply, and nothing image-related is persisted. PDF pages come from pdf.js, DOCX from docx-preview, XLSX from the preview JSON.
- DuckDuckGo HTML endpoints return 202 (bot wall) from many servers and Bing serves junk to scrapers. Search goes SearXNG, then Brave HTML, then DuckDuckGo lite.
- Context fill uses the last step's input + output tokens, not the turn total.
- Tool calls collapse into a "N tool calls" group by default. Tools whose card must stay visible get a `"tool-call:<name>": []` entry in `messageGroupBy` (`thread.aui.tsx`).
- Artifact frames have an opaque origin (no `allow-same-origin`), so `localStorage` throws. `frame.ts` injects in-memory storage before any artifact code runs.
- Web code must not use `crypto.randomUUID()`: it is missing on plain-HTTP origins (the tailnet dev URL), and assistant-ui swallows the resulting attachment errors. Use `generateId` from `ai`.
- Browser-executed tools need `sendAutomaticallyWhen` on `useChatRuntime`, or the turn stops after the first one. The server merges their schemas from the request body with `frontendTools`.
- Tools can stream progress: an `async function*` execute yields preliminary outputs the UI renders live. `toModelOutput` controls what the model sees (sub-agents send only the report).
- Appearance has its own validated `/api/appearance` endpoint. Generic settings forms must not overwrite it. Only changed top-level appearance fields are patched; custom theme libraries travel with the preferences. First-device migration uses PUT without replacing an existing snapshot.
- Chat reload recovery uses assistant-ui resumable session storage per thread and `initialThreadId` to restore selection per tab/account. The server retains SSE replay in memory for 15 minutes after the last update; Stop calls an explicit cancel endpoint, while page unload leaves generation running. See `docs/research/assistant-ui.md`.
- Messages are persisted by the client's history adapter, not by `/api/chat`. A chat sent with curl leaves the thread empty. Drive the UI to test persistence. Server-side writers (schedules) store `{ role, parts, metadata }` with format `ai-sdk/v6` and a `parent_id` chain; the current branch is the newest message and its ancestors.
- Memory is opt-in and stored separately from chats. `turnStream()` injects bounded global/current-project facts and exposes save/search/forget tools only when enabled for the account and chat. Automatic saves are model-selected; with automatic saving off, mutations require approval. The top-right chat options menu disables memory use and writes for a normal chat while keeping its history. Manual deletion/editing, reset, preference changes, and tool-based forgetting revoke already-offered memory tools through a revision counter. Changing a thread's project also revokes its old memory tools. No subagent receives the memory-writing tools. Retrieved facts sit immediately before the current user message; only stable memory policy belongs in the system prefix.
- Memory transfers use reviewed text/Markdown or okaychat JSON; they do not connect to Claude/ChatGPT accounts. Content is encrypted with `OKAYCHAT_SECRET`. JSON preserves project scope for the same account; unavailable scopes become global only in the review preview, with a warning. Chat deletion does not delete saved memories.
- Anonymous chats use reserved `tmp_` ids and never create a thread, messages, usage records, uploads, artifacts, or memory entries. They have no replay buffer or browser storage checkpoint; reload discards them. `RuntimeProvider` skips history/title APIs and the sidebar hides them. The top-right menu starts them with personalization off; optional personalization reads only global memory and custom instructions, never writes memories or includes project context. `DocumentAttachmentAdapter` must use `/files/extract?temporary=1`; its per-thread adapter comes from `unstable_useAdapters` (a global runtime attachment override would silently bypass this). Anonymous tools are limited to web search/page reading and optional read-only memory search; persistent tools and compaction are unavailable.
- `maxSteps` (default 20) and `maxSearches` (default 5) are independent. A turn and all its delegates share ONE `SearchBudget` and the same built-in web tools object; create it before constructing either tool set. Browser-tool continuations recover search counts from current-turn tool history. Page reads do not consume search queries.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Server (tsx watch, 127.0.0.1:8787) + Vite (tailnet IP:5173, proxies `/api`) |
| `npm run typecheck` | Both tsconfigs |
| `npm test` | Node tests (appearance, account pictures, independent tool limits, memory isolation/imports, and streamed-chat integration) |
| `npm run build` / `npm start` | Production build and server |

**Dev servers always run on the tailnet.** The user wants every dev server reachable over Tailscale. Vite binds to `tailscale ip -4` (override with `OKAYCHAT_DEV_HOST`) and allows `*.ts.net` hosts. Share the MagicDNS URL (`http://<host>.<tailnet>.ts.net:5173`), not localhost. Do not bind to `0.0.0.0`.

Local dev needs `.env` with `OKAYCHAT_SECRET` (see `.env.example`). Web tools in dev need two helpers, or search fails (Brave 429, DuckDuckGo 202 from this host):

- SearXNG container `okaychat-dev-searxng` on `127.0.0.1:8888` (`OKAYCHAT_SEARXNG_URL`). Command in `.env.example`.
- Scrapling via `scripts/dev-scrapling.sh`, which runs it from the `okaychat:latest` image (`OKAYCHAT_SCRAPLING_COMMAND`). Build the image first.

The server reads `.env` only at start. Restart `npm run dev` after editing it.
