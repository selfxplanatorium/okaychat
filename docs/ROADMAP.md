# Roadmap

Status as of 2026-11-05. Update this file when a feature ships or a plan changes.

## Pass 1: core (built)

| Area | What exists | Notes |
| --- | --- | --- |
| Accounts | Email + password, first user is admin. Settings → Admin: add users, change roles, reset passwords (signs the user out), delete users, open or close sign-up | scrypt hashes, 30-day httpOnly session cookie. The sign-up switch overrides `OKAYCHAT_ALLOW_SIGNUP` once set |
| Profile | Settings → Account: change display name, upload/change/remove a profile picture; account menu displays the saved image | Private per-account raster images in SQLite, server format/dimension/size checks, browser resize and metadata removal |
| Memory | Settings → Memory: opt-in encrypted facts, a synthesized memory summary per scope, background review of idle chats (add/update/delete), BM25 fact retrieval, past-chat search, automatic or approval-based saves, in-chat save/search/forget, manual CRUD/search/reset, project scopes, top-right per-chat exclusion | Used across providers and schedules. Reviewed Claude/ChatGPT text/Markdown imports, okaychat JSON round-trip, and readable exports. Selective model-controlled saving; no direct provider-account synchronization |
| Knowledge | Account collections of PDF/DOCX/XLSX/text/code files, pasted text, or one fetched URL (original bytes kept; extraction separate); structure-aware chunks with exact source offsets; hybrid FTS5 + cosine retrieval; per-chat attachments from the composer; read-only `search_knowledge`/`read_knowledge_chunk` tools; inline citations that open the source passage; `/knowledge` management page with collection editing, progress, retry, cancel, reindex, search test | OpenAI/Google/Ollama/OpenAI-compatible embeddings or keyword-only. Per-turn context only, so prompt caching keeps working. Resumable in-process ingestion. See `docs/implementation/knowledge.md` |
| Temporary chats | The top-right ghost starts an unsaved conversation with personalization off; chat options can enable read-only global memory/custom instructions. The ghost offers Save to history once the chat has content | Browser memory only until explicitly saved; no temporary history/usage/uploads/artifacts or replay. Reload discards an unsaved chat; saving materializes its attachments without backfilling usage |
| Tool limits | Independent agent steps (default 20) and web searches (default 5; 0 disables searches) in Settings → General | Hard query budget shared with delegated tasks, retained over browser-tool continuations; page reads remain available |
| Server-wide keys | Admins connect providers for every user or for chosen groups and users (Settings → Admin). Each audience can be limited to some catalog models (all models by default); a user gets the union of their audiences. A user's own key for the same provider wins. Users see a "Server key" badge | `shared_connections`, merged under each user's connections in `catalog/providers.ts`, filtered by audience and model policy. Admins are not exempt. See `docs/implementation/entitlements.md` |
| User groups | Settings → Admin → Groups: named sets of users. Server-wide providers and shared MCP servers go to everyone or to chosen groups and single users | `groups.ts`: `share_audiences` row = restricted; `share_users`/`share_groups` list who |
| Providers | OpenCode Go first (onboarding), the user's own ChatGPT plan through the Codex login, OpenCode Zen, native Ollama, and every models.dev provider that speaks OpenAI, OpenAI-compatible, Anthropic, or Google APIs. Custom OpenAI-compatible endpoints (LM Studio, vLLM, older proxies) remain separate | Keys AES-256-GCM encrypted. Go model list is live from `/v1/models`, enriched by models.dev. ChatGPT models are live from the Codex backend (`docs/implementation/codex-chat.md`). Ollama uses `/api/tags`, `/api/show`, and `/api/ps` for installed models, capabilities, context, and loaded state, with pull progress and delete (`docs/implementation/ollama.md`) |
| Chat | assistant-ui Thread: streaming, Markdown, reasoning, tool calls, branches, edit, regenerate, copy, export; streams resume after reload | Threads and branching history persisted in SQLite. Selected chat and pending stream stored per tab; replay held in server memory for 15 minutes after the last update |
| Reply editing | Settings → General → Edit assistant messages (off by default, with a confirmation naming every consequence): a pencil on finished replies opens an inline editor, saved text gets an "Edited" badge and Undo | Per account. Only text parts change; id, branch, children, tools, reasoning, and files stay. The first original is kept encrypted for auditing and Undo. Refused while a turn writes, off the latest branch, covered by a summary, or for user messages. Edited text feeds later turns, retries, search, exports, and shares. See `docs/implementation/message-editing.md` |
| Model picker | Search, favorites, capability icons, context size, price, per-model reasoning effort | |
| Files | Images (vision, also pasted from the clipboard), PDFs as native file input up to 10 MB, DOCX (server text extraction), 60+ text/code formats | Models without PDF input get the extracted text, swapped in per request on the server (`pdf-parts.ts`), so switching models keeps working. PDFs without a text layer get a clear note |
| MCP | Streamable HTTP, SSE, stdio (admin only), OAuth with PKCE + dynamic registration, per-tool toggles, status, reconnect, timeouts, idle close. Image results (saved, shown, injected for vision models), resources (`mcp_list_resources`/`mcp_read_resource`), prompts (composer Prompts menu), form elicitation, MCP Apps (`ui://` cards), admin-shared servers | See `docs/implementation/mcp.md` |
| Tool approvals | MCP tools marked destructive (or every tool, per server) wait for Allow / Deny in the thread. After untrusted content, destructive/outbound tools ask even under a `never` policy, with the risk named; schedules auto-deny; delegates never receive destructive tools | See `docs/implementation/mcp.md` and `docs/implementation/prompt-injection.md` |
| Prompt injection | Third-party text from web, MCP (results, descriptions, instructions, prompts), files, projects, skills, artifacts, research, delegates, memory, knowledge, email, editable drafts, and past chats gets a deterministic data envelope and an advisory instruction badge. Destructive tools after that content ask even under `never`, MCP App calls included. Remote Markdown images wait for an exact-URL Load; tool cards use local icons | No classifier. Residual risks and sources in `docs/implementation/prompt-injection.md` |
| Sub-agents | `delegate_task` runs a self-contained task on an allowed model (default sub-agent model, utility model, chat model) with web and approval-free MCP tools. Progress streams into a card; only the report reaches the main context. Usage recorded as `subagent` | Toggle and default model in Settings → General |
| Scheduled prompts | Sidebar → Scheduled: a prompt, model, and schedule (local time on chosen weekdays, or every N minutes). Runs on the server with the browser closed, into one chat, a new chat per run, or an attached existing chat. Run now, enable, edit | Server writes `ai-sdk/v6` history. An attached chat keeps its own model, runs wait while it streams, and deleting it disables the schedule. Interactive MCP elicitation is declined by schedules |
| Projects | Sidebar → Projects and the project switcher: per-project instructions, pinned files (PDF/DOCX/text, 300k chars total), and default model. New chats join the active project | Project text lives in the second, per-chat system message, so the shared account prefix stays stable |
| Search | Global spotlight (Ctrl/⌘+K) matches titles and message text through SQLite FTS5, independent of the active project. Selecting a result clears the project filter | `messages_fts` is kept in sync by triggers on `messages`, so every writer is indexed |
| Sharing | Share button on a chat creates a read-only public link (`/share/<token>`), revocable. Live: shows the current branch. Exposes text, generated images, and artifacts (rendered); hides reasoning, tool inputs, usage, and costs | Public endpoints under `/api/public/shares`, outside the auth middleware |
| Email | Settings → Email connects a mailbox through IMAP and SMTP: ordered discovery (known providers, Thunderbird autoconfig, Microsoft Autodiscover, RFC 6186 SRV, verified hostname probes) with live, cancellable progress, an editable wizard, connection test, per-account read/send switches, signature, and default. The assistant can inventory accounts, list folders, list/search/read messages, and send or reply after an approval that shows the exact from address, recipients, subject, and complete body (signature included, never appended later) | App passwords only; OAuth is not built. Non-admin connections are role-checked and DNS-pinned on every connect. Attachments download only when explicitly named, with 20 MB/file and 50 MB/message caps through the normal storage quota. Delegates and schedules cannot send. See `docs/implementation/email.md` |
| Email drafts | The assistant writes an email with `draft_email`, shown as a compact editable letter in the chat. The card has To/Cc/Bcc, Subject, an auto-growing plain-text body, a sender account, an Edited/Updated marker, a word count, and a quiet toolbar: Send after an exact-payload review, Copy, Download `.eml`, Open in mail app, and Discard. Autosave is debounced and revision-checked, survives reload and account switches, and keeps unsaved text on a conflict or offline retry | Drafts are persisted per user and chat, shared by the tool and the card. Send uses the same approved SMTP path as `email_send`/`email_reply` with a single-use review token, live sender/signature/send-switch checks, and sent/read-only/resend. No account disables Send with a settings link. Plain text only; no attachments, templates, rich HTML, or scheduled send. See `docs/implementation/email.md` |
| Voice | Read aloud (Piper on the server by default, browser, OpenAI, OpenAI Realtime, Azure, ElevenLabs, Mistral, OpenAI-compatible) and speech to text (browser, Whisper on the server, OpenAI, Groq, Mistral, Azure, Deepgram, ElevenLabs, OpenAI-compatible), audio-file transcription, auto-send and auto-play. Optional NVIDIA GPU acceleration for server Whisper, with a safe CPU fallback | Read aloud is off until chosen. Recordings are not stored unless an admin sets retention. The microphone needs HTTPS; over plain HTTP the button transcribes a picked or phone-recorded file. GPU use and its fallback are shown in Admin → Voice. See `docs/implementation/speech.md` |
| Voice calls | Continuous spoken conversation in a full-screen call view: local Whisper → normal chat turn → streaming Piper, with barge-in that cancels the turn, or optional OpenAI Realtime speech-to-speech over WebRTC. Per-call engine choice, live transcript, mute, timer, actionable failures | Local needs the speech worker but no account keys and records nothing. Realtime uses the server-held OpenAI key and does not use tools/RAG/memory/compaction. One call per account, 30 min default cap. See `docs/implementation/voice-calls.md` |
| Caching | Stable prompt prefix, Anthropic breakpoints, OpenAI `prompt_cache_key`, OpenCode session affinity headers | See `docs/implementation/prompt-caching.md` |
| Usage | Per message (tokens, cache %, cost, time), per thread, dashboard by day/model/purpose, OpenCode Go 5 h/week/month spend | Cost uses models.dev prices incl. context tiers |
| Context | Composer ring with fill %, auto-compact threshold marker, thread cost | |
| Compaction | Automatic at a threshold (default 80%) and manual. Summary replaces older turns; marker in the thread shows the summary. Optional trim first: earlier messages keep their text, lose reasoning, tool results, and file contents (`read_attachment` brings a file back) | Branch-aware: a reply at or before the summary boundary cannot be edited or undone; replies after it, and text inside a trim, can. An edit shifts the trim's context estimate |
| Appearance | Port of T3Code: theme library, light/dark/system, per-mode halves, custom + VS Code theme import, contrast, glass opacity, chat width, panel motion, fonts and sizes, word wrap. Synced per user across devices, including custom themes. Depth layer (lit surfaces, tinted shadows, accent gradients, floating sidebar) derived from every theme | Local cache for instant application; unsaved edits survive reloads and retry on focus/reconnect. MIT, credited in `src/web/theme/` |
| Branding | Lit green tile with overlapping white dialogue marks, plus a separate rounded serif SVG wordmark. Shared across sidebar, sign-in, onboarding, and public shares | Both follow the brand accent. Browser and PWA icons contain only the tile; the wordmark uses a CSS mask |
| Web | `web_search` (SearXNG sidecar, then Brave HTML, then DuckDuckGo lite) and `web_fetch` (Readability → Markdown, PDFs, paging, Scrapling fallback with optional headless Chromium). Source cards in the UI | No keys. Toggle in Settings → General |
| Deep research | Composer toggle (Alt+Shift+D, plus menu on phones): plan, web-only workers (parallel on the sub-agent model when allowed), gap and conflict review with one follow-up round, cited report as the reply. Live progress card with questions and pages read | Spends the account's search and step limits. See `docs/implementation/deep-research.md` |
| Artifacts | `create_artifact` / `update_artifact` (exact find/replace edits or full rewrite) / `read_artifact`. HTML, React (TSX via Babel + esm.sh + Tailwind browser build), SVG, Markdown, code. Side panel with preview/code, versions, copy, download, resize | Sandboxed iframe without `allow-same-origin`. Preview needs internet for the CDNs. Toggle in Settings → General |
| Documents | `create_document` / `edit_document` / `read_document` / `import_document` for PDF, Word, and Excel. HTML/CSS becomes a vector PDF through Chromium in the separate browser worker or a Word file through `docx`; a JSON workbook becomes XLSX through `exceljs`, with formulas evaluated and row/column inserts shifting references. Uploaded PDF/DOCX/XLSX files are imported and edited in place. Panel previews: browser PDF viewer, `docx-preview`, spreadsheet grid; source and download alongside. `view_artifact` returns a screenshot to vision models for layout checks | See `docs/implementation/documents.md`. PDF creation needs the browser worker; other formats work without Chromium |
| Generative UI | `render_spec` (declarative components from our themed catalog: cards, tables, metrics, bars, forms) and `show_widget` / `edit_widget` (HTML/SVG in a null-origin sandbox with render reports for repair), via `generative-frame` | Tools run in the browser. See `docs/implementation/generative-ui.md`. Toggle in Settings → General |
| Image generation | `generate_image` through the user's ChatGPT plan (Codex CLI) or image APIs: OpenAI, Gemini, xAI, Together (reusing chat provider keys), Black Forest Labs, fal, Replicate (image-only keys). Settings → General switches services on/off and picks the model; with several on, the assistant asks which to use. References for edits, images inline with download | See `docs/implementation/image-generation.md`, `docs/implementation/codex-images.md` |
| Code execution | `run_code` runs Python and Bash in a separate `sandbox` container. One workspace per chat with its own uid, files persist between runs, attachments copied in by `file_id`, images inline and files downloadable. Each run jailed by bubblewrap with no network at all (own network, mount, IPC namespaces, inner seccomp filter), fails closed. Offline toolset: FFmpeg, LibreOffice, Pandoc, Tesseract/OCRmyPDF, poppler, qpdf, Ghostscript, Graphviz, librsvg, ExifTool, archives, scientific Python. Outputs can be imported for `view_artifact` (PPTX via LibreOffice) | See `docs/implementation/code-sandbox.md`. Toggle in Settings → General |
| Keyboard | Every feature without a pointer: configurable shortcuts (Settings → Keyboard, synced per account), a command list that runs any command by name (Ctrl/⌘+/), message navigation (J/K, then C/E/R/B), arrow keys in the chat list and model picker, Enter or Ctrl/⌘+Enter to send | Defaults avoid browser shortcuts (Alt+Shift+letter). See `docs/implementation/keyboard.md` |
| Mobile app | Installable PWA (manifest, maskable icons, offline shell), safe areas, touch-sized controls, swipe drawer, native-style settings rows | Install needs HTTPS. See `docs/implementation/mobile-pwa.md` |
| Deploy | Dockerfile with two targets (`app`; `browser`: Chromium + Scrapling worker), separate sandbox and speech Dockerfiles, Compose with all workers and SearXNG | Optional `docker-compose.gpu.yml` enables CUDA Whisper. `SCRAPLING_BROWSER=false` skips Scrapling's stealth-browser fallback |

