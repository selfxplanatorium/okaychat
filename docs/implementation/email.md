# Email

Email accounts connect one mailbox for reading through IMAP and sending through SMTP. The assistant
gets six mailbox tools plus `draft_email`, which writes an editable inline letter, and every send or
reply waits for a review that shows the exact payload. OAuth is
deliberately out of scope for v1: the account form and provider notes tell the user to create an app
password, and the server exposes an auth-method list so a future OAuth provider can be added without
changing the UI contract.

## Files

| File | Role |
| --- | --- |
| `src/server/email/accounts.ts` | Owned CRUD, AES-256-GCM encryption, validation, defaults, live toggles, connect-time host guard and DNS pinning |
| `src/server/email/discover.ts` | Ordered discovery chain, autoconfig/autodiscover/SRV parsers, TLS/STARTTLS probes |
| `src/server/email/imap.ts` | imapflow client: folders, list, search, read, explicit attachment download |
| `src/server/email/smtp.ts` | nodemailer transport: send, verify, Bcc in the envelope only |
| `src/server/email/mime.ts` | Header-injection checks, MIME build/parse, transfer decoding, HTML-to-text |
| `src/server/email/send.ts` | The one approved-send path shared by the model tools and the draft card: live send/read switches, exact sender and signature, reply participants |
| `src/server/email/tools.ts` | The six model tools, live toggle checks, envelopes, approval metadata |
| `src/server/email/drafts.ts` | Persisted editable drafts, revision CAS, review tokens, the draft `.eml` builder, branch copies |
| `src/server/email/draft-tool.ts` | `draft_email`: create, read the latest user-edited draft, or update with a revision |
| `src/server/email/draft-routes.ts` | Owned draft API: get, patch, delete, `.eml`, review, send |
| `src/server/email/routes.ts` | Settings API, NDJSON discovery stream, connection tests |
| `src/server/email/errors.ts` | Actionable error mapping; never echoes an auth reply |
| `src/web/components/settings/EmailSettings.tsx` | Account cards and the add/edit wizard: live discovery progress, cancellation, manual-entry usernames, honest test status |
| `src/web/components/chat/email-tools.tsx` | List/search/read cards and the send/reply review card |
| `src/web/components/chat/EmailDraftCard.tsx` | Inline editable letter: fields, autosave status, review dialog, send/copy/.eml/mailto/discard/rewrite |
| `src/web/components/chat/email-draft-state.ts` | Debounced revision-checked autosave controller, scoped reload outbox, card-state derivation |

## Data

`email_accounts` stores the account label, address, IMAP/SMTP endpoint JSON, password, security flag,
read/send switches, default marker, signature, and last-check result. Endpoints and the password are
separate AES-256-GCM ciphertexts (`crypto.ts`, `OKAYCHAT_SECRET`). The password is write-only: it is
never part of `EmailAccount`, never returned by a route, and never logged. Editing a host, port, or
username without entering the password again is refused, so a stored secret cannot silently follow a
new destination. Message bodies are not mirrored into SQLite. Downloaded attachments use the existing
`uploads` row and quota path, so the Library can serve them and `assertStorage` applies.

A user may connect at most 10 accounts. The first account becomes the default; deleting the default
promotes the oldest remaining one. The default cannot be cleared to nothing.

`email_drafts` holds the inline editable letters. The key is `(thread_id, id)`, like messages, so a
branch can keep the same opaque card id. Every row belongs to a user and a chat, stores the recipient
arrays, subject, plain-text body, optional reply handle, sending account, `revision`, `status`
(`draft|sending|sent`), last writer (`user|model`), sent timestamp/count, last send error, and one
pending review. `account_id` deliberately has no foreign key: deleting an account must leave the
draft visible with `accountMissing` so the user can choose another sender. Drafts are text and are
not charged to the storage quota; the caps are 100 per chat and 2,000 per account. A card binds
`message_id` only when that message exists in the same chat.

## Tools

