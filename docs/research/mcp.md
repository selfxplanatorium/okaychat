# @ai-sdk/mcp: client usage and connection manager reference

Versions verified: `@ai-sdk/mcp` 2.0.78, `ai` 7.0.143, zod v4 (peer). Node 22 target. Source read from `node_modules/@ai-sdk/mcp/dist/index.js` and `dist/index.d.ts`. Opencode source read from `/tmp/research/opencode/packages/core/src/mcp/`.

## Summary

- F1: `@ai-sdk/mcp` has no reconnect, no per-call default timeout, and no `list_changed` handling. A hung tool call waits forever unless you pass `signal` or `timeout`.
- F2: Server `notifications/tools/list_changed` is not handled. It is reported to `onUncaughtError` as "Unsupported message type". You must re-run `client.tools()` yourself.
- F3: Tool failures (`isError: true`) are returned as values, not thrown. Connect failures and timeouts throw `MCPClientError` (except raw `fetch` errors, see F5).
- F4: OAuth is supported through `authProvider` (interface `OAuthClientProvider`). The redirect flow needs a second `auth(...)` call with the callback code, then a new client.
- F5: Connection refused surfaces as a raw `TypeError: fetch failed`, not `MCPClientError`. Catch both.
- F6: Opencode does not use `@ai-sdk/mcp`. It uses the official `@modelcontextprotocol/client` SDK and wraps it with its own lifecycle, timeouts, and retries.

## 1. Install and imports

```bash
npm i @ai-sdk/mcp@latest ai@latest zod
```

```ts
import { createMCPClient, MCPClientError, UnauthorizedError, auth } from '@ai-sdk/mcp';
import type { OAuthClientProvider, MCPClient, MCPTransport } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
```

Exports are verified in `dist/index.d.ts`. The stdio class name keeps the `Experimental_` prefix.

## 2. Transports

`createMCPClient(config)` returns `Promise<MCPClient>`. It connects during the call. Connect errors reject the promise.

### Streamable HTTP (recommended)

```ts
const client = await createMCPClient({
  transport: {
    type: 'http',
    url: 'https://mcp.example.com/mcp',
    headers: { Authorization: `Bearer ${token}` }, // static headers
    redirect: 'error', // default; 'follow' to follow redirects
  },
});
```

`MCPTransportConfig` fields (type `sse` or `http`): `url`, `headers`, `authProvider`, `redirect` (default `'error'`), `fetch` (custom fetch), and for HTTP only: `initialSessionId`, `initialProtocolVersion`, `onSessionIdChange`, `onSessionExpired`, `terminateSessionOnClose` (default `true`).

Default `initialProtocolVersion` is `"2026-07-28"` (modern, stateless). Legacy servers are handled by fallback to `initialize`.

### SSE (legacy servers)

```ts
const client = await createMCPClient({
  transport: { type: 'sse', url: 'https://mcp.example.com/sse', headers: { Authorization: `Bearer ${token}` } },
});
```

### stdio (local servers)

```ts
const client = await createMCPClient({
  transport: new Experimental_StdioMCPTransport({
    command: 'node',
    args: ['server.js'],
    env: { API_KEY: process.env.API_KEY! },
    cwd: '/path/to/server',
    stderr: 'inherit', // default; IOType | Stream | number
  }),
});
```

Verified in `dist/mcp-stdio/index.js`: the child env is only `env` plus this allowlist from the host: `HOME, LOGNAME, PATH, SHELL, TERM, USER` (Windows has its own list). Other host variables are not passed. Put every secret the server needs in `env`.

### Custom transport

Pass an object implementing `MCPTransport`: `start()`, `send(message, options?)`, `close(options?)`, and optional `onmessage`, `onerror`, `onclose`, `supportsProtocolVersionDiscovery`. Custom transports default to the legacy `initialize` flow unless `supportsProtocolVersionDiscovery` is `true`.

### Per-user headers and bearer tokens

- Static: `headers` in the transport config. Fixed for the lifetime of the client.
- Rotating: implement `authProvider.tokens()`. The HTTP transport calls it on every request and sets `Authorization: Bearer <access_token>` when present (verified in `dist/index.js`, `HttpMCPTransport` header builder).
- Per-user isolation: create one client per user (or per user+server). Do not share a client between users.

### Session reuse (HTTP only)

