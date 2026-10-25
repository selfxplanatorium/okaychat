# Scrapling page-fetch fallback

`src/browser/scrapling.ts` runs Scrapling in the browser worker. The app calls `POST /v1/fetch` through `src/server/tools/scrapling.ts`; no Scrapling process runs in the app container.

## Transport and isolation

The fetch process starts `scrapling mcp` over stdio under the `scrape` user in the container. There is no Scrapling HTTP port or authentication token. `protocolVersionDiscovery: false` avoids the Python server's rejected initialize fallback, and startup is bounded to 30 seconds. The child receives `PLAYWRIGHT_BROWSERS_PATH` explicitly when configured.

Every fetch passes the worker's egress proxy in its arguments. The per-user firewall prevents bypassing that proxy. Public-address checks and container boundaries are documented in `browser-worker.md`.

## Fetch sequence

1. Call `make_request` with Markdown extraction, the Chrome impersonation profile, and a 45-second timeout.
2. If the result is unusable and browser fetching is enabled, call `browser_fetch_once` with headless Chromium and a 120-second timeout.
3. Accept only non-error results with status below 400 and more than 200 characters of content. Cap returned content at 2,000,000 characters; `web_fetch` pages it further.

Failures return no fallback result, allowing the app to use a thin plain-fetch result or report an error. Closed transports are discarded so the next call can reconnect. The MCP client has a five-minute idle timer.

## Configuration and checks

`OKAYCHAT_SCRAPLING_COMMAND` selects the executable for local development. The browser image controls whether stealth Chromium fetching is installed; `OKAYCHAT_SCRAPLING_BROWSER` enables that path. See the Dockerfile, `src/browser/config.ts`, and `scripts/dev-scrapling.sh` for the maintained setup.

The real-container tests in `test/integration/` check public fetching and rejection of private, loopback, and compose-service destinations using fixture request counters.
