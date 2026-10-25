# Cross-chat memory and transfer

## Architecture

Memory is opt-in, per-account, and encrypted in SQLite. Account and current-project facts can enter a turn; other users and unrelated projects cannot. Preferences, ownership, scope, and revision checks apply both when offering tools and when executing them.

`src/server/chat.ts` integrates memory through `turnStream()` for interactive chats and schedules. Retrieved facts are stored with each turn and replayed through `turn-context.ts`; summaries are pinned in the chat's context. Chat recall uses the separate messages FTS index. The client's history adapter persists interactive messages, so `/api/chat` cannot assume it has stored the latest user message.

Text/Markdown and versioned okaychat JSON transfers use an editable preview before committing selected facts. They do not connect to a provider account. JSON preserves project scope for the same account; unavailable scopes receive a warning in the import preview.

## API and limits

When Use memory is off, the automatic-saving row is muted and explains how to enable it. Its disabled switch preserves the saved preference. Base UI switches expose `data-disabled` on their root; shared disabled styling uses that attribute so unavailable switches are dimmed and desaturated even when their saved value is on.

`src/server/memory.ts` owns `/api/memory`, entry CRUD, preferences, summaries (`POST /summaries/refresh`), preview/import, JSON/text exports, retrieval, and the chat tools. `src/server/memory-learn.ts` owns background review and summary writing. The table encrypts content and keeps a content hash for duplicate detection.

Threat model for memory encryption (`crypto.ts`, AES-256-GCM, one server-wide key derived from `OKAYCHAT_SECRET`):

- Covers: a copy of `okaychat.db` without the secret (stolen backup, copied volume, leaked table dump). Memory text and provider/MCP secrets are unreadable there.
- Does not cover: anyone who can run code in the app process or read its environment. The key is in memory and in the environment, and the server must decrypt memory to build prompts.
- Does not cover: other users of the same server. All users share the key; access control is in the routes.
- Does not cover: guessing. `content_hash` is an unkeyed SHA-256 of normalized text, so a known or short phrase can be confirmed against the database.
- Operational: store `OKAYCHAT_SECRET` apart from `okaychat.db` backups. Losing or changing it makes all encrypted data unreadable. Memory starts disabled with automatic saving selected; enabling it allows memory tools and a bounded prompt section across providers. With automatic saving disabled, memory write tools require the existing in-chat approval flow. With it enabled, `memory_save`/`memory_forget` still ask for approval once the conversation holds outside content (any tool result other than the memory tools, or an attached file), because injected text could otherwise plant a memory that steers every later chat (`readOutsideContent`). The background review only reads user and assistant text, never tool output or attachment bodies. `ChatPrivacyMenu` in the top-right header persists a normal-chat memory exclusion in `threads.memory_disabled`; that chat remains in history. The composer has no memory control.

The account holds up to 500 entries and 200,000 content characters, with at most 2,000 characters per entry. Import text is limited to 200,000 characters. Text parsing splits bullets/paragraphs without an extra model call; preview is editable through source text and selectable entry checkboxes before commit. Unknown project scopes in imported backups become global with a preview warning. JSON export uses `{ format: "okaychat-memory", version: 1, entries }`; text export uses a Markdown-style list. Settings preference changes dispatch `okaychat:memory` to refresh the header control.

Memory tools re-check the account's enablement, preference revision, thread ownership, current project scope, and per-chat exclusion when they execute, so pausing/resetting or editing/deleting facts revokes stale writes already offered to an in-flight model. Existing context already sent to a provider cannot be withdrawn.

## Summaries, background review, retrieval, and chat recall


