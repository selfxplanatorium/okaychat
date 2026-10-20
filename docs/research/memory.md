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

`src/server/memory.ts` owns `/api/memory`, entry CRUD, preferences, preview/import, and JSON/text exports. The table encrypts content and keeps a content hash for duplicate detection.

Threat model for memory encryption (`crypto.ts`, AES-256-GCM, one server-wide key derived from `OKAYCHAT_SECRET`):

- Covers: a copy of `okaychat.db` without the secret (stolen backup, copied volume, leaked table dump). Memory text and provider/MCP secrets are unreadable there.
- Does not cover: anyone who can run code in the app process or read its environment. The key is in memory and in the environment, and the server must decrypt memory to build prompts.
- Does not cover: other users of the same server. All users share the key; access control is in the routes.
- Does not cover: guessing. `content_hash` is an unkeyed SHA-256 of normalized text, so a known or short phrase can be confirmed against the database.
- Operational: store `OKAYCHAT_SECRET` apart from `okaychat.db` backups. Losing or changing it makes all encrypted data unreadable. Memory starts disabled with automatic saving selected; enabling it allows memory tools and a bounded prompt section across providers. With automatic saving disabled, memory write tools require the existing in-chat approval flow. `ChatPrivacyMenu` in the top-right header persists a normal-chat memory exclusion in `threads.memory_disabled`; that chat remains in history. The composer has no memory control.

The account holds up to 500 entries and 200,000 content characters, with at most 2,000 characters per entry. Import text is limited to 200,000 characters. Text parsing splits bullets/paragraphs without an extra model call; preview is editable through source text and selectable entry checkboxes before commit. Unknown project scopes in imported backups become global with a preview warning. JSON export uses `{ format: "okaychat-memory", version: 1, entries }`; text export uses a Markdown-style list. Settings preference changes dispatch `okaychat:memory` to refresh the header control.

Each turn injects at most 50 facts within a 24,000-character content budget, selected by keyword overlap with the current request and kept in stable creation order. The `memory_search` tool retrieves other eligible saved entries within the same bounds. This is saved-fact recall; automatic retrieval of past conversations is not implemented. Memory tools re-check the account's enablement, preference revision, thread ownership, current project scope, and per-chat exclusion when they execute, so pausing/resetting or editing/deleting facts revokes stale writes already offered to an in-flight model. Existing context already sent to a provider cannot be withdrawn.

## Acceptance checks

Verify ownership for reads, CRUD, import, export, project scopes, and model tools; memory disabled suppresses injection and assistant writes; automatic saving disabled still allows explicit user requests if documented; imports require a preview/selection step and do not mutate during preview; duplicate imports are idempotent; malformed/oversized input fails clearly; JSON exports round-trip; deleting/resetting memories changes subsequent context; changing model/provider retains the same user's memories; and scheduled prompts obey the same preferences. Use the browser for an end-to-end persistence check across reloads and a fresh conversation.

## Anonymous chats

The header menu can start an anonymous chat. Its `tmp_` id is generated in browser memory; the history adapter never creates a stored thread or writes messages, and the sidebar excludes it. `/api/chat` recognizes the reserved prefix and bypasses thread/usage persistence, automatic compaction, stored artifacts/images, delegated tasks, MCP, and browser tools. The stream is tied to the request with no resumable copy; the client stores neither selection nor stream checkpoint. Reload drops the conversation. `ensureThread` rejects reserved ids so stale history writers cannot accidentally persist one.

Personalization starts off: no saved memory, custom user instructions, project instructions, or project files enter the model context. A separate header switch can enable read-only global memory and custom user instructions for this anonymous conversation. `temporaryMemory` offers search only, rechecking account preferences/revision on execution; save/update/forget are never available. This is an authenticated app mode, not a claim about retention by an upstream model provider.

Document attachments use a per-thread adapter and `/files/extract?temporary=1`, so extraction does not retain original upload bytes or return an importable file id. Web search and page reading remain available. File-generating tools and stored compaction are not offered in anonymous mode. Tests cover default context exclusion, optional read-only personalization, rejected persistence, absent replay headers, unchanged table counts, and actual document extraction.