```ts
const client = await createMCPClient({
  transport: {
    type: 'http', url,
    initialSessionId: saved?.sessionId,
    initialProtocolVersion: saved?.protocolVersion,
    terminateSessionOnClose: false,
    onSessionIdChange: (id) => saveSession(id),
    onSessionExpired: (id) => clearSession(id),
  },
  initialInitializeResult: saved?.initializeResult, // skips initialize
});
```

Session reuse applies only to legacy protocol versions. Modern (`2026-07-28`) is stateless.

## 3. Client config options (`MCPClientConfig`)

| Option | Default | Notes |
|---|---|---|
| `transport` | required | Config object or `MCPTransport` instance |
| `initializationOptions` | none | `RequestOptions` (`signal`, `timeout`, `maxTotalTimeout`) for startup and `initialize`. Without it, startup has no timeout. |
| `protocolVersionDiscovery` | `true` | Sends `server/discover` first when transport supports it. Set `false` for servers that require `initialize` first. |
| `maxRetries` | `0` | Retries `tools/call` only, with exponential backoff. Retries on HTTP 408, 409, 429, 5xx, and codes `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EPIPE`, `ConnectionClosed`, and similar. Not on JSON-RPC errors. |
| `onUncaughtError` | none | Receives transport and protocol errors that have no caller (see section 7). |
| `clientName`, `version` | `ai-sdk-mcp-client`, `1.0.0` | Sent in `clientInfo`. `name` is deprecated. |
| `capabilities` | `{}` | Client capabilities. Only `elicitation` is typed. |
| `initialInitializeResult` | none | Reuse saved initialize metadata. |
| `experimental_events` | none | Webhook subscriptions. Out of scope here. |

## 4. Tools

### `client.tools()`

```ts
const tools = await client.tools(); // Promise<Record<string, Tool>>
```

- Paginates `tools/list` through `nextCursor` and returns all tools.
- Keys are the raw MCP tool names. No prefix, no sanitizing (verified in `toolsFromDefinitions`). Name collisions across servers overwrite each other silently. Namespace yourself (section 9).
- Each entry has `description`, `title`, `inputSchema`, `execute`, `toModelOutput`, `metadata` (`clientName`, `toolName`, `title`, `annotations`), and `_meta`.
- Input schema: built from the server's JSON Schema with `additionalProperties: false`.

Schema option: pass zod v4 schemas to validate and type the tool definition.

```ts
import { z } from 'zod/v4';
const tools = await client.tools({
  schemas: {
    echo: { inputSchema: z.object({ text: z.string() }) },
    search: { inputSchema: z.object({ q: z.string() }), outputSchema: z.object({ hits: z.number() }) },
  },
});
```

With `schemas` as a record, only listed tools are returned. Verified: `schemas: { echo: ... }` returned `['echo']` only. Use `'automatic'` (default) to use the server JSON Schema unchanged.

`outputSchema` is applied to `structuredContent`, or to JSON parsed from the first text part. A mismatch throws `MCPClientError`.

Use `toolsFromDefinitions(listToolsResult, opts)` to build tools from a `listTools()` result you already have (for example after a manual refresh).

### Passing to `streamText` / `generateText`

```ts
import { streamText, isStepCount } from 'ai';

const result = streamText({
  model,            // your model
  tools,
  stopWhen: isStepCount(10),
  prompt,
  onEnd: async () => { /* per the package README; not run here */ },
});
```

Close the client when the stream ends (README pattern uses `onEnd`). For `generateText`, close in `finally`.

### Results and errors

- Success: `execute` returns the `CallToolResult`: `{ content: [...], structuredContent?, isError, _meta? }`. `content` parts are `text`, `image` (base64), `resource`, or `resource_link`.
- Tool error (`isError: true`): returned as a normal value. It is not thrown. Verified: `{"content":[{"type":"text","text":"boom failed"}],"isError":true}` came back from `execute`. Check `isError` yourself if you need to treat it as failure.
- Protocol error (JSON-RPC error, e.g. unknown tool, invalid params): thrown as `MCPClientError` with `code` (JSON-RPC code, e.g. `-32602`). Verified.
- `toModelOutput` maps text and image parts to model content. Non-content results go as JSON.
- Input validation: done by the `ai` runtime against `inputSchema` before `execute`. Calling `execute` directly with bad input does not validate it. A bad result shape from the server throws `MCPClientError` "Failed to parse server response". Verified.

