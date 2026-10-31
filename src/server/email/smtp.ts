import type { ConnectionOptions } from "node:tls";
import nodemailer from "nodemailer";
import type { EmailAddress, EmailSendResult } from "../../shared/email.js";
import type { EmailSecrets } from "./accounts.js";
import { emailConnectTarget } from "./accounts.js";
import { EmailError, mapEmailError } from "./errors.js";
import { assertAddressList, assertHeaderValue, buildMime } from "./mime.js";

// SMTP sending through nodemailer. A STARTTLS endpoint always requires the upgrade (requireTLS), so
// a server that cannot provide TLS fails instead of receiving credentials in cleartext. The raw
// message is built by mime.ts and sent exactly as approved: this module never appends a signature or
// changes the sender after the user's review.

const CONNECTION_TIMEOUT = 15_000;
const GREETING_TIMEOUT = 10_000;
const SOCKET_TIMEOUT = 60_000;
export const MAX_RECIPIENTS = 25;

function transportFor(secrets: EmailSecrets, target: { host: string; servername?: string }, tls?: ConnectionOptions) {
  const { smtp } = secrets;
  return nodemailer.createTransport({
    // Resolved and checked (pinned for non-admins) immediately before this transport is created,
    // so nodemailer resolves a literal address and cannot follow a rebinding answer.
    host: target.host,
    port: smtp.port,
    secure: smtp.security === "tls",
    requireTLS: smtp.security === "starttls",
    servername: target.servername,
    auth: { user: smtp.username, pass: secrets.password },
    name: "okaychat.local",
    connectionTimeout: CONNECTION_TIMEOUT,
    greetingTimeout: GREETING_TIMEOUT,
    socketTimeout: SOCKET_TIMEOUT,
    logger: false,
    debug: false,
    tls: { rejectUnauthorized: true, servername: target.servername, ...tls },
    disableFileAccess: true,
    disableUrlAccess: true,
  });
}

export interface OutgoingMail {
  to: EmailAddress[];
  cc?: EmailAddress[];
  subject: string;
  text: string;
  replyTo?: EmailAddress[];
  inReplyTo?: string;
  references?: string[];
}

function validate(mail: OutgoingMail): void {
  if (!mail.to.length) throw new EmailError("protocol", "Add at least one recipient.");
  if (mail.to.length + (mail.cc?.length ?? 0) > MAX_RECIPIENTS) throw new EmailError("protocol", `A message can have at most ${MAX_RECIPIENTS} recipients.`);
  assertAddressList("To", mail.to);
  assertAddressList("Cc", mail.cc ?? []);
  assertAddressList("Reply-To", mail.replyTo ?? []);
  assertHeaderValue("Subject", mail.subject, 998);
  if (mail.inReplyTo) assertHeaderValue("In-Reply-To", mail.inReplyTo, 998);
  for (const reference of mail.references ?? []) assertHeaderValue("References", reference, 998);
}

export async function sendEmail(secrets: EmailSecrets, mail: OutgoingMail, opts: { tls?: ConnectionOptions } = {}): Promise<EmailSendResult> {
  validate(mail);
  const from = secrets.account.address;
  const text = mail.text;
  const raw = await buildMime({
    from: { address: from, name: secrets.account.label },
    to: mail.to,
    cc: mail.cc,
    replyTo: mail.replyTo,
    subject: mail.subject,
    text,
    inReplyTo: mail.inReplyTo,
    references: mail.references,
  });
  const recipients = [...mail.to, ...(mail.cc ?? [])].map((entry) => entry.address);
  const target = await emailConnectTarget(secrets.userId, secrets.smtp.host).catch((error: unknown) => {
    throw mapEmailError(error, "SMTP server");
  });
  const transport = transportFor(secrets, target, opts.tls);
  try {
    const info = await transport.sendMail({ envelope: { from, to: recipients }, raw });
    return {
      accountId: secrets.account.id,
      from,
      to: mail.to.map((entry) => entry.address),
      cc: (mail.cc ?? []).map((entry) => entry.address),
      subject: mail.subject,
      accepted: (info.accepted ?? []).map(String),
      rejected: (info.rejected ?? []).map(String),
    };
  } catch (error) {
    throw mapEmailError(error, "SMTP server");
  } finally {
    transport.close();
  }
}

/** SMTP-only connection check for the settings Test button. */
export async function verifySmtp(secrets: EmailSecrets, tls?: ConnectionOptions): Promise<void> {
  const target = await emailConnectTarget(secrets.userId, secrets.smtp.host).catch((error: unknown) => {
    throw mapEmailError(error, "SMTP server");
  });
  const transport = transportFor(secrets, target, tls);
  try {
    await transport.verify();
  } catch (error) {
    throw mapEmailError(error, "SMTP server");
  } finally {
    transport.close();
  }
}