`email_folders` doubles as the account inventory: with no `accountId` it returns every owned
account's id, label, address, default marker, read/send switches, and signature. Pass an explicit
account id to fetch folders; inventory itself opens no mail connection, so an unreachable or
read-disabled default cannot hide the other accounts. Send/reply require an explicit `accountId`;
list/search/read can fall back to the default. The inventory is scanned and enveloped like mail
content because signatures and labels are user-supplied text.

`draft_email` is separate from the six mailbox tools and exists in every stored chat, even with no
mailbox: a draft can still be copied, downloaded, or opened in a mail app. A call without `draftId`
creates a draft (a default account is chosen when one exists); a call with only `draftId` returns the
latest stored version, including the user's edits; a call with `draftId`, `revision`, and changed
fields updates it. A stale model revision fails and tells the model to read the draft again, so it
never overwrites newer user text. Its result is enveloped as `kind="email_draft"` and taints later
actions; it is not offered to temporary chats or delegates and can never send.

`email_search` maps the model-facing `query` field to IMAP `TEXT`, and keeps `from`, `subject`,
`since`, `unseen`, and `limit`. `email_read` returns the opaque mailbox+UIDVALIDITY+UID handle as
`id`, the RFC `Message-ID`, `replyTo`, the full address lists, dates, flags, attachment part ids, and
the body, so a later read, reply, or explicit download can use the same message without guessing.
Read bodies decode through imapflow's charset pipeline; a named `text/*` part is treated as an
attachment, never as the message body.

## Discovery

`POST /api/email/discover` streams one NDJSON line per attempt, then a final result. The wizard shows
the progress block live on the address step as well as the server step, cancels the stream when it is
dismissed, and fills an editable form; a failed attempt never becomes a success. The order is fixed:

1. **Known providers** (`presetFor`): Gmail/googlemail, Outlook/hotmail/live/msn, iCloud/me, any
   `yahoo.*`, Fastmail, any `gmx.*`, and Proton. Proton has no direct IMAP server; the result explains
   that Proton Mail Bridge is required and sets `needsBridge`, without inventing servers.
2. **Thunderbird autoconfig**: `autoconfig.<domain>`, the domain's
   `/.well-known/autoconfig/mail/config-v1.1.xml`, then `autoconfig.thunderbird.net/v1.1/<domain>`.
   XML is parsed with `@xmldom/xmldom`, namespace-agnostically by local name. `%EMAILADDRESS%`,
   `%EMAILLOCALPART%`, `%EMAILDOMAIN%`, and `%REALNAME%` are substituted. OAuth-only or `plain`
   socket entries are not reported as usable.
3. **Microsoft Autodiscover**: `POST https://autodiscover.<domain>/autodiscover/autodiscover.xml`,
   then `https://autodiscover.<domain>/autodiscover/autodiscover.json?Email=…&Protocol=IMAP`. The XML
   and nested JSON responses are parsed for IMAP/SMTP protocol objects.
4. **RFC 6186 SRV** through `node:dns/promises.resolveSrv`: `_imaps._tcp`, `_imap._tcp`,
   `_submissions._tcp`, `_submission._tcp`. Secure records are preferred; priority then weight orders
   the candidates; `_imap`/`_submission` candidates require STARTTLS.
5. **Hostname heuristics with real probes**: `imap.<domain>:993`, `mail.<domain>:993`,
   `imap.<domain>:143` (STARTTLS), `smtp.<domain>:465`, `smtp.<domain>:587` (STARTTLS),
   `mail.<domain>:465`. Each candidate is opened and checked for a real IMAP/SMTP greeting; STARTTLS
   candidates also require a successful verified TLS upgrade. No credentials are sent.

The first result for each side wins, and later stages only fill a missing side. Each result carries a
confidence (`high` preset, `medium` document/SRV, `low` guess). Discovery documents are capped at
512 KB (XML) or 256 KB (JSON) with an 8 s timeout. A probe has one 6 s deadline for the whole
exchange — DNS, connect, greeting, EHLO, STARTTLS, and the TLS handshake — and the request's abort
signal is forwarded to every stage, so a server that accepts and then stays silent cannot hold the
wizard open. Response lines and queued lines are bounded (4 KB, 40 lines).

## Draft card

