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
  projects.ts         Projects: instructions, pinned files, system prompt section
  shares.ts           Public read-only links (/api/public/shares, no auth)
  search.ts           Full-text search over messages (FTS5, synced by triggers in db.ts)
  schedules.ts        Scheduled prompts: next-run math, 30 s ticker, server-side runs
  artifacts.ts        Artifact tools, versions table, panel API
  codex.ts            Codex CLI login (device code) and per-run CODEX_HOME with encrypted credentials
  llm.ts              Model factory per wire format, cache breakpoints, OpenCode headers
  catalog/            models.dev catalog + provider connections (encrypted keys)
  mcp/                MCP connection manager, OAuth provider, storage
  tools/              Built-in tools: web_search, web_fetch (+ Scrapling fallback), generate_image (Codex), delegate_task (sub-agents)
  compaction.ts usage.ts files.ts threads.ts settings.ts auth.ts db.ts
src/web/
  App.tsx             Auth gate, onboarding, shell, routes (wouter)
  runtime/            assistant-ui runtime: thread list, history, attachments, model context
  components/chat/    Composer controls, context meter, tool renderers
  components/artifacts Artifact card, side panel, sandboxed frame documents
  components/genui    Generative UI catalog (render_spec components) and widget toolkit
  components/settings Settings pages
  components/share    Public share page and share button
  theme/              T3Code theme engine port (see its README)
  state/              zustand stores (data, appearance, thread meta)
src/shared/types.ts   Types shared by both sides
docs/                 Reusable documentation (see below)
```

## Documentation

`docs/` holds knowledge that outlives a single task. Read the relevant file before working on an area, and update it when you learn something.

- `docs/ROADMAP.md`: what is built, what is next.
- `docs/research/opencode-go.md`: OpenCode Go endpoints, headers, catalog, limits.
- `docs/research/prompt-caching.md`: cache strategy per wire format.
- `docs/research/mcp.md`: `@ai-sdk/mcp` usage and reliability rules.
- `docs/research/assistant-ui.md`: runtime, thread list, history, components.
- `docs/research/t3code-appearance.md`: what we ported from T3Code and how.
- `docs/research/web-search.md`, `docs/research/scrapling.md`: keyless search and page fetching.
- `docs/research/codex-images.md`: image generation through the Codex CLI, login, credential handling.
- `docs/research/generative-ui.md`: `generative-frame` widgets and spec mode, browser-executed tools.

Add a new file under `docs/research/` whenever you research an external API or library.

## Working with subagents

You can delegate to smaller-model subagents (for example Haiku) for specialized, well-bounded tasks: researching one library and writing a doc, porting a file, mechanical refactors, writing tests for a known interface. Give them the exact files, the target path, and the acceptance check. Keep architecture decisions and cross-cutting changes with the main agent, and review subagent output before relying on it.

## Conventions

- TypeScript strict. ESM only.
- Server code never imports from `src/web`. Shared types live in `src/shared`.
- Secrets (provider keys, MCP tokens) are encrypted at rest with `OKAYCHAT_SECRET` (AES-256-GCM). Never log them.
- Match the surrounding code style. Comments explain why, not what.
- Commits: no co-author lines.

## Non-obvious facts

- assistant-ui puts unknown message metadata keys under `metadata.custom`. Server-side code that reads raw AI SDK messages sees them at the top level. `metadataOf()` and `currentContextTokens()` handle both.
- `useAuiState` selectors must return primitives or stable references, or React re-renders forever.
- The chat request body comes from `AssistantChatTransport`: thread id is `id`, model and effort are `config.modelName` / `config.reasoningEffort` (registered in `ModelContextBridge`), `planMode` comes from the transport `body` function.
- OpenCode Go ids missing from models.dev inherit the wire format of a sibling in the same family (`qwen3.6-plus` uses Anthropic like `qwen3.8-max`).
- DuckDuckGo HTML endpoints return 202 (bot wall) from many servers and Bing serves junk to scrapers. Search goes SearXNG, then Brave HTML, then DuckDuckGo lite.
- Context fill uses the last step's input + output tokens, not the turn total.
- Tool calls collapse into a "N tool calls" group by default. Tools whose card must stay visible get a `"tool-call:<name>": []` entry in `messageGroupBy` (`thread.aui.tsx`).
- Artifact frames have an opaque origin (no `allow-same-origin`), so `localStorage` throws. `frame.ts` injects in-memory storage before any artifact code runs.
- Browser-executed tools need `sendAutomaticallyWhen` on `useChatRuntime`, or the turn stops after the first one. The server merges their schemas from the request body with `frontendTools`.
- Tools can stream progress: an `async function*` execute yields preliminary outputs the UI renders live. `toModelOutput` controls what the model sees (sub-agents send only the report).
- Messages are persisted by the client's history adapter, not by `/api/chat`. A chat sent with curl leaves the thread empty. Drive the UI to test persistence. Server-side writers (schedules) store `{ role, parts, metadata }` with format `ai-sdk/v6` and a `parent_id` chain; the current branch is the newest message and its ancestors.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Server (tsx watch, 127.0.0.1:8787) + Vite (tailnet IP:5173, proxies `/api`) |
| `npm run typecheck` | Both tsconfigs |
| `npm run build` / `npm start` | Production build and server |

**Dev servers always run on the tailnet.** The user wants every dev server reachable over Tailscale. Vite binds to `tailscale ip -4` (override with `OKAYCHAT_DEV_HOST`) and allows `*.ts.net` hosts. Share the MagicDNS URL (`http://<host>.<tailnet>.ts.net:5173`), not localhost. Do not bind to `0.0.0.0`.

Local dev needs `.env` with `OKAYCHAT_SECRET` (see `.env.example`). Web tools in dev need two helpers, or search fails (Brave 429, DuckDuckGo 202 from this host):

- SearXNG container `okaychat-dev-searxng` on `127.0.0.1:8888` (`OKAYCHAT_SEARXNG_URL`). Command in `.env.example`.
- Scrapling via `scripts/dev-scrapling.sh`, which runs it from the `okaychat:latest` image (`OKAYCHAT_SCRAPLING_COMMAND`). Build the image first.

The server reads `.env` only at start. Restart `npm run dev` after editing it.
