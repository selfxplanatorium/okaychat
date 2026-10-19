# Roadmap

Status as of 2026-10-19. Update this file when a feature ships or a plan changes.

## Pass 1: core (built)

| Area | What exists | Notes |
| --- | --- | --- |
| Accounts | Email + password, first user is admin. Settings → Admin: add users, change roles, reset passwords (signs the user out), delete users, open or close sign-up | scrypt hashes, 30-day httpOnly session cookie. The sign-up switch overrides `OKAYCHAT_ALLOW_SIGNUP` once set |
| Server-wide keys | Admins connect providers for every user (Settings → Admin). A user's own key for the same provider wins. Users see a "Server key" badge | `shared_connections`, merged under each user's connections in `catalog/providers.ts` |
| Providers | OpenCode Go first (onboarding), OpenCode Zen, and every models.dev provider that speaks OpenAI, OpenAI-compatible, Anthropic, or Google APIs. Custom OpenAI-compatible endpoints (Ollama, LM Studio, vLLM) | Keys AES-256-GCM encrypted. Go model list is live from `/v1/models`, enriched by models.dev |
| Chat | assistant-ui Thread: streaming, Markdown, reasoning, tool calls, branches, edit, regenerate, copy, export; streams resume after reload | Threads and branching history persisted in SQLite. Selected chat and pending stream stored per tab; replay held in server memory for 15 minutes after the last update |
| Model picker | Search, favorites, capability icons, context size, price, per-model reasoning effort | |
| Files | Images (vision, also pasted from the clipboard), PDFs as native file input up to 10 MB, DOCX (server text extraction), 60+ text/code formats | Models without PDF input get the extracted text, swapped in per request on the server (`pdf-parts.ts`), so switching models keeps working. PDFs without a text layer get a clear note |
| MCP | Streamable HTTP, SSE, stdio (admin only), OAuth with PKCE + dynamic registration, per-tool toggles, status, reconnect, timeouts, idle close | See `docs/research/mcp.md` |
| Tool approvals | MCP tools marked destructive (or every tool, per server) wait for Allow / Deny in the thread | See `docs/research/mcp.md` |
| Sub-agents | `delegate_task` runs a self-contained task on an allowed model (default sub-agent model, utility model, chat model) with web and approval-free MCP tools. Progress streams into a card; only the report reaches the main context. Usage recorded as `subagent` | Toggle and default model in Settings → General |
| Plan mode | Composer toggle. The server offers only web, sub-agent, and read-only MCP tools and asks for a numbered plan. "Execute plan" under the answer switches to act mode and runs it | Mode is per device. The mode instructions sit at the end of the system prompt |
| Scheduled prompts | Settings → Scheduled: a prompt, model, and schedule (local time on chosen weekdays, or every N minutes). Runs on the server into the schedule's own chat, also with the browser closed. Run now, enable, edit | Server writes messages in the client's `ai-sdk/v6` history format. Tools that need approval wait until the chat is opened |
| Projects | Sidebar switcher filters chats by project; new chats join the active project. Per-project instructions, pinned files (PDF/DOCX/text, 300k chars total), default model. Settings → Projects | Project text sits in the system prompt after user instructions, so it caches across the project's turns |
| Search | Sidebar search matches titles locally and message text through SQLite FTS5 (prefix match, diacritics folded, highlighted snippets), scoped to the active project | `messages_fts` is kept in sync by triggers on `messages`, so every writer is indexed |
| Sharing | Share button on a chat creates a read-only public link (`/share/<token>`), revocable. Live: shows the current branch. Exposes text, generated images, and artifacts (rendered); hides reasoning, tool inputs, usage, and costs | Public endpoints under `/api/public/shares`, outside the auth middleware |
| Voice | Mic button (browser speech recognition, in the browser's language) and "Read aloud" on answers (browser speech synthesis, Markdown and code stripped) | No server or keys. Dictation needs HTTPS or localhost, so it is hidden over plain-HTTP origins such as the tailnet dev URL; use `tailscale serve` for HTTPS. Chrome sends dictation audio to Google |
| Caching | Stable prompt prefix, Anthropic breakpoints, OpenAI `prompt_cache_key`, OpenCode session affinity headers | See `docs/research/prompt-caching.md` |
| Usage | Per message (tokens, cache %, cost, time), per thread, dashboard by day/model/purpose, OpenCode Go 5 h/week/month spend | Cost uses models.dev prices incl. context tiers |
| Context | Composer ring with fill %, auto-compact threshold marker, thread cost | |
| Compaction | Automatic at a threshold (default 80%) and manual. Summary replaces older turns; marker in the thread shows the summary | Branch-aware: editing above the boundary ignores the summary |
| Appearance | Port of T3Code: theme library, light/dark/system, per-mode halves, custom + VS Code theme import, contrast, glass opacity, chat width, panel motion, fonts and sizes, word wrap. Synced per user across devices, including custom themes | Local cache for instant application; unsaved edits survive reloads and retry on focus/reconnect. MIT, credited in `src/web/theme/` |
| Web | `web_search` (SearXNG sidecar, then Brave HTML, then DuckDuckGo lite) and `web_fetch` (Readability → Markdown, PDFs, paging, Scrapling fallback with optional headless Chromium). Source cards in the UI | No keys. Toggle in Settings → General |
| Artifacts | `create_artifact` / `update_artifact` (exact find/replace edits or full rewrite) / `read_artifact`. HTML, React (TSX via Babel + esm.sh + Tailwind browser build), SVG, Markdown, code. Side panel with preview/code, versions, copy, download, resize | Sandboxed iframe without `allow-same-origin`. Preview needs internet for the CDNs. Toggle in Settings → General |
| Generative UI | `render_spec` (declarative components from our themed catalog: cards, tables, metrics, bars, forms) and `show_widget` / `edit_widget` (HTML/SVG in a null-origin sandbox with render reports for repair), via `generative-frame` | Tools run in the browser. See `docs/research/generative-ui.md`. Toggle in Settings → General |
| Image generation | `generate_image` through each user's own ChatGPT plan via the Codex CLI. Device-code login in Settings → General, credentials encrypted at rest, references for edits, images inline with download | See `docs/research/codex-images.md` |
| Deploy | Dockerfile (Node 22 + Python venv with Scrapling, optional Chromium), Compose with SearXNG | `SCRAPLING_BROWSER=false` build arg for a smaller image |

## Pass 2: completed

- Resumable streams and selected-chat restoration after reload.
- Per-user appearance sync, including custom theme libraries, with first-device migration and offline edit recovery.
- Code-split authenticated chat, public shares, and settings. Separate cacheable React, assistant-ui, AI SDK, Markdown, UI primitives, and widget chunks. Sign-in startup JavaScript is about 573 KB (184 KB gzip), down from 1.87 MB (571 KB gzip); the largest individual chunk is about 326 KB. See `docs/research/web-bundle.md`.

No planned core items remain. New work can be tracked as a subsequent pass.

## Known gaps

- Stream replay is kept in server memory for 15 minutes after the last update. Reload recovery works; pending generations do not survive a server restart.

- No public usage/limits API for OpenCode Go was found. Go windows show our own recorded spend, not the remaining quota.
- Live chat, tools, and web search are confirmed working against OpenCode Go with the user's key. The earlier local key had expired, which is why the first end-to-end test failed.