The inline letter is a view of one persisted `email_drafts` row, not a copy of the tool output. On
mount it hydrates through `GET /api/email/threads/:threadId/drafts/:id`; a streaming or stale tool
result is only a disabled preview until that record arrives. A missing row shows "Draft discarded"
and is never recreated from old chat history.

Routes, all scoped to the signed-in user and the live chat (another user's id, a deleted chat, or a
deleted account is a 404/422, never a cross-account read):

| Route | Purpose |
| --- | --- |
| `GET /threads/:threadId/drafts/:id` | The current record |
| `PATCH /threads/:threadId/drafts/:id` | `{ revision, fields, messageId? }`; compare-and-set, 409 on a stale revision |
| `DELETE /threads/:threadId/drafts/:id` | Discard (refused while sending) |
| `GET /threads/:threadId/drafts/:id/eml` | RFC 5322 download through the real MIME builder; no send switch needed |
| `POST /threads/:threadId/drafts/:id/review` | `{ revision }`; builds the exact payload and a single-use review token |
| `POST /threads/:threadId/drafts/:id/send` | `{ reviewId, revision }`; the token is the only accepted input |

Autosave is debounced at 600 ms in `EmailDraftCard`/`DraftAutosave`. Each PATCH carries the last
acknowledged revision and the complete fields. A response never replaces text typed while its request
was in flight; that newer text is queued against the acknowledged revision. A 409 keeps the local
text, shows a conflict, and offers "Keep my version" (fetch the latest revision, then save the local
text) or "Reload latest" (adopt the server text). A network failure is `offline`; the text is kept
and retried on reconnect, window focus, or the manual Retry. Unacknowledged text is mirrored to a
localStorage outbox keyed by user, chat, and draft, so a reload restores it only when its revision
still matches; a newer server revision wins and clears the outbox. Saves that arrive after a newer
model write do not move the card backwards.

A model update that lands while the card is open is fetched and shown with a quiet "Updated"; unsaved
local text is preserved as the next pending save rather than being silently discarded. User edits
always win until the model writes again, and then the server revision is authoritative for what the
next save targets.

Send is deliberately two-step and works without the model. The card first flushes every pending save,
then asks the server to review the current revision. The review shows the live account label and From
address, exact To/Cc/Bcc, subject, full body, and signature. Confirming sends only the review id and
revision; the server rebuilds the payload from the stored row and the live account, hashes it against
the reviewed payload, and claims the row in one conditional update so two sends cannot both start. It
then goes through `send.ts`, the same approved path as `email_send`/`email_reply`: the live send
switch, sender, signature, reply participants, host check, TLS, and Bcc-as-envelope-only rules all
apply. A changed draft or account invalidates the token. Content writes clear it. A review lasts 10
minutes and is single-use. A successful send stores `sent_at`, increments `send_count`, makes the
fields read-only, and shows "Sent"; resending is a new review and another approval. A failed send
returns the draft to editable with the mapped error in `last_error`. The server never appends a
signature after approval; the card offers an explicit "Add signature" before review when the account
requires one.

The toolbar also copies a readable message (with the HTTPS clipboard fallback), downloads a Unicode
`.eml` built by `buildMime`, opens `mailto:` with encoded subject/body/recipients, discards after a
confirmation dialog, and asks for a rewrite by appending a user turn that names the draft id. All
other actions keep working with no account. When no connected account can send, Send is disabled and
a Settings → Email link explains why. At 360px the header, fields, and toolbar wrap with `min-w-0`;
the body auto-grows without a fixed-height jump. Fields have labels; status is announced through a
polite live region, copy feedback included; Ctrl/⌘+Enter opens the review, Escape only blurs a field;
every button has a command in `commands.ts` and keeps its focus ring and 44px touch target on coarse
pointers. Mail HTML is never rendered.

## Security model

- **Transport.** Stored accounts only accept TLS (`tls`) or required STARTTLS (`starttls`). imapflow
  runs with `doSTARTTLS: true`, so a server that omits or refuses the upgrade fails instead of
  authenticating in clear text. nodemailer uses `requireTLS` for STARTTLS. Certificates are always
  verified (`rejectUnauthorized: true`) with the server hostname as SNI/servername. Self-signed
  certificates are refused.
