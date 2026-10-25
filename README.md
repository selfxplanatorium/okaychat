# okaychat

A self-hosted, multi-user AI chat app. OpenCode Go is the primary connection; you can also connect your own ChatGPT plan, other model providers, or custom OpenAI-compatible endpoints. Each account has its own connections, settings, files, and conversations.

## Features

- Streaming chat with reasoning and tool logs, branching, file attachments, Markdown/math/Mermaid, reload recovery, and Markdown/PDF export.
- MCP tools, resources, prompts, approval forms, and embedded apps. Plugins also holds per-account Agent Skills.
- Keyless web search, image generation, document creation/editing, interactive widgets, and code execution in a separate offline sandbox.
- Projects, scheduled prompts, a persistent file library, public read-only chat links, and opt-in memory with reviewed import/export.
- Per-chat model and reasoning controls, token/context/cost tracking, prompt caching, and automatic or manual compaction.
- Synced appearance and keyboard settings, accent-adaptable branding, and an installable mobile web app.

Admins can manage accounts and groups, set storage limits and system prompts, and share provider connections or MCP servers with selected audiences.

## Run with Docker

Use Docker Compose on a Linux host that supports the container capabilities and namespace settings in [docker-compose.yml](docker-compose.yml). Linux amd64 is the tested container platform; the browser worker and sandbox check their isolation requirements at startup.

1. Copy the environment template:

   ```sh
   cp .env.example .env
   ```

2. Set `OKAYCHAT_SECRET` and `OKAYCHAT_SANDBOX_TOKEN` in `.env` to different random values. Generate each with:

   ```sh
   openssl rand -base64 32
   ```

3. Build and start the services:

   ```sh
   docker compose up -d --build
   ```

Open http://localhost:8787. The first account is the administrator. Connect OpenCode Go during onboarding or choose another provider in Settings → Providers. The ChatGPT connection uses each user's own Codex device login; Docker includes the CLI by default.

| Service | Purpose |
| --- | --- |
| `okaychat` | App and SQLite database, with persistent data in the `okaychat-data` volume. |
| `searxng` | Private web search; no public host port. |
| `sandbox` | Python/Bash and offline document/media tools. Each code run has its own filesystem and network namespaces, with no network access. |
| `browser` | Chromium rendering and Scrapling page fetching. Separate users and an egress firewall keep untrusted pages away from app data and secrets. |

The app generates the browser worker's token into the shared `okaychat-browser-token` volume. Sandbox workspaces use `okaychat-sandbox`; produced files are copied into app storage. See the [browser worker](docs/implementation/browser-worker.md) and [code sandbox](docs/implementation/code-sandbox.md) guides for their boundaries and platform limits.

To omit Scrapling's stealth-browser fallback while keeping document rendering:

```sh
docker compose build --build-arg SCRAPLING_BROWSER=false
```

## Configuration and storage

| Variable | Default | Purpose |
| --- | --- | --- |
| `OKAYCHAT_SECRET` | required | Encrypts provider/MCP credentials and memory. Changing or losing it makes existing encrypted data unreadable. |
| `OKAYCHAT_SANDBOX_TOKEN` | required by Compose | Shared secret between the app and code sandbox. |
| `OKAYCHAT_ALLOW_SIGNUP` | `false` | Allows later accounts to register; the administrator can change this in the app. |
| `OKAYCHAT_PUBLIC_URL` | inferred | Public origin for MCP OAuth redirects behind a reverse proxy. |
| `OKAYCHAT_PORT` | `8787` | App host port in Compose. |
| `OKAYCHAT_DATA_DIR` | `./data` locally, `/data` in Compose | SQLite, generated image files, and local runtime state. |
| `OKAYCHAT_STORAGE_LIMIT` | `1073741824` | Default per-user storage quota in bytes; admins can override it per account. |
| `OKAYCHAT_SEARXNG_URL` | supplied by Compose | SearXNG endpoint; without it, search uses public-engine fallbacks. |
| `SANDBOX_IDLE_MINUTES` | `30` | Lifetime of unused sandbox workspaces. Saved outputs remain in app storage. |

Back up the app data volume and retain `OKAYCHAT_SECRET` separately. Upload originals remain until Library/account deletion; sandbox scratch cleanup does not remove saved outputs. [Storage accounting and limits](docs/implementation/storage-quota.md) explains what counts toward quota.

HTTPS is needed for PWA installation and browser features such as microphone dictation outside localhost. See [mobile/PWA behavior](docs/implementation/mobile-pwa.md) for installation and offline-shell limits.

## Development

Use Node.js 22.13 or newer:

```sh
npm ci
cp .env.example .env
npx playwright-core install chromium
```

Set `OKAYCHAT_SECRET` in `.env`, then run `npm run dev`. The API listens on `127.0.0.1:8787`, and the local browser worker on `127.0.0.1:8791`. Vite listens on the machine's Tailscale address at port 5173; use its MagicDNS URL. `OKAYCHAT_DEV_HOST` can select another tailnet address. The local worker uses application-level egress checks; use `scripts/dev-browser.sh` for the container's enforced boundaries.

Web search and code execution need their sidecars in development. `.env.example` lists the variables; [AGENTS.md](AGENTS.md#commands) includes the setup commands.

## Checks and build output

```sh
npm run typecheck
npm test
npm run build
```

`npm start` serves a production build. `test/integration/run.sh` runs the separate real-container isolation suites. Build output under `dist/` is disposable and gitignored; source assets under `src/web/public/` and bundled fonts are runtime inputs. Keep research snapshots, design experiments, prompts, and other temporary working files outside the repository.

## Documentation

- [Roadmap](docs/ROADMAP.md): current features, completed work, and known gaps.
- [AGENTS.md](AGENTS.md): architecture, conventions, implementation-guide index, and development commands.
- [Chat runtime](docs/implementation/assistant-ui.md), [memory](docs/implementation/memory.md), and [MCP](docs/implementation/mcp.md): conversation and tool behavior.
- [Security](docs/implementation/security.md): threat model, controls, and residual limits.
- [Appearance and branding](docs/implementation/appearance.md): separate icon/wordmark assets and theme adaptation.

## Credits

The appearance system is ported from [T3 Code](https://github.com/pingdotgg/t3code) (MIT). The chat UI is built on [assistant-ui](https://www.assistant-ui.com). Bundled font provenance and licenses are listed in the [font guide](docs/implementation/bundled-fonts.md).
