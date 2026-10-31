# Service health and graceful degradation

okaychat stays usable when an optional service is missing. One registry answers "is it up?", chat
turns withhold only the tools that cannot work, requests fail fast with the existing
`service_unavailable` error, and the web app explains the outage once the user actually meets it.

Code: `src/server/services.ts` (registry, probes, `/api/services`), `src/shared/services.ts` (wire
types and parsers), `src/web/state/services.ts` and `services-derive.ts` (store and pure rules),
`src/web/components/ServiceAvailability.tsx` and `components/chat/ServiceNotice.tsx` (surfaces).

## The registry

```ts
{ id, state: "up" | "down" | "degraded" | "unconfigured", reasonKey, fixKey?, checkedAt, latencyMs? }
```

- `up`: the service answered and can do its job.
- `degraded`: usable with a known limitation (server speech on the CPU after a GPU failure, a provider
  whose last request was rejected).
- `down`: configured, but cannot be reached or refuses work.
- `unconfigured`: this server does not have it (no URL, no worker). Not an outage, no banner; affected panels still show setup guidance.

`reasonKey` and `fixKey` are short codes; the web app translates them (`i18n/en/services.ts`). The wire
never carries a URL, token, host, worker message, or any other raw text, and `parseServiceStatus` drops
unknown fields on the client as well.

### Caching and cost

- `SERVICE_TTL_MS` (15 s) per source; concurrent callers share one probe in flight (`sourceStatus`).
- `PROBE_TIMEOUT_MS` (2 s) per probe. The deadline settles even when the transport ignores the abort,
  and a probe never throws: any failure becomes `down`/`timeout`.
- No timer and no background loop. Nothing is probed at startup. The first request that needs a status
  pays for it; `/api/services` and a chat turn both go through the same cache.
- `?refresh=1` bypasses the TTL but still shares the in-flight probe. The bypass has one cooldown per
  **source** (`FORCE_COOLDOWN_MS`, 5 s), shared by every account and tab and by Admin → Voice's
  `workerHealth(true)`, so ten tabs cannot fan out even when they belong to different accounts.
- A request that fails to connect (`ECONNREFUSED`, reset) reports the failure into the cache, so the
  next request fails fast instead of waiting for another timeout. A successful request clears a cached
  `down` for that id only.
- Request evidence carries a version. A probe snapshots it before starting and merges only ids that did
  not get newer evidence while it ran, so a failure (or success) reported during a slow probe is not
  overwritten by that probe's older answer. Checking the probe's completion time was not enough: a
  probe that *started* earlier always finishes later.
- A long job timing out is *not* an outage and is never reported as one. An application-level 503 from
  a worker *is* one (see Failing fast).

## Services, probes, and what a user sees

| Service id | Probe | Depends on | When it is down |
| --- | --- | --- | --- |
| `browser` | `GET <browser>/health`, needs `ok` and `chromium` | Chromium in the browser worker | `view_artifact` is withheld from the turn; PDF creation and PDF export answer `service_unavailable`. DOCX/XLSX, reading, editing, downloads, and client previews keep working. `web_fetch` uses the separate `scrapling` entry. |
| `scrapling` | same health answer, `scrapling` flag | Scrapling in the browser worker | `web_fetch` keeps the plain fetch; pages behind a bot wall or JS shell cannot be read. Never disables `web_fetch`, and a render outage never marks it down. |
| `speech` | `GET <speech>/health` (never loads a model) | speech worker container | Server voices (Piper) and Whisper answer `service_unavailable`. Cloud and browser engines keep working. `degraded` means CUDA failed and the worker serves on the CPU: still usable. |
| `sandbox` | `GET <sandbox>/health`; 503 means the isolation check failed | sandbox container | `run_code` is withheld from the turn; `import_document` of a presentation and PPTX conversion answer `service_unavailable`. Saved outputs stay downloadable from the Library. |
| `searxng` | `GET <searxng>/healthz` | SearXNG sidecar | Search falls back to Brave and DuckDuckGo Lite, so `web_search` stays offered; the notice says results come from the fallback engines. |
| `codex` | `codex_auth` row | the user's own Codex login | Not signed in (`unconfigured`); the `chatgpt` provider is absent. |
| `providers` | `readConnections` + shared model policies, database only | the user's own and shared **chat-capable** provider rows | No usable connection (`unconfigured`), or `degraded` after the account's last chat request was rejected for auth/quota. Speech-only (`speech-*`) and image-only (`image-*`) keys share the table but never count. Never contacts a vendor and never spends quota. |
| `email:<accountId>` | stored last connection test (`last_check_status`) | the account's own row | `down` after a failed test, `degraded` while untested. Mail tools stay offered: `email_folders` without an account id never connects, so one bad account cannot hide the others. |

