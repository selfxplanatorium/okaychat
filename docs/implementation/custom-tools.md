# Custom tools

Private per-account Python functions and fixed-destination HTTPS request tools, under
**Plugins → Custom tools**. Enabled tools become ordinary AI SDK tools in interactive stored chats.
There is no sharing, discovery, model-authored creation, or execution on the application host.

## Data and identity

`custom_tools` holds one definition per row: display text, icon, strict input schema, encrypted config,
encrypted secrets, a monotonic `revision`, and a `base_key`. The exposed tool key is
`<base_key>_r<revision>` (`custom_` + 24 hex + `_r` + revision), so an edit changes the tool identity and
invalidates prepared approvals. `custom_tool_runs` is the execution ledger; `custom_tool_counters` keeps
lifetime attempts/outcomes; `custom_tool_rate_windows` holds fixed UTC-minute abuse counters.

Config, secrets, inputs, reviews and results use the existing AES-256-GCM `encrypt`/`decrypt` with an
envelope binding `{v,userId,toolId,runId?,value}`. A ciphertext copied to another row fails closed.
Secrets are write-only: list/detail return names only, and no endpoint reveals a value.

## Validation contract

`src/shared/custom-tools.ts` is the single authoritative implementation for both the editor and the
server. It contains a bounded strict JSON parser (duplicate keys, reserved keys, depth, nodes, finite and
safe numbers), the supported JSON-schema subset, definition validation, path/query/body/header builders,
canonical JSON, result redaction and fixed error messages. Nothing is generated code, and no submitted
value appears in a validation message; paths are JSON pointers and reasons are fixed enums.

The subset is deliberately small: root object with `additionalProperties:false`, string (enum/max length),
number/integer (bounds), boolean, array (items, maxItems) and object. Unsupported keywords, `$ref`,
defaults, combinators, nullable types, and tuples are rejected. Input is capped at 16 KiB; a request body
at 32 KiB; a result at 32 KiB; a schema at 16 KiB.

## Python

Python runs only in the existing `sandbox` container. The app posts a one-use workspace id derived from
`sha256("custom-function:" + runId)` to `POST /workspaces/:ws/function`. The runner writes a fixed wrapper
and the user module to private files, starts `python3 -I`, and captures stdout exactly up to 32 KiB and
stderr up to 8 KiB; an overflow kills the process group rather than splicing output. The wrapper calls
`main(input)` once, rejects async/generator functions, walks the result for JSON-only types and safe
numbers, then writes exactly one JSON value. The app parses that stdout independently with the shared
limits. A fresh workspace and uid are created for every invocation and deleted in `finally`; there is no
file download, persistence, or reuse.

Python has no configured secrets, no account files, no attachments, and no network. It requires the
existing `code` feature in addition to `customTools`. A busy worker answers 429 and is not a service
outage; isolation failure remains a 503 and withholds Python tools with the normal service note.

## HTTP

Origins are canonical HTTPS origins only: no path, query, fragment, userinfo, non-default port, IP literal,
or trailing dot. Path placeholders must occupy a whole segment and reference a required top-level scalar;
substituted `.`, `..`, slashes, backslashes and percent signs are refused. Query values are literal or a
required scalar input. Headers are an allowlist; credential-like names (`authorization`, `x-api-key`, and
names containing token/secret/auth/credential) must be secret references. Cookies, host, forwarding
headers, method override and the other transport headers are never configurable.

Every dispatch uses `publicFetch` with `redirect:"error"`, including for administrators. No retry and no
fallback transport exist. The response body is read through `readCapped` at 32 KiB decompressed, with the
request timeout covering DNS, connection and body. JSON responses require `application/json` or
`application/*+json` and strict UTF-8; text responses accept `text/plain`, `text/csv` or
`application/json`. 3xx becomes `redirect_blocked`; other non-2xx becomes `http_status` with the numeric
status only. Response headers are discarded. Known secret values and common credential patterns are
redacted before persistence, scanning, and model delivery; a result key containing a secret fails
`invalid_result`.

## Approvals and runtimes

Custom tools are assembled only for an interactive stored chat (`interactiveChat`) whose request is not a
scheduled run, comparison pane, temporary chat, research worker, delegate, channel, evaluation, voice
call, or alternate agent transport. A local voice call active on the same thread also withholds them. The
executor re-checks the runtime, feature, revision, enabled state and sandbox availability.

Python needs no baseline approval. HTTP always needs approval. During the custom branch of
`toolApproval` the server validates the input, prepares a run and an exact review (URL, method, public
headers, secret names, body) and stores it. On the approval continuation the replayed decision is
accepted only against that existing prepared row; owner, session, thread, tool, revision, request hash,
expiry, live feature and enabled state are checked again. The approved capability is a module-branded
object; a `confirmed:true` argument or client metadata can never authorize dispatch. A definition edit,
secret change, disable, policy revoke, voice call start, expiry or restart invalidates the prepared run.

Workspace tests use the same prepared-run path. Python runs immediately against saved code. HTTP returns
a `TestReview` with a single-use token bound to the owner and session; `POST /:id/test/execute` verifies
the token and dispatches once. Tests may run a disabled definition, but feature and code checks still
apply.

## Ledger, quota and retention

Every run reserves a fixed 128 KiB quota slot; definition text plus encrypted config/secrets is charged
once. Terminal transitions clear input/review/token/approval payloads. Result retention is 20 terminal
runs per tool for 7 days, keeping the latest admitted result until replaced. Prepared runs expire after
10 minutes and at most 10 exist per account. Dedupe rows survive pruning as bounded tombstones when they
are still inside the 24-hour idempotency window. Rate limits are 30 attempts per account per UTC minute,
10 attempts per logical reply, 2 active executions per account and 4 per process, plus the normal
operation limiter. Attempts increment only on the atomic prepared → running claim; denied and expired
runs do not count. A restart marks running rows `unknown` and expires prepared approvals; nothing resumes.

## UI

`/plugins?tab=tools` lists tools; `tool=<id>` opens the editor, `new=python|http` starts a draft, and
`panel=test` is accepted in the link. The tab strip is URL state, the editor and test panel stack on
phones, and the action bar respects the bottom safe area. The schema editor has a builder and a raw JSON
view over the same subset. Secrets show as “Stored” with Replace/Remove and never as a password field.
The test panel shows the server-authored review with full URL/query/body before Send. Result cards render
plain text/code only. Chat calls use the normal approval UI and work-log grouping; imported records stay
inert and public shares keep hiding tool input/output.

## Configuration and limits

- `customTools` feature key; Python also needs `code`; HTTP does not need `webFetch`.
- 50 definitions per account, at most 20 enabled.
- Python timeout 1–30 s (default 10 s), HTTP 1–20 s (default 10 s).
- 8 secrets per HTTP tool, 2 KiB each, 8 KiB total.

## Deferred

Sharing or admin-authored catalogs, import/export of definitions or secrets, arbitrary JSON Schema,
OpenAPI import, OAuth, private hosts, redirects, dynamic origins, multipart/binary/streaming bodies,
response extraction, pagination, retries, webhooks, Python secrets/env/files/persistence, dependency
installs, async `main`, version history, per-chat or per-preset selectors, unattended runtimes, and
durable execution across restart.
