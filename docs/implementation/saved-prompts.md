# Saved prompts

Personal prompt templates with `{{variable}}` placeholders, inserted by the Prompts dialog or a `/shortcut` in the
main composer. See `src/shared/saved-prompts.ts`, `src/server/saved-prompts.ts`, and
`src/web/components/chat/SavedPromptsDialog.tsx`.

## Data and limits

`saved_prompts` holds one row per account and shortcut: `name`, `shortcut` (`COLLATE NOCASE`, unique per account),
`body`, a monotonic `revision`, and timestamps. The name is trimmed; the body keeps its whitespace. Templates are
ordinary account text (not encrypted), never logged, and never sent to a model except when the user explicitly
inserts the expanded text into a message. The table is deliberately not called `prompts`: `server/prompts.ts` owns
administrative system prompts.

A name is at most 80 code points, a body 20,000 code points / 80 KiB, and there are at most 200 prompts and 20
distinct variables. Prompt bytes (`name + shortcut + body`) count against the storage quota; replacements charge
net growth and a shrink or delete works while over quota.

## Grammar

Only `{{name}}` (`[A-Za-z][A-Za-z0-9_]{0,31}`, case-sensitive) is a variable. `\{{name}}` emits the literal text
`{{name}}`; one backslash is consumed. Every other brace or backslash is literal, so JSON examples remain usable.
Substitution is one linear pass with literal values: braces or `$&` in a value are never reparsed. The server and
the web use the same parser, the shared preview, and the same expanded-text caps (100,000 code points / 400 KiB).

## UI and API

`GET /api/saved-prompts` returns `{ prompts }` sorted by name (case-insensitive) then id. `POST` creates;
`PUT /:id` and `DELETE /:id` require the current `revision` and return 409 for a stale one. A duplicate shortcut is
also 409; the client refetches and reports the shortcut field because the wire error does not carry server details.
Request bodies are capped at 96 KiB.

The Prompts button (desktop) and the plus menu's Prompts row (touch) open one dialog owned by `ChatView`:
saved prompts, external MCP prompts grouped by server, a manage view, the editor, and the variable fill view.
External MCP prompts keep their existing argument dialog; the sources never share loading or error state.

Slash insertion is limited to the whole main composer being `/` plus `[a-zA-Z0-9-]` with the caret collapsed at
the end and no IME composition. This deliberate scope keeps URLs, paths, and prose ordinary. Up/Down move the
active row, Enter inserts and is consumed, Escape closes and suppresses the menu for the unchanged token, and Tab
closes without selecting. At most eight rows show; the dialog searches the full library.

Picking a prompt with no variables inserts immediately, otherwise the dialog becomes the fill form. Insertion
appends `\n\n` before the text only when the composer is non-empty and does not already end in a blank line; it
never trims existing text or clears attachments. Inserting always focuses the main composer at the end. The
replace target captures account id, chat id, whole text, and selection, so a chat switch or edited text aborts the
insertion and asks the user to choose again rather than writing into another chat.

## State

`state/saved-prompts.ts` is memory-only, keyed by account, with one shared GET and an in-flight guard. A late answer
for a previous account is dropped, and a GET that started before an acknowledged write cannot restore the old
list. The dialog keeps a dirty editor on network, quota, or conflict failures and offers reload or retry. Sign-out
and account changes clear the store.
