import type { ConnectionOptions } from "node:tls";
import nodemailer from "nodemailer";
import type { EmailAddress, EmailSendResult } from "../../shared/email.js";
import type { EmailSecrets } from "./accounts.js";
import { EmailError, mapEmailError } from "./errors.js";
import { assertAddressList, assertHeaderValue, buildMime } from "./mime.js";

// SMTP sending through nodemailer. A STARTTLS endpoint always requires the upgrade (requireTLS), so
// a server that cannot provide TLS fails instead of receiving credentials in cleartext. The raw
// message is built by mime.ts, and the SMTP envelope lists exactly the approved recipients.

const CONNECTION_TIMEOUT = 15_000;
const GREETING_TIMEOUT = 10_000;
const SOCKET_TIMEOUT = 60_000;
export const MAX_RECIPIENTS = 25;

function transportFor(secrets: EmailSecrets, tls?: ConnectionOptions) {
  const { smtp } = secrets;
  const servername = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(smtp.host) || smtp.host.includes(":") ? undefined : smtp.host;
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.security === "tls",
    requireTLS: smtp.security === "starttls",
    servername,
    auth: { user: smtp.username, pass: secrets.password },
    name: "okaychat.local",
    connectionTimeout: CONNECTION_TIMEOUT,
    greetingTimeout: GREETING_TIMEOUT,
    socketTimeout: SOCKET_TIMEOUT,
    logger: false,
    debug: false,
    tls: { rejectUnauthorized: true, servername, ...tls },
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

function withSignature(secrets: EmailSecrets, text: string): string {
  const signature = secrets.account.signature.trim();
  if (!signature) return text;
  return `${text.replace(/\s+$/, "")}\n\n-- \n${signature}`;
}

export async function sendEmail(secrets: EmailSecrets, mail: OutgoingMail, opts: { tls?: ConnectionOptions } = {}): Promise<EmailSendResult> {
  validate(mail);
  const from = secrets.account.address;
  const text = withSignature(secrets, mail.text);
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
  const transport = transportFor(secrets, opts.tls);
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
  const transport = transportFor(secrets, tls);
  try {
    await transport.verify();
  } catch (error) {
    throw mapEmailError(error, "SMTP server");
  } finally {
    transport.close();
  }
}
