# Custom provider connections

Custom connections (`custom-*` provider ids) are OpenAI-compatible HTTP endpoints. Beyond a base URL and
an optional key they carry connection-wide authentication, static headers, default query parameters, and
a model source. Built-in providers, Ollama, ChatGPT, image-only (`image-*`) and speech-only (`speech-*`)
rows never accept these settings: the provider PUT routes answer 400 `unsupported_field`.

| File | Role |
| --- | --- |
| `src/shared/provider-transport.ts` | Contracts, limits, pure validators (shared by server and form) |
| `src/server/catalog/provider-config.ts` | PUT schema, patch merge, config_json codec, summaries, digests |
| `src/server/provider-transport.ts` | The one HTTP boundary for v1 custom connections, discovery |
| `src/server/catalog/providers.ts` | Hydration (`connectionFromRow`), save (`prepareConnectionSave`/`commitConnectionSave`), manual/discovered models, caches, pins |
| `src/web/components/settings/CustomProviderFields.tsx`, `custom-connection-state.ts` | The create/edit form and its pure state |

## Configuration

- **Auth** (`transport.auth`): `bearer` (default; `Authorization: Bearer <key>`, nothing when keyless),
  `api-key` (the raw key in `headerName`, which may be `authorization` for another scheme), or `headers`
  (no generated auth; only static headers). No path ever switches to Bearer by itself.
- **Headers** (`transport.headers`) and **query** (`transport.query`): up to 16 and 8 rows. Header names are
  stored lowercase; query names are case-sensitive.
- **Model source** (`modelSource`): `discover` (GET `<base>/models`, bounded to 1 MiB and 10,000 ids,
  8 s deadline) or `manual` (1–32 ids, validated locally, zero probes). Manual entries use `unknownModel`
  metadata and unknown pricing.
- Everything that affects routing or auth belongs to the connection. There are no per-model overrides; a
  deployment that needs another path, key, or version uses another connection.

## Write-only values and patch rules

`apiKey`, header values, and query values are write-only. Lists return only `transport` (auth, `hasApiKey`,
row names with `hasValue`) and `modelSource`, and only for the owner's rows and the admin's view of shared
rows. An audience member of a shared connection sees none of it; an own override starts from defaults.

- Omitted `transport`/`modelSource` or an omitted nested field keeps the stored value. A supplied array
  replaces the set; a row without `value` keeps the value of the same normalized name, and a new name
  needs a value. `apiKey: ""` deletes the key. A mask string is an ordinary value, never "keep".
- Switching between bearer and api-key, or changing the api-key header name, needs the key again.
  `headers` mode refuses a key and clears the stored one.
- An origin change (scheme, host, effective port) needs every surviving key, header, and query value
  supplied again, or removed. A same-origin path change keeps them.
- One validator serves both routes and `saveConnection()`. Errors are 400 `{error, field, reason}` with a
  stable reason (`reserved_header`, `control_character`, `secret_reentry_required`, …) and never echo values.
- The user route builds the candidate from the owned row only, runs `privateUrlError` on the effective
  base URL when the patch changes more than `enabled`/`name`, then commits. The commit re-reads the row and
  answers 409 `changed` if it moved during the DNS check.

Validation limits (also in `TRANSPORT_LIMITS`): base URL ≤ 2,048 bytes, absolute http(s), no userinfo,
query, fragment, backslash, encoded separators, or operation suffix; key ≤ 8,192 bytes; header names RFC
tokens ≤ 64 bytes; header values printable ASCII ≤ 4,096 bytes; all configured headers ≤ 16 KiB; query
values ≤ 512 bytes, encoded query ≤ 2,048 bytes, final URL ≤ 8,192 bytes. CR, LF, C0, DEL, C1, and
malformed Unicode are rejected, never stripped. Extra headers cannot be `host`, `content-length`,
`transfer-encoding`, `cookie`, `authorization`, `proxy-authorization`, `connection`, `upgrade`,
`trailer`, `te`, `keep-alive`, `expect`, `content-type`, `accept-encoding`, `user-agent`, `proxy-*`,
`sec-*`, or a pseudo-header, nor the chosen auth header.

