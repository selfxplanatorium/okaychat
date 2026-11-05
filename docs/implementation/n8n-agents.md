# n8n webhook agents

An agent is a text-only chat target (`n8n/agt_…`), separate from the LLM catalog. The chat endpoint dispatches it before building prompts, tools, memory, knowledge, research or compaction. Titles use the first user line. Utility, embedding and delegate paths remain LLM-only. No runtime dependencies were added.

## Configuration and ownership

Private definitions belong to an account. Admins manage shared definitions; conversational use still requires the configured user/group audience, including for admins. Shared recipients receive safe descriptors, never endpoint/configuration/authentication details. Configuration, including the entire webhook URL, is encrypted with the existing account-data key. Authentication is a single write-only custom header; omission preserves it only for an identical URL, null removes it, and a supplied value replaces it. Changing the URL requires re-entering or removing the credential.

Management uses `/api/agents/n8n` and `/api/admin/agents/n8n`, revision CAS on updates/deletion, strict bounded JSON bodies and `Cache-Control: no-store`. Saving, listing and status requests never execute a webhook. The explicit test action sends a fresh session and empty history, reads the complete bounded response and returns a plain-text preview. Tests have a 30-second deadline, one concurrent test per account and a five-second cooldown. They may execute workflow actions. No test transcript is stored.

## Sending and memory

Every request, including admin requests, uses `publicFetch` with checked and pinned public DNS, HTTPS only and manual redirects. Redirects are rejected without forwarding credentials or sending another request. Header names cannot override routing, framing, cookies or application identity. No automatic retries occur, including before first output. Stop closes the local request; remote workflow execution may continue.

Webhook defaults: `message`, `history`, `sessionId`, history mode. Chat Trigger defaults: `chatInput`, `history`, `sessionId`, remote mode, with `action: sendMessage`. The workflow must explicitly read the history extension. There is no `loadPreviousSession` request and no n8n management API integration.

History is a JSON array of user/assistant text, at most 100 preceding messages and 256 KiB; complete oldest messages are removed. Latest text is separate (200,000-byte cap), total POST is at most 512 KiB. System prompts, hidden reasoning, tools, files, project context, memories and skills are excluded. Current attachments and tool continuations are rejected before sending.

Remote session identifiers are random and encrypted, scoped to account/thread/agent/revision. A full text-projection digest, including message IDs, prevents reusing remote memory after edits, retries or branches. New sessions do not backfill remote history. Failure/cancellation invalidates the local session. Reset forgets the local session only. Temporary chats force no-history mode and persist no session, request counter or status evidence; a remote workflow can still retain their messages.

## Responses and provenance

The parser supports NDJSON, SSE, JSON and text. Auto detection recognizes n8n begin/item/end frames even when the MIME type says JSON. Node-run ends do not terminate the HTTP response. Repeated completed runs receive separate local text segments; errors after partial text remain errors. JSON extraction uses explicit answer-key precedence and optional RFC 6901 own-property pointers. Buttons, tools, approval/resume flows, binary output and arbitrary objects are never executed or stringified as answers.

Limits: 8 MiB decoded HTTP bytes, 1 MiB answer text, 256 KiB line/event, 100,000 events, 16 normalization levels, 1,000 array elements. UTF-8 decoding is fatal; readers are released/cancelled on termination. Plain text without a newline can wait until the sniff cap or EOF in auto mode; choose text mode to stream it immediately.

Persisted display text is unchanged. Start metadata marks every response as outside-agent content, including partial replies. When later sent to an LLM, these assistant text parts receive `n8n_agent` provenance envelopes, even if the advisory injection scanner finds nothing. The existing approval gate treats the envelope as taint. Mixed histories in compaction, research and memory reviews receive the same projection. Remote Markdown image consent remains in effect. Public shares already explicitly select text/parts and omit message metadata, so private provenance identifiers, sessions and configuration do not appear there.

No synthetic tokens, costs or context-window measurements are recorded. Separate run rows contain outcome, duration and byte counts only; they survive agent deletion and expire after 90 days on subsequent recording. Definitions and encrypted sessions count against storage quota. Status is per-viewer, per-revision last-response evidence (15-minute TTL, maximum 1,000 entries), never an active health probe.

## Testing and operation

Run `npm run typecheck`, `npm test`, and `npm run build`. Parser, route and store suites are deterministic and offline. Live verification is opt-in:

```sh
OKAYCHAT_N8N_LIVE=1 OKAYCHAT_N8N_LIVE_URL=https://your-public-workflow.example/webhook/chat node --test --import tsx src/server/n8n/live.test.ts
```

Use only an explicitly approved conversational workflow. Optional `OKAYCHAT_N8N_LIVE_HEADER_NAME` and `OKAYCHAT_N8N_LIVE_HEADER_VALUE` supply a header without printing it. Missing configuration skips. Network failures and proxy 502/503/504 skip safely; authentication failures skip only with `OKAYCHAT_N8N_LIVE_ALLOW_OFFLINE=1`. A successful HTTP response with malformed/wrong content fails.

The verified deployment's temporary public access ends 2026-11-06 at 09:00 Europe/Berlin (08:00 UTC). Network denial after that does not prove a credential failure. Do not change routing, publish workflows or introduce a relay to make the test pass.

Protocol references: [Chat Trigger](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-langchain.chattrigger/), [Webhook](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/), [Respond to Webhook](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.respondtowebhook/). Reference source snapshot: n8n `a79aac7f9791ae9dc9d1c53a11c878521982e727`, `packages/frontend/@n8n/chat/src/{types,api,utils}`. The snapshot does not identify the deployed version.
