# Message translation

A per-message machine translation the reader can ask for. It is **derived text**: a standalone model call whose answer is stored beside the message, never in it. Nothing in a chat's prompt, history, search, shares, exports, or archives changes when a translation exists.

## Why it is separate

`messages` is what the chat sends, what exports and public shares render, and what the prompt cache depends on. Writing a translation into `messages` would change the model's past, break every cached prefix, and leak machine text into shared links. So a translation lives in its own table keyed by `(thread_id, message_id, lang)`, and every other feature keeps reading the original.

## Contracts

`src/shared/message-translations.ts` holds the types and limits:

| Constant | Value | Meaning |
| --- | --- | --- |
| `MAX_TRANSLATION_SOURCE_CHARS` | 12,000 | Characters of the message sent to the model; longer text is cut at a paragraph break. |
| `MAX_TRANSLATION_TEXT_BYTES` | 32 KiB | UTF-8 bytes kept for one stored translation; cut on a code point at the last whitespace. |
| `MAX_TRANSLATIONS_PER_MESSAGE` | 20 | Languages per message. |
| `MAX_TRANSLATIONS_PER_THREAD` | 5,000 | Rows per chat, so one long thread cannot exhaust storage quietly. |
| `TRANSLATION_BODY_LIMIT` | 8 KiB | `PUT` body cap checked before JSON parsing. |

`sourceHash` is `sha256(JSON.stringify(texts))` over the message's text parts in order, attachment placeholders removed. An edit changes it, which is how the server detects a stale row; the web store is invalidated by the editor (see the interaction table).

## Storage

Migration `message_translations` (append-only, after api-access) creates:

```sql
CREATE TABLE message_translations (
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  lang TEXT NOT NULL CHECK(length(CAST(lang AS BLOB)) BETWEEN 2 AND 35),
  source_hash TEXT NOT NULL CHECK(length(source_hash) = 64),
  source_chars INTEGER NOT NULL CHECK(source_chars >= 0),
  translated TEXT NOT NULL CHECK(length(CAST(translated AS BLOB)) BETWEEN 1 AND 32768),
  truncated INTEGER NOT NULL CHECK(truncated IN (0,1)),
  model_ref TEXT NOT NULL CHECK(length(CAST(model_ref AS BLOB)) BETWEEN 1 AND 1200),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, message_id, lang),
  FOREIGN KEY (thread_id, message_id) REFERENCES messages(thread_id, id) ON DELETE CASCADE
);
```

Only `translated` bytes count against the storage quota (`quota.ts`); a deleted chat cascades the rows away and frees them. Deleting one language frees its bytes on the next `storageUsed` call, which is a live SQL sum.

## The request

1. `getSettings(userId).translateMessages === false` → `forbidden`. The switch is the account's consent.
2. Temporary chat, foreign thread, unknown message → one `not_found` sentence (`Message not found`), so ids cannot be probed.
3. A busy chat (`threadBusy`) → `conflict`: the client stores a turn only when it ends, so translating a changing message would cache the wrong text.
4. Only stored `ai-sdk/v6` user/assistant messages with text parts (`attachmentName()` placeholders removed) are eligible → `validation`.
5. The language must canonicalize (`shared/locale-tag.ts`) → `validation`.
6. A row with the same `source_hash` and `refresh !== true` is returned **before** a model is resolved: a cache hit costs nothing and records no usage.
7. The chat limit and the per-message language limit answer `conflict`.
8. Model choice: the account's `utilityModel`, else the request's `modelRef`, else the chat's stored model. `n8n/` refs are skipped (an agent is not a model). No ref → `conflict` naming Settings → General. `resolveModel` errors propagate unchanged (a revoked model is a real `forbidden`, not a missing model).
9. One `generateText` with `maxRetries: 0`, `maxOutputTokens: 6000`, the caller's `AbortSignal`, and no tools. `createModel(model, conn, { userId })` keeps the account cache affinity but never marks a chat breakpoint.
10. Usage is recorded as `kind: "translation"` **before** the storage assertion, so a quota refusal still leaves an honest ledger row.
11. An empty answer is `validation` and caches nothing. Over-long output is cut at the byte cap and stored with `truncated = 1`.
12. Re-read the current row and recheck the row limits inside the write transaction. `assertStorage(userId, netGrowth)` uses that current row, then the UPSERT runs in the same transaction; `created_at` is kept on refresh. A concurrent delete or replacement cannot grant stale quota credit.

