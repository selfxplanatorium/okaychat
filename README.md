# okaychat

A self-hosted AI chat that is simple to run and pleasant to use. OpenCode Go is the default connection, and any other provider can be added. It supports MCP tools, free web search, file reading, usage and context tracking, and automatic compaction.

## Run with Docker

```sh
cp .env.example .env
echo "OKAYCHAT_SECRET=$(openssl rand -base64 32)" >> .env
echo "OKAYCHAT_SANDBOX_TOKEN=$(openssl rand -base64 32)" >> .env
docker compose up -d --build
```

Open http://localhost:8787. The first account you create is the admin. Paste your OpenCode Go key (https://opencode.ai/console) on the first screen, or connect another provider under Settings → Providers.

Compose starts four containers:

- `okaychat`: the app, with data in the `okaychat-data` volume (SQLite + caches).
- `searxng`: a private search engine for the `web_search` tool. It is not exposed outside the compose network.
- `sandbox`: runs Python and Bash for the `run_code` tool, with one private workspace per chat and an offline toolset (FFmpeg, LibreOffice, Pandoc, Tesseract/OCRmyPDF, poppler, Ghostscript, Graphviz, scientific Python, and more). Every run is jailed without any network access, and the container holds no app secrets. It needs the seccomp profile and AppArmor setting in `docker-compose.yml`. See `docs/research/code-sandbox.md`.
- `browser`: Chromium for PDFs, document previews, and the model's visual checks, and Scrapling for pages that block plain fetches. It holds no app data or secrets, and a firewall in its own network namespace lets only its egress proxy reach public addresses. The app generates its token; nothing to configure. See `docs/research/browser-worker.md`.

Without Scrapling's stealth-browser fallback for JavaScript-heavy pages (documents still use the worker's Chromium):

```sh
docker compose build --build-arg SCRAPLING_BROWSER=false
```

Updating a setup that ran the previous three containers: run `docker compose up -d --build`. The data volume is reused; the `okaychat-browser-token` volume is created automatically, and the browser container needs the capabilities listed in `docker-compose.yml`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OKAYCHAT_SECRET` | required | Encrypts provider keys and MCP tokens. Do not change it after setup. |
| `OKAYCHAT_ALLOW_SIGNUP` | `false` | Let people create accounts after the admin exists. |
| `OKAYCHAT_PUBLIC_URL` | auto | Public origin for MCP OAuth redirects behind a reverse proxy. Without it, each user's own requests set their redirect origin. |
| `OKAYCHAT_SANDBOX_TOKEN` | required | Shared secret between the app and the code sandbox. |
| `OKAYCHAT_SEARXNG_URL` | set by compose | SearXNG instance for web search. Without it, search falls back to scraping public engines. |
| `OKAYCHAT_PORT` | `8787` | Host port in compose. |

## Development

```sh
npm install
cp .env.example .env   # set OKAYCHAT_SECRET
npm run dev            # server on :8787, web on :5173, browser worker on :8791
```

See `AGENTS.md` for architecture and conventions, and `docs/ROADMAP.md` for what is built and what is next.

## Credits

The appearance system is ported from [T3 Code](https://github.com/pingdotgg/t3code) (MIT). The chat UI is built on [assistant-ui](https://www.assistant-ui.com).
