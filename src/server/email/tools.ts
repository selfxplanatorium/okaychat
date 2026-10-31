import type { ConnectionOptions } from "node:tls";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { EmailAddress } from "../../shared/email.js";
import { accountForRead, accountForSend, accountSecrets } from "./accounts.js";
import { EmailError } from "./errors.js";
import { downloadAttachment, listFolders, listMessages, readMessage, searchMessages, MAX_MESSAGE_ATTACHMENT_BYTES } from "./imap.js";
import { injectionMetadata, riskMetadata, scanForInjection, wrapUntrusted } from "../prompt-injection.js";
import { storeUpload } from "../files.js";
import { sendEmail, type OutgoingMail } from "./smtp.js";

// Model tools for email. Reads re-check the account's live read switch on every call; sends re-check
// the send switch and always need approval. Headers, folder names, subjects, senders, and bodies are
// third-party data, so every read result is enveloped for the model and scanned for the UI badge.
// Attachments are downloaded only when the model names their part ids, never as a side effect.

const MAX_RECIPIENTS = 25;
const noLineBreaks = (value: string) => !/[\r\n\0]/.test(value);
const emailAddress = z
  .string()
  .trim()
  .max(320)
  .refine((value) => noLineBreaks(value) && /^[^\s@<>]{1,64}@[^\s@<>]+$/.test(value), "Enter a valid email address.");
const subject = z.string().trim().min(1).max(998).refine(noLineBreaks, "A subject cannot contain line breaks.");
const bodyText = z.string().min(1).max(100_000).refine((value) => !value.includes("\0"), "Invalid message text.");
const accountId = z.string().min(1).max(80).optional().describe("Account id from a previous email tool result, or omit for the default account.");
const messageId = z.string().min(1).max(2000).describe("Message id exactly as email_list or email_search returned it.");

const folderName = z.string().trim().min(1).max(300);
const party = z.object({ address: emailAddress, name: z.string().max(200).refine(noLineBreaks).optional() });

function publicAccount(account: ReturnType<typeof accountForRead>) {
  return { id: account.id, label: account.label, address: account.address, isDefault: account.isDefault };
}

function getEmails(value: ReadonlyArray<z.infer<typeof party>>): EmailAddress[] {
  return value.map((entry) => ({ address: entry.address, ...(entry.name ? { name: entry.name } : {}) }));
}

function scan(value: unknown) {
  const report = scanForInjection(JSON.stringify(value));
  return injectionMetadata(report) ? { injection: report } : {};
}

function envelope(value: unknown, address: string, name: string) {
  return wrapUntrusted(JSON.stringify(value), { kind: "email", name, account: address }).text;
}

function validateAttachments(parts: string[] | undefined): string[] {
  if (!parts?.length) return [];
  if (parts.length > 20) throw new EmailError("too_large", "Request at most 20 attachments from one message.");
  for (const part of parts) {
    if (!/^[0-9]{1,4}(?:\.[0-9]{1,4}){0,6}$/.test(part)) throw new EmailError("not_found", `"${part.slice(0, 40)}" is not an attachment part id.`);
  }
  return parts;
}

export interface EmailTools {
  tools: ToolSet;
  subTools: ToolSet;
}

/**
 * Six email tools. `subTools` deliberately contains only the read tools: a delegate or schedule can
 * never send mail, and schedules auto-deny anything that needs approval anyway.
 */
