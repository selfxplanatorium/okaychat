# Email

Email accounts connect one mailbox for reading through IMAP and sending through SMTP. The assistant
gets six tools, and every send or reply waits for an approval that shows the exact payload. OAuth is
deliberately out of scope for v1: the account form and provider notes tell the user to create an app
password, and the server exposes an auth-method list so a future OAuth provider can be added without
changing the UI contract.

## Files

| File | Role |
| --- | --- |
| `src/server/email/accounts.ts` | Owned CRUD, AES-256-GCM encryption, validation, defaults, live toggles, host guard |
| `src/server/email/discover.ts` | Ordered discovery chain, autoconfig/autodiscover/SRV parsers, TLS/STARTTLS probes |
| `src/server/email/imap.ts` | imapflow client: folders, list, search, read, explicit attachment download |
| `src/server/email/smtp.ts` | nodemailer transport: send, verify |
| `src/server/email/mime.ts` | Header-injection checks, MIME build/parse, transfer decoding, HTML-to-text |
| `src/server/email/tools.ts` | The six model tools, live toggle checks, envelopes, approval metadata |
| `src/server/email/routes.ts` | Settings API, NDJSON discovery stream, connection tests |
| `src/server/email/errors.ts` | Actionable error mapping; never echoes an auth reply |
| `src/web/components/settings/EmailSettings.tsx` | Account cards and the add/edit wizard |
| `src/web/components/chat/email-tools.tsx` | List/search/read cards and the send/reply review card |

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

## Discovery

`POST /api/email/discover` streams one NDJSON line per attempt, then a final result. The wizard shows
each line and fills an editable form; a failed attempt never becomes a success. The order is fixed:

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
512 KB (XML) or 256 KB (JSON) with an 8 s timeout; probes time out after 6 s.

## Security model

- **Transport.** Stored accounts only accept TLS (`tls`) or required STARTTLS (`starttls`). imapflow
  runs with `doSTARTTLS: true`, so a server that omits or refuses the upgrade fails instead of
  authenticating in clear text. nodemailer uses `requireTLS` for STARTTLS. Certificates are always
  verified (`rejectUnauthorized: true`) with the server hostname as SNI/servername. Self-signed
  certificates are refused.
- **Hosts.** Every save, discovery result, probe, and connection re-checks the destination. Non-admins
  may only reach public addresses; private, loopback, link-local, CGNAT, and tailnet addresses are
  refused. Admins may point an account at a LAN server, as with provider base URLs and MCP servers.
  Discovery documents go through `publicFetch` for non-admins (pinned DNS, revalidated redirects) and
  ordinary `fetch` for admins, so an internal autoconfig endpoint remains reachable. Socket probes
  pass a guarded DNS lookup at connection time.
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
  `riskMetadata("outbound")`. The approval card shows the exact recipients, subject, and body. After
  untrusted content the generic gate names the outbound risk. Scheduled runs auto-deny; delegates and
  sub-agents never receive send or reply. A reply re-reads the original message and rejects any
  recipient that was not in its From/To/Cc/Reply-To (and must include the sender), so no hidden
  recipient can be added after approval; `In-Reply-To` and `References` are derived from the original.
- **Attachments.** Never fetched by list, search, or read. `email_read` downloads only part ids named
  in `downloadAttachments`, caps each at 20 MB and the whole message at 50 MB, stops a stream as soon
  as the budget is crossed, sanitizes name/MIME, and stores the file through `storeUpload` (quota).
  Temporary chats have no email tools and store nothing.

### Residual risks

- **DNS rebinding TOCTOU.** The host is checked before connecting and again through a guarded lookup
  where the client exposes one. A hostile resolver can still change its answer between a pre-check and
  a connection inside a library that does not accept a lookup hook (notably nodemailer and imapflow's
  initial STARTTLS socket). The window is small and matches the provider/MCP posture documented in
  `security.md`; keep untrusted mail providers on public DNS.
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
  XML/JSON, SRV ordering, heuristic order, host refusal.
- `mime.test.ts`: header-injection rejection, unicode round-trip, quoted-printable/base64, multipart
  parsing, filename/MIME sanitation, HTML-to-text.
- `protocol.test.ts`: in-process `node:net`/`node:tls` mock IMAP and SMTP servers for connect, auth,
  folders, list, search, read, attachment streaming, SMTP send, STARTTLS success and fail-closed, and
  certificate verification.
- `tools.test.ts`: approval metadata, delegate exclusion, temporary chats, live read/send toggles,
  model envelopes, reply recipient validation, explicit attachment download and quota.
- `approval.test.ts`: the real chat turn asks for approval on a clean send, names the outbound risk
  after untrusted content, and auto-denies in an unattended schedule.
