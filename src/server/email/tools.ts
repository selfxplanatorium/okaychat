import type { ConnectionOptions } from "node:tls";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { EmailAccount, EmailAddress } from "../../shared/email.js";
import { accountForRead, accountSecrets, defaultAccount, listAccounts } from "./accounts.js";
import { EmailError } from "./errors.js";
import { downloadAttachment, listFolders, listMessages, readMessage, searchMessages, MAX_MESSAGE_ATTACHMENT_BYTES } from "./imap.js";
import { injectionMetadata, riskMetadata, scanForInjection, wrapUntrusted } from "../prompt-injection.js";
import { storeUpload } from "../files.js";
import { sendApproved, sendApprovedReply } from "./send.js";
import { isEmailAddress } from "./mime.js";
import { assertFeature } from "../permissions/guard.js";

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
  .refine((value) => noLineBreaks(value) && isEmailAddress(value), "Enter a valid single email address.");
const subject = z.string().trim().min(1).max(998).refine(noLineBreaks, "A subject cannot contain line breaks.");
const bodyText = z.string().min(1).max(100_000).refine((value) => !value.includes("\0"), "Invalid message text.");
const readAccountId = z.string().min(1).max(80).optional().describe("Account id from a previous email_folders result, or omit for the default account.");
const sendAccountId = z.string().min(1).max(80).describe("Account id from email_folders. Sending never guesses an account.");
const senderAddress = z.string().trim().max(320).refine((value) => noLineBreaks(value) && isEmailAddress(value), "Enter the account's from address.").describe("The connected account address this message is sent from.");
const messageId = z.string().min(1).max(2000).describe("Message id exactly as email_list or email_search returned it.");

const folderName = z.string().trim().min(1).max(300);
const party = z.object({ address: emailAddress, name: z.string().max(200).refine(noLineBreaks).optional() });

function publicAccount(account: EmailAccount) {
  return { id: account.id, label: account.label, address: account.address, isDefault: account.isDefault };
}

