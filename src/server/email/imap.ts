import type { ConnectionOptions } from "node:tls";
import { ImapFlow, type FetchMessageObject, type MessageStructureObject } from "imapflow";
import { parseAddressHeader } from "mailparser";
import type { EmailAddress, EmailAttachmentInfo, EmailFolder, EmailMessage, EmailMessageSummary } from "../../shared/email.js";
import type { EmailSecrets } from "./accounts.js";
import { emailConnectTarget } from "./accounts.js";
import { EmailError, mapEmailError } from "./errors.js";
import { htmlToText, sanitizeFilename, sanitizeMime } from "./mime.js";
import { verifySmtp } from "./smtp.js";

// IMAP reading through imapflow. Connections always use TLS or a required STARTTLS upgrade; a
// STARTTLS-capable server that fails or omits the upgrade is refused (doSTARTTLS), so credentials
// never cross a plaintext link. Attachments are never fetched by list/search/read; only an explicit
// download request streams them, bounded per file and per message.

const INBOX = "INBOX";
const LIST_LIMIT = 50;
const MAX_FOLDERS = 500;
const MAX_BODY_CHARS = 100_000;
const MAX_PART_BYTES = 2 * 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const CONNECTION_TIMEOUT = 15_000;
const GREETING_TIMEOUT = 10_000;
const SOCKET_TIMEOUT = 60_000;

const active = new Map<string, number>();
const MAX_PER_ACCOUNT = 2;

function clientFor(secrets: EmailSecrets, target: { host: string; servername?: string }, tls?: ConnectionOptions): ImapFlow {
  const { imap } = secrets;
  return new ImapFlow({
    // The address is already resolved and checked (pinned for non-admins), so imapflow's own
    // resolver cannot be rebound between the guard and this connection.
    host: target.host,
    port: imap.port,
    secure: imap.security === "tls",
    // Required STARTTLS: refuse to authenticate if the upgrade is missing or fails.
    doSTARTTLS: imap.security === "starttls",
    servername: target.servername,
    auth: { user: imap.username, pass: secrets.password, loginMethod: "LOGIN" },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: CONNECTION_TIMEOUT,
    greetingTimeout: GREETING_TIMEOUT,
    socketTimeout: SOCKET_TIMEOUT,
    tls: { rejectUnauthorized: true, servername: target.servername, ...tls },
  });
}

async function withClient<T>(secrets: EmailSecrets, run: (client: ImapFlow) => Promise<T>, tls?: ConnectionOptions): Promise<T> {
  const id = secrets.account.id;
  const count = active.get(id) ?? 0;
  if (count >= MAX_PER_ACCOUNT) {
    throw new EmailError("connections", "This email account already has two open connections. Wait for the current request to finish and try again.");
  }
  // Re-check the live admin role and resolve/pin the host immediately before every connection,
  // including verify, reply, and attachment downloads.
  const target = await emailConnectTarget(secrets.userId, secrets.imap.host).catch((error: unknown) => {
    throw mapEmailError(error, "IMAP server");
  });
  active.set(id, count + 1);
  const client = clientFor(secrets, target, tls);
  try {
    await client.connect();
    return await run(client);
  } catch (error) {
    throw mapEmailError(error);
  } finally {
    try {
      if (client.usable) await client.logout();
      else client.close();
    } catch {
      client.close();
    }
    const left = (active.get(id) ?? 1) - 1;
    if (left > 0) active.set(id, left);
    else active.delete(id);
  }
}

function addresses(value: Array<{ name?: string; address?: string }> | undefined): EmailAddress[] {
  return (value ?? [])
    .filter((entry): entry is { name?: string; address: string } => !!entry.address)
    .slice(0, 100)
    .map((entry) => ({ address: entry.address.slice(0, 320), ...(entry.name ? { name: entry.name.slice(0, 200) } : {}) }));
}

export function encodeMessageId(mailbox: string, uidValidity: string | bigint, uid: number): string {
  return Buffer.from(JSON.stringify({ m: mailbox, v: String(uidValidity), u: uid }), "utf8").toString("base64url");
}

export function decodeMessageId(id: string): { mailbox: string; uidValidity: string; uid: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(id, "base64url").toString("utf8"));
  } catch {
    parsed = null;
  }
  const value = parsed as { m?: unknown; v?: unknown; u?: unknown } | null;
  if (!value || typeof value.m !== "string" || !value.m || value.m.length > 500 || typeof value.v !== "string" || !value.v || typeof value.u !== "number" || !Number.isInteger(value.u) || value.u < 1) {
    throw new EmailError("not_found", "That message id is not valid. List or search again to get a current one.");
  }
  return { mailbox: value.m, uidValidity: value.v, uid: value.u };
}