export function emailTools(opts: { userId: string; temporary?: boolean; signal?: AbortSignal; tls?: ConnectionOptions }): EmailTools {
  if (opts.temporary) return { tools: {}, subTools: {} };
  const { userId } = opts;

  const readAccount = (id?: string) => accountForRead(userId, id);
  const sendAccount = (id?: string) => accountForSend(userId, id);

  const email_folders = tool({
    description: "List the folders (mailboxes) in the user's email account. Use it before listing or searching a non-inbox folder. Omits message contents.",
    inputSchema: z.object({ accountId }),
    execute: async ({ accountId: id }) => {
      const account = readAccount(id);
      const folders = await listFolders(accountSecrets(userId, account.id), opts.tls);
      const output = { account: publicAccount(account), folders };
      return { ...output, ...scan(output) };
    },
    toModelOutput: ({ output }) => {
      const { injection: _injection, ...rest } = output;
      return { type: "text", value: envelope(rest, rest.account.address, "email folders") };
    },
  });

  const email_list = tool({
    description: "List recent messages in one email folder, newest first, with stable message ids for email_read. Defaults to INBOX. Bodies are not fetched.",
    inputSchema: z.object({
      accountId,
      mailbox: folderName.optional().describe("Folder path from email_folders; defaults to INBOX."),
      limit: z.number().int().min(1).max(50).optional().describe("Max messages, default 15."),
      unreadOnly: z.boolean().optional().describe("Only messages without the \\Seen flag."),
    }),
    execute: async ({ accountId: id, mailbox, limit, unreadOnly }) => {
      const account = readAccount(id);
      const listed = await listMessages(accountSecrets(userId, account.id), { mailbox, limit, unreadOnly }, opts.tls);
      const output = { account: publicAccount(account), ...listed };
      return { ...output, ...scan(output) };
    },
    toModelOutput: ({ output }) => {
      const { injection: _injection, ...rest } = output;
      return { type: "text", value: envelope(rest, rest.account.address, "email list") };
    },
  });

  const email_search = tool({
    description: "Search an email folder by text, sender, subject, or date. Returns compact headers and stable message ids; use email_read for a body.",
    inputSchema: z.object({
      accountId,
      query: z.string().trim().min(1).max(300).optional().describe("Text in headers or body."),
      from: z.string().trim().min(1).max(300).refine(noLineBreaks).optional(),
      subject: z.string().trim().min(1).max(300).refine(noLineBreaks).optional(),
      since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.").optional().describe("Messages received on or after this date."),
      unseen: z.boolean().optional(),
      mailbox: folderName.optional(),
      limit: z.number().int().min(1).max(50).optional().describe("Max results, default 15."),
    }).refine((value) => value.query || value.from || value.subject || value.since || value.unseen, "Give at least one search field."),
    execute: async ({ accountId: id, ...query }) => {
      const account = readAccount(id);
      const found = await searchMessages(accountSecrets(userId, account.id), query, opts.tls);
      const output = { account: publicAccount(account), ...found };
      return { ...output, ...scan(output) };
    },
    toModelOutput: ({ output }) => {
      const { injection: _injection, ...rest } = output;
      return { type: "text", value: envelope(rest, rest.account.address, "email search results") };
    },
  });

  const email_read = tool({
    description: "Read one email by its message id: headers, plain-text body, and attachment names. Attachments are not downloaded unless you pass their part ids in `downloadAttachments`; a downloaded file is saved to the Library and returned with a file id.",
    inputSchema: z.object({
      accountId,
      messageId,
      downloadAttachments: z
        .array(z.string().min(1).max(40))
        .max(20)
        .optional()
        .describe("Attachment part ids from a previous email_read of this message. Only pass ids the user explicitly wants."),
    }),
    execute: async ({ accountId: id, messageId: message, downloadAttachments }) => {
      const account = readAccount(id);
      const secrets = accountSecrets(userId, account.id);
      const result = await readMessage(secrets, message, opts.tls);
      const parts = validateAttachments(downloadAttachments);
      const stored = [];
      let used = 0;
      for (const part of parts) {
        opts.signal?.throwIfAborted();
        const remaining = MAX_MESSAGE_ATTACHMENT_BYTES - used;
        const attachment = await downloadAttachment(secrets, message, part, remaining, opts.tls);
        used += attachment.data.byteLength;
        // Existing upload path: quota is charged here and the Library can serve it.
        const fileId = storeUpload(userId, attachment.filename, attachment.mime, attachment.data);
        const meta = result.message.attachments.find((entry) => entry.part === part);
        stored.push({
          part,
          filename: attachment.filename,
          mime: attachment.mime,
          size: attachment.size,
          fileId,
          url: `/api/uploads/${fileId}/file`,
          ...(meta ? { originalSize: meta.size } : {}),
        });
      }
      const output = {
        account: publicAccount(account),
        message: result.message,
        storedAttachments: stored,
      };
      return { ...output, ...scan(output) };
    },
    toModelOutput: ({ output }) => {
      const { injection: _injection, ...rest } = output;
      return {
        type: "text",
        value: envelope(
          {
            account: rest.account,
            mailbox: rest.message.mailbox,
            subject: rest.message.subject,
            from: rest.message.from,
            to: rest.message.to,
            cc: rest.message.cc,
            date: rest.message.date,
            messageId: rest.message.messageId,
            inReplyTo: rest.message.inReplyTo,
            references: rest.message.references,
            unread: rest.message.unread,
            attachments: rest.message.attachments,
            body: rest.message.body,
            bodyTruncated: rest.message.bodyTruncated,
            storedAttachments: rest.storedAttachments,
          },
          rest.account.address,
          rest.message.subject || "email message",
        ),
      };
    },
  });

  const email_send = tool({
    description: `Send a new email from the user's account. Always shows the exact recipients, subject, and body for approval before anything is sent. The From address is the connected account, never a chosen one. At most ${MAX_RECIPIENTS} recipients.`,
    inputSchema: z.object({
      accountId,
      to: z.array(party).min(1).max(MAX_RECIPIENTS),
      cc: z.array(party).max(MAX_RECIPIENTS).optional(),
      subject,
      body: bodyText.describe("Plain-text body. The account signature is added by the server."),
    }).refine((value) => value.to.length + (value.cc?.length ?? 0) <= MAX_RECIPIENTS, `At most ${MAX_RECIPIENTS} recipients.`),
    metadata: riskMetadata("outbound"),
    needsApproval: true,
    execute: async ({ accountId: id, to, cc, subject, body }) => {
      const account = sendAccount(id);
      const mail: OutgoingMail = { to: getEmails(to), cc: cc ? getEmails(cc) : undefined, subject, text: body };
      return sendEmail(accountSecrets(userId, account.id), mail, { tls: opts.tls });
    },
  });

  const email_reply = tool({
    description:
      "Reply to an existing email. The server re-reads the original message and refuses recipients that were not part of that conversation, so the approval preview shows exactly who will receive it. Always requires approval. Pass the original sender in `to` and thread participants in `cc` for reply-all; the server supplies In-Reply-To and References.",
    inputSchema: z.object({
      accountId,
      messageId,
      to: z.array(party).min(1).max(MAX_RECIPIENTS).describe("Must include the original sender's address (or its Reply-To)."),
      cc: z.array(party).max(MAX_RECIPIENTS).optional().describe("Only addresses that already appeared in the original From, To, Cc, or Reply-To."),
      subject: subject.describe('Use the original subject with a "Re:" prefix.'),
      body: bodyText,
    }).refine((value) => value.to.length + (value.cc?.length ?? 0) <= MAX_RECIPIENTS, `At most ${MAX_RECIPIENTS} recipients.`),
    metadata: riskMetadata("outbound"),
    needsApproval: true,
    execute: async ({ accountId: id, messageId: message, to, cc, subject, body }) => {
      const account = sendAccount(id);
      const secrets = accountSecrets(userId, account.id);
      const original = (await readMessage(secrets, message, opts.tls)).message;
      const normalize = (address: string) => address.trim().toLowerCase();
      const own = normalize(account.address);
      const replyTargets = (original.replyTo.length ? original.replyTo : original.from).map((entry) => normalize(entry.address)).filter((address) => address && address !== own);
      const participants = new Set([...original.from, ...original.to, ...original.cc, ...original.replyTo].map((entry) => normalize(entry.address)).filter((address) => address && address !== own));
      const toAddresses = to.map((entry) => normalize(entry.address));
      const ccAddresses = (cc ?? []).map((entry) => normalize(entry.address));
      if (!replyTargets.length) throw new EmailError("protocol", "That message has no sender to reply to.");
      if (!toAddresses.some((address) => replyTargets.includes(address))) {
        throw new EmailError("protocol", `A reply must go to the original sender (${replyTargets[0]}).`);
      }
      for (const address of [...toAddresses, ...ccAddresses]) {
        if (!replyTargets.includes(address) && !participants.has(address)) {
          throw new EmailError("protocol", `${address} did not appear in the original conversation, so it cannot be added to a reply.`);
        }
      }
      const expectedSubject = `Re: ${original.subject}`.trim();
      const normalizeSubject = (value: string) => value.replace(/^(?:\s*(?:re|fwd?):\s*)+/gi, "").trim().toLowerCase();
      if (normalizeSubject(subject) !== normalizeSubject(expectedSubject)) {
        throw new EmailError("protocol", `A reply keeps the original subject. Use "${expectedSubject.slice(0, 300)}".`);
      }
      const references = [ ...original.references, ...(original.messageId ? [original.messageId] : []) ].slice(-20);
      const mail: OutgoingMail = {
        to: getEmails(to),
        cc: cc ? getEmails(cc) : undefined,
        subject,
        text: body,
        inReplyTo: original.messageId ?? undefined,
        references,
      };
      const result = await sendEmail(secrets, mail, { tls: opts.tls });
      return { ...result, replyTo: original.messageId, originalSubject: original.subject };
    },
  });

  // Read tools are safe for delegates; anything that sends is never exposed to them.
  const readTools: ToolSet = { email_folders, email_list, email_search, email_read };
  return {
    tools: { ...readTools, email_send, email_reply },
    subTools: readTools,
  };
}
