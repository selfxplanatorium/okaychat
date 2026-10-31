// Email accounts are IMAP for reading and SMTP for sending, with a password or app password.
// OAuth is deliberately out of scope for v1; the server exposes an auth-method list so the UI can
// explain that only password auth exists yet. See docs/implementation/email.md.

export type EmailSecurity = "tls" | "starttls";

/** A server endpoint as the UI shows it. The password never leaves the server. */
export interface EmailServerConfig {
  host: string;
  port: number;
  security: EmailSecurity;
  username: string;
}

export interface EmailAccount {
  id: string;
  label: string;
  address: string;
  imap: EmailServerConfig;
  smtp: EmailServerConfig;
  /** Reading tools are allowed to use this account. */
  readEnabled: boolean;
  /** Sending tools may use this account; every send still needs approval. */
  sendEnabled: boolean;
  isDefault: boolean;
  signature: string;
  /**
   * Allows unauthenticated plaintext probing during discovery for this account's domain. It never
   * permits credentials over plaintext: reads and sends still require TLS.
   */
  allowInsecureProbe: boolean;
  lastCheckAt: number | null;
  lastCheckStatus: "ok" | "failed" | null;
  lastCheckError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface EmailAccountInput {
  label: string;
  address: string;
  /** Omitted on edit preserves the stored password. */
  password?: string;
  imap: EmailServerConfig;
  smtp: EmailServerConfig;
  signature?: string;
  readEnabled?: boolean;
  sendEnabled?: boolean;
  allowInsecureProbe?: boolean;
  isDefault?: boolean;
}

export type EmailConfidence = "high" | "medium" | "low";

export interface EmailDiscoveryServer {
  host: string;
  port: number;
  security: EmailSecurity;
  username: string;
}

export interface EmailDiscoveryAttempt {
  stage: "preset" | "thunderbird" | "microsoft" | "srv" | "heuristic" | "probe";
  status: "running" | "ok" | "failed" | "skipped";
  label: string;
  detail?: string;
  confidence?: EmailConfidence;
}

export interface EmailDiscoveryResult {
  email: string;
  imap: EmailDiscoveryServer | null;
  smtp: EmailDiscoveryServer | null;
  source: string | null;
  confidence: EmailConfidence | null;
  attempts: EmailDiscoveryAttempt[];
  notes: string[];
  /** Proton Mail needs the Bridge; no usable server settings exist otherwise. */
  needsBridge?: boolean;
}

/** NDJSON lines streamed by `POST /api/email/discover`. */
export type EmailDiscoveryEvent =
  | { type: "attempt"; attempt: EmailDiscoveryAttempt }
  | { type: "result"; result: EmailDiscoveryResult }
  | { type: "error"; error: string };

export interface EmailAuthMethod {
  id: "password" | "oauth";
  label: string;
  available: boolean;
  note?: string;
}

export interface EmailFolder {
  path: string;
  name: string;
  delimiter: string;
  specialUse?: string;
}

/** Stable message handle: mailbox + UIDVALIDITY + UID. */
export interface EmailMessageId {
  id: string;
  mailbox: string;
  uid: number;
  uidValidity: string;
}

export interface EmailAddress {
  name?: string;
  address: string;
}

export interface EmailMessageSummary {
  id: string;
  mailbox: string;
  uid: number;
  subject: string;
  from: EmailAddress[];
  to: EmailAddress[];
  date: string | null;
  unread: boolean;
  flagged: boolean;
  size: number;
  hasAttachments: boolean;
}

export interface EmailAttachmentInfo {
  /** IMAP body part identifier; pass it back to email_read to download explicitly. */
  part: string;
  filename: string;
  mime: string;
  size: number;
}

export interface EmailMessage extends EmailMessageSummary {
  cc: EmailAddress[];
  replyTo: EmailAddress[];
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  body: string;
  bodyTruncated: boolean;
  attachments: EmailAttachmentInfo[];
}

export interface EmailStoredAttachment extends EmailAttachmentInfo {
  fileId: string;
  url: string;
}

export interface EmailSendResult {
  accountId: string;
  from: string;
  to: string[];
  cc: string[];
  /** Present only when the message had envelope-only recipients. */
  bcc?: string[];
  subject: string;
  accepted: string[];
  rejected: string[];
}