Per-account entries are plain database reads; nothing on this path talks to a provider, mail server, or
vendor. "Configured" is not "verified": `providers: up` only means at least one usable connection
exists, and the reason says so.

## Server behaviour

### A turn with a down service

Before assembling tools for a new user message, `chat.ts` asks the registry only for a sidecar whose tool
this turn could actually offer:

- `browser` only for an artifact-enabled, non-temporary chat on a vision model with a configured renderer
  (`view_artifact` is the tool).
- `sandbox` only when the model can call tools, the chat is stored, code execution is on, and the runner
  is configured (`run_code`).

A plain text reply, a temporary chat, a model without tool calling, or artifacts/code execution switched
off makes **no** probe and writes **no** note. When a probe is needed it waits at most the 2 s deadline
(`turnServiceStates`); startup never waits, and an unanswered probe leaves the service available for the
request to test. Only an enabled tool whose configured service is **down** is withheld:

- `view_artifact` is not offered (only relevant for vision models with artifacts on).
- `run_code` is not offered.

The reason is written to the reply's metadata (`AssistantMetadata.unavailable`, an array of
`TurnUnavailable`), and the reply shows one line per withheld service with the fix. The model is not
told to guess: `create_document` still exists and answers `service_unavailable` with the fix if the
user asks for a PDF.

An **unconfigured** optional service is not withheld and produces no note on every reply; the call
that needs it answers `service_unavailable` instead.

MCP servers that could not connect appear in the same list (`service: "mcp"`, `name`, `mcpError` /
`mcpNeedsAuth`). Their own error text stays server-side.

### Continuations keep the sidecar tools