### Direct calls

```ts
const res = await client.callTool({
  name: 'echo',
  arguments: { text: 'hi' },
  options: { signal, timeout: 15_000 },
}); // Promise<CallToolResult>
```

Note: `tools()[name].execute(args, { abortSignal })` passes only the abort signal. It has no timeout option. To time-limit a tool through `tools()`, pass a signal: `AbortSignal.timeout(ms)` in `execute`'s options, or use `callTool` directly. Abort rejects with `MCPClientError` "Request was aborted". Source-verified, not run.

### Closing

```ts
await client.close(); // idempotent: returns if already closed
```

`close()` tears down the transport. For stdio it kills the child process. For HTTP it sends `DELETE` to end the session unless `terminateSessionOnClose: false`. Pending requests reject with "Connection closed". Requests after close reject with "Attempted to send a request from a closed client". Verified.

`close` does not drain or wait for running tools. Verified only the post-close error path.

## 5. Resources and prompts

Verified method names on `MCPClient`:

- `listResources({ params?, options? })` returns `ListResourcesResult` (`resources[]` with `uri`, `name`, `title`, `description`, `mimeType`, `size`).
- `listResourceTemplates({ options? })` returns `resourceTemplates[]` with `uriTemplate`.
- `readResource({ uri, options? })` returns `contents[]` (text or base64 blob).
- `experimental_listPrompts({ params?, options? })` returns `prompts[]`.
- `experimental_getPrompt({ name, arguments?, options? })` returns `messages[]`.
- `complete({ ref, argument, options? })` for argument autocompletion.

All of these throw `MCPClientError` if the server did not advertise the capability (`tools`, `resources`, `prompts`, `completions`). Check `client.initializeResult.capabilities` first.

## 6. Errors and timeouts

Exported classes: `MCPClientError` (extends `AISDKError`), `MCPClientOAuthError`, `AuthorizationServerMismatchError`, `UnauthorizedError`. Use `MCPClientError.isInstance(e)`.

`MCPClientError` fields: `code` (JSON-RPC code), `statusCode` (HTTP status), `url`, `responseBody`, `data`.

| Situation | Thrown | Verified message |
|---|---|---|
| Startup timeout (`initializationOptions.timeout`) | `MCPClientError` | `MCP client initialization timed out after 1500ms` |
| Request timeout (`options.timeout`) | `MCPClientError` | `Request timed out after 500ms` |
| Abort via `signal` | `MCPClientError` | `Request was aborted` |
| JSON-RPC error | `MCPClientError` with `code` | `Unknown tool`, code `-32602` |
| Server connection refused (http, sse) | raw `TypeError` | `fetch failed` (cause has `code`) |
| stdio binary missing | `Error` with `code: 'ENOENT'` | `spawn ... ENOENT` |
| stdio server never answers | `MCPClientError` (init timeout) | as above |
| HTTP 401, no authProvider | `UnauthorizedError` or HTTP error | unverified |
| Closed client used | `MCPClientError` | `Attempted to send a request from a closed client` |

Built-in timeouts:

- Startup: `initializationOptions.timeout`. Unset means no timeout (F1).
- Per request: `options.timeout` on each method, or `maxTotalTimeout`. Unset means no timeout.
- Retries: `maxRetries` (tool calls only, default 0).
- Protocol discovery: 1000 ms fixed (`DEFAULT_PROTOCOL_DISCOVERY_TIMEOUT`, source).

Classify connect errors this way:

```ts
const isAuthErr = (e: unknown) => e instanceof UnauthorizedError;
const isConnRefused = (e: any) => e instanceof TypeError || (e?.cause as any)?.code === 'ECONNREFUSED';
```

`UnauthorizedError` is thrown when the redirect flow is needed (section 7). Check with `instanceof`.

## 7. OAuth

### Interface: `OAuthClientProvider`

Required:

- `tokens(): OAuthTokens | undefined | Promise<...>`
- `saveTokens(tokens): void | Promise<void>`
- `redirectToAuthorization(url: URL): void | Promise<void>`
- `saveCodeVerifier(verifier: string): void | Promise<void>`
- `codeVerifier(): string | Promise<string>`
- `get redirectUrl(): string | URL`
- `get clientMetadata(): OAuthClientMetadata`
- `clientInformation(): OAuthClientInformation | undefined | Promise<...>`

