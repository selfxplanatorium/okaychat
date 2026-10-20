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

Compose starts three containers:

- `okaychat`: the app, with data in the `okaychat-data` volume (SQLite + caches).
- `searxng`: a private search engine for the `web_search` tool. It is not exposed outside the compose network.
- `sandbox`: runs Python and Bash for the `run_code` tool, with one private workspace per chat. It has no internet access and holds no app secrets. See `docs/research/code-sandbox.md`.

Smaller image without the headless browser used for JavaScript-heavy pages:

```sh
docker compose build --build-arg SCRAPLING_BROWSER=false
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OKAYCHAT_SECRET` | required | Encrypts provider keys and MCP tokens. Do not change it after setup. |
| `OKAYCHAT_ALLOW_SIGNUP` | `false` | Let people create accounts after the admin exists. |
| `OKAYCHAT_PUBLIC_URL` | auto | Public origin for MCP OAuth redirects behind a reverse proxy. |
| `OKAYCHAT_SANDBOX_TOKEN` | required | Shared secret between the app and the code sandbox. |
| `OKAYCHAT_SEARXNG_URL` | set by compose | SearXNG instance for web search. Without it, search falls back to scraping public engines. |
| `OKAYCHAT_PORT` | `8787` | Host port in compose. |

## Development

```sh
npm install
cp .env.example .env   # set OKAYCHAT_SECRET
npm run dev            # server on :8787, web on :5173
```

See `AGENTS.md` for architecture and conventions, and `docs/ROADMAP.md` for what is built and what is next.

## Credits

The appearance system is ported from [T3 Code](https://github.com/pingdotgg/t3code) (MIT). The chat UI is built on [assistant-ui](https://www.assistant-ui.com).