function walk(part: MessageStructureObject | undefined, out: MessageStructureObject[] = []): MessageStructureObject[] {
  if (!part) return out;
  out.push(part);
  for (const child of part.childNodes ?? []) walk(child, out);
  return out;
}

function isAttachment(part: MessageStructureObject): boolean {
  if (part.disposition?.toLowerCase() === "attachment") return true;
  // A named text part is an attachment too (text/plain; name="notes.txt"). Without this a named
  // text attachment could be mistaken for the message body.
  const name = part.dispositionParameters?.filename ?? part.parameters?.name;
  return !!name;
}

export function attachmentsOf(structure: MessageStructureObject | undefined): EmailAttachmentInfo[] {
  return walk(structure)
    .filter((part) => part.part && isAttachment(part))
    .slice(0, 100)
    .map((part) => ({
      part: part.part!,
      filename: sanitizeFilename(part.dispositionParameters?.filename ?? part.parameters?.name ?? "attachment"),
      mime: sanitizeMime(part.type),
      size: Math.max(0, part.size ?? 0),
    }));
}

function isoDate(value: Date | string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function summary(message: FetchMessageObject, mailbox: string, uidValidity: string): EmailMessageSummary {
  const envelope = message.envelope;
  const flags = message.flags ?? new Set<string>();
  return {
    id: encodeMessageId(mailbox, uidValidity, message.uid),
    mailbox,
    uid: message.uid,
    subject: (envelope?.subject ?? "").slice(0, 500),
    from: addresses(envelope?.from),
    to: addresses(envelope?.to),
    date: isoDate(envelope?.date ?? message.internalDate),
    unread: !flags.has("\\Seen"),
    flagged: flags.has("\\Flagged"),
    size: message.size ?? 0,
    hasAttachments: attachmentsOf(message.bodyStructure).length > 0,
  };
}

const summaryQuery = { uid: true, envelope: true, flags: true, internalDate: true, size: true, bodyStructure: true } as const;

export async function listFolders(secrets: EmailSecrets, tls?: ConnectionOptions): Promise<EmailFolder[]> {
  return withClient(secrets, async (client) => {
    const list = await client.list();
    const folders = list
      .filter((folder) => folder.path && folder.path !== "\\Noselect")
      .slice(0, MAX_FOLDERS)
      .map((folder) => ({
        path: folder.path,
        name: folder.name || folder.path,
        delimiter: folder.delimiter || "/",
        ...(folder.specialUse ? { specialUse: folder.specialUse } : {}),
      }));
    return folders.sort((a, b) => (a.path === INBOX ? -1 : b.path === INBOX ? 1 : a.path.localeCompare(b.path)));
  }, tls);
}

function preferredMailbox(folder: string | undefined): string {
  const name = (folder ?? "").trim();
  return name || INBOX;
}

export async function listMessages(secrets: EmailSecrets, opts: { mailbox?: string; limit?: number; unreadOnly?: boolean } = {}, tls?: ConnectionOptions): Promise<{ mailbox: string; messages: EmailMessageSummary[] }> {
  const mailbox = preferredMailbox(opts.mailbox);
  const limit = Math.min(Math.max(opts.limit ?? 15, 1), LIST_LIMIT);
  return withClient(secrets, async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const box = client.mailbox;
      if (!box) throw new EmailError("not_found", `Folder "${mailbox}" is not available.`);
      const uidValidity = String(box.uidValidity);
      const messages: EmailMessageSummary[] = [];
      const query = summaryQuery;
      if (opts.unreadOnly) {
        const found = (await client.search({ seen: false }, { uid: true })) || [];
        const uids = found.slice(-limit);
        for (const uid of uids) {
          const message = await client.fetchOne(String(uid), query, { uid: true });
          if (message) messages.push(summary(message, mailbox, uidValidity));
        }
      } else {
        const start = Math.max(1, box.exists - limit + 1);
        for await (const message of client.fetch(`${start}:*`, query)) messages.push(summary(message, mailbox, uidValidity));
      }
      // Newest first: sequence order arrives ascending; UID order is ascending too.
      messages.sort((a, b) => b.uid - a.uid);
      return { mailbox, messages };
    } finally {
      lock.release();
    }
  }, tls);
}

export interface EmailSearchQuery {
  mailbox?: string;
  text?: string;
  from?: string;
  subject?: string;
  since?: string;
  unseen?: boolean;
  limit?: number;
}

