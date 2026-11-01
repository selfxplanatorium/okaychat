# MCP connections and tool behavior

`src/server/mcp/manager.ts` owns one lazy client per user/server pair. Supported transports are Streamable HTTP, SSE, and administrator-only stdio. OAuth state and encrypted credentials are per user; viewers of shared servers retain their own switches and credentials.

## Connection lifecycle

The manager bounds startup to 20 seconds, listing to 15 seconds, and tool calls to 120 seconds by default. Tool definitions have a five-minute TTL; unused clients close after ten minutes. The manager supplies reconnects and list refreshes rather than relying on library notifications. Tool names are sanitized and hashed to avoid collisions and provider name limits.

Some Python MCP servers reject the fallback initialize handshake after protocol discovery with code `-32022`. The manager retries with `protocolVersionDiscovery: false`; the browser worker's Scrapling client starts with discovery disabled.

## Tool approvals

Per-server policy in `config.approval` (Settings → MCP servers → edit): `destructive` (default), `always`, `never`.

- `destructive` asks when a tool declares `annotations.destructiveHint: true`, or `readOnlyHint: false` without `destructiveHint: false`. MCP's spec defaults treat an unannotated tool as possibly destructive. Following that literally would prompt for almost every tool, so unannotated tools run without asking. Pick `always` for servers you do not trust.
- The server sets AI SDK `needsApproval` on the `dynamicTool`. `streamText` stops with a `tool-approval-request`. The client shows Allow / Deny (assistant-ui `ToolFallback`), then `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses` resends, and `streamText` runs or skips the call. Denied calls persist as `output-denied`.
- The work-log group opens itself while a call waits for approval (`thread.aui.tsx`), or the prompt would be hidden.
- MCP tools are `dynamic-tool` parts in UI messages, not `tool-<name>`.
- After untrusted content entered the turn — including server instructions, a tool description, project files, or a memory summary — a destructive or non-read-only tool is gated by the chat's `toolApproval` even when the server policy is `never`. The existing card names the risk. Sub-agents never receive destructive or non-read-only tools; scheduled runs auto-deny instead of waiting. See `prompt-injection.md`.
- Text results go to the model inside a provenance envelope in `toModelOutput`; the card keeps `{ text, images }`. Descriptions are enveloped with their server and carry the static `okaychatExternalMetadata` marker, so a description alone taints the turn. Input-schema property descriptions stay raw (see `prompt-injection.md`).

A server that cannot connect is named on the reply: `AssistantMetadata.unavailable` carries one entry per failed
server (`service: "mcp"`, `name`, `mcpError` or `mcpNeedsAuth`, fix link to Settings → MCP servers). The server's own
error text never leaves the server. The note is stored with the turn and replayed, but it does not pin the MCP tool
block: `toolsForUser()` runs again on every request (including a continuation), so a server that reconnects can add
its tools, and one that fails can drop them. That is the existing MCP lifecycle; only the sidecar `browser`/`sandbox`
tools are held stable across a continuation. See `docs/implementation/service-health.md`.

## Resources, prompts, and app rendering

`src/server/mcp/manager.test.ts` drives each feature against a fake Streamable HTTP server.

### Image results

`presentResult()` decodes `image` content parts (max 8 per result, 10 MB each), sniffs the bytes, and saves PNG/JPEG/WebP/GIF/AVIF that fully decode through `storeImage()` (`tools/image.ts`): same `images` table as generated images, so quota, Library, and chat deletion apply. Other formats (SVG) are dropped with a note. The tool output becomes `{ text, images }`; the card renders the saved copies. The model only sees text; vision models get the images once through `injectToolImages()` (the `view_artifact` path), capped at 8 per reply. Embedded binary resources become a size note, never base64 text.

### Resources

Every connected server whose `initialize` capabilities include `resources` adds to one shared pair: `mcp_list_resources({ server, cursor? })` (resources plus URI templates) and `mcp_read_resource({ server, uri })` (text capped at 100k chars, image blobs through the image path). One pair keeps the tool block small and stable for caching.

### Prompts

`GET /api/mcp/prompts` lists prompts from servers with the `prompts` capability; `POST /api/mcp/:id/prompts` renders one to text. The composer's Prompts button (desktop) and the plus-menu submenu (touch) appear only when at least one prompt is available. Discovery starts alongside startup data without blocking chat loading, and refreshes after MCP settings changes and when an available prompt menu opens. This connects enabled servers in the background; loading, empty, and failed discovery keep the option hidden. Superseded discovery responses are ignored. Arguments open a dialog; the result is inserted after any typed text, never sent. The rendered text is wrapped by `getPromptText()` in the `kind="mcp_prompt"` data envelope, visible and editable in the composer; sending it keeps it data and taints the turn.

### Elicitation

The client advertises `capabilities.elicitation = {}` (form mode). `@ai-sdk/mcp` does not tell which call a request belongs to, so the handler uses the newest in-flight call of that (user, server) entry. MCP tool `execute` is an async generator (`runWithElicitation`): it yields `{ elicitation }` as a preliminary output, the tool card renders the form (`McpElicitation.tsx`), the answer goes to `POST /api/mcp/elicitations/:id`, and the call resumes. The call timeout is our own `PausableTimeout` (no `options.timeout`), paused while the form is open, because the SDK cannot reset a request timeout. AI SDK v7 has no `experimental_context`, so `toolsForUser()` builds tools twice: interactive ones for the chat (`interactive: true` only from `/api/chat`) and `subTools` for sub-agents, which decline. Scheduled runs are non-interactive too.

### MCP Apps

The client advertises `mcpAppClientCapabilities`. A tool with `_meta.ui.resourceUri` (`ui://`) returns `{ text, images, app: { serverId, resourceUri }, result }` (the call result without images, capped at 256 KB because it is stored with the message). `_meta.ui.visibility: ["app"]` tools are hidden from the model and callable only from the app. The card (`McpApp.tsx`) does not use assistant-ui's `McpAppRenderer`: that one loads its frame from the hosted `*.auiusercontent.com` shim. Ours is a null-origin `srcdoc` iframe with a CSP from the resource's declared domains and a small JSON-RPC bridge (`ui/initialize`, tool input/result notifications, `tools/call`, `resources/read`, `ui/open-link`, `ui/message` into the composer, size changes, theme changes). App calls go through `POST /api/mcp/:id/app/{resource,call,read}` on the user's own connection. The iframe can call `tools/call` on load, so it is not treated as a user click: a destructive or non-read-only tool is refused with the existing 409 confirmation even under `approval: never`, and only the user's Allow retries with `confirmed: true`. Read-only tools still run. `thread.aui.tsx` keeps app cards out of the work-log group and gives each a `resultKey`.

### Shared servers

An admin's server with `shared = 1` appears for every user in its audience (`listSharedServers`, joined on the owner still being admin; audiences in `groups.ts`: everyone, or chosen groups and users). Viewers get their own switch and tool toggles (`mcp_server_users`) and their own OAuth tokens (`readOAuth`/`writeOAuth` pick the table by ownership); the owner's URL, headers, env, and approval policy apply. Network rules and stdio permission follow `ownerId`; saved images and connections follow `userId`. A user's own server with the same name hides the shared one. Owner edits, unsharing, and deletion close every user's connection (`disconnectServerEverywhere`).