## Pass 10: custom tools (built)

- Plugins → Custom tools: private per-account Python functions and fixed-destination HTTPS request tools,
  strict schema builder, write-only encrypted secrets, exact approval review, workspace tests, retained
  run ledger, counters and a new `customTools` permission. Python uses a one-use sandbox function mode;
  HTTP uses `publicFetch` only, with redirects and private destinations refused. See
  `docs/implementation/custom-tools.md`.

## Pass 2: completed

- Resumable streams and selected-chat restoration after reload.
- Per-user appearance sync, including custom theme libraries, with first-device migration and offline edit recovery.
- Code-split authenticated chat, public shares, and settings, with separate cacheable library chunks. Sign-in does not load the authenticated chat runtime. See `docs/implementation/web-bundle.md` for the boundaries and measurement method.

- Startup path: the session check starts the shell chunk, appearance, account data, chat list, and restored chat messages in parallel. Preloaded routes avoid a Suspense hold. The startup loader appears only after 700 ms. Production assets are precompressed and cached; model catalogs warm at boot and refresh without blocking requests. See `docs/implementation/web-bundle.md`.
- Prompt-injection defenses: provenance envelopes, heuristic badges, per-turn approval gating for destructive/outbound actions, stable instruction hierarchy, and consent-gated remote Markdown images. See `docs/implementation/prompt-injection.md`.
- Plain-language errors: one server taxonomy with safe wire fields, provider status/body mapping and `Retry-After`, capped jittered abortable retries with a visible "Retrying in Ns…" state, actionable chat errors (Retry, Switch model, Open setting, Copy details), plain tool errors, inline settings/upload failures, and a mounted render boundary. See `docs/implementation/errors.md`.
- Current implementation guides live in `docs/implementation/`. Obsolete research snapshots and copied vendor components have been removed; generated build output and design working files are excluded from version control.