export async function searchMessages(secrets: EmailSecrets, query: EmailSearchQuery, tls?: ConnectionOptions): Promise<{ mailbox: string; messages: EmailMessageSummary[] }> {
  const mailbox = preferredMailbox(query.mailbox);
  const limit = Math.min(Math.max(query.limit ?? 15, 1), LIST_LIMIT);
  const search: Record<string, unknown> = {};
  if (query.text) search.text = query.text;
  if (query.from) search.from = query.from;
  if (query.subject) search.subject = query.subject;
  if (query.since) search.since = new Date(query.since);
  if (query.unseen) search.seen = false;
  if (!Object.keys(search).length) search.all = true;
  return withClient(secrets, async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const box = client.mailbox;
      if (!box) throw new EmailError("not_found", `Folder "${mailbox}" is not available.`);
      const uidValidity = String(box.uidValidity);
      const found = (await client.search(search, { uid: true })) || [];
      const messages: EmailMessageSummary[] = [];
      for (const uid of found.slice(-limit).reverse()) {
        const message = await client.fetchOne(String(uid), summaryQuery, { uid: true });
        if (message) messages.push(summary(message, mailbox, uidValidity));
      }
      return { mailbox, messages };
    } finally {
      lock.release();
    }
  }, tls);
}

function headerValue(block: Buffer | undefined, name: string): string | null {
  if (!block) return null;
  const text = block.toString("utf8").replace(/\r?\n[ \t]+/g, " ");
  const match = new RegExp(`^${name}:\\s*(.+)$`, "im").exec(text);
  return match?.[1]?.trim().slice(0, 2000) ?? null;
}

function safeAddressHeader(value: string): EmailAddress[] {
  try {
    return parseAddressHeader(value).value
      .slice(0, 100)
      .map((entry) => ({ address: entry.address ?? "", ...(entry.name ? { name: entry.name } : {}) }))
      .filter((entry) => entry.address);
  } catch {
    return [];
  }
}

function referencesOf(value: string | null): string[] {
  if (!value) return [];
  return [...value.matchAll(/<[^<>\s]{1,998}>/g)].map((match) => match[0]).slice(0, 50);
}

export interface EmailReadResult {
  message: EmailMessage;
  /** Raw headers the reply tool validates against. Never rendered as HTML. */
  headers: { messageId: string | null; inReplyTo: string | null; references: string[] };
}

async function readStream(stream: NodeJS.ReadableStream, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array);
    size += buffer.byteLength;
    if (size > max) throw new EmailError("too_large", "This message body is larger than the reading limit.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}

/**
 * imapflow converts known text charsets to UTF-8 and reports that in `meta.charset`. If conversion
 * was skipped (an unknown charset), decode the transfer-decoded bytes with the declared charset
 * before falling back to UTF-8. Decoding a UTF-8 body again is a no-op.
 */
function textBody(buffer: Buffer, charset: string | undefined): string {
  const name = (charset ?? "").trim().toLowerCase();
  if (!name || name === "utf-8" || name === "utf8" || name === "us-ascii" || name === "ascii") return buffer.toString("utf8");
  try {
    return new TextDecoder(name).decode(buffer);
  } catch {
    return buffer.toString("utf8");
  }
}

export async function readMessage(secrets: EmailSecrets, messageId: string, tls?: ConnectionOptions): Promise<EmailReadResult> {
  const { mailbox, uidValidity, uid } = decodeMessageId(messageId);
  return withClient(secrets, async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const box = client.mailbox;
      if (!box) throw new EmailError("not_found", `Folder "${mailbox}" is not available.`);
      // A UIDVALIDITY change means the id now points at a different message.
      if (uidValidity !== String(box.uidValidity)) {
        throw new EmailError("not_found", "That message is no longer available; the folder was rebuilt. List or search again.");
      }
      const message = await client.fetchOne(String(uid), {
        ...summaryQuery,
        headers: ["Message-ID", "In-Reply-To", "References", "Reply-To"],
      }, { uid: true });
      if (!message) throw new EmailError("not_found", "That message no longer exists in this folder.");
      if ((message.size ?? 0) > MAX_MESSAGE_ATTACHMENT_BYTES && attachmentsOf(message.bodyStructure).length === 0) {
        throw new EmailError("too_large", "That message is larger than 50 MB.");
      }
      const parts = walk(message.bodyStructure);
      const single = !message.bodyStructure?.childNodes;
      const plain = parts.find((part) => part.type.toLowerCase() === "text/plain" && !isAttachment(part) && (part.part || single));
      const html = parts.find((part) => part.type.toLowerCase() === "text/html" && !isAttachment(part) && (part.part || single));
      let body = "";
      if (plain) {
        const partId = plain.part ?? "1";
        const download = await client.download(String(uid), partId, { uid: true, maxBytes: MAX_PART_BYTES });
        if (download.content) body = textBody(await readStream(download.content, MAX_PART_BYTES), download.meta?.charset);
      }
      if (!body.trim() && html) {
        const partId = html.part ?? "1";
        const download = await client.download(String(uid), partId, { uid: true, maxBytes: MAX_PART_BYTES });
        if (download.content) body = await htmlToText(textBody(await readStream(download.content, MAX_PART_BYTES), download.meta?.charset));
      }
      const truncated = body.length > MAX_BODY_CHARS;
      if (truncated) body = `${body.slice(0, MAX_BODY_CHARS)}\n\n[truncated]`;
      const base = summary(message, mailbox, uidValidity);
      const messageIdHeader = headerValue(message.headers, "Message-ID");
      const inReplyTo = headerValue(message.headers, "In-Reply-To");
      const references = referencesOf(headerValue(message.headers, "References"));
      const replyToRaw = headerValue(message.headers, "Reply-To");
      return {
        message: {
          ...base,
          cc: addresses(message.envelope?.cc),
          replyTo: replyToRaw ? safeAddressHeader(replyToRaw) : addresses(message.envelope?.replyTo),
          messageId: messageIdHeader,
          inReplyTo,
          references,
          body,
          bodyTruncated: truncated,
          attachments: attachmentsOf(message.bodyStructure),
        },
        headers: { messageId: messageIdHeader, inReplyTo, references },
      };
    } finally {
      lock.release();
    }
  }, tls);
}

