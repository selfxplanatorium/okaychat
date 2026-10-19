# Web search and page fetching without API keys

Researched 2026-10-19. Verified = run in this sandbox. Unverified = not run or not checked.

## Environment limit (read first)

From this sandbox IP, DuckDuckGo blocks almost every request with HTTP 202 and an anomaly page ("Unfortunately, bots use DuckDuckGo too"). Verified.

- HTML endpoint: 1 of 8 POST attempts returned results (sequence: intro GET, cookie jar, POST, 3 s gaps). After that, every attempt returned 202.
- Lite endpoint: 0 of 5 attempts succeeded.
- SearXNG upstream engines from this IP: DuckDuckGo CAPTCHA, Brave suspended for 180 s (too many requests), Mojeek altcha challenge. Verified in SearXNG logs and JSON `unresponsive_engines`.

A production server IP will differ. Plan for blocking anyway (section 5).

## 1. DuckDuckGo

### 1a. HTML endpoint (primary keyless option)

Request. Verified on 200 responses.

- Method: `POST https://html.duckduckgo.com/html/`
- Body (`application/x-www-form-urlencoded`): `q=<query>`, `b=` (empty on page 1), optional `kl=wt-wt` (region), optional `df=d|w|m|y` (time filter).
- Headers used on the successful request: `User-Agent` (Chrome UA), `Referer: https://html.duckduckgo.com/`, `Accept-Language: en-US,en;q=0.9`, cookie jar from a prior `GET https://html.duckduckgo.com/html/`.
- Not verified: which of these are required. The block state changed during testing, so the minimum header set was not isolated. SearXNG also sends `Sec-Fetch-*` headers.
- GET with `?q=` also returns 202 when blocked. The success response was only observed for POST.

Result markup (verified on a saved 200 response, 10 results):

| Field | Selector |
| --- | --- |
| Result container | `#links .result.web-result` |
| Title | `h2 a.result__a` (text) |
| URL | `h2 a.result__a` `href` |
| Snippet | `a.result__snippet` (text) |
| Paging token | `input[name=vqd]` (present, unused) |

URL format: the sample used direct URLs (`href="https://github.com/..."`). Zero `uddg` wrappers in the sample. Verified. Older DDG output wraps URLs as `//duckduckgo.com/l/?uddg=<encoded>`. Decode defensively, as in the snippet below.

Parser, tested on the saved 200 page (10 results). Verified:

```js
import { parseHTML } from "linkedom";

function unwrap(href) {
  const u = new URL(href, "https://duckduckgo.com");
  return u.hostname.endsWith("duckduckgo.com") && u.pathname === "/l/"
    ? u.searchParams.get("uddg")
    : href;
}

export function parseDdgHtml(html) {
  const { document } = parseHTML(html);
  const out = [];
  for (const r of document.querySelectorAll("#links .result.web-result")) {
    const a = r.querySelector("h2 a.result__a");
    if (!a) continue;
    out.push({
      title: a.textContent.trim(),
      url: unwrap(a.getAttribute("href")),
      snippet: r.querySelector("a.result__snippet")?.textContent.trim() ?? "",
    });
  }
  return out;
}
```

Blocked signals. Verified:

- HTTP 202 (instead of 200).
- Body contains `<form id="challenge-form" action="//duckduckgo.com/anomaly.js...">` and "bots use DuckDuckGo".

Treat either as blocked. SearXNG treats the form as a CAPTCHA with `suspended_time=0`.

### 1b. Lite endpoint

- `POST https://lite.duckduckgo.com/lite/` with `q=<query>`. Verified: 202 on 5 of 5 attempts from this IP.
- Result selectors: unverified. The SearXNG image in this test has no lite engine to copy from.
- Use as a second attempt only. Do not depend on it.

### 1c. Blocking handling (recommendation)

