import type { ConnectionOptions } from "node:tls";
import type { EmailAccount, EmailAddress, EmailSendResult } from "../../shared/email.js";
import { accountForRead, accountForSend, accountSecrets, type EmailSecrets } from "./accounts.js";
import { EmailError } from "./errors.js";
import { readMessage } from "./imap.js";
import { sendEmail, type OutgoingMail } from "./smtp.js";

// The one approved-send path. `email_send`/`email_reply` (after the chat approval) and the draft card
// (after its review confirmation) both end here, so the live send switch, the exact sender, the
// visible signature, and the reply participant rules cannot drift between callers.

export type Sender = (secrets: EmailSecrets, mail: OutgoingMail, opts: { tls?: ConnectionOptions }) => Promise<EmailSendResult>;
export type OriginalReader = typeof readMessage;

export interface SendOptions {
  tls?: ConnectionOptions;
  /** Tests inject a fake transport; production uses nodemailer through `sendEmail`. */
  sender?: Sender;
  reader?: OriginalReader;
}

/**
 * The approved body is exactly what leaves the server. A signature is user data, so it must already
 * be in the text the user reviewed; appending it after approval would hide content from them.
 */
export function approvedBody(account: EmailAccount, body: string): string {
  const signature = account.signature.trim();
  if (!signature) return body;
  const block = signatureBlock(account);
  if (!body.endsWith(block)) {
    throw new EmailError(
      "protocol",
      `The message body must end with the account signature exactly as email_folders returned it:\n\n-- \n${signature}`,
    );
  }
  return body;
}

/** The exact text a body must end with when the account has a signature. */
export const signatureBlock = (account: EmailAccount): string => {
  const signature = account.signature.trim();
  return signature ? `\n\n-- \n${signature}` : "";
};

/** The From address is part of the approval; a later account change must invalidate it. */
export function approvedSender(account: EmailAccount, from: string): EmailAccount {
  if (account.address.trim().toLowerCase() !== from.trim().toLowerCase()) {
    throw new EmailError("protocol", `Send from the connected account address (${account.address}). The account address changed after review.`);
  }
  return account;
}

/** Live send switch + exact sender + exact signature, re-read immediately before sending. */
export function approvedAccount(userId: string, accountId: string, from: string, body: string): { account: EmailAccount; text: string } {
  const account = approvedSender(accountForSend(userId, accountId), from);
  return { account, text: approvedBody(account, body) };
}

export interface ApprovedMail {
  accountId: string;
  from: string;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  body: string;
}

export async function sendApproved(userId: string, input: ApprovedMail, opts: SendOptions = {}): Promise<EmailSendResult> {
  const { account, text } = approvedAccount(userId, input.accountId, input.from, input.body);
  const mail: OutgoingMail = { to: input.to, cc: input.cc, bcc: input.bcc, subject: input.subject, text };
  return (opts.sender ?? sendEmail)(accountSecrets(userId, account.id), mail, { tls: opts.tls });
}

/**
 * A reply re-reads the original message and only allows its participants, so no hidden recipient can
 * be added after review. Bcc is refused for the same reason.
 */
export async function sendApprovedReply(
  userId: string,
  input: ApprovedMail & { messageId: string },
  opts: SendOptions = {},
): Promise<EmailSendResult & { replyTo: string | null; originalSubject: string }> {
  const { account, text } = approvedAccount(userId, input.accountId, input.from, input.body);
  if (input.bcc?.length) throw new EmailError("protocol", "A reply cannot have Bcc recipients. Remove them or send a new message instead.");
  // A reply also reads the original message, so the live read switch applies just as it does
  // to email_read; a send-only account cannot use a disabled read path.
  accountForRead(userId, account.id);
  const secrets = accountSecrets(userId, account.id);
  const original = (await (opts.reader ?? readMessage)(secrets, input.messageId, opts.tls)).message;
  const normalize = (address: string) => address.trim().toLowerCase();
  const own = normalize(account.address);
  const replyTargets = (original.replyTo.length ? original.replyTo : original.from).map((entry) => normalize(entry.address)).filter((address) => address && address !== own);
  const participants = new Set([...original.from, ...original.to, ...original.cc, ...original.replyTo].map((entry) => normalize(entry.address)).filter((address) => address && address !== own));
  const toAddresses = input.to.map((entry) => normalize(entry.address));
  const ccAddresses = (input.cc ?? []).map((entry) => normalize(entry.address));
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
  if (normalizeSubject(input.subject) !== normalizeSubject(expectedSubject)) {
    throw new EmailError("protocol", `A reply keeps the original subject. Use "${expectedSubject.slice(0, 300)}".`);
  }
  const references = [...original.references, ...(original.messageId ? [original.messageId] : [])].slice(-20);
  const mail: OutgoingMail = {
    to: input.to,
    cc: input.cc,
    subject: input.subject,
    text,
    inReplyTo: original.messageId ?? undefined,
    references,
  };
  const result = await (opts.sender ?? sendEmail)(secrets, mail, { tls: opts.tls });
  return { ...result, replyTo: original.messageId, originalSubject: original.subject };
}