- **Hosts.** Every save, discovery result, probe, and connection re-checks the destination, and the
  live admin role is read again on every connection. Non-admins may only reach public addresses;
  private, loopback, link-local, CGNAT, and tailnet addresses are refused. Admins may point an
  account at a LAN server, as with provider base URLs and MCP servers. For non-admins
  `emailConnectTarget()` resolves the host, rejects any non-public answer, and returns the checked
  IP literal that IMAP and SMTP must connect to (with the original hostname kept only as the TLS
  SNI/certificate name). The clients therefore never run a second DNS lookup between the check and
  the socket. Draft tests, verified accounts, replies, and attachment downloads all go through the
  same check; a saved account stops working after its owner is demoted from admin.
  Discovery documents go through `publicFetch` for non-admins (pinned DNS, revalidated redirects) and
  ordinary `fetch` for admins, so an internal autoconfig endpoint remains reachable. Every document
  redirect is followed manually, bounded to four hops, and must stay HTTPS: an HTTPS-to-HTTP
  downgrade is refused. Socket probes also pass a guarded DNS lookup at connection time.
- **Plaintext.** The per-account "allow unauthenticated plaintext discovery" switch permits only a
  banner check on a plaintext port when TLS probing fails. It never permits credentials, reads, or
  sends over plaintext; those still require TLS.
- **Secrets.** Endpoints and passwords are encrypted with `OKAYCHAT_SECRET`. Auth failures map to a
  generic "rejected the sign-in" message and never echo the server's reply, which can quote the
  username or password.
- **Untrusted content.** Folders, headers, subjects, senders, bodies, and attachment names are
  third-party data. Every read tool keeps its raw output for the card and wraps the model text with
  `wrapUntrusted(kind: "email")`; scans ride on the result for the advisory badge. The tool names are
  in `UNTRUSTED_TOOL_NAMES`, so replayed history taints later turns. Mail HTML is never rendered; the
  server converts it to text and the UI shows plain text.
- **Sending.** `email_send` and `email_reply` always have `needsApproval: true` and
  `riskMetadata("outbound")`. `accountId` and `from` are required, so the approval never guesses the
  default or another account. The review shows the from address, exact recipients, subject, and the
  complete body. The server sends that body verbatim and never appends a signature: when the account
  has one, the model must already include it at the end of the body, and `email_folders` returns the
  exact signature text. Execution re-reads the live account and refuses a changed sender, a changed
  signature, or a body that no longer contains the current signature; nothing is silently
  substituted. After untrusted content the generic gate names the outbound risk. Scheduled runs
  auto-deny; delegates and sub-agents never receive send or reply. A reply re-reads the original
  message (also enforcing the live read switch, so a send-only account cannot read through a reply)
  and rejects any recipient that was not in its From/To/Cc/Reply-To (and must include the sender), so
  no hidden recipient can be added after approval; `In-Reply-To` and `References` are derived from
  the original. Custom send/reply cards render the existing approval controls below the review panel;
  the review panel starts expanded while approval is pending. The draft card uses the same send
  service after its own exact-payload review, but keeps a single-use hashed token instead of the model
  approval; it cannot approve a changed revision, sender, or signature, and it never calls SMTP
  directly. Bcc exists only in the SMTP envelope, never in message headers.
- **Attachments.** Never fetched by list, search, or read. `email_read` downloads only part ids named
  in `downloadAttachments`, caps each at 20 MB and the whole message at 50 MB, stops a stream as soon
  as the budget is crossed, sanitizes name/MIME, and stores the file through `storeUpload` (quota).
  Temporary chats have no email tools and store nothing.

### Residual risks

- **DNS rebinding TOCTOU.** For non-admins the DNS answer is checked and the connection is pinned to
  the checked IP literal for both IMAP and SMTP, so the libraries cannot resolve the name a second
  time. Admins keep hostname behaviour so LAN names work. The remaining window is the ordinary gap
  between the role/DNS check and the already-pinned `connect()` call; an admin demoted in that exact
  interval could finish one connection. The next connection re-checks the role and fails.