## Pass 3: UX flows (built)

An audit of the main interaction flows and six improvements that keep frequent actions where the user already is. See `docs/implementation/ux-audit.md` for the evidence and the deliberate deferrals.

- **Retry with another model, in place**: the assistant action bar opens the favorite-aware model list and re-answers the same user message in the current chat, never a branch. Announced and shown in the composer; blocked while history is cached.
- **Complete context popover**: explains that the ring counts the last reply's final step (input + output), links to the auto-compaction row, and adds open/compact/trim commands.
- **Settings deep links**: one typed helper (`lib/settings-link.ts`) with real focus targets; used by the context popover, model picker, memory, research web-tools state, and shortcut hints. No new pages.
- **Commands in Ctrl/⌘+K**: the chat spotlight gains a Commands group from the existing registry, with one keyboard order across commands and chats and focus kept on the command's destination.
- **Sidebar quick create**: Projects and Scheduled get a one-click `+` and real empty-state actions; both forms open immediately from `?new=1`.
- **First-run shortcut hints**: a quiet, account-dismissed row in an empty chat teaches the configured search, model, and command bindings, with a retryable save failure.

Deferred: a per-chat tools sheet (needs consolidated per-chat capability state).

## Pass 4: resilience (built)

- **Graceful degradation**: one service registry with cached, single-flight probes (browser worker and its Scrapling fallback, speech worker, sandbox, SearXNG, and per-account Codex, providers, and email statuses that never contact a vendor), an authenticated `GET /api/services`, tools withheld per turn with the reason stored on the reply, fail-fast `service_unavailable` with a fix hint, a dismissible notice only after the service was actually used, explanatory panel states (Voice, Library, PDF export), and recovery on focus or a failed action. See `docs/implementation/service-health.md`.