export interface DownloadedAttachment {
  filename: string;
  mime: string;
  size: number;
  data: Uint8Array;
}

/**
 * Downloads one attachment by part id. `remaining` is the message-wide budget the caller already
 * spent; the stream stops as soon as either limit is crossed, before the whole file is buffered.
 */
export async function downloadAttachment(secrets: EmailSecrets, messageId: string, partId: string, remaining = MAX_MESSAGE_ATTACHMENT_BYTES, tls?: ConnectionOptions): Promise<DownloadedAttachment> {
  const { mailbox, uidValidity, uid } = decodeMessageId(messageId);
  const budget = Math.min(MAX_ATTACHMENT_BYTES, remaining);
  if (budget <= 0) throw new EmailError("too_large", `One message can download at most ${MAX_MESSAGE_ATTACHMENT_BYTES / 1024 / 1024} MB of attachments.`);
  return withClient(secrets, async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const box = client.mailbox;
      if (!box) throw new EmailError("not_found", `Folder "${mailbox}" is not available.`);
      if (uidValidity !== String(box.uidValidity)) throw new EmailError("not_found", "That message is no longer available; list it again.");
      const message = await client.fetchOne(String(uid), { uid: true, bodyStructure: true }, { uid: true });
      if (!message) throw new EmailError("not_found", "That message no longer exists in this folder.");
      const found = attachmentsOf(message.bodyStructure).find((attachment) => attachment.part === partId);
      if (!found) throw new EmailError("not_found", `That attachment is not in this message. Available: ${attachmentsOf(message.bodyStructure).map((a) => a.part).join(", ") || "none"}.`);
      if (found.size > budget) throw new EmailError("too_large", `That attachment is larger than the ${Math.round(budget / 1024 / 1024)} MB remaining limit.`);
      const download = await client.download(String(uid), partId, { uid: true, maxBytes: budget + 1 });
      if (!download.content) throw new EmailError("not_found", "That attachment could not be downloaded.");
      const data = await readStream(download.content, budget);
      const filename = sanitizeFilename(download.meta.filename ?? found.filename);
      const mime = sanitizeMime(download.meta.contentType ?? found.mime);
      return { filename, mime, size: data.byteLength, data };
    } finally {
      lock.release();
    }
  }, tls);
}

/** Connects, authenticates, and checks the SMTP server too. Used by the settings Test button. */
export async function verifyAccount(secrets: EmailSecrets, opts: { tls?: ConnectionOptions } = {}): Promise<{ folders: number }> {
  const folders = await withClient(secrets, async (client) => (await client.list()).length, opts.tls);
  await verifySmtp(secrets, opts.tls);
  return { folders };
}
