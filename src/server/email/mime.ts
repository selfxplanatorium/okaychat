import { simpleParser, type ParsedMail } from "mailparser";
import MailComposer, { type MailComposerOptions } from "nodemailer/lib/mail-composer";
import type { EmailAddress } from "../../shared/email.js";

// Safe MIME building and parsing. Header values are checked for CR/LF before nodemailer sees them,
// so a subject, address, or message id cannot inject an extra header. Bodies and encodings are left
// to nodemailer/mailparser, which handle unicode, quoted-printable, base64, and multipart correctly.

export class EmailHeaderError extends Error {}

const HEADER_FORBIDDEN = /[\r\n\0]/u;
const MAILBOX_FORBIDDEN = /[\s\u0000-\u001f\u007f<>()",;:\\[\]]/u;
const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_LABEL = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

/**
 * Exactly one mailbox in dotted-atom form. Commas, semicolons, quotes, parentheses, groups, and
 * comments are refused so a reviewed address can never be parsed by the mail library as a list or
 * as a different mailbox than the one shown to the user.
 */
export function isEmailAddress(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 320 || MAILBOX_FORBIDDEN.test(value)) return false;
  const at = value.lastIndexOf("@");
  if (at <= 0 || at !== value.indexOf("@")) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length > 64 || !LOCAL_PART.test(local)) return false;
  if (!domain || domain.length > 253) return false;
  if (IPV4.test(domain)) return domain.split(".").every((part) => Number(part) <= 255);
  return domain.split(".").every((label) => DOMAIN_LABEL.test(label));
}

/** Throws when a value could break out of its header line. Never trims silently. */
export function assertHeaderValue(name: string, value: string, max = 4000): string {
  if (typeof value !== "string" || HEADER_FORBIDDEN.test(value)) throw new EmailHeaderError(`${name} cannot contain line breaks.`);
  if (value.length > max) throw new EmailHeaderError(`${name} is too long.`);
  return value;
}

export function assertAddressList(field: string, values: readonly EmailAddress[]): void {
  for (const value of values) {
    assertHeaderValue(field, value.address, 320);
    if (!isEmailAddress(value.address)) throw new EmailHeaderError(`${field} contains an invalid address: ${value.address.slice(0, 80)}`);
    if (value.name !== undefined) assertHeaderValue(field, value.name, 200);
  }
}

/** Attachment names are metadata, not paths. Strip separators, control characters, and leading dots. */
export function sanitizeFilename(name: string, fallback = "attachment"): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .split(/[\\/]+/)
    .filter((part) => part && part !== "." && part !== "..")
    .join("_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

export function sanitizeMime(mime: string | undefined): string {
  const value = (mime ?? "").split(";")[0]!.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,60}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,60}$/.test(value) ? value : "application/octet-stream";
}

/** Quoted-printable body decoding, including soft line breaks. Works on bytes so UTF-8 survives. */
export function decodeQuotedPrintable(text: string): Buffer {
  const out: number[] = [];
  const bytes = Buffer.from(text, "latin1");
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!;
    if (byte === 0x3d /* = */) {
      if (bytes[i + 1] === 0x0d && bytes[i + 2] === 0x0a) { i += 2; continue; }
      if (bytes[i + 1] === 0x0a) { i += 1; continue; }
      const hex = String.fromCharCode(bytes[i + 1] ?? 0, bytes[i + 2] ?? 0);
      if (/^[0-9a-f]{2}$/i.test(hex)) { out.push(parseInt(hex, 16)); i += 2; continue; }
    }
    out.push(byte);
  }
  return Buffer.from(out);
}

/** Quoted-printable header-decoding ("Q" encoding): underscores are spaces. */
export function decodeQEncoding(text: string): string {
  return decodeQuotedPrintable(text.replaceAll("_", " ")).toString("utf8");
}