Optional:

- `saveClientInformation(info)` (needed for dynamic client registration)
- `isClientInformationDynamicallyRegistered(): boolean` (return `true` only for DCR-created clients)
- `saveAuthorizationServerInformation(info)` and `authorizationServerInformation()`. If `saveAuthorizationServerInformation` is missing, the library falls back to `saveClientInformation`. Without either, the redirect path throws "must be saveable before starting authorization". Implement one.
- `invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier', context?)`
- `addClientAuthentication(headers, params, url, metadata?)`
- `state()`, `saveState(state)`, `storedState()` for CSRF state checking
- `validateAuthorizationServerURL(serverUrl, asUrl)` and `validateResourceURL(serverUrl, resource?)`

### Flow

1. Client sends a request. Server returns `401` with `WWW-Authenticate`.
2. Transport calls `auth(provider, { serverUrl, resourceMetadataUrl, scope })`.
3. `auth` discovers protected-resource metadata and authorization server metadata. It reuses tokens, refreshes them if a refresh token exists, or registers a client if none exists.
4. If user interaction is needed, it calls `provider.saveState` (if any), `provider.saveCodeVerifier`, `provider.saveAuthorizationServerInformation`, then `provider.redirectToAuthorization(url)`. It returns `'REDIRECT'`.
5. The transport throws `UnauthorizedError`. The connect or tool call fails.
6. Your callback route receives `code`, `state`, and `iss`. Call `auth` again:

```ts
const result = await auth(provider, {
  serverUrl: 'https://mcp.example.com/mcp',
  authorizationCode: code,
  callbackState: state,      // must match provider.storedState()
  callbackIssuer: iss,       // the iss parameter; validated against the AS
});
// result === 'AUTHORIZED'
```

7. Create a new client with the same provider. Tokens are read by `tokens()` on each request.

Refresh is automatic. On `InvalidGrantError` the library calls `invalidateCredentials('tokens', ...)`. On `InvalidClientError` for a DCR client it calls `invalidateCredentials('all')` and re-registers.

Per-user note: each user needs their own provider instance and storage. Keying tokens by user and server is your job. The provider should also be safe under concurrent refreshes.

### Opencode OAuth (for comparison)

Opencode uses `@modelcontextprotocol/client` with its own `OAuthClientProvider` in `packages/core/src/mcp/oauth.ts`:

- Starts a loopback HTTP listener on `127.0.0.1` at `callback_port`, else the port in `redirect_uri`, else an ephemeral port. Redirect path defaults to `/callback`.
- State is 32 random bytes, base64url. Callback rejects on state mismatch and returns 409 on a second callback.
- Probes the server with an `initialize` POST and reads `WWW-Authenticate` with a 5 s timeout.
- Client registration: static `client_id` if configured, else CIMD (Client ID Metadata Document, `https://opencode.ai/oauth/opencode/client.json`) if the server advertises it, else DCR.
- Refresh requests are de-duplicated per (url, client_id, refresh_token) so rotating refresh tokens are not used twice.
- Invalidates stored credentials only if the stored refresh token is still the one presented.
- If no token or no interactive redirect is available, the connect fails with `NeedsAuthError` and server status `needs_auth`.

## 8. Notifications

Verified in `dist/index.js`:

- The client accepts only requests and responses from the server. Any message with a `method` and no `id` (a notification) goes to `onUncaughtError` as "Unsupported message type". Verified: a server sending `notifications/tools/list_changed` produced exactly this message.
- `capabilities.tools.listChanged` is parsed from `initialize`, but no handler is exposed on `MCPClient`. There is no `onToolsChanged`.
- Server requests (`ping`, `elicitation/create`) are answered. Other methods get `-32601`.
- Elicitation: `client.onElicitationRequest(ElicitationRequestSchema, handler)`. Not tested here.

Consequence: you must poll or refresh on your own. Re-run `client.tools()` after a timer, after a failed call, or on a schedule. Opencode uses its own SDK handlers for list changes (section 9).

## 9. Opencode patterns

Source: `packages/core/src/mcp/client.ts`, `index.ts`, `stdio.ts`, `oauth.ts`, `packages/core/src/tool/mcp.ts`.

Timeouts (per server config, `timeout.startup|catalog|execution`):