- Summary per scope (`memory_summaries`, encrypted): account memory, and one per project. `memory-learn.ts` rewrites a scope's summary with the `memorySummary` prompt once its facts settle for 60 s (fingerprint of fact ids and update times). Settings shows each summary with a Rewrite button. The shared system message carries the `memory` policy. The account summary and the current project's summary go in the second, per-chat system message, after the tool definitions, so a summary change never invalidates the tool block. The pinned snapshot refreshes after 24 h without a turn.
- Prompt-cache stability: the summary text is pinned per thread (`threads.memory_snapshot_enc`). A running chat keeps its pinned text until the revision or project changes, or the chat has had no turn for 24 hours. Each turn refreshes the snapshot timestamp; a background rewrite does not replace an active chat's pinned summary.
- Withdrawal: a summary is used only while its revision equals the account's. Manual edits, deletions, `memory_forget`, resets, and preference changes bump the revision; user-requested edits and deletions also drop the scope's summary text. Nothing derived from a removed fact is sent again, and a scope without a usable summary falls back to its 30 most recent facts in the per-turn context. Facts the model adds do not bump the revision; retrieval covers them until the next rewrite.
- Background review: with Use memory and automatic saving on, a chat idle for 10 minutes (and active within the last 14 days) is reviewed from its cursor (`threads.memory_cursor`) with the `memoryExtract` prompt. The model sees the new messages and up to 60 related saved facts with ids and dates, and answers with add/update/delete JSON. Adds go to the chat's scope; updates and deletes may target any fact the chat can see. Operations on unknown ids are ignored. The writes re-check preferences, revision, exclusion, and project before applying. A failed review is not retried. Forks start their cursor at the fork point. At most three reviews and three summaries run per minute, server-wide.
- Model and cost: background jobs use the utility model, then the chat's model, then the default model, and record usage as kind `memory`. Without automatic saving no review runs.
- Retrieval: BM25 over the decrypted library (at most 500 entries, so no index and no plaintext FTS table), light English stemming, stop words, and a small recency boost. Each turn sends up to 10 matching facts (6,000 characters) with their dates beside the latest user message. `memory_search` returns up to 20 matches, or the most recent facts when nothing matches a paraphrase. No embeddings: providers differ in embedding support, and the summary carries the general picture.
- Chat recall (Search past chats, on by default with memory): `conversation_search` runs an OR query over the messages FTS index, best excerpts per chat, or lists recent chats for an empty query; `conversation_read` returns a chat's current branch in 16,000-character parts. A project chat sees its project's chats only; other chats see chats outside projects. The current chat, temporary chats, and memory-disabled chats are never returned.

Known limits: background review only covers the last 14 days when memory is first enabled; keyword retrieval misses pure paraphrases; a background delete (the user contradicted a fact in a chat without asking to forget it) does not bump the revision, so the old summary may mention the fact until its rewrite a few minutes later.

## Acceptance checks

Verify ownership for reads, CRUD, import, export, project scopes, and model tools; memory disabled suppresses injection and assistant writes; automatic saving disabled still allows explicit user requests if documented; imports require a preview/selection step and do not mutate during preview; duplicate imports are idempotent; malformed/oversized input fails clearly; JSON exports round-trip; deleting/resetting memories changes subsequent context; changing model/provider retains the same user's memories; and scheduled prompts obey the same preferences. Use the browser for an end-to-end persistence check across reloads and a fresh conversation.

## Temporary chats

The server prompt key is `temporary`; a database migration moves existing overrides from the former key without changing their text.

The top-right ghost starts and ends a temporary chat. Its `tmp_` id is generated in browser memory; the history adapter never creates a stored thread or writes messages, and the sidebar excludes it. `/api/chat` recognizes the reserved prefix and bypasses thread/usage persistence, automatic compaction, stored artifacts/images, delegated tasks, MCP, and browser tools. The stream is tied to the request with no resumable copy; the client stores neither selection nor stream checkpoint. Reload drops an unsaved conversation. `ensureThread` rejects reserved ids so stale history writers cannot accidentally persist one. Once it has content, the ghost offers Save to history, copying the current branch and materializing its attachments without backfilling usage.

Personalization starts off: no saved memory, custom user instructions, project instructions, or project files enter the model context. A separate header switch can enable read-only global memory and custom user instructions for this temporary conversation. `temporaryMemory` offers search only, rechecking account preferences/revision on execution; save/update/forget are never available. This is an authenticated app mode, not a claim about retention by an upstream model provider.

Document attachments use a per-thread adapter and `/files/extract?temporary=1`, so extraction does not retain original upload bytes or return an importable file id. Web search and page reading remain available. File-generating tools and stored compaction are not offered in temporary mode. Tests cover default context exclusion, optional read-only personalization, rejected persistence, absent replay headers, unchanged table counts, and actual document extraction.