- **Server-supplied data.** A provider can publish misleading autoconfig/SRV records. The user sees
  and can correct every server, and the Test button verifies TLS and authentication before saving.
- **Discovery probes are unauthenticated.** They reveal that a host exists and speaks IMAP/SMTP and
  its certificate, which is the same information a normal client reveals. No credentials are sent.
- **Forwarded mail is still hostile.** A trusted sender can forward an injection. The envelope, badge,
  and approval gate reduce the chance of an unwanted action but do not make the content safe.
- **OAuth is absent.** Users with providers that disable password/app-password IMAP cannot connect
  yet. The auth-method endpoint and UI note make that limitation explicit.

## Limits and errors

At most 10 accounts per user, 50 messages per list/search, 100,000 characters of body text, 20 MB per
downloaded attachment, 50 MB per message, 25 recipients, and two simultaneous IMAP connections per
account. Errors are mapped to auth failed, host unreachable, certificate, too many connections,
too large, rate limited, not found, or protocol, each with a plain-language fix hint. The last-check
result is stored per account and shown in Settings; a failed test cannot be shown as connected.

## Providers

Gmail, Googlemail, Outlook.com, Hotmail, Live, MSN, iCloud, me.com, Yahoo, Fastmail, and GMX have
presets. Proton requires Bridge. Thunderbird and Microsoft autoconfig cover many business domains,
and SRV/heuristics cover the rest. Gmail, Outlook, iCloud, Yahoo, and Fastmail generally require an
app password; the UI says so in the empty state and per-account notes. OAuth sign-in is not available
yet.

## Tests

`src/server/email/` contains focused suites:

- `accounts.test.ts`: encryption round-trip, ownership, blank-password edit, host-change refusal,
  defaults, validation, account cap, host guard.
- `discover.test.ts`: preset order and Proton, namespaced autoconfig with substitutions, autodiscover
  XML/JSON, complete HTTP-to-SRV fallback ordering, SRV ordering, heuristic order, host refusal.
- `mime.test.ts`: header-injection rejection, unicode round-trip, quoted-printable/base64, multipart
  parsing, filename/MIME sanitation, HTML-to-text.
- `protocol.test.ts`: in-process `node:net`/`node:tls` mock IMAP and SMTP servers for connect, real
  AUTH validation, folders, list, search, read, non-UTF-8 charset conversion, a named text part as an
  attachment, attachment streaming, SMTP send, STARTTLS success and fail-closed (no AUTH before TLS),
  certificate verification, a demoted non-admin blocked before any socket, and probe deadlines/abort.
- `tools.test.ts`: approval metadata, delegate exclusion, temporary chats, live read/send toggles,
  account inventory with a read-disabled default, `email_search` query → `TEXT`, the opaque id /
  Message-ID / Reply-To in the read envelope, reply recipient validation and the live read switch,
  reviewed from/body exactness including signature and stale-change rejection, explicit account
  choice after a default change, explicit attachment download, and quota.
- `approval.test.ts`: the real chat turn asks for approval on a clean send, shows the exact from and
  complete body (signature included) before Allow, names the outbound risk after untrusted content,
  honours a replayed approval without asking a human again, and auto-denies in an unattended
  schedule.
- `drafts.test.ts`: route ownership, deleted chat/account, revision CAS, CRLF and size validation with
  valid blanks, review/send with a fake sender, stale/changed review, single-use tokens, concurrent
  sends, resend, Bcc envelope-only, signature and live send switch, reply Bcc refusal, branch copies,
  message binding inside the chat, `.eml` Unicode round-trip, and `draft_email` create/read/update
  with the user's latest text and an envelope.
- `draft-chat.test.ts`: a real chat turn offers `draft_email` without any mailbox, runs it without
  approval, stores the draft, and sends only the enveloped result to the next model step.
- `src/web/components/chat/email-draft-state.test.ts`: the 600 ms debounce, in-flight edit
  preservation, conflict/retry, offline retry, reload outbox and server hydration, and card-state
  derivation (draft, saving, sent, no account).