- Startup 30 s, catalog (`tools/list`, prompts, resources) 30 s, execution 12 h. Execution has `onprogress` set so long calls keep the SDK timeout alive.

Retries:

- Connect and catalog list calls retry on transient errors only (HTTP 408, 429, 5xx except 501, and network errors): 250 ms, 1 s, max 2 retries. Connect retries stop when the startup deadline passes.
- Tool calls are not retried. A tool call hitting a session-expiry error reconnects once and runs the call again.

Reconnect:

- On `onclose`, the server is marked `failed` with the reason. There is no automatic reconnect loop. The user or a credential change triggers `connect`.
- Session expiry (HTTP 404, or 400 "Server not initialized" on a legacy session) raises `SessionExpiredError`. The server is reconnected under a per-server lock.

Lifecycle:

- Per-server lock and a per-endpoint lock (`endpointLoads`) so servers sharing a URL do not connect in parallel.
- Close: legacy HTTP sessions get `DELETE` with a 1 s timeout. stdio: wait 2 s for exit, then SIGTERM, then SIGKILL after 2 s.
- Status enum: `pending`, `connected`, `failed` (with error), `needs_auth`, `disabled`.

Tool discovery and names:

- Tools are listed during connect. A failed list marks the server `failed`, not silently empty.
- Names: `namespace(server) + "_" + tool`, where each non-`[a-zA-Z0-9_-]` character becomes `_` (`tool/mcp.ts`). No length cap and no collision check. Verified by reading, not run.
- The raw tool name and the server name are kept on the tool object for routing (`callTool({ server, name })`).
- Tool list changes: SDK `listChanged` handlers with `autoRefresh: false`. Changes are debounced 100 ms before the tool registry reloads.

Errors to the model:

- `isError: true`: opencode joins the text parts and throws a `ToolFailure` with that text, or "MCP tool returned an error".
- Non-error results: text joined by newline. If the server has no `outputSchema` and the text starts with `{` or `[`, it is parsed as JSON.

Other:

- Per-server config flags: `disabled`, `codemode`, `protocol` (`legacy`, `auto`, `2026-07-28`).
- Stdio runs through an `Environment` service. The local driver merges host `process.env` (as the SDK did). Workspace locations use the sandbox environment, so host variables do not cross into them (`stdio.ts`).
- Server `instructions` from `initialize` are injected into the system prompt.

## 10. Tool name constraints

- Provider limit (from your brief, not re-verified against provider docs here): OpenAI and Anthropic tool names must match `^[a-zA-Z0-9_-]{1,64}$`.
- `@ai-sdk/mcp` does no sanitizing or length checks. Verified: keys are raw MCP names. A name with `.` or `/`, or longer than 64 characters, will likely fail at the provider. Unverified (no provider call made).
- Opencode sanitizes to `[a-zA-Z0-9_-]` and does not check length (section 9). Long server or tool names could exceed 64 characters. Unverified whether this fails in practice.

Recommended: build the model-facing name yourself and keep a map back to `{ server, tool }`:

```ts
const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
const modelName = (server: string, tool: string) => {
  const hash = createHash('sha256').update(`${server}\0${tool}`).digest('hex').slice(0, 8);
  return `${sanitize(server).slice(0, 20)}_${sanitize(tool).slice(0, 30)}_${hash}`.slice(0, 64);
};
```

Keep the map from `modelName` to `{ server, tool }` so routing is exact.

## 11. Reliability checklist

Rules for a per-user connection manager:

