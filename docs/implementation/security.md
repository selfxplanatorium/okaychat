# Security

What okaychat defends against, where each control lives, and what is knowingly left open. Area docs hold the details; this file is the map.

## Threat model

Defended against:

- Other accounts on the same server. Every row is owned by a user and every route checks it.
- Anyone on the internet without an account. Only `/api/auth`, `/api/health`, the MCP OAuth callback, and share links (random 256-bit tokens) are reachable without a session.
- Content the model reads: web pages, files, MCP results, past chats. It can steer the model (prompt injection), so third-party text is spotlighted as data, remote Markdown images wait for consent, and destructive/outbound tools need approval after outside content. See `docs/implementation/prompt-injection.md`.
- Model-written code and markup. Code runs in the sandbox container, in a per-run jail with no network. Markup runs in opaque-origin frames with a CSP, or in a fresh Chromium context in the browser worker container.
- A copied database file. Provider keys, MCP secrets, memory, email passwords, and the retained original text of edited replies are AES-256-GCM encrypted with `OKAYCHAT_SECRET`.

Not defended against: an admin (who controls the server), anyone who can run code in the app container or read its environment, or a provider/MCP server you chose to trust with your data.

## Controls by area

| Area | Control | Where |
| --- | --- | --- |
| Sessions | 256-bit tokens stored as SHA-256, HttpOnly + SameSite=Lax (+ Secure behind HTTPS), 30 days | `auth.ts` |
| CSRF | `hono/csrf` on every `/api/*` write, including login | `index.ts` |
| Passwords | scrypt, constant-time compare, dummy hash for unknown emails, lowercase emails | `crypto.ts`, `auth.ts` |
| Brute force | 10 failures per email, 50 per client, 10 per account for password change, per 15 min | `auth.ts`, `account.ts` |
| Account recovery | Password change revokes other sessions; "Sign out other devices"; admin reset revokes all | `account.ts`, `admin.ts` |
| Response headers | `frame-ancestors 'self'`, `X-Frame-Options`, `nosniff`, referrer policy; generic 500s with a log reference | `index.ts` |
| Input | zod on every JSON body, 100 MB body cap, per-route upload caps, bounded ids | routes |
| Outbound requests | Public-address check at connection time, revalidated redirects, byte caps: `web_fetch`, non-admin provider/MCP URLs (including every native Ollama endpoint), image model lists, skill sources | `public-fetch.ts` |
| Browser worker egress | Chromium and Scrapling reach the network only through the worker's egress proxy (public addresses; CDN hosts only for renders), enforced by a per-uid firewall in the worker's network namespace. No app data, secrets, or host mounts; own users; no capabilities after start | `src/browser/`, `docker/browser-*.sh`, `docs/implementation/browser-worker.md` |
| Speech | Recordings transcribed in memory and not stored unless an admin sets a retention period (then encrypted, purged every 10 min, never from temporary chats); synthesized audio served only after a magic-byte audio check; 25 MB / 4096-character caps, 6 concurrent requests per account; non-admin self-hosted speech URLs pass the public-address check (Realtime WebSockets checked before connecting). The speech worker is a separate container with no app data, a generated token, read-only root, and no capabilities | `speech/`, `src/server/speech/` |
| Stored secrets | Write-only in the UI; never follow a changed origin; MCP OAuth tokens cleared on URL change | `providers.ts`, `routes.ts`, `skills.ts` |
| User files | Served with `sandbox` CSP, `nosniff`, download by default; images/fonts sniffed | `files.ts`, `tools/sandbox.ts`, `fonts.ts`, `account.ts` |
| Artifacts in the browser | Sandboxed opaque-origin iframe plus a meta CSP: network only to `FRAME_NETWORK_HOSTS`, no form posts | `shared/artifact-frame.ts` |
| MCP Apps | Same opaque-origin sandbox (`allow-scripts` only) with a CSP built from the server's declared https domains, none by default. Apps reach only their own server through our API; the iframe can call tools on load, so destructive or non-read-only calls need Allow in the card even under `approval: never`; `ui/message` fills the composer, never sends | `components/chat/McpApp.tsx`, `mcp/manager.ts` |
| MCP elicitation | Forms only (no URL mode), flat typed fields validated server-side, answered only by the asking user, cancelled after 10 min or on Stop; sub-agents and schedules decline | `mcp/elicitation.ts` |
| Shared MCP servers | Admin-owned; viewers never see headers, env, or command; per-user OAuth tokens; a demoted admin's servers stop being shared | `mcp/store.ts` |
| Shared provider models | Per-audience allowlists on top of the visibility audience; union across groups/users, own key wins, admin not exempt; hidden when empty; `listModels`/`listProviders` filter and the model factory rechecks before any provider request | `entitlements.ts`, `catalog/providers.ts`, `llm.ts`, `docs/implementation/entitlements.md` |
| Email | IMAP/SMTP endpoints and passwords encrypted with `OKAYCHAT_SECRET`; passwords write-only and re-entered after a server/username change; TLS or required STARTTLS with verified certificates; the live admin role and destination are re-checked on every connection and non-admin connections are pinned to a checked public IP; discovery documents capped, redirects bounded and HTTPS-only, probes have a total deadline; attachment downloads explicit and quota-bounded; sends and replies require an explicit account and from address, always need approval over the complete body (signature included, never appended later), are outbound risk, and are withheld from delegates and schedules; mail HTML is never rendered. Editable drafts are owned per user and chat with revision CAS; their Send uses an exact-payload, single-use hashed review bound to the revision and payload, then the same live-checked approved send path (never raw SMTP); a removed account leaves the draft visible but blocks edits/sends until another sender is chosen | `src/server/email/`, docs/implementation/email.md |
| Server rendering | Separate container. Offline by default (only the document and staged files); HTML/React previews may load from the artifact CDNs through the egress proxy. WebSocket/WebRTC/service-worker blocks, DNS limited to the CDNs, timeouts that close the job's context | `src/browser/render.ts` |
| Office files | ZIP expansion bounded before any parser runs | `documents/zip-bounds.ts` |
| Code execution | Separate container with no secrets. Each run in bubblewrap: own network namespace (loopback only), mount namespace (only its workspace, private `/tmp` and `/dev/shm`), IPC namespaces, inner seccomp filter, no capabilities; per-chat uid; read-only root; fails closed when the jail cannot be built | `sandbox/`, `docker-compose.yml`, `docs/implementation/code-sandbox.md` |
| Deep research | Workers get only `web_search` and `web_fetch`, built for them; plan and review calls get no tools; the chat model cannot start research itself | `research.ts` |
| Prompt injection | Deterministic provenance envelopes on web, MCP, file, artifact, skill, research, delegate, past-chat, fact, summary, knowledge, and MCP-prompt text; tool descriptions are enveloped and marked as external metadata; heuristic advisory badge; initial and per-step taint that includes system 1/2 sources the approval hook cannot see; destructive/outbound risk metadata gates approval even under `approval: never`; MCP App calls are gated as untrusted code, not user clicks; schedules auto-deny; delegates get no destructive tools; remote Markdown images need exact-URL consent and drop srcSet/sizes | `prompt-injection.ts`, `chat.ts`, `mcp/manager.ts`, `markdown-image-policy.ts`, `protected-markdown-image.tsx`, `docs/implementation/prompt-injection.md` |
| Persistent writes | Skill installs always need approval; memory writes need approval after outside content | `skills.ts`, `memory.ts` |
| Resource abuse | Storage quota (including message text, knowledge originals/text/vectors), 4 concurrent turns, 50 schedules, 30 MCP servers, 2 knowledge ingest jobs per account and one per collection, 2,000 sources per collection | `quota.ts`, `chat.ts`, `schedules.ts`, `routes.ts`, `knowledge/jobs.ts` |
| Container | App drops root to `node` after fixing `/data` ownership | `docker-entrypoint.sh` |
| Supply chain | Lockfile, base images and SearXNG pinned by digest, CI with tests and `npm audit`, Dependabot | `Dockerfile`, `.github/` |

