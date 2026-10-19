# Roadmap

Status as of 2026-10-19. Update this file when a feature ships or a plan changes.

## Pass 1: core (built)

| Area | What exists | Notes |
| --- | --- | --- |
| Accounts | Email + password, first user is admin, optional open sign-up | scrypt hashes, 30-day httpOnly session cookie |
| Providers | OpenCode Go first (onboarding), OpenCode Zen, and every models.dev provider that speaks OpenAI, OpenAI-compatible, Anthropic, or Google APIs. Custom OpenAI-compatible endpoints (Ollama, LM Studio, vLLM) | Keys AES-256-GCM encrypted. Go model list is live from `/v1/models`, enriched by models.dev |
| Chat | assistant-ui Thread: streaming, Markdown, reasoning, tool calls, branches, edit, regenerate, copy, export | Threads and branching history persisted in SQLite |
| Model picker | Search, favorites, capability icons, context size, price, per-model reasoning effort | |
| Files | Images (vision), PDF and DOCX (server text extraction), 60+ text/code formats | PDFs without a text layer get a clear note |
| MCP | Streamable HTTP, SSE, stdio (admin only), OAuth with PKCE + dynamic registration, per-tool toggles, status, reconnect, timeouts, idle close | See `docs/research/mcp.md` |
| Caching | Stable prompt prefix, Anthropic breakpoints, OpenAI `prompt_cache_key`, OpenCode session affinity headers | See `docs/research/prompt-caching.md` |
| Usage | Per message (tokens, cache %, cost, time), per thread, dashboard by day/model/purpose, OpenCode Go 5 h/week/month spend | Cost uses models.dev prices incl. context tiers |
| Context | Composer ring with fill %, auto-compact threshold marker, thread cost | |
| Compaction | Automatic at a threshold (default 80%) and manual. Summary replaces older turns; marker in the thread shows the summary | Branch-aware: editing above the boundary ignores the summary |
| Appearance | Port of T3Code: theme library, light/dark/system, per-mode halves, custom + VS Code theme import, contrast, glass opacity, chat width, panel motion, fonts and sizes, word wrap | MIT, credited in `src/web/theme/` |
| Web | `web_search` (SearXNG sidecar, then Brave HTML, then DuckDuckGo lite) and `web_fetch` (Readability → Markdown, PDFs, paging, Scrapling fallback with optional headless Chromium). Source cards in the UI | No keys. Toggle in Settings → General |
| Artifacts | `create_artifact` / `update_artifact` (exact find/replace edits or full rewrite) / `read_artifact`. HTML, React (TSX via Babel + esm.sh + Tailwind browser build), SVG, Markdown, code. Side panel with preview/code, versions, copy, download, resize | Sandboxed iframe without `allow-same-origin`. Preview needs internet for the CDNs. Toggle in Settings → General |
| Generative UI | `render_spec` (declarative components from our themed catalog: cards, tables, metrics, bars, forms) and `show_widget` / `edit_widget` (HTML/SVG in a null-origin sandbox with render reports for repair), via `generative-frame` | Tools run in the browser. See `docs/research/generative-ui.md`. Toggle in Settings → General |
| Deploy | Dockerfile (Node 22 + Python venv with Scrapling, optional Chromium), Compose with SearXNG | `SCRAPLING_BROWSER=false` build arg for a smaller image |

## Pass 2: next

1. Image generation through the user's own Codex CLI: per-user sandboxed `CODEX_HOME` inside the container, `codex login` device flow from the settings page, an `generate_image` tool that runs `codex exec` with image output, results stored as files and shown inline.
2. Agentic features: plan/act mode, sub-agents (delegate a task to another model), tool approval prompts for destructive MCP tools, scheduled prompts.
3. Projects: per-project instructions, pinned files, and default model.
4. Search across threads (SQLite FTS5).
5. Sharing: read-only public link for a thread.
6. Voice input (assistant-ui dictation adapter) and TTS.
7. Native PDF input for models that support it (skip text extraction), image paste from clipboard.
8. Admin page: users, sign-up toggle, server-wide provider keys.
9. Resumable streams (survive reloads) using assistant-ui's resumable transport.
10. Sync appearance settings to the server per user (now per device).
11. Code-split the chat bundle (1.6 MB unminified main chunk: assistant-ui, Markdown, AI SDK client).

## Known gaps

- No public usage/limits API for OpenCode Go was found. Go windows show our own recorded spend, not the remaining quota.
- Live chat, tools, and web search are confirmed working against OpenCode Go with the user's key. The earlier local key had expired, which is why the first end-to-end test failed.