## Pass 5: reuse and revisit (built)

- **Personal saved prompts**: account-wide templates with `{{variable}}` filling, a combined Prompts dialog that keeps external MCP prompts, and `/shortcut` insertion in the main composer. See `docs/implementation/saved-prompts.md`.
- **Private message bookmarks**: per-message marks with a current-branch jump list, focus and a short semantic highlight, and no copy into forks. See `docs/implementation/message-annotations.md`.
- **Private answer feedback**: Helpful / Not helpful plus an optional encrypted comment, explicit edit/remove, conflict handling, and a changed-reply notice.
- **Accessible reply details**: a real Details button and popover for the stored model, token, cache, cost, and time values; the compact footer is no longer hover-only.

All four are private account data beside messages or the prompt library. None enters message content, prompts, search, exports, public shares, memory, or provider requests by itself.

## Pass 6: connected workspace (built)

- **n8n webhook agents**: per-account agents with encrypted definitions and auth headers, NDJSON/SSE/JSON response parsing, optional history memory, streaming chat, stop, usage counters, and shared audiences. See `docs/implementation/n8n-agents.md`.
- **Liquid glass appearance**: a vendored, attributed Glisse 0.5.0 adaptation with explicit backdrop sources, bounded material leases, performance tiers, appearance settings, and Glisse switches across the app. The sliding sidebar selection card was removed in favour of a static selection. See `docs/implementation/appearance.md`.
- **Granular permissions**: an admin workspace for people, groups, models, features, limits, prompt overrides, effective inspection, and audit; per-model and per-user instructions; server-side enforcement across tools, routes, jobs, and runtimes. See `docs/implementation/granular-permissions.md`.
- **Assistant presets, continuation, and archives**: named reusable assistants with copied snapshots and restrictive tool/knowledge policies; explicit continuation of length-limited replies with generation receipts; portable native chat archives with bounded import/export. See `docs/implementation/assistant-presets.md`, `continuation.md`, and `chat-archives.md`.
- **Performance pass**: FTS row addressing and trigger repair, a history time index, scoped model resolution, bounded live-model caches, and a repeatable benchmark. See `docs/implementation/performance.md`.
- **Official ChatGPT sign-in**: the SIWC desktop-helper flow for chat, independent of the Codex CLI image connection, behind a default-off deployment flag until the live release checks pass. See `docs/implementation/codex-chat.md`.