1. Lazy connect (A1): create the client on first use for a (user, server) pair. Do not connect all servers at login. Opencode connects at startup per server and marks failures, so pick lazy for per-user scale.
2. Startup timeout (A2): set `initializationOptions: { timeout: 30_000 }`. The library has no default.
3. Per-call timeout (A3): pass `signal` or `timeout` on every `callTool` and on `execute` (via `AbortSignal.timeout`). Opencode uses 12 h for execution. Pick a bound that fits your UX and document it.
4. Cache tool lists (A4): store `tools()` output per (user, server) with a TTL. Rebuild with `toolsFromDefinitions` from a stored `listTools` result if you want to avoid re-listing. Invalidate on failed calls and on the refresh timer (F2).
5. Refresh timer (A5): re-list tools every N minutes because `list_changed` is not delivered (F2). Opencode uses the SDK's notifications instead.
6. Retries (A6): keep `maxRetries: 0` for tool calls that are not idempotent. Use your own backoff for connect: 250 ms, 1 s, then give up, matching opencode. Retry only on transient errors: `TypeError` (fetch), `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, HTTP 408, 429, and 5xx except 501.
7. Reconnect (A7): on connection-closed errors, drop the client, reconnect once, and re-run the call only if the tool is idempotent. Opencode reconnects once on session expiry only.
8. Close idle clients (A8): track `lastUsed` per client. Close after an idle timeout (for example 10 min). Always call `client.close()` in `finally` for one-shot calls. Stdio children leak if you skip this.
9. Namespacing (A9): use `sanitize(server)_sanitize(tool)` plus a short hash, capped at 64 characters, with a reverse map (section 10). Do not rely on the raw names.
10. Per-tool enable flags (A10): filter `tools()` output by per-user and per-server allowlist before passing to the model. Filter with `schemas` or by deleting keys. Opencode gates each call through a permission check named `<server>_<tool>`.
11. Health status (A11): keep `pending | connected | failed | needs_auth | disabled` per (user, server), with the last error message. Opencode reports the same states to the UI.
12. Auth (A12): for remote OAuth servers, return `needs_auth` when the redirect path throws `UnauthorizedError`, not `failed`. Save the callback state and code verifier in per-user storage.
13. Isolation (A13): one provider and one client per user and server. Never share tokens or stdio processes across users. For stdio, set `env` explicitly (section 2).
14. Error handling (A14): treat `result.isError === true` as a tool error for the model, not a transport failure. Treat `MCPClientError` with `code` as a protocol error. Treat `TypeError` and `ENOENT` as connect failures.
15. Uncaught errors (A15): always pass `onUncaughtError`. Log "Unsupported message type" as a notification. Without it, transport errors are dropped silently.

Risks:

- R1: No per-call default timeout. A stuck server blocks the agent step indefinitely. Mitigation: rule 3.
- R2: `list_changed` silently ignored. Stale tool lists after server updates. Mitigation: rule 5.
- R3: Tool name collisions across servers overwrite each other in `tools()`. Mitigation: rule 9.
- R4: Stdio child processes survive if `close()` is skipped. Mitigation: rule 8.
- R5: Shared client across users leaks tokens and session state. Mitigation: rule 13.

Questions for the team:

- Q1: Which tool calls are idempotent? This decides whether reconnect re-runs a call (rule 7).
- Q2: Idle timeout and max concurrent stdio children per host?
- Q3: Do any target servers use OAuth or stdio only? This decides how much of section 7 to build first.

## 12. Unverified

- OAuth redirect and callback flow end to end (no OAuth server was run).
- Provider rejection of invalid tool names (no model call was made).
- `streamText` with `tools()` output and `onEnd` (taken from the package README, not run).
- `close()` behavior while a tool call is in flight.
- Opencode's behavior under real load or with real OAuth servers (read from source only).
- Whether `supportsMcpToolParameterHeaders` (modern protocol, `x-mcp-header`) is needed. Not investigated.
- Experimental events and webhooks (`experimental_events`). Out of scope.


## Verified in okaychat (2026-10-19)

- Python MCP servers built on `mcp>=2.3` (Scrapling 0.5) answer `server/discover`, switch the connection to `2026-07-28`, and then reject the client's `initialize` fallback with JSON-RPC code `-32022` ("initialize handshake is not accepted"). Connecting with `protocolVersionDiscovery: false` works. `src/server/mcp/manager.ts` retries with discovery off when it sees this error.
- DeepWiki (`https://mcp.deepwiki.com/mcp`, Streamable HTTP, no auth) connects, lists 3 tools, and executes `read_wiki_structure` through the manager.

## Tool approvals

Per-server policy in `config.approval` (Settings → MCP servers → edit): `destructive` (default), `always`, `never`.

- `destructive` asks when a tool declares `annotations.destructiveHint: true`, or `readOnlyHint: false` without `destructiveHint: false`. MCP's spec defaults treat an unannotated tool as possibly destructive. Following that literally would prompt for almost every tool, so unannotated tools run without asking. Pick `always` for servers you do not trust.
- The server sets AI SDK `needsApproval` on the `dynamicTool`. `streamText` stops with a `tool-approval-request`. The client shows Allow / Deny (assistant-ui `ToolFallback`), then `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses` resends, and `streamText` runs or skips the call. Denied calls persist as `output-denied`.
- The work-log group opens itself while a call waits for approval (`thread.aui.tsx`), or the prompt would be hidden.
- MCP tools are `dynamic-tool` parts in UI messages, not `tool-<name>`.

