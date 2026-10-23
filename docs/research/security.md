# Security

What okaychat defends against, where each control lives, and what is knowingly left open. Area docs hold the details; this file is the map.

## Threat model

Defended against:

- Other accounts on the same server. Every row is owned by a user and every route checks it.
- Anyone on the internet without an account. Only `/api/auth`, `/api/health`, the MCP OAuth callback, and share links (random 256-bit tokens) are reachable without a session.
- Content the model reads: web pages, files, MCP results, past chats. It can steer the model (prompt injection), so model-chosen actions are bounded: no access to the server's network, no data leaving rendered HTML, approval for persistent writes after outside content.
- Model-written code and markup. It runs in the sandbox container, in opaque-origin frames with a CSP, or in a locked-down Chromium context.
- A copied database file. Provider keys, MCP secrets, and memory are AES-256-GCM encrypted with `OKAYCHAT_SECRET`.

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
| Outbound requests | Public-address check at connection time, revalidated redirects, byte caps: `web_fetch`, non-admin provider/MCP URLs, image model lists, skill sources, Scrapling via the egress proxy | `public-fetch.ts`, `egress-proxy.ts` |
| Stored secrets | Write-only in the UI; never follow a changed origin; MCP OAuth tokens cleared on URL change | `providers.ts`, `routes.ts`, `skills.ts` |
| User files | Served with `sandbox` CSP, `nosniff`, download by default; images/fonts sniffed | `files.ts`, `tools/sandbox.ts`, `fonts.ts`, `account.ts` |
| Artifacts in the browser | Sandboxed opaque-origin iframe plus a meta CSP: network only to `FRAME_NETWORK_HOSTS`, no form posts | `shared/artifact-frame.ts` |
| Server rendering | Request routing, WebSocket/WebRTC/service-worker blocks, DNS limited to the CDNs | `documents/render.ts` |
| Office files | ZIP expansion bounded before any parser runs | `documents/zip-bounds.ts` |
| Code execution | Separate container, internal-only network, no secrets, per-chat uid, dropped capabilities, read-only root | `sandbox/`, `docker-compose.yml` |
| Persistent writes | Skill installs always need approval; memory writes need approval after outside content | `skills.ts`, `memory.ts` |
| Resource abuse | Storage quota (including message text), 4 concurrent turns, 50 schedules, 30 MCP servers | `quota.ts`, `chat.ts`, `schedules.ts`, `routes.ts` |
| Container | App drops root to `node` after fixing `/data` ownership | `docker-entrypoint.sh` |
| Supply chain | Lockfile, base images and SearXNG pinned by digest, CI with tests and `npm audit`, Dependabot | `Dockerfile`, `.github/` |

## Known residual risks

- **Prompt injection is not solved.** It is contained: the injected model cannot reach the server's network, exfiltrate through rendered HTML, or silently persist instructions. It can still give a wrong answer, call MCP tools you enabled without approval, or ask you to approve something harmful. Read approval prompts.
- **Artifact popups.** `allow-popups` lets an artifact open a URL after a user click; the URL can carry data. Browsers block popups without a click.
- **Scrapling's Chromium bypasses proxies for loopback** (`127.0.0.1` inside the app container). Chromium's local network access block stops page requests from public pages to loopback.
- **Chromium runs with `--no-sandbox`.** A renderer exploit lands in the app container as `node`. Keep the image updated.
- **Shared provider keys have no per-user spend limit.** Usage and cost per user are recorded and visible to admins; the concurrency and schedule caps only bound the rate.
- **No 2FA or session list.** Sessions can be revoked as a group.
- **Sign-up reveals registered emails** ("already registered"). Keep sign-up closed on servers that do not need it.
- **`npm audit` moderate findings without a fix:** `mammoth` → `argparse` → `sprintf-js` (no patched release). The vulnerable path is mammoth's command-line tool, which okaychat does not use.

## Operating checklist

1. Serve over HTTPS behind a reverse proxy and set `OKAYCHAT_PUBLIC_URL`.
2. Keep `OKAYCHAT_ALLOW_SIGNUP=false` unless strangers should register; add users from Admin.
3. Back up `OKAYCHAT_SECRET` separately from the data volume.
4. Rebuild images when Dependabot updates base images, Chromium, or Scrapling.
5. Give admin rights only to people who may run code on the server (stdio MCP servers run as the app).