A continuation request (the last message is the assistant's) does not probe a sidecar again: it reads
the `unavailable` list stored on that reply and withholds the same `view_artifact`/`run_code` tools. A
sidecar that recovers or fails mid-turn therefore never changes their part of the tool block.

MCP is different and is not promised as stable: `toolsForUser()` runs again on every request, so a
server that reconnects during a turn can add its tools. The stored `service: "mcp"` note is the reason
the *turn began* without that server, not a permanent brake. A retry or edit ends with a new user
message and is a new turn.

### Failing fast

`browserJob`, the sandbox client, the speech worker client, PDF export, and PDF document creation call
`assertServiceAvailable` or translate a connection failure into `serviceUnavailable(id)`. That is the
existing feature-09 `AppError` (`code: "service_unavailable"`, status 503, retryable, with a safe fix
hint naming the compose service). Tool errors keep the code through the stream: the chat's tool-error
transform recognises our own messages and emits the wire error, so the card shows a service failure
instead of a generic one.

A worker's own HTTP 503 is treated the same way at the boundary: report that capability down, then throw
`service_unavailable`, rather than reporting success before checking `res.ok`. A 4xx (the browser
worker's 422 page/format validation, a sandbox 409/422) is the worker answering a bad request, not an
outage: it reports success and keeps its actionable error. An unconfigured browser worker answers the
same `service_unavailable` instead of exposing its environment variable name.

Rendering (`/v1/render`) depends on `browser`; page reading (`/v1/fetch`) depends on `scrapling`.
`browserJob` checks and reports only the route's own capability, so a working fetch never clears a
render outage and a missing Chromium never blocks plain page reading through Scrapling.

Cancellation is never translated into an outage: an aborted request keeps `aborted` (a worker's 499
stays "Cancelled"), and cleanup calls (sandbox cancel/delete) skip the guard so a down sandbox can still
be cleaned up.

## Web behaviour

- `GET /api/services` (authenticated) returns the list for the current account. The store starts it
  once with the startup data, then refreshes on window focus and after a request or tool call reports
  `service_unavailable`. One request in flight per account; a late answer for a previous account is
  dropped; a failed health request never turns into an outage. Forced refreshes also have a client
  cooldown, so a burst of failed actions (or a health request that itself failed) cannot fan out, and
  `/api/services` is never the trigger for another `/api/services` request.
- Raw binary boundaries (`speechFetch` for audio, `exportThread` for a PDF) cannot use `api()`. They go
  through the same `responseError()` helper: the non-OK body is parsed into the wire error (never raw
  worker text), and a `service_unavailable` raises the same refresh event.
- **Banner** (`ServiceNotice`): only services the user actually used in this session (a tool part that
  ran, a speech attempt, a PDF export) that are down or degraded, minus what was dismissed. Loading
  the registry never raises it. It is dismissible for the session, and a service that recovers loses
  its dismissal so the next outage is shown again. The usage watcher reads assistant-ui's own tool
  parts (`type: "tool-call"`, `toolName`, `args`, `result`, `isError`, `status`) as the reply streams;
  it never scans stored history and never treats the turn's `unavailable` metadata as a use. Providers
  count as used once the reply is active (Codex too for a `chatgpt/` model), page reading marks
  Scrapling only when the result's `via` says it served the page, and email marks the account id the
  call actually used.
- **Inline** (`ServiceAvailability`): a panel that needs one service explains the state instead of
  showing a request error, with "Check again" and, when a settings page owns the fix, a deep link.
  Used in Settings → Voice, the Library, the PDF export menus, and the composer's local voice hint.
  `checking` is its own state; a control is never disabled while the answer is unknown. A caller's
  custom note describes a **down** or **unconfigured** service only: `degraded` always explains its own limitation (a CPU
  fallback is slower, not unavailable).
- **Speech controls** stay visible while their engine is configured. When the selected engine is the
  local worker and the registry knows it is down, the composer microphone and the message's read-aloud
  button are disabled and described by the composer's hint (compose fix plus a Voice settings link);
  dictation/read-aloud adapters are not removed. Stop-recording and Stop-speaking are never disabled,
  so an active capture or playback can always be stopped. Cloud and browser engines are unaffected, and
  a CPU fallback is still usable.
- **Turn note** (`TurnServiceNote`): the stored reason under the reply, with the fix and a settings
  link.
- A disabled control is described by the adjacent explanation, whose own buttons stay in the tab order.
  A control is never colour-only or silently absent. Fix text is either a settings link or the compose
  command (`docker compose up -d <service>`), never a URL or token.

## Adding a service

1. Add its id to `SERVICE_IDS` (and `SERVICE_REASONS`/`SERVICE_FIXES` if new codes are needed) in
   `src/shared/services.ts`. Email-style per-account ids use the `email:` pattern; add a new prefix
   there and to `parseServiceStatus`.
2. Add a source and probe in `src/server/services.ts` (`SOURCE_IDS`, `SOURCE_OF`, `DEFAULT_PROBES`,
   `FIX`). The probe gets an `AbortSignal` and returns one `ProbeResult` per id, or `"unconfigured"`.
   Import the client module lazily inside the probe if that module imports `services.ts`.
3. Export a `fetch…Health(signal)` from the client module and make its own calls call
   `assertServiceAvailable` / `reportServiceFailure` / `reportServiceSuccess`.
4. Withhold the tools that need it in `chat.ts` (`turnServiceStates`, `unavailableEntry`) and add the
   client mapping in `web/state/services-derive.ts` (`TOOL_SERVICE`, names, reasons, fixes).
5. Add the i18n keys to `src/web/i18n/en/services.ts` (names, reason, fix) and, if a panel needs it,
   a `ServiceAvailability` note.
6. Add tests: a fake probe in `src/server/services.test.ts`, and the tool omission in
   `src/server/chat-services.test.ts`.

## Limits

Capability freshness is checked per id: successful renders cannot extend a stale Scrapling failure, and
partial request evidence still requires a complete health probe. General settings uses the live registry,
so its sandbox explanation recovers on focus or Check again. PDF export is also disabled with setup
guidance when the browser worker is unconfigured.

- Probes are shallow: a health endpoint proves the process answers, not that a job will succeed. A
  service can be reported `up` and still fail; the call then fails fast and marks it down.
- Provider and email status is coarse by design. There is no vendor call, no mailbox connection, and no
  quota spent from this path; a rejected key or failed test is only visible after the user's own action.
- The banner is session-scoped (dismissal is remembered in `sessionStorage` per account), not a
  server-side acknowledgement.
- There is no metrics export, no Admin dashboard, and no automatic container orchestration.