## Pass 7: sharing, tags, notices, comparison (built)

- **Share links v2**: several links per chat, live or frozen snapshots, expiry, optional password with
  a scoped HMAC cookie, per-link view counts, an account-wide manager, and a revoke that ends every
  cookie. See `docs/implementation/share-links.md`.
- **Thread tags**: flat private labels, sidebar filtering that ANDs with project and search, and saved
  filter presets synced per account. See `docs/implementation/thread-tags.md`.
- **Notification center**: durable, deduped notices for scheduled runs and archive jobs, unread state,
  and opt-in system notifications through the service worker (no Web Push). See
  `docs/implementation/notifications.md`.
- **Model comparison**: `/compare` with 2–3 panes, each a hidden real chat running the normal turn
  pipeline and persisted server-side, with promote-to-chat and 30-day retention. See
  `docs/implementation/model-comparison.md`.

Deferred: share slugs/QR/analytics/watermarks, tag hierarchy/colors/automation, Web Push and quiet
hours, more than three panes or pane-side tools/artifacts, comparison judging and export.

## Pass 8: private evaluation workspace (built)

- **Datasets and runs**: `/evaluations` holds named case sets with revision compare-and-set, immutable
  per-run snapshots of the cases and target, and no chat/thread reuse. One active run per account is a
  partial unique index; the worker is in-process, bounded to two runs, and never resumes after a
  restart. See `docs/implementation/evaluations.md`.