## Known residual risks

- **Prompt injection is not solved.** The envelope is spotlighting, not a sandbox: the model can still obey content, and the heuristic scanner has both false positives and false negatives. It is contained: remote Markdown images do not load before consent, the sandbox cannot reach the network, artifact rendering has bounded egress, and annotated destructive or outbound tools after outside content ask with the risk named. Read-tool arguments remain outbound channels, and the opt-in background memory reviewer can still learn poisoned facts. It can still give a wrong answer, call a tool whose server omitted or lied about its destructive annotation, or persuade you to approve something harmful. Read approval prompts. The full limits, including vision input, MCP Apps, MCP prompts the user edits, input-schema text, same-step parallel calls, and link clicks, are in `docs/implementation/prompt-injection.md`.
- **Artifact popups.** `allow-popups` lets an artifact open a URL after a user click; the URL can carry data. Browsers block popups without a click.
- **Chromium runs with `--no-sandbox`** in the browser worker (its namespace sandbox is unavailable under Docker and Ubuntu's user-namespace restriction). A render exploit lands in that job's slot user: its own job, the artifact CDNs through the proxy, nothing else. An exploit through a page Scrapling reads lands in `scrape`: concurrent fetches and the public internet through the proxy. Neither reaches the app, its data or secrets, the worker token, the sandbox, or private networks. See `docs/implementation/browser-worker.md`. Keep the image updated.
- **The sandbox container runs without Docker's AppArmor profile** and with a seccomp profile that lets the runner create user namespaces, which bubblewrap needs. Run code cannot create namespaces (inner seccomp filter). Host AppArmor profiles that attach by path are kept off run code by the jail's exec view. See `docs/implementation/code-sandbox.md`.
- **Concurrent runs see each other's process list** (pids and command lines, including arguments run code passes to its subprocesses), not environments, memory, descriptors, or files.
- **Concurrent runs share the sandbox's 2 GB and 2 CPUs.** One run can starve or OOM-kill another; limits are per process and per workspace, not per run.
- **Shared provider keys have no per-user spend limit.** Usage and cost per user are recorded and visible to admins; the concurrency and schedule caps only bound the rate.
- **Email role/host checks still have a tiny connect window.** For non-admins the destination is resolved, every answer is checked, and the connection is pinned to the checked IP literal for both IMAP and SMTP, so a hostile resolver cannot change the answer the client uses. The remaining window is between that check and the pinned `connect()`; an admin demoted in exactly that interval could finish one in-flight connection, and the next one fails. Socket probes also use a guarded lookup. Self-signed certificates and plaintext credentials are still refused.
- **No 2FA or session list.** Sessions can be revoked as a group.
- **Sign-up reveals registered emails** ("already registered"). Keep sign-up closed on servers that do not need it.
- **`npm audit` moderate findings without a fix:** `mammoth` → `argparse` → `sprintf-js` (no patched release). The vulnerable path is mammoth's command-line tool, which okaychat does not use.

## Operating checklist

1. Serve over HTTPS behind a reverse proxy and set `OKAYCHAT_PUBLIC_URL`.
2. Keep `OKAYCHAT_ALLOW_SIGNUP=false` unless strangers should register; add users from Admin.
3. Back up `OKAYCHAT_SECRET` separately from the data volume.
4. Rebuild images when Dependabot updates base images, Chromium, or Scrapling. Debian security updates (FFmpeg, LibreOffice, Ghostscript, poppler in the sandbox) arrive only with a rebuild.
5. Give admin rights only to people who may run code on the server (stdio MCP servers run as the app).