No single-flight: two identical concurrent requests may both call the provider; the second UPSERT writes the same text and only net growth is charged, and the DB cache covers every later repeat. One message owns one `AbortController` in the web store, so starting a second translation aborts the first and its provider call.

## Prompt and envelope

`PromptKey` `translation` is in `src/server/prompts.ts`, editable by an admin like every other prompt. Only `{language}` is substituted, with the English language name (`Intl.DisplayNames(["en"])`), so instructions stay English whatever the UI language is. The message itself arrives in the next user message inside `wrapUntrusted(..., { kind: "message_translation", name: "chat message" })`: it is data, never instructions.

## Routes

Mounted in `src/server/routes.ts` beside the annotation routes, behind `requireFeature("translation")`, CSRF-protected, `Cache-Control: private, no-store`:

| Method and path | Body | Answer |
| --- | --- | --- |
| `GET /api/threads/:id/messages/:messageId/translations` | – | `MessageTranslationList` with `stale` per row |
| `PUT /api/threads/:id/messages/:messageId/translations/:lang` | `{ modelRef?, refresh? }` | `MessageTranslation` |
| `DELETE /api/threads/:id/messages/:messageId/translations/:lang` | – | `{ ok: true }` |

Errors use existing codes only (`validation`, `conflict`, `not_found`, `forbidden`, `storage_quota`, plus the provider mapping).

## Web

- `state/message-translations.ts`: account-scoped Zustand cache keyed `${threadId} ${messageId}`. `loadTranslations` single-flights per message and is called only when the dialog opens. A `GET` never overwrites a later acknowledged `PUT` (per-message epoch). A reload keeps the block hidden; only a confirmed `PUT` sets `active`. Stale rows stay listed as data but are never shown.
- `components/chat/MessageTranslation.tsx`: the two More-menu items, the block under each message, the keyboard command, the translating/error rows. The block renders through `TextMessagePartProvider` + `MarkdownText`, so code, math, Mermaid, the remote-image policy, and knowledge citations behave exactly like message text.
- `components/chat/TranslationDialog.tsx`: language picker over the shipped UI locales and `TRANSLATION_LANGUAGES`, existing non-stale languages with Remove. The description states the original is unchanged.
- `components/chat/translation-gate.ts`: the pure disabled matrix (temporary, unsaved, syncing, running/editing, switch off, no model, empty text), used by `annotation-gates.ts` and tested without a runtime.
- `state/translation-dialog.ts` holds the open target; account switches and sign-out close it. Chat deletion drops its entries on this page.
- `Alt+Shift+F` translates the focused message; `message.translateChoose` opens the picker from the command list.

## Interactions

| Area | Behavior |
| --- | --- |
| Chat prefix / prompt cache | A translation never touches `messages`, `turn_context`, the system prefix, tools, or `threads.updated_at`. |
| Edit a reply | The source hash changes, so the old row is stale and the next Translate regenerates and replaces it. Undo changes the hash back and regenerates too. On the page, a saved edit or Undo calls `invalidateMessageTranslations()`, which hides the block, marks cached rows stale, aborts a running Translate, and makes the dialog refetch. |
| Compaction and trim | Reads the stored message text, so messages inside a summary or trim still translate. |
| Branch / fork | Rows are not copied: derived text, and copying would double-charge. |
| Delete chat | FK cascade removes rows and frees quota. |
| Share links, export, archive | Original text only. `snapshot_json`, `threadMarkdown`, and the archive manifest never read this table. |
| Search, memory, titles, evaluations, read aloud | Never read translations. |
| Quota | Stored translated bytes count; deleting frees them; `storage-changed` refreshes the meter. |
| Temporary chats | Disabled in the UI and `404` on the server. |

## Limits and privacy

Translations are private account data. They are not encrypted at rest (they are derived from text that already is not), do not appear on public pages, and share the chat's lifetime. The model receives exactly one message, wrapped as untrusted data; no other chat content, memory, or tools are sent.

A message edit or Undo during generation is detected before the write: the payload carries its source
hash, and translate re-reads the message after the model answers. A changed message returns a conflict and
stores nothing, while the paid usage is still recorded. The dialog also surfaces a failed translation-list
load with a retry instead of an empty list.