- **Scoring and judging**: manual 1–5 or pass/fail scores with encrypted comments, plus one rubric judge
  pass whose candidate and reference answers arrive inside the untrusted-data envelope. Re-judging
  replaces judge rows only.
- **Comparison and export**: two runs of one dataset side by side, CSV/JSON download with a
  spreadsheet formula guard, budget/time/output caps, and per-table storage accounting.

Deferred: dataset import/templates, rubric libraries, multiple judges, pairwise preference judging,
one-click reruns of failed cases, regression gates, scheduled or webhook runs, sharing/admin
visibility, charts, and tool-using or multi-turn cases.

## Pass 9: team channels (built)

- **Rooms and authority**: public/private/group shared rooms with explicit membership, one owner,
  moderators, invitations, exclusions, transfer, archive, and audited admin moderation. Group rooms
  follow live group membership. See `docs/implementation/channels.md`.
- **Text messaging**: Markdown text only, quoted replies by message id, structured mentions, six
  reactions, monotonic read cursors, `all`/`mentions`/`none` notices, room search, and a mobile-first
  `/channels` workspace with lazy route, sidebar unread badge, keyboard commands, and a focused member
  and settings experience.
- **Resumable invalidations**: a durable event log, HMAC cursors with epoch/floor reset, bounded SSE
  with heartbeat and per-account/process caps, a polling fallback, and sync refresh on revocation.
- **Explicit room AI**: model or reduced-preset binding, transactional admission with a frozen source
  boundary and encrypted transcript, an in-process two-slot worker with checkpoints/cancellation and
  exactly-once usage kind `channel`, and no tools, memory, projects, files, RAG, or personal context.

Deferred: uploads/images, nested threads, DMs, presence, custom emoji, room sharing/export/import,
scheduled room posting, autonomous AI, in-place regeneration, per-room retention, and multi-writer
deployment.

## Known gaps

- Stream replay is kept in server memory for 15 minutes after the last update. Reload recovery works; pending generations do not survive a server restart.

- No public usage/limits API for OpenCode Go was found. Go windows show our own recorded spend, not the remaining quota.

- Deliberate deferrals: MFA/SSO and a Postgres backend. Chats stay private to an account unless shared read-only; team rooms are a separate aggregate with explicit membership. Authentication is password-based with session revocation, and storage is SQLite plus files.

## ChatGPT plan OAuth release gate

The SIWC desktop helper, encrypted store, and transport are implemented behind a default-off deployment flag. Live server-exchange admission, namespaced tool round trips, rotation, deployment eligibility, mobile resume, and image independence must pass before enabling it in a release. The CLI remains image-only; see `docs/implementation/codex-chat.md`.