1. Check the 202 or challenge form. Do not parse results from a blocked page.
2. Retry the HTML POST once after 3 s with a fresh cookie jar.
3. Fall back to Scrapling `make_request` on the same POST URL. Verified: `make_request` on a GET URL returned 202 with the challenge page. Unverified for POST.
4. Fall back to Scrapling `browser_fetch_once` on the query URL. Unverified: no Chromium in the sandbox.
5. Return "search unavailable" and cool down for about 10 min per egress IP.
6. Cache results (about 15 min) and serialize requests (about one per 2 s) to reduce blocking.

## 2. SearXNG (self-hosted, preferred when configured)

### Image

- `docker.io/searxng/searxng:latest`, 384 MB. Verified (pulled). Listing tags via Docker Hub failed in the sandbox, so pin a tag that you check yourself. Unverified.

### settings.yml

Verified: this file served by the container.

```yaml
use_default_settings: true
search:
  formats:
    - html
    - json
server:
  secret_key: "<long random string>"
  limiter: false
  public_instance: false
```

- `search.formats` controls which `format=` values are allowed. Without `json`, `format=json` returns 403. Verified (`format=csv` and `format=rss` returned 403 when not enabled).
- `server.limiter: false` for private use. The default settings say this is also overridable via `SEARXNG_LIMITER`.
- Other overrides from the default file: `SEARXNG_SECRET`, `SEARXNG_BASE_URL`, `SEARXNG_BIND_ADDRESS`, `SEARXNG_PORT`, `SEARXNG_PUBLIC_INSTANCE`. Read from comments in `settings.yml`. Env names not tested.

### JSON API

Request: `GET /search?q=<query>&format=json`. Verified. Optional params (`language`, `time_range`, `categories`, `engines`, `pageno`) are standard SearXNG params. Unverified here.

Response shape. Verified:

```json
{
  "query": "okchat self hosted",
  "results": [
    {
      "title": "...", "url": "...", "content": "...",
      "engine": "google cse", "engines": ["google cse"],
      "publishedDate": null, "thumbnail": "...", "score": 1.0,
      "category": "general", "parsed_url": ["https", "...", "/", "", "", ""],
      "template": "default.html", "positions": [1]
    }
  ],
  "answers": [], "corrections": [], "infoboxes": [], "suggestions": [],
  "unresponsive_engines": [["brave", "Suspended: too many requests"], ["duckduckgo", "CAPTCHA"]]
}
```

Use `results[].title`, `url`, `content`. Check `unresponsive_engines` to see upstream failures. The 20 results in the sample came from the one engine that answered, not from DDG.

Container port: 8080 inside the container. Verified.

Logs: `X-Forwarded-For nor X-Real-IP header is set!`. Harmless on an internal network. Set the headers if a reverse proxy sits in front.

### Docker Compose sidecar

Built on the official `container/docker-compose.yml` layout. Verified that file exists. Valkey (`valkey/valkey:9-alpine`) is in the official file as the limiter store. Not needed with `limiter: false`.

```yaml
services:
  okaychat:
    # ...existing okaychat service...
    environment:
      OKAYCHAT_SEARXNG_URL: http://searxng:8080
    networks: [searxng-net]

  searxng:
    image: docker.io/searxng/searxng:latest   # pin a tag
    restart: unless-stopped
    environment:
      SEARXNG_SECRET: ${SEARXNG_SECRET}
    volumes:
      - ./searxng:/etc/searxng:rw
    networks: [searxng-net]
    # no ports: only okaychat reaches it

networks:
  searxng-net: {}
```

Do not set `internal: true` on the network. SearXNG needs outbound access to its upstream engines. Unverified as a compose file (the container was tested with `docker run` only). The settings file is mounted at `/etc/searxng`.

## 3. Other keyless options

