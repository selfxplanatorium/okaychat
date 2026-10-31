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
- `unconfigured`: this server does not have it (no URL, no worker). Not an outage, no notice.

`reasonKey` and `fixKey` are short codes; the web app translates them (`i18n/en/services.ts`). The wire
never carries a URL, token, host, worker message, or any other raw text, and `parseServiceStatus` drops
unknown fields on the client as well.

### Caching and cost

- `SERVICE_TTL_MS` (15 s) per source; concurrent callers share one probe in flight (`sourceStatus`).
- `PROBE_TIMEOUT_MS` (2 s) per probe. The deadline settles even when the transport ignores the abort,
  and a probe never throws: any failure becomes `down`/`timeout`.
- No timer and no background loop. Nothing is probed at startup. The first request that needs a status
  pays for it; `/api/services` and a chat turn both go through the same cache.
- `?refresh=1` bypasses the TTL but still shares the in-flight probe, and is throttled to once per 5 s
  per account.
- A request that fails to connect (`ECONNREFUSED`, reset) reports the failure into the cache, so the
  next request fails fast instead of waiting for another timeout. A successful request clears a cached
  `down` (the evidence is newer than the probe). A long job timing out is *not* an outage and is never
  reported as one.

## Services, probes, and what a user sees

| Service id | Probe | Depends on | When it is down |
| --- | --- | --- | --- |
| `browser` | `GET <browser>/health`, needs `ok` and `chromium` | browser worker container | `view_artifact` is withheld from the turn; PDF creation and PDF export answer `service_unavailable`. DOCX/XLSX, reading, editing, downloads, and client previews keep working. `web_fetch` keeps its plain fetch path. |
| `scrapling` | same health answer, `scrapling` flag | browser worker container | `web_fetch` keeps the plain fetch; pages behind a bot wall or JS shell cannot be read. Never disables `web_fetch`. |
| `speech` | `GET <speech>/health` (never loads a model) | speech worker container | Server voices (Piper) and Whisper answer `service_unavailable`. Cloud and browser engines keep working. `degraded` means CUDA failed and the worker serves on the CPU: still usable. |
| `sandbox` | `GET <sandbox>/health`; 503 means the isolation check failed | sandbox container | `run_code` is withheld from the turn; `import_document` of a presentation and PPTX conversion answer `service_unavailable`. Saved outputs stay downloadable from the Library. |
| `searxng` | `GET <searxng>/healthz` | SearXNG sidecar | Search falls back to Brave and DuckDuckGo Lite, so `web_search` stays offered; the notice says results come from the fallback engines. |
| `codex` | `codex_auth` row | the user's own Codex login | Not signed in (`unconfigured`); the `chatgpt` provider is absent. |
| `providers` | `readConnections` + shared model policies, database only | the user's own and shared provider rows | No usable connection (`unconfigured`), or `degraded` after the account's last chat request was rejected for auth/quota. Never contacts a vendor and never spends quota. |
| `email:<accountId>` | stored last connection test (`last_check_status`) | the account's own row | `down` after a failed test, `degraded` while untested. Mail tools stay offered: `email_folders` without an account id never connects, so one bad account cannot hide the others. |

Per-account entries are plain database reads; nothing on this path talks to a provider, mail server, or
vendor. "Configured" is not "verified": `providers: up` only means at least one usable connection
exists, and the reason says so.

## Server behaviour

### A turn with a down service

Before assembling tools for a new user message, `chat.ts` asks the registry for `browser` and `sandbox`
(`turnServiceStates`, bounded by the probe deadline, and never blocking on an unknown service). A
service that is **down** is withheld:

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

### Continuations keep the tool list

A continuation request (the last message is the assistant's) does not probe again: it reads the
`unavailable` list stored on that reply and withholds the same tools. A service that recovers or fails
mid-turn therefore never changes the tool block, so the prompt cache stays valid. A retry or edit ends
with a new user message and is a new turn.

### Failing fast

`browserJob`, the sandbox client, the speech worker client, PDF export, and PDF document creation call
`assertServiceAvailable` or translate a connection failure into `serviceUnavailable(id)`. That is the
existing feature-09 `AppError` (`code: "service_unavailable"`, status 503, retryable, with a safe fix
hint naming the compose service). Tool errors keep the code through the stream: the chat's tool-error
transform recognises our own messages and emits the wire error, so the card shows a service failure
instead of a generic one.

Cancellation is never translated into an outage: an aborted request keeps `aborted`, and cleanup calls
(sandbox cancel/delete) skip the guard so a down sandbox can still be cleaned up.

## Web behaviour

- `GET /api/services` (authenticated) returns the list for the current account. The store starts it
  once with the startup data, then refreshes on window focus and after a request or tool call reports
  `service_unavailable`. One request in flight per account; a late answer for a previous account is
  dropped; a failed health request never turns into an outage.
- **Banner** (`ServiceNotice`): only services the user actually used in this session (a tool part that
  ran, a speech attempt, a PDF export) that are down or degraded, minus what was dismissed. Loading
  the registry never raises it. It is dismissible for the session, and a service that recovers loses
  its dismissal so the next outage is shown again.
- **Inline** (`ServiceAvailability`): a panel that needs one service explains the state instead of
  showing a request error, with "Check again" and, when a settings page owns the fix, a deep link.
  Used in Settings → Voice, the Library, and the PDF export menus. `checking` is its own state; a
  control is never disabled while the answer is unknown.
- **Turn note** (`TurnServiceNote`): the stored reason under the reply, with the fix and a settings
  link.
- Disabled controls are focusable (`aria-disabled`) and described by the adjacent explanation; the
  explanation's own buttons are in the tab order. Fix text is either a settings link or the compose
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

- Probes are shallow: a health endpoint proves the process answers, not that a job will succeed. A
  service can be reported `up` and still fail; the call then fails fast and marks it down.
- Provider and email status is coarse by design. There is no vendor call, no mailbox connection, and no
  quota spent from this path; a rejected key or failed test is only visible after the user's own action.
- The banner is session-scoped (dismissal is remembered in `sessionStorage` per account), not a
  server-side acknowledgement.
- There is no metrics export, no Admin dashboard, and no automatic container orchestration.
