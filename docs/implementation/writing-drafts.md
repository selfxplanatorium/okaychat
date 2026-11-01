# Writing drafts

`draft_text` creates a small inline editor for standalone writing the user wants to reuse elsewhere:
messages, posts, letters, announcements, and similar text. The default chat prompt and tool description
direct the model to use it for those requests, keep ordinary answers and code in chat, honour explicit
plain-text/Markdown requests, and use `draft_email` for email. Selection is model-driven, not Markdown
detection. An admin override of the Chat assistant prompt replaces its default guidance.

The card has an editable title and plain-text body, Copy (body only), and Discard.
It has no sender, recipients, signature, mail settings notice, send, mailto, or email download action,
and never fetches mailbox accounts. Copy includes current local edits.

## Shared lifecycle

`src/server/text-drafts.ts` provides the create/read/update tool. Input uses `title` and `body`, plus
`draftId` for reads and `revision` for updates. Title is stored in the existing `subject` column.
`email_drafts.kind` distinguishes `email` (the default for existing rows) and `text`; it is immutable
through the API. This reuses ownership checks, revision CAS, message binding, delete-on-chat-delete,
branch copies, and the combined caps of 100 drafts per chat / 2,000 per account, without a second
storage or autosave implementation. Draft text has the same 100,000-character body cap and is not
charged separately to storage quota. `src/shared/email-draft.ts` remains the shared transport shape.

`TextDraftCard` in `EmailDraftCard.tsx` selects the reduced UI and reuses `DraftAutosave`: 600 ms
debounce, in-flight edit preservation, scoped local outbox, offline retry, and explicit conflict
resolution. The owned API remains `/api/email/threads/:threadId/drafts/:id`; no mail server is involved.
Text drafts reject mail fields, email export, and send preparation on the server, even with a forged
API request. Mail and text tools refuse each other's draft kinds. Tool results are enveloped as
`text_draft` and classified as untrusted because they can include pasted content and user edits.

The tool is available only in saved chats with a tool-capable model; temporary chats and delegates
never receive it. It does not depend on a connected mailbox, artifacts, or a sidecar. The tool renderer
and `resultKey()` preserve the latest card for each draft after reply folding. Keyboard commands are
`textDraft.copy` and `textDraft.discard`.

## Verification

`email/drafts.test.ts` covers text draft ownership, user edits, stale model updates, kind separation,
mail-action refusal, and branch copies. `email/draft-chat.test.ts` exercises a real chat turn with a
mock provider, verifying tool availability, persistence, no approval prompt, and enveloped model output.
The shared autosave controller's race, conflict, and outbox tests live in `email-draft-state.test.ts`.
These tests verify wiring; they do not prove a live model will select the tool for every request.