- Wikipedia API: `GET https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=<q>&format=json`. Verified 200 with a JSON `query.search` array. Send a descriptive `User-Agent`. Good for encyclopedic facts only.
- Mojeek: `GET https://www.mojeek.com/search?q=<q>`. From this IP it returned an altcha "Captcha" page. Unverified on normal IPs. SearXNG parses `ul.results-standard li a.ob`.
- Marginalia, Mwmbl, Wiby, Yep, Startpage: SearXNG has engines for them in this image. Not tested.
- Brave: the free API needs a key. The HTML search page is aggressively rate-limited (429 from this IP, verified via SearXNG).

## 4. Page fetching for `web_fetch`

### Library versions (npm, checked 2026-10-19)

| Package | Version | License | Tested |
| --- | --- | --- | --- |
| `@mozilla/readability` | 0.6.0 | Apache-2.0 | Yes |
| `linkedom` | 0.18.13 | ISC | Yes |
| `turndown` | 7.2.4 | MIT | Yes |
| `defuddle` | 0.19.5 | MIT | No (unverified) |
| `node-html-markdown` | 2.0.0 | not checked | No (unverified) |
| `@extractus/article-extractor` | 9.0.1 | not checked | No (unverified) |

Test: Wikipedia "Node.js" page (397 KB HTML). Readability and linkedom extracted a 24.7k-character article, and Turndown produced 52k characters of Markdown. Verified. Most of the extra size is image markup, so drop `img` in a Turndown rule before shipping.

Node ESM gotcha: `import TurndownService from "turndown"` fails in Node 22 ESM with `require is not defined`. Use `createRequire(import.meta.url)("turndown")`. Verified.

### Recommended pipeline (lightweight)

`fetch` (with timeout and size limit) → `linkedom.parseHTML` → `Readability` → Turndown (with `img` rule removed) → truncate to a token budget.

Limits (recommendation):

- Timeout 15 s, max 5 redirects.
- Read the body as a stream and abort past about 2 MB.
- Only accept `text/html` and `text/plain`.
- Block private and loopback IP targets (SSRF) before connecting.
- Truncate Markdown to about 50k characters, and say so in the tool result.

### When to fall back to Scrapling

Trigger on any of these:

- Status 403, 429, or 503 with a challenge marker (`cf-mitigated`, "Just a moment", DDG `challenge-form`).
- Readability returns fewer than about 200 characters on a page that has a large `<script>` payload (likely client-rendered).

Order:

1. Scrapling `make_request` (HTTP, `impersonate=chrome`, `extraction_type=markdown`). Verified that it runs. Verified 202 on DDG.
2. Scrapling `browser_fetch_once` with `solve_cloudflare=true` for JS pages. Unverified: needs the Chromium install.

## 5. Recommended strategy

1. Search. If `OKAYCHAT_SEARXNG_URL` is set, query SearXNG JSON. If it returns zero results or `unresponsive_engines` covers all engines, fall through to DDG.
2. Search, no SearXNG. DDG HTML POST. Parse with the snippet above. On a blocked signal, run the blocking steps in 1c.
3. Fetch. Use the Node pipeline in section 4. Fall back to Scrapling HTTP, then browser, on the triggers above.
4. Docker. Ship the lite Scrapling image (928 MB, verified). Make the browser layer optional and documented.

## Risks

- R1: DuckDuckGo blocks by IP. A shared server IP can be blocked for hours. Mitigation: SearXNG sidecar, caching, cooldown.
- R2: DDG markup and endpoints change. The selectors above are verified only on one saved page from 2026-10-19.
- R3: Scrapling 0.5 renamed the MCP tools (0.4.9 had `get`, `fetch`, `stealthy_fetch`). Code written against one version breaks on the other. Pin `scrapling[ai]==0.5`.
- R4: The stealth browser path is unverified (no Chromium here). Do not rely on it until tested in the target image.
- R5: Image size. Lite Scrapling image is 928 MB. Browser variant is larger and unmeasured.
- R6: Scraping search engines may violate their terms of service. Not reviewed.