## Storage

`api_key_enc` is unchanged. `config_json` gains `customTransportVersion: 1`, `transport: {auth,
headerNames, queryNames, valuesEnc}` (AES-256-GCM of the values) and `modelSource`; other keys are kept.
There is no schema migration. A row without a version is a legacy row: it keeps its historical wire
behavior (including the keyless `not-needed` Bearer placeholder) until a save supplies `transport` or
`modelSource`. New custom rows are always v1. A corrupt v1 row or an unknown version fails closed: no
models, every request refused with a configuration error. Rolling back to a binary without this code
ignores v1 settings, so disable those connections first or restore the earlier database.

## The transport boundary

`providerFetch(conn)` returns the existing transport for built-ins and legacy rows, and for v1 rows a
fetch that, on every attempt:

1. pins the request to the connection's origin and literal base path (segment boundary), refusing
   another origin, userinfo, fragments, and encoded separators before any secret is attached;
2. adds each default query parameter once (a caller value equal to it is kept; a different or repeated
   value is refused before the network);
3. removes SDK `Authorization` and the chosen auth header, sets the configured auth, then the static
   headers; `Content-Type` (multipart boundaries) is the SDK's;
4. forces `redirect: "error"` and treats any 3xx as a non-retryable error that never exposes `Location`;
5. uses `publicFetch` for guarded (non-admin own) rows, direct fetch otherwise;
6. replaces every failed response with its status, a bounded `Retry-After`, and authored text, and every
   thrown failure with a code-only network error, so no echoed secret reaches provider-errors, logs,
   ingestion status, speech errors, or tool results. Successful bodies stream through unbuffered.

Chat composes SDK → response bounds → retry (live checks, finite-credit attempt cap) → connection
transport → leaf. The model's base must equal the connection's (`createModel` refuses a mismatch).

Wired boundaries: `llm.ts` (chat), `catalog/providers.ts` (discovery), `knowledge/embeddings.ts`,
`tools/image.ts` and `tools/image-models.ts`, `speech/engines.ts` (`upstream`) and `speech/options.ts`.
WebSocket Realtime (`speech/engines.ts`) and Realtime signalling (`voice/backend.ts`) refuse a v1 custom
connection instead of sending Bearer only. Current image and speech selectors resolve fixed service ids,
so a custom connection cannot be chosen for image generation or voice; that selection is deferred.

## Caches and pins

Discovery lists are keyed by `connectionDigest()`: a SHA-256 over provider id, scope, guarded policy,
base URL, key, auth, sorted headers and query, and model source. Image and speech option caches and the
external API connection check include it too. Knowledge pins keep their endpoint hash for rows without
query and add a keyed query digest otherwise; a `fingerprint` of the whole transport stops active
embedding operations on any change. See [knowledge](knowledge.md).

## Azure OpenAI

Fixed deployment (recommended): base URL `https://RESOURCE.openai.azure.com/openai/deployments/<name>`,
auth `api-key` with header `api-key`, query `api-version=<version>`, model source manual with exactly
`<name>`. The save refuses any other model source for a deployment path, and the connection makes no
`/models` request. The model id is the deployment name. Embeddings need their own connection whose
deployment is the collection model.

Modern `/openai/v1`: base URL `https://RESOURCE.openai.azure.com/openai/v1`, the deployment ids entered
manually as model ids, no `api-version` added automatically. Data-plane model lists are not deployment
inventories, and management-plane discovery is out of scope.

## Deferred

SigV4, service-account OAuth, OAuth client credentials, managed identity, management-plane discovery,
mTLS, signed query credentials, per-model overrides, templated routing, protocol auto-detection, custom
Responses/Realtime transports, capability/price editing, and custom image/speech service selection.
