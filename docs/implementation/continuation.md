# Explicit continuation and generation receipts

A reply may be continued only when the server recorded a trustworthy terminal finish reason. The UI never
infers a cutoff from text length or punctuation, and nothing continues automatically.

## Receipts

`generation_runs` is a ledger, not a restart-safe generation:

- one row per assistant message (`UNIQUE(thread_id, assistant_message_id)`, no message foreign key because
  request streaming can precede history persistence);
- `config_json` is the immutable `ResolvedRunConfig` (instructions, sampling, tool policy, knowledge ids);
- `state` is `running|waiting|finished|aborted|error|interrupted`, `finish_reason` is the normalized SDK
  reason, and `usage_json`/`cost`/`context_tokens`/`duration_ms` are the logical reply's numbers;
- `generation_segments` dedupes one provider stream invocation per server-chosen segment id, so a reconnect
  or replay never bills twice. A receipt reserves a fixed 64 KiB against the account quota, which covers
  its status, bounded usage, and at most 100 segments.

The server chooses the assistant message id with `createUIMessageStream({ generateId })`. A tool-result or
approval continuation reuses the id and receipt of the reply it continues. Receipts are written before any
provider request and before terminal metadata is emitted. Startup marks open rows `interrupted`; it never
resumes or rebills them.

`src/server/generation-runs.ts` owns `beginRun`, `recordSegmentOnce`, `endRun`, `projectGenerationMetadata`,
`generationBusy`, and `cancelWaitingRun`. Private history reads project only `{runId,state,finishReason,
continuationOf,usage,cost,contextTokens,durationMs,assistantName,assistantIcon}`; the receipt config never
reaches the browser. `appendMessage` strips any client-supplied generation object, so a fabricated
`finished`/`length` cannot enable Continue.

## Terminal semantics

`stop`, `length`, `content-filter`, and `other`/`unknown` are terminal; `tool-calls` means the logical reply
is waiting for a client tool or approval; abort and error win over an earlier step. A reply with unresolved
tool input/approval/result parts is never continuable. `waiting` keeps the chat's logical busy lock through
`thread-runs.ts`, even with no HTTP stream, until a tool result arrives or the user cancels.

`POST /api/threads/:id/generations/:runId/cancel` marks a waiting/running receipt aborted and aborts its
controller when one is attached. A terminal receipt cannot be changed by a late cancel.

## The explicit request

Only a finished, `length`, unedited, nonempty latest assistant leaf with no unresolved tools and an
acknowledged stored message shows **Continue**. `message.continue` targets the focused reply and
`chat.continue` targets the only rendered eligible control; neither has a default shortcut.

Clicking appends a normal visible user message with exactly `CONTINUE_TEXT` from `shared/generation.ts`,
parented on the displayed leaf, and carries `metadata.custom.continuation.targetMessageId`. No assistant
prefill, no hidden prompt, no rewriting of the original answer. A nonempty composer draft or attachments
opens a keep-draft confirmation and stays in the composer.

The server (`src/server/continuation.ts`) rechecks ownership, the stored target's role/text/edit state, its
receipt (`finished` + `length`), unresolved tools, the visible message id/text/parent, and that no competing
persisted child exists. The unique partial index on `(thread_id,user_message_id)` where the receipt config
is a continue request turns a double-click into one receipt. A continuation is a new run with new budgets
and its own answer; earlier completed tool calls are history, never executed again. Research bootstrap is
off for the continuation turn; ordinary tools remain available under the current preset.

Compaction protects the target: only ancestors before it may be summarized, and trim is skipped for the
turn. If the target plus the request still does not fit, the turn fails with guidance instead of truncating
it.

## Deliberate limits

- Temporary chats do not receive a receipt, so the Continue control is not offered; saving a temporary chat
  does not fabricate eligibility.
- Provider usage reported only on a terminal event and not through steps may be absent from a receipt;
  partial tokens are never invented.
- Realtime voice calls keep their separate path and do not use presets or continuation.