## Beyond tools (added 2026-10-23)

Built to match LibreChat and Open WebUI. `src/server/mcp/manager.test.ts` drives each feature against a fake Streamable HTTP server.

### Image results

`presentResult()` decodes `image` content parts (max 8 per result, 10 MB each), sniffs the bytes, and saves PNG/JPEG/WebP/GIF through `storeImage()` (`tools/image.ts`): same `images` table as generated images, so quota, Library, and chat deletion apply. Other formats (SVG) are dropped with a note. The tool output becomes `{ text, images }`; the card renders the saved copies. The model only sees text; vision models get the images once through `injectToolImages()` (the `view_artifact` path), capped at 8 per reply. Embedded binary resources become a size note, never base64 text.

### Resources

Every connected server whose `initialize` capabilities include `resources` adds to one shared pair: `mcp_list_resources({ server, cursor? })` (resources plus URI templates) and `mcp_read_resource({ server, uri })` (text capped at 100k chars, image blobs through the image path). One pair keeps the tool block small and stable for caching.

### Prompts

`GET /api/mcp/prompts` lists prompts from servers with the `prompts` capability; `POST /api/mcp/:id/prompts` renders one to text. The composer's Prompts button (desktop) and the plus-menu submenu (touch) appear only when at least one prompt is available. Discovery starts alongside startup data without blocking chat loading, and refreshes after MCP settings changes and when an available prompt menu opens. This connects enabled servers in the background; loading, empty, and failed discovery keep the option hidden. Superseded discovery responses are ignored. Arguments open a dialog; the result is inserted after any typed text, never sent.

### Elicitation

The client advertises `capabilities.elicitation = {}` (form mode). `@ai-sdk/mcp` does not tell which call a request belongs to, so the handler uses the newest in-flight call of that (user, server) entry. MCP tool `execute` is an async generator (`runWithElicitation`): it yields `{ elicitation }` as a preliminary output, the tool card renders the form (`McpElicitation.tsx`), the answer goes to `POST /api/mcp/elicitations/:id`, and the call resumes. The call timeout is our own `PausableTimeout` (no `options.timeout`), paused while the form is open, because the SDK cannot reset a request timeout. AI SDK v7 has no `experimental_context`, so `toolsForUser()` builds tools twice: interactive ones for the chat (`interactive: true` only from `/api/chat`) and `subTools` for sub-agents, which decline. Scheduled runs are non-interactive too.

### MCP Apps

The client advertises `mcpAppClientCapabilities`. A tool with `_meta.ui.resourceUri` (`ui://`) returns `{ text, images, app: { serverId, resourceUri }, result }` (the call result without images, capped at 256 KB because it is stored with the message). `_meta.ui.visibility: ["app"]` tools are hidden from the model and callable only from the app. The card (`McpApp.tsx`) does not use assistant-ui's `McpAppRenderer`: that one loads its frame from the hosted `*.auiusercontent.com` shim. Ours is a null-origin `srcdoc` iframe with a CSP from the resource's declared domains and a small JSON-RPC bridge (`ui/initialize`, tool input/result notifications, `tools/call`, `resources/read`, `ui/open-link`, `ui/message` into the composer, size changes, theme changes). App calls go through `POST /api/mcp/:id/app/{resource,call,read}` on the user's own connection; tools that would need approval return 409 until the user allows them in the card. `thread.aui.tsx` keeps app cards out of the work-log group and gives each a `resultKey`.

### Shared servers

An admin's server with `shared = 1` appears for every user in its audience (`listSharedServers`, joined on the owner still being admin; audiences in `groups.ts`: everyone, or chosen groups and users). Viewers get their own switch and tool toggles (`mcp_server_users`) and their own OAuth tokens (`readOAuth`/`writeOAuth` pick the table by ownership); the owner's URL, headers, env, and approval policy apply. Network rules and stdio permission follow `ownerId`; saved images and connections follow `userId`. A user's own server with the same name hides the shared one. Owner edits, unsharing, and deletion close every user's connection (`disconnectServerEverywhere`).
