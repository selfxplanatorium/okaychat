# Cross-chat memory and provider transfer

Researched against official OpenAI and Anthropic documentation on 2026-10-20. Product behavior changes; the source links below are the authority. The architecture recommendations are okaychat decisions, not claims about either provider's internals.

## Current provider behavior

### Claude

Claude's current memory experience saves individual topics during conversations, including explicit requests to remember something. Its old 24-hour summary implementation is now a legacy experience. Users can inspect, edit, and delete topics, or ask for changes in chat. Account controls distinguish pausing memory from permanently resetting it. Pausing stops both use and creation without deleting existing entries. Per-chat memory can also be disabled before the first message. Project memory is scoped: a project can combine its own memory with account memory, while other projects stay separate. Deleting a source chat does not automatically remove its saved memories. Claude excludes sensitive topics by default and offers separate opt-in controls; some identifiers are never saved. Chat-history search is a separate retrieval feature with links to source conversations. [Claude memory and search](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context).

Incognito conversations neither consume existing memory nor contribute new entries, and do not appear in chat history. Incognito is different from a regular conversation with memory disabled: the latter remains in history. Incognito does not promise immediate server deletion; Anthropic documents retention and organization-policy exceptions. [Claude incognito chats](https://support.claude.com/en/articles/12260368-use-incognito-chats).

### ChatGPT and local Codex memory

OpenAI describes memory as persistent recall of preferences, workflows, and project conventions; required instructions remain a separate concern. Personalization controls manage this context. [Personalize ChatGPT](https://learn.chatgpt.com/docs/personalize).

ChatGPT web/account memory and local Codex memory are different stores. ChatGPT account memory is managed in personalization settings. Local Codex supports separate controls for using existing memories and generating future memories, including per-chat choices; generation is asynchronous and filters eligible sessions. These local files must not be mistaken for an export of a user's ChatGPT web account. [OpenAI memory documentation](https://learn.chatgpt.com/docs/customization/memories).

Saved memories follow deletion controls separate from conversations. Removing a chat does not necessarily remove an existing saved memory. [OpenAI cloud security and retention](https://learn.chatgpt.com/docs/enterprise/chatgpt-work-cloud-security).

## Moving memories between services

Claude officially supports a text-based migration flow: ask the previous assistant to describe its stored context, paste the result into Claude's memory import screen, then inspect the resulting entries. Markdown files can be used to keep a copy. Imports are experimental and may omit context, particularly information outside Claude's work focus. Export is available through the memory settings or by asking Claude to reproduce its memory. Current and legacy accounts have different settings paths, so instructions should link to the official guide rather than hard-code only one screen. No portable archive schema or public memory synchronization endpoint is established by this guide. [Claude memory import/export](https://support.claude.com/en/articles/12123587-import-and-export-your-memory-from-claude).

OpenAI's documented desktop/CLI agent-import feature imports supported local agent setup, projects, and recent chats, including Claude Code project memories. It is not a general public API for synchronizing ChatGPT web-account memories with an arbitrary app. [OpenAI agent import](https://learn.chatgpt.com/docs/import).

okaychat should provide a user-mediated transfer workflow for both services: export/copy the memories the source service makes available, paste or upload that text, review the proposed entries, then save only the selected items. An assistant-generated dump cannot prove that every stored fact was included. Do not promise direct account sync, full conversation-archive import, or a provider's undocumented JSON format.

Suggested okaychat transfer prompt (our wording; not a provider guarantee):

```text
I am moving my context to another assistant. Export the memories and preferences you can access about me as a plain Markdown list, with one fact per item. Include my response preferences, recurring projects, tools, and durable personal context. Preserve dates when known. Exclude passwords, tokens, financial identifiers, and other secrets. Distinguish confirmed facts from uncertainty, and say if the export may be incomplete.
```

For moving okaychat memories into Claude, export text and use Claude's documented import flow. For ChatGPT, copy the selected facts into a normal conversation and explicitly ask it to remember them; availability, retention, and completeness depend on that account's memory settings. This is a user-controlled transfer suggestion, not a verified automated importer or synchronization protocol.

## okaychat architecture

The implementation should use the existing Node/SQLite stack, without a vector database or new service:

- A dedicated per-user memory table stores durable entries, source, optional project scope, and creation/update timestamps. Store content encrypted with the existing `crypto.ts` AES-GCM helpers. Every query and mutation must enforce the authenticated user, including model tools. Project ids must also belong to that user.
- Keep memory preferences separate from generic settings writes. Default memory use off; expose explicit account enablement and a separate automatic-saving control. Pausing use must disable prompt injection and assistant writes; manual management and exports can still work. A memory-disabled chat must suppress both use and generation if offered. Do not call that switch incognito unless the chat is also excluded from persistent history.
- Include a bounded, deterministic memory section in the turn context. Global facts and the current project's facts are eligible; other users and other projects are never eligible. Keep memory policy in the stable system prefix and put query-dependent facts in an ephemeral user-context message immediately before the latest user request, so a changed retrieval subset does not invalidate the conversation prefix. Treat memory as quoted context, not executable instructions or a way to override current user requests.
- Offer model tools to find, remember/update, and forget entries, so explicit requests work during normal conversations. Memory is opt-in; enabling it also enables automatic saving by default, unless the user turns off the separate automatic-saving control. It should preserve durable user-provided preferences and confirmed facts, avoiding guesses, transient tasks, secrets, and instructions from web pages or tool output. The system must explain that model-controlled automatic saving is selective, not an exhaustive log of every fact mentioned.
- Visible settings provide manual add/edit/delete, search, clear-all, source labels, and scope labels. Deleting a project retains its facts in the settings library for editing/deletion/export, without promoting them into global chat context; active tools from that project are revoked. Deletion removes the active database content; like deleting any SQLite data, it does not erase backups or copies in earlier conversations. Avoid promising that saved memory deletion rewrites prior messages.
- Import accepts text/Markdown and a versioned okaychat JSON export. Preview parsing happens before persistence, with warnings, selectable entries, limits, and duplicate detection. Validate every entry, enforce payload/content limits and project ownership, and commit the selection in one transaction. Do not silently treat a full chat archive as a list of memories.
- JSON export preserves entries and scope for an okaychat round trip; text export stays readable and copyable for another assistant. The UI should link to provider instructions and disclose that imported memories are sent to the selected model whenever memory is used in future chats.

`src/server/chat.ts` is the shared integration point for interactive chats and scheduled prompts (`turnStream`). Compose memory there, so supported providers behave consistently. `src/server/projects.ts` already provides a project-owned prompt section. `src/server/search.ts` and the existing FTS5 index can support a future chat-history recall tool; chat search and saved facts remain separate concepts. The client history adapter persists interactive conversations, so the server must not assume `/api/chat` has already stored the new user message.

### Implemented API and limits

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

## Memory v2: summary, background review, retrieval, chat recall

Researched 2026-10-21. Sources: [Claude memory and chat search](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context), [OpenAI memory controls](https://openai.com/index/memory-and-new-controls-for-chatgpt/), [Mem0 state of agent memory 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026), [Mastra observational memory](https://mastra.ai/docs/memory/observational-memory), Letta memory blocks and sleep-time compute. Benchmark numbers in these sources are vendor-reported.

What the field converges on:

- Two layers. An always-in-context synthesized profile (Claude's legacy "synthesis", ChatGPT's chat-history insights, Letta core memory blocks) plus a store of atomic facts retrieved per request. Claude's current experience saves individual topics during chats; the legacy one rewrote a summary every 24 hours.
- Memory work off the reply's critical path. Letta's sleep-time agent, Mastra's observer/reflector, and ChatGPT's asynchronous generation consolidate memory in the background.
- Reconciliation, not append. Mem0's extraction compares new facts with related saved ones and chooses add, update, or delete, so a changed fact replaces the old one instead of contradicting it. Staleness of high-relevance facts remains the hardest open problem; timestamps on facts are the common mitigation.
- Hybrid retrieval (semantic + BM25 + entity) with scoping filters before ranking. Keyword BM25 alone is the weakest of the three on paraphrases.
- Chat recall as a separate tool: Claude's chat search is RAG over past chats, scoped to non-project chats or one project, and appears as tool calls with links to the source chats.

okaychat implementation:

- Summary per scope (`memory_summaries`, encrypted): account memory, and one per project. `memory-learn.ts` rewrites a scope's summary with the `memorySummary` prompt once its facts settle for 60 s (fingerprint of fact ids and update times). Settings shows each summary with a Rewrite button. The system prompt carries the `memory` policy, then the account summary, then the current project's summary.
- Prompt-cache stability: the summary text is pinned per thread (`threads.memory_snapshot_enc`). A running chat keeps its pinned text until the revision or project changes, or the chat has been idle for an hour (provider caches are cold by then). A new summary therefore costs one prefix cache miss per chat at most.
- Withdrawal: a summary is used only while its revision equals the account's. Manual edits, deletions, `memory_forget`, resets, and preference changes bump the revision; user-requested edits and deletions also drop the scope's summary text. Nothing derived from a removed fact is sent again, and a scope without a usable summary falls back to its 30 most recent facts in the per-turn context. Facts the model adds do not bump the revision; retrieval covers them until the next rewrite.
- Background review: with Use memory and automatic saving on, a chat idle for 10 minutes (and active within the last 14 days) is reviewed from its cursor (`threads.memory_cursor`) with the `memoryExtract` prompt. The model sees the new messages and up to 60 related saved facts with ids and dates, and answers with add/update/delete JSON. Adds go to the chat's scope; updates and deletes may target any fact the chat can see. Operations on unknown ids are ignored. The writes re-check preferences, revision, exclusion, and project before applying. A failed review is not retried. Forks start their cursor at the fork point. At most three reviews and three summaries run per minute, server-wide.
- Model and cost: background jobs use the utility model, then the chat's model, then the default model, and record usage as kind `memory`. Without automatic saving no review runs.
- Retrieval: BM25 over the decrypted library (at most 500 entries, so no index and no plaintext FTS table), light English stemming, stop words, and a small recency boost. Each turn sends up to 10 matching facts (6,000 characters) with their dates beside the latest user message. `memory_search` returns up to 20 matches, or the most recent facts when nothing matches a paraphrase. No embeddings: providers differ in embedding support, and the summary carries the general picture.
- Chat recall (Search past chats, on by default with memory): `conversation_search` runs an OR query over the messages FTS index, best excerpts per chat, or lists recent chats for an empty query; `conversation_read` returns a chat's current branch in 16,000-character parts. A project chat sees its project's chats only; other chats see chats outside projects. The current chat, temporary chats, and memory-disabled chats are never returned. This last rule is stricter than Claude, whose memory-disabled chats remain searchable.

Known limits: background review only covers the last 14 days when memory is first enabled; keyword retrieval misses pure paraphrases; a background delete (the user contradicted a fact in a chat without asking to forget it) does not bump the revision, so the old summary may mention the fact until its rewrite a few minutes later.

## Acceptance checks

Verify ownership for reads, CRUD, import, export, project scopes, and model tools; memory disabled suppresses injection and assistant writes; automatic saving disabled still allows explicit user requests if documented; imports require a preview/selection step and do not mutate during preview; duplicate imports are idempotent; malformed/oversized input fails clearly; JSON exports round-trip; deleting/resetting memories changes subsequent context; changing model/provider retains the same user's memories; and scheduled prompts obey the same preferences. Use the browser for an end-to-end persistence check across reloads and a fresh conversation.

## Temporary chats

The header menu can start a temporary chat. Its `tmp_` id is generated in browser memory; the history adapter never creates a stored thread or writes messages, and the sidebar excludes it. `/api/chat` recognizes the reserved prefix and bypasses thread/usage persistence, automatic compaction, stored artifacts/images, delegated tasks, MCP, and browser tools. The stream is tied to the request with no resumable copy; the client stores neither selection nor stream checkpoint. Reload drops the conversation. `ensureThread` rejects reserved ids so stale history writers cannot accidentally persist one.

Personalization starts off: no saved memory, custom user instructions, project instructions, or project files enter the model context. A separate header switch can enable read-only global memory and custom user instructions for this temporary conversation. `temporaryMemory` offers search only, rechecking account preferences/revision on execution; save/update/forget are never available. This is an authenticated app mode, not a claim about retention by an upstream model provider.

Document attachments use a per-thread adapter and `/files/extract?temporary=1`, so extraction does not retain original upload bytes or return an importable file id. Web search and page reading remain available. File-generating tools and stored compaction are not offered in temporary mode. Tests cover default context exclusion, optional read-only personalization, rejected persistence, absent replay headers, unchanged table counts, and actual document extraction.