/** Safe inventory: never a password or server secret, but everything needed to choose and draft. */
function safeAccounts(userId: string) {
  return listAccounts(userId).map((account) => ({
    id: account.id,
    label: account.label,
    address: account.address,
    isDefault: account.isDefault,
    readEnabled: account.readEnabled,
    sendEnabled: account.sendEnabled,
    signature: account.signature.trim(),
  }));
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

  // Rechecked on every execution, so the feature and the account's read/send switches are both live.
  const guard = () => assertFeature(userId, "email");
  const readAccount = (id?: string) => accountForRead(userId, id);

  const email_folders = tool({
    description:
      "List the user's connected email accounts and, for one account, its folders (mailboxes). Call it with no accountId to see every owned account (id, label, address, default, read/send switches, signature). Then pass accountId to list folders before listing or searching a non-inbox folder. Omits message contents.",
    inputSchema: z.object({ accountId: readAccountId }),
    execute: async ({ accountId: id }) => {
      guard();
      const accounts = safeAccounts(userId);
      if (!accounts.length) throw new EmailError("protocol", "No email account is connected. Add one in Settings → Email.");
      if (!id) {
        const fallback = defaultAccount(userId);
        if (!fallback) throw new EmailError("protocol", "No email account is connected. Add one in Settings → Email.");
        if (!fallback.readEnabled) {
          // Still answer with the inventory so the model can pick another account; opening the
          // disabled default would fail and hide every other mailbox.
          const output = {
            accounts,
            account: publicAccount(fallback),
            folders: [] as Awaited<ReturnType<typeof listFolders>>,
            note: `Reading is turned off for the default account ${fallback.address}. Choose another accountId from accounts.`,
          };
          return { ...output, ...scan(output) };
        }
        // Inventory must remain available even when the default server is unreachable.
        const output = { accounts, account: publicAccount(fallback), folders: [] as Awaited<ReturnType<typeof listFolders>> };
        return { ...output, ...scan(output) };
      }
      const account = readAccount(id);
      const folders = await listFolders(accountSecrets(userId, account.id), opts.tls);
      const output = { accounts, account: publicAccount(account), folders };
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
      accountId: readAccountId,
      mailbox: folderName.optional().describe("Folder path from email_folders; defaults to INBOX."),
      limit: z.number().int().min(1).max(50).optional().describe("Max messages, default 15."),
      unreadOnly: z.boolean().optional().describe("Only messages without the \\Seen flag."),
    }),
    execute: async ({ accountId: id, mailbox, limit, unreadOnly }) => {
      guard();
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
      accountId: readAccountId,
      query: z.string().trim().min(1).max(300).optional().describe("Text in headers or body."),
      from: z.string().trim().min(1).max(300).refine(noLineBreaks).optional(),
      subject: z.string().trim().min(1).max(300).refine(noLineBreaks).optional(),
      since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.").optional().describe("Messages received on or after this date."),
      unseen: z.boolean().optional(),
      mailbox: folderName.optional(),
      limit: z.number().int().min(1).max(50).optional().describe("Max results, default 15."),
    }).refine((value) => value.query || value.from || value.subject || value.since || value.unseen, "Give at least one search field."),
    execute: async ({ accountId: id, ...query }) => {
      guard();
      const account = readAccount(id);
      const { query: text, ...rest } = query;
      const found = await searchMessages(accountSecrets(userId, account.id), { ...rest, text }, opts.tls);
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
      accountId: readAccountId,
      messageId,
      downloadAttachments: z
        .array(z.string().min(1).max(40))
        .max(20)
        .optional()
        .describe("Attachment part ids from a previous email_read of this message. Only pass ids the user explicitly wants."),
    }),
    execute: async ({ accountId: id, messageId: message, downloadAttachments }) => {
      guard();
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
            id: rest.message.id,
            mailbox: rest.message.mailbox,
            uid: rest.message.uid,
            subject: rest.message.subject,
            from: rest.message.from,
            to: rest.message.to,
            cc: rest.message.cc,
            replyTo: rest.message.replyTo,
            date: rest.message.date,
            messageId: rest.message.messageId,
            inReplyTo: rest.message.inReplyTo,
            references: rest.message.references,
            unread: rest.message.unread,
            flagged: rest.message.flagged,
            size: rest.message.size,
            hasAttachments: rest.message.hasAttachments,
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
    description: `Send a new email from a connected account. Always shows the exact from address, recipients, subject, and body for approval before anything is sent. accountId and from are required and must match the connected account. The server sends the body verbatim and never appends anything: when the account has a signature, include it exactly at the end of the body (email_folders returns it). At most ${MAX_RECIPIENTS} recipients.`,
    inputSchema: z.object({
      accountId: sendAccountId,
      from: senderAddress,
      to: z.array(party).min(1).max(MAX_RECIPIENTS),
      cc: z.array(party).max(MAX_RECIPIENTS).optional(),
      subject,
      body: bodyText.describe("The complete plain-text body exactly as it should be sent, including the account signature when one is set."),
    }).refine((value) => value.to.length + (value.cc?.length ?? 0) <= MAX_RECIPIENTS, `At most ${MAX_RECIPIENTS} recipients.`),
    metadata: riskMetadata("outbound"),
    needsApproval: true,
    execute: async ({ accountId: id, from, to, cc, subject, body }) => {
      guard();
      return sendApproved(userId, { accountId: id, from, to: getEmails(to), cc: cc ? getEmails(cc) : undefined, subject, body }, { tls: opts.tls });
    },
  });

  const email_reply = tool({
    description:
      "Reply to an existing email. The server re-reads the original message and refuses recipients that were not part of that conversation, so the approval preview shows exactly who will receive it. Always requires approval. accountId and from are required; pass the original sender in `to` and thread participants in `cc` for reply-all; the server supplies In-Reply-To and References. The body is sent verbatim and must include the account signature exactly when one is set.",
    inputSchema: z.object({
      accountId: sendAccountId,
      from: senderAddress,
      messageId,
      to: z.array(party).min(1).max(MAX_RECIPIENTS).describe("Must include the original sender's address (or its Reply-To)."),
      cc: z.array(party).max(MAX_RECIPIENTS).optional().describe("Only addresses that already appeared in the original From, To, Cc, or Reply-To."),
      subject: subject.describe('Use the original subject with a "Re:" prefix.'),
      body: bodyText.describe("The complete plain-text body exactly as it should be sent, including the account signature when one is set."),
    }).refine((value) => value.to.length + (value.cc?.length ?? 0) <= MAX_RECIPIENTS, `At most ${MAX_RECIPIENTS} recipients.`),
    metadata: riskMetadata("outbound"),
    needsApproval: true,
    execute: async ({ accountId: id, from, messageId: message, to, cc, subject, body }) => {
      guard();
      return sendApprovedReply(userId, { accountId: id, from, messageId: message, to: getEmails(to), cc: cc ? getEmails(cc) : undefined, subject, body }, { tls: opts.tls });
    },
  });

  // Read tools are safe for delegates; anything that sends is never exposed to them.
  const readTools: ToolSet = { email_folders, email_list, email_search, email_read };
  return {
    tools: { ...readTools, email_send, email_reply },
    subTools: readTools,
  };
}