export function decodeTransferEncoding(content: Buffer | string, encoding: string | undefined, charset = "utf-8"): string {
  const raw = typeof content === "string" ? Buffer.from(content, "latin1") : content;
  const normalized = (encoding ?? "").toLowerCase().trim();
  let bytes: Buffer;
  if (normalized === "base64") {
    // Whitespace and a missing tail are tolerated by decoders; Buffer's base64 ignores invalid characters.
    bytes = Buffer.from(raw.toString("ascii").replace(/\s+/g, ""), "base64");
  } else if (normalized === "quoted-printable") {
    bytes = decodeQuotedPrintable(raw.toString("latin1"));
  } else {
    bytes = raw;
  }
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

/** Turns an HTML mail body into readable text. The app never renders mail HTML. */
export async function htmlToText(html: string): Promise<string> {
  const { parseHTML } = await import("linkedom");
  const { document } = parseHTML(html);
  for (const node of document.querySelectorAll("script, style, noscript, iframe, object, svg")) node.remove();
  // Keep link targets readable without loading anything remote.
  for (const anchor of document.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href");
    if (href && /^https?:/i.test(href)) anchor.textContent = `${anchor.textContent ?? ""} (${href})`;
  }
  return (document.body?.textContent ?? document.textContent ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface MailMessage {
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  replyTo?: EmailAddress[];
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string[];
  messageId?: string;
  headers?: Record<string, string>;
}

/** Builds an RFC 5322 message. Every header field is checked before composition. */
export async function buildMime(message: MailMessage): Promise<Buffer> {
  assertHeaderValue("From", message.from.address, 320);
  if (!isEmailAddress(message.from.address)) throw new EmailHeaderError("From contains an invalid address.");
  if (message.from.name) assertHeaderValue("From", message.from.name, 200);
  assertAddressList("To", message.to);
  assertAddressList("Cc", message.cc ?? []);
  assertAddressList("Bcc", message.bcc ?? []);
  assertAddressList("Reply-To", message.replyTo ?? []);
  assertHeaderValue("Subject", message.subject, 998);
  if (message.inReplyTo) assertHeaderValue("In-Reply-To", message.inReplyTo, 998);
  for (const reference of message.references ?? []) assertHeaderValue("References", reference, 998);
  if (message.messageId) assertHeaderValue("Message-ID", message.messageId, 998);
  for (const [name, value] of Object.entries(message.headers ?? {})) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) throw new EmailHeaderError("Invalid header name.");
    assertHeaderValue(name, value, 4000);
  }
  const options: MailComposerOptions = {
    from: message.from,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    replyTo: message.replyTo,
    subject: message.subject,
    text: message.text,
    inReplyTo: message.inReplyTo,
    references: message.references,
    messageId: message.messageId,
    headers: message.headers,
    // No file or URL content here, but keep the composer from ever resolving one.
    disableFileAccess: true,
    disableUrlAccess: true,
  };
  return new MailComposer(options).compile().build();
}

export interface ParsedEmail {
  parsed: ParsedMail;
  text: string;
}

/** Parses a complete message (used by tests and for small downloaded sources). */
export async function parseMime(source: Buffer | string): Promise<ParsedEmail> {
  const parsed = await simpleParser(source, { skipTextToHtml: true, skipImageLinks: true });
  return { parsed, text: parsed.text ?? (parsed.html ? await htmlToText(parsed.html) : "") };
}

/** Address objects from mailparser or IMAP headers, bounded and stripped of empty entries. */
export function toAddresses(value: { value?: Array<{ name?: string; address?: string }> } | undefined): EmailAddress[] {
  return (value?.value ?? [])
    .filter((entry): entry is { name?: string; address: string } => typeof entry.address === "string" && entry.address.length > 0)
    .slice(0, 100)
    .map((entry) => ({ address: entry.address.slice(0, 320), ...(entry.name ? { name: entry.name.slice(0, 200) } : {}) }));
}
