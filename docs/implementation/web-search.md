# Web search and page reading

Built-in tools live in `src/server/tools/web.ts`. They need no provider API key.

## Search

`webSearch` tries the configured SearXNG instance, Brave HTML results, then DuckDuckGo Lite. Each engine request has a 12-second timeout. Empty results or an engine failure advance to the next engine; if all fail, the error includes their failure messages. DuckDuckGo HTTP 202 is treated as a bot wall, not a results page.

Compose supplies a private SearXNG sidecar configured by `docker/searxng/`. `OKAYCHAT_SEARXNG_URL` selects it in the app. Its configuration must enable JSON responses; it is not exposed as a public search service.
SearXNG is optional: the service registry (`docs/implementation/service-health.md`) reports it `down` when its
`/healthz` fails, but `web_search` stays offered because the public engines remain. The web notice says results come
from the fallback engines.

Each engine request also ends when the reply is stopped: the tools pass their `abortSignal` into `webSearch`/`webFetch`, which combine it with the timeout and pass it to Scrapling.

The model-facing `web_search` defaults to eight results and accepts one to twenty. A turn and all delegates share the same `SearchBudget`. Page reads do not consume search queries; see `step-limits.md`.

## Page reading

`webFetch` accepts HTTP(S) public URLs only. `publicFetch` pins checked public DNS results, validates redirects, and rejects private destinations. Plain fetching has a 20-second timeout and a 5 MiB body cap.

PDFs are extracted with `unpdf`. HTML is parsed with `linkedom`, reduced with Readability, and converted to Markdown with Turndown. Plain text is returned directly. Those HTML libraries load lazily on first use.

Blocked responses and JavaScript shells fall back to Scrapling in the separate browser worker. A short successful plain-fetch result is retained if Scrapling cannot improve it. Scrapling's own transport and egress rules are documented in `scrapling.md` and `browser-worker.md`.

The model receives text in 40,000-character pages, including the title, source URL, current page, total pages, and fetch method. The model text is spotlighted by `wrapUntrusted()` in `toModelOutput`; snippets are scanned for instruction-like phrases and show the advisory badge on the card. The composer Search switch hides `web_search` only; `web_fetch` remains available. The account's web-tools preference disables both. See `prompt-injection.md`.
