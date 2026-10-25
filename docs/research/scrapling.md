# Scrapling

Researched 2026-10-19. Verified = run in this sandbox. Unverified = not run or not checked; marked inline.

## Versions and requirements

- Latest on PyPI: `scrapling` 0.5 (uploaded 2026-10-17). Verified.
- Python: `>=3.10`. Tested on Python 3.14.4 (host) and 3.11.2 (Debian bookworm, container).
- License: BSD-3-Clause. Verified (PyPI metadata).
- Install: `pip install "scrapling[ai]==0.5"`. Pin the version. 0.5 renamed the MCP tools (section 3).

## Extras

| Extra | Adds | Use |
| --- | --- | --- |
| (none) | lxml, cssselect, orjson, tld, w3lib | Parsing only |
| `fetchers` | curl_cffi, playwright, patchright, browserforge, msgspec, anyio, protego | HTTP and browser fetchers |
| `ai` | `fetchers` + `mcp>=2.0.0` + markdownify | MCP server |
| `rag` | `fetchers` + markdownify | RAG helpers |
| `shell` | `fetchers` + IPython | Interactive shell |

Verified: `[ai]` pulls `playwright` and `patchright` even when only HTTP tools are used. The MCP server imports both at startup, so there is no HTTP-only install without them. On disk they are about 137 MB each. Verified (`du`).

## Browser step

`scrapling install` (verified from `cli.py`, 0.5) runs:

1. `python -m playwright install chromium`
2. `python -m playwright install-deps chromium` (apt, needs root)
3. `tld` list update

Use `-f` to force a rerun.

- Chromium download: 191.1 MiB (Chrome for Testing 156.0.8078.4). Verified from the download header. The download failed in this sandbox (CDN redirect, then a write error mid-transfer), so the browser was never installed. Browser-tool behavior is unverified.
- Headless shell and ffmpeg are also listed by Playwright. Sizes unverified.
- `install-deps` lists 103 apt packages for Chromium, including `xvfb`, `fonts-noto-color-emoji`, `fonts-liberation`, `libasound2`, `libxkbcommon0`, `fontconfig`. Verified (`--dry-run` in the container). Total size unverified.
- Scrapling 0.5 uses Playwright Chromium. The name "camoufox" does not appear in 0.5. Verified (grep).

## MCP server

Start over stdio: `scrapling mcp` (console script `scrapling-mcp` also exists). Verified.

Transports:

- stdio (default).
- Streamable HTTP: `scrapling mcp --http --host 127.0.0.1 --port 8000`. Requires `--auth-token <t>` or env `SCRAPLING_MCP_AUTH_TOKEN`, unless `--no-auth`. Also `--allowed-host` for DNS-rebinding protection. Verified (`--help`).
- `--executable-path` or env `SCRAPLING_EXECUTABLE_PATH` for a custom Chromium.

Handshake: `initialize` returns protocol `2025-06-18`, server name `Scrapling`, version `0.5`. Verified.

### Tools (0.5, verified by `tools/list`)

Required parameters are marked `*`.

HTTP only, no JavaScript:

- `make_request`: `url*`, `method`, `impersonate` (default `chrome`), `extraction_type` (`text|html|markdown`, default `markdown`), `css_selector`, `main_content_only` (default true), `params`, `data`, `json`, `headers`, `cookies`, `timeout` (30), `follow_redirects`, `max_redirects`, `retries`, `retry_delay`, `proxy`, `proxy_auth`, `auth`, `verify`, `http3`, `stealthy_headers`.
- `session_make_request`: same as `make_request`, takes `session_id*` from `open_request_session`.
- `open_request_session` (`session_id`, `impersonate`, `proxy`), `close_session` (`session_id*`), `list_sessions`.

Stealth browser:

- `browser_fetch_once`: `url*` plus the browser options (`headless`, `google_search`, `real_chrome`, `wait`, `proxy`, `locale`, `timezone_id`, `extra_headers`, `useragent`, `cdp_url`, `executable_path`, `timeout`, `disable_resources`, `wait_selector`, `wait_selector_state`, `cookies`, `network_idle`, `block_webrtc`, `allow_webgl`, `solve_cloudflare`, `additional_args`, `pierce_shadow`, `hide_canvas`, `real_chrome`).
- `browser_open` (`session_id`, browser options), `browser_fetch` (`url*`, `session_id*`, plus per-request options), `browser_extract`, `browser_actions` (`session_id*`, `actions*`, `slowly`), `browser_evaluate` (`session_id*`, `expression*`), `browser_screenshot` (`session_id*`, `image_type`, `full_page`, `selector`, `ref`), `browser_save_state`, `browser_load_state` (`session_id*`, `path*`), `browser_network_requests`, `browser_network_request`.

Not present in 0.5: `get`, `bulk_get`, `fetch`, `bulk_fetch`, `stealthy_fetch`, `bulk_stealthy_fetch`, `screenshot`, `open_session`. These names belong to 0.4.9. Verified against the 0.4.9 wheel source.

### Output

Every fetch tool returns `ResponseModel`:

```json
{ "status": 200, "content": ["<page text>"], "url": "https://example.com/" }
```

`content` is a list of strings. Format follows `extraction_type`. Verified on `https://example.com/` through `make_request`.

Observation: on example.com with `main_content_only=true`, the `<h1>` was dropped. Check extraction on real pages before relying on `main_content_only`. Unverified beyond that one page.

CSS extraction: `css_selector` selects after `main_content_only` filtering. Snapshots (browser sessions) require exactly one match. Verified (tool schema).

## Docker

### Tested Dockerfile (HTTP mode, no browsers)

```dockerfile
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/scrapling \
 && /opt/scrapling/bin/pip install --no-cache-dir "scrapling[ai]==0.5" \
 && find /opt/scrapling -name "__pycache__" -prune -exec rm -rf {} +
ENV PATH="/opt/scrapling/bin:${PATH}"
```

Verified: the image built (about 1 min 45 s) and `scrapling mcp` answered a `make_request` call to example.com with status 200 inside the container. Stdin must stay open while the call runs. Piping a file that reaches EOF early returns "Connection closed".

Image size: 928 MB total. Verified.

- Scrapling venv: 392 MB (curl_cffi 38 MB, lxml 12 MB, cryptography 15 MB, playwright 137 MB, patchright 137 MB).
- Base image and apt layers make up the rest. The node base and apt split were not measured separately.

Lighter mode: not possible with 0.5 as shipped. Dropping `playwright`/`patchright` breaks import of the MCP server. Verified. Stubbing them would be fragile and was not tested.

### Full image with browsers (unverified)

Add to the Dockerfile:

```dockerfile
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw
RUN /opt/scrapling/bin/scrapling install \
 && rm -rf /var/lib/apt/lists/* /root/.cache
```

Unverified: the Chromium download failed in the sandbox, so the browser layer size and `install-deps` size are unknown. Expect several hundred MB on top of the lite image. Estimate only. The image runs as root, so `install-deps` works. Verified: `whoami` returned `root` in the lite image. Set `PLAYWRIGHT_BROWSERS_PATH` so the browser lands in a known path.

## License summary

- Scrapling: BSD-3-Clause. Verified.
- Playwright: not checked here (typically Apache-2.0). Unverified.
- Chromium: not checked here. Unverified.

## In okaychat (2026-10-25)

Scrapling runs in the browser worker container, not the app: `scrapling mcp --http --host 127.0.0.1 --port 8092`
as its own user (`scrape`), with a random `SCRAPLING_MCP_AUTH_TOKEN` per container start that only the job server
knows. The job server calls `make_request`, then `browser_fetch_once` when `OKAYCHAT_SCRAPLING_BROWSER=true`,
always with `proxy` set to the worker's egress proxy; the worker firewall rejects any connection that does not go
through it. Verified in the integration suite: example.com through Scrapling works, while the fixture's private
address, a hostname resolving to it, loopback, `0x7f000001`, `[::1]`, and the compose service names return no page
and leave the fixture's counters at zero. The app reaches it as `POST /v1/fetch` (`src/server/tools/scrapling.ts`).
In dev the local worker starts it over stdio (`OKAYCHAT_SCRAPLING_COMMAND`). Node playwright-core 1.64.0 and
Scrapling's Python playwright 1.64.0 use the same Chromium revision (1248), so the image has one browser.
