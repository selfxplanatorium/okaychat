// Editable email drafts shared by the `draft_email` tool and the inline draft card. A draft belongs
// to one user and one chat; its id is opaque. Every content change bumps `revision`, and writes are
// compare-and-set on it. See docs/implementation/email.md ("Draft card").

export const EMAIL_DRAFT_LIMITS = {
  /** Same cap as email_send's body. */
  body: 100_000,
  subject: 998,
  /** Entries stored per recipient field. Sending allows at most `sendRecipients` in total. */
  entries: 50,
  entry: 400,
  sendRecipients: 25,
  perThread: 100,
  perUser: 2_000,
} as const;

export type EmailDraftStatus = "draft" | "sending" | "sent";

/** The editable content. Recipient entries are what the user typed: `a@b.test` or `Name <a@b.test>`. */
export interface EmailDraftFields {
  accountId: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  /** Opaque email_read message id this draft replies to; a reply is sent through the reply checks. */
  inReplyTo: string | null;
}

export interface EmailDraft extends EmailDraftFields {
  /** Text drafts share revision/autosave storage but can never be sent as mail. */
  kind?: "email" | "text";
  id: string;
  threadId: string;
  messageId: string | null;
  toolCallId: string | null;
  revision: number;
  status: EmailDraftStatus;
  /** Who wrote the current revision. A model write after user edits shows the "updated" state. */
  updatedBy: "user" | "model";
  /** The stored account id no longer exists; editing requires choosing another account. */
  accountMissing: boolean;
  sentAt: number | null;
  sendCount: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface EmailDraftPatch {
  revision: number;
  fields: Partial<EmailDraftFields>;
  /** Binds the draft to the assistant message that holds its card, once. */
  messageId?: string;
}

/** Exactly what will be sent, as the server built it from the stored revision and the live account. */
export interface EmailDraftReview {
  reviewId: string;
  revision: number;
  expiresAt: number;
  accountId: string;
  accountLabel: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  signature: string;
  reply: boolean;
}

export interface EmailDraftSendResult {
  draft: EmailDraft;
  accepted: string[];
  rejected: string[];
}

const LINE_BREAK = /[\r\n\0]/;

export const hasLineBreak = (value: string) => LINE_BREAK.test(value);

/** Splits a typed recipient line. Commas and semicolons separate entries; empty pieces are dropped. */
export function splitRecipients(text: string): string[] {
  return text
    .split(/[,;\r\n]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export const joinRecipients = (entries: readonly string[]) => entries.join(", ");

/** `Name <a@b.test>` or `a@b.test`. Returns null for anything else; the server checks the address. */
export function parseRecipient(entry: string): { address: string; name?: string } | null {
  const value = entry.trim();
  if (!value || hasLineBreak(value)) return null;
  const angle = /^(.*?)\s*<([^<>\s]+)>$/.exec(value);
  if (angle) {
    const name = angle[1]!.trim().replace(/^"(.*)"$/, "$1").trim();
    return { address: angle[2]!, ...(name ? { name } : {}) };
  }
  return /[\s<>]/.test(value) ? null : { address: value };
}

/** A UI hint only: the server's mailbox check is stricter and authoritative. */
export function looksLikeAddress(entry: string): boolean {
  const parsed = parseRecipient(entry);
  return !!parsed && /^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/.test(parsed.address);
}

export const emptyDraftFields = (): EmailDraftFields => ({ accountId: null, to: [], cc: [], bcc: [], subject: "", body: "", inReplyTo: null });
