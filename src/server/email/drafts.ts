import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  EMAIL_DRAFT_LIMITS as LIMITS,
  emptyDraftFields,
  hasLineBreak,
  parseRecipient,
  type EmailDraft,
  type EmailDraftFields,
  type EmailDraftReview,
  type EmailDraftSendResult,
  type EmailDraftStatus,
} from "../../shared/email-draft.js";
import type { EmailAddress } from "../../shared/email.js";
import { newId } from "../crypto.js";
import { db, tx } from "../db.js";
import { accountForSend, getAccount } from "./accounts.js";
import { mapEmailError } from "./errors.js";
import { buildMime, isEmailAddress } from "./mime.js";
import { sendApproved, sendApprovedReply, type ApprovedMail, type SendOptions } from "./send.js";

// Email drafts shared by the draft_email tool and the inline card. Every read and write is scoped to
// the owning user and chat. Content writes are compare-and-set on `revision`, so an autosave cannot
// overwrite a newer model write (or the reverse) without noticing. Sending is a separate, explicit
// two-step: `reviewDraft` builds the exact payload from the stored revision and the live account and
// returns a single-use token bound to both; `sendDraft` accepts only that token, claims the row with
// one conditional UPDATE (so two sends cannot both start), and goes through the same approved-send
// service as email_send/email_reply. Drafts are text and are not charged to the storage quota; the
// per-chat and per-account caps bound them instead (docs/implementation/storage-quota.md).

const REVIEW_TTL_MS = 10 * 60_000;
/** SMTP gives up well before this. A row still "sending" afterwards was interrupted by a restart. */
const SENDING_STALE_MS = 5 * 60_000;

interface DraftRow {
  kind: "email" | "text";
  id: string;
  thread_id: string;
  user_id: string;
  message_id: string | null;
  tool_call_id: string | null;
  account_id: string | null;
  to_json: string;
  cc_json: string;
  bcc_json: string;
  subject: string;
  body: string;
  in_reply_to: string | null;
  revision: number;
  status: EmailDraftStatus;
  updated_by: "user" | "model";
  sending_at: number | null;
  sending_from: "draft" | "sent" | null;
  sent_at: number | null;
  send_count: number;
  last_error: string | null;
  review_hash: string | null;
  review_revision: number | null;
  review_payload: string | null;
  review_expires: number | null;
  created_at: number;
  updated_at: number;
}

function fail(status: 400 | 404 | 409 | 422, message: string): never {
  throw new HTTPException(status, { message });
}

const noBreak = (value: string) => !hasLineBreak(value);
const entry = z.string().max(LIMITS.entry, "A recipient is too long.").refine(noBreak, "A recipient cannot contain line breaks.");
const entries = z.array(entry).max(LIMITS.entries, `At most ${LIMITS.entries} recipients per field.`);

export const draftFieldsSchema = z
  .object({
    accountId: z.string().min(1).max(80).nullable(),
    to: entries,
    cc: entries,
    bcc: entries,
    subject: z.string().max(LIMITS.subject, "The subject is too long.").refine(noBreak, "A subject cannot contain line breaks."),
    body: z.string().max(LIMITS.body, `The body can be at most ${LIMITS.body} characters.`).refine((value) => !value.includes("\0"), "Invalid message text."),
    inReplyTo: z.string().min(1).max(2000).nullable(),
  })
  .strict();

export const draftPatchSchema = z
  .object({
    revision: z.number().int().min(1),
    fields: draftFieldsSchema.partial(),
    messageId: z.string().min(1).max(200).optional(),
  })
  .strict();

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) fail(400, parsed.error.issues[0]?.message ?? "Invalid draft.");
  return parsed.data!;
}

const clean = (list: readonly string[]) => list.map((value) => value.trim()).filter(Boolean);

function threadOwned(userId: string, threadId: string): boolean {
  return !!db.prepare("SELECT 1 FROM threads WHERE id = ? AND user_id = ?").get(threadId, userId);
}

function accountExists(userId: string, accountId: string): boolean {
  return !!db.prepare("SELECT 1 FROM email_accounts WHERE id = ? AND user_id = ?").get(accountId, userId);
}

/** A card binds its draft to the assistant message that shows it, but only inside this same chat. */
function messageInThread(threadId: string, messageId: string): boolean {
  return !!db.prepare("SELECT 1 FROM messages WHERE thread_id = ? AND id = ?").get(threadId, messageId);
}

function assertThread(userId: string, threadId: string): void {
  if (!threadOwned(userId, threadId)) fail(404, "Chat not found");
}

function rowOf(userId: string, threadId: string, id: string): DraftRow {
  assertThread(userId, threadId);
  const select = () => db.prepare("SELECT * FROM email_drafts WHERE user_id = ? AND thread_id = ? AND id = ?").get(userId, threadId, id) as DraftRow | undefined;
  const row = select();
  if (!row) fail(404, "Draft not found");
  if (row!.status === "sending" && (row!.sending_at ?? 0) < Date.now() - SENDING_STALE_MS) {
    // The process stopped mid-send. The message may or may not have left, so say so instead of
    // silently allowing a resend or keeping the draft locked forever.
    db.prepare(
      "UPDATE email_drafts SET status = coalesce(sending_from, 'draft'), sending_at = NULL, sending_from = NULL, last_error = ? WHERE user_id = ? AND thread_id = ? AND id = ? AND status = 'sending'",
    ).run("A previous send did not finish. Check your Sent folder before sending again.", userId, threadId, id);
    return select()!;
  }
  return row!;
}

function assertTextFields(fields: EmailDraftFields): void {
  if (fields.accountId || fields.inReplyTo || fields.to.length || fields.cc.length || fields.bcc.length) {
    fail(422, "Text drafts only support a title and body.");
  }
}

function fieldsOf(row: DraftRow): EmailDraftFields {
  return {
    accountId: row.account_id,
    to: JSON.parse(row.to_json) as string[],
    cc: JSON.parse(row.cc_json) as string[],
    bcc: JSON.parse(row.bcc_json) as string[],
    subject: row.subject,
    body: row.body,
    inReplyTo: row.in_reply_to,
  };
}

function toDraft(row: DraftRow): EmailDraft {
  return {
    kind: row.kind,
    id: row.id,
    threadId: row.thread_id,
    messageId: row.message_id,
    toolCallId: row.tool_call_id,
    ...fieldsOf(row),
    revision: row.revision,
    status: row.status,
    updatedBy: row.updated_by,
    accountMissing: !!row.account_id && !accountExists(row.user_id, row.account_id),
    sentAt: row.sent_at,
    sendCount: row.send_count,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getDraft(userId: string, threadId: string, id: string): EmailDraft {
  return toDraft(rowOf(userId, threadId, id));
}

export function createDraft(
  userId: string,
  threadId: string,
  input: Partial<EmailDraftFields>,
  meta: { toolCallId?: string; by: "user" | "model"; kind?: "email" | "text" },
): EmailDraft {
  assertThread(userId, threadId);
  const parsed = parseInput(draftFieldsSchema.partial(), input);
  const fields: EmailDraftFields = { ...emptyDraftFields(), ...parsed };
  if (meta.kind === "text") assertTextFields(fields);
  if (fields.accountId && !accountExists(userId, fields.accountId)) fail(404, "Email account not found");
  const perThread = (db.prepare("SELECT count(*) AS n FROM email_drafts WHERE user_id = ? AND thread_id = ?").get(userId, threadId) as { n: number }).n;
  if (perThread >= LIMITS.perThread) fail(409, `A chat can hold at most ${LIMITS.perThread} drafts. Discard some first.`);
  const perUser = (db.prepare("SELECT count(*) AS n FROM email_drafts WHERE user_id = ?").get(userId) as { n: number }).n;
  if (perUser >= LIMITS.perUser) fail(409, `An account can hold at most ${LIMITS.perUser} drafts. Discard some first.`);
  const id = newId("drf");
  const now = Date.now();
  db.prepare(
    `INSERT INTO email_drafts (id, thread_id, user_id, tool_call_id, account_id, to_json, cc_json, bcc_json, subject, body, in_reply_to, revision, status, updated_by, created_at, updated_at, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'draft', ?, ?, ?, ?)`,
  ).run(
    id, threadId, userId, meta.toolCallId ?? null, fields.accountId,
    JSON.stringify(clean(fields.to)), JSON.stringify(clean(fields.cc)), JSON.stringify(clean(fields.bcc)),
    fields.subject, fields.body, fields.inReplyTo, meta.by, now, now, meta.kind ?? "email",
  );
  return getDraft(userId, threadId, id);
}

/**
 * Content write. `revision` must be the one the writer last saw; anything else is a 409 so the card
 * can keep the user's text and offer a choice instead of losing either side.
 */
export function updateDraft(userId: string, threadId: string, id: string, input: unknown, by: "user" | "model"): EmailDraft {
  const patch = parseInput(draftPatchSchema, input);
  const row = rowOf(userId, threadId, id);
  if (row.status === "sending") fail(409, "This draft is being sent and cannot be edited.");
  if (row.status === "sent") fail(409, "This email was already sent. A sent draft is read-only.");
  if (patch.revision !== row.revision) fail(409, `This draft changed since it was loaded (now revision ${row.revision}).`);
  const current = fieldsOf(row);
  const next: EmailDraftFields = { ...current, ...patch.fields };
  if (row.kind === "text") assertTextFields(next);
  next.to = clean(next.to);
  next.cc = clean(next.cc);
  next.bcc = clean(next.bcc);
  if (next.accountId && !accountExists(userId, next.accountId)) {
    if (patch.fields.accountId !== undefined && patch.fields.accountId !== current.accountId) fail(404, "Email account not found");
    fail(422, "The email account for this draft was removed. Choose another account.");
  }
  // A message id from another chat (or one that has not been stored yet) must never bind the card.
  const bindMessage = patch.messageId && messageInThread(threadId, patch.messageId) ? patch.messageId : null;
  const changed = JSON.stringify(next) !== JSON.stringify(current);
  if (!changed) {
    if (bindMessage) db.prepare("UPDATE email_drafts SET message_id = coalesce(message_id, ?) WHERE user_id = ? AND thread_id = ? AND id = ?").run(bindMessage, userId, threadId, id);
    return getDraft(userId, threadId, id);
  }
  const result = db.prepare(
    `UPDATE email_drafts SET account_id = ?, to_json = ?, cc_json = ?, bcc_json = ?, subject = ?, body = ?, in_reply_to = ?,
       revision = revision + 1, updated_by = ?, message_id = coalesce(message_id, ?), last_error = NULL,
       review_hash = NULL, review_revision = NULL, review_payload = NULL, review_expires = NULL, updated_at = ?
     WHERE user_id = ? AND thread_id = ? AND id = ? AND revision = ? AND status = 'draft'`,
  ).run(
    next.accountId, JSON.stringify(next.to), JSON.stringify(next.cc), JSON.stringify(next.bcc), next.subject, next.body, next.inReplyTo,
    by, bindMessage, Date.now(), userId, threadId, id, patch.revision,
  );
  if (result.changes !== 1) fail(409, "This draft changed since it was loaded.");
  return getDraft(userId, threadId, id);
}

export function deleteDraft(userId: string, threadId: string, id: string): void {
  const row = rowOf(userId, threadId, id);
  if (row.status === "sending") fail(409, "This draft is being sent. Wait for the send to finish.");
  db.prepare("DELETE FROM email_drafts WHERE user_id = ? AND thread_id = ? AND id = ? AND status != 'sending'").run(userId, threadId, id);
}

/**
 * A downloadable RFC 5322 draft. Nothing leaves the server and no send switch applies, so this works
 * for an account whose sending is off. It goes through the same MIME builder as a real send, so
 * unicode subjects and bodies get the standard encoded-word and transfer encodings, never raw
 * non-ASCII header bytes. The body is exported verbatim: no signature is ever appended here.
 */
export async function draftEml(userId: string, threadId: string, id: string): Promise<{ filename: string; content: ArrayBuffer }> {
  const row = rowOf(userId, threadId, id);
  if (row.kind === "text") fail(422, "Text drafts cannot be exported as email.");
  const fields = fieldsOf(row);
  const to = recipients("To", fields.to);
  const cc = recipients("Cc", fields.cc);
  const bcc = recipients("Bcc", fields.bcc);
  if (hasLineBreak(fields.subject)) fail(422, "A subject cannot contain line breaks.");
  if (fields.body.length > LIMITS.body) fail(422, "The body is too large.");
  const account = fields.accountId && accountExists(userId, fields.accountId) ? getAccount(userId, fields.accountId) : null;
  const fallback = (db.prepare("SELECT email FROM users WHERE id = ?").get(userId) as { email: string } | undefined)?.email ?? "draft@localhost";
  const from = account?.address ?? fallback;
  const content = await buildMime({
    from: { address: isEmailAddress(from) ? from : "draft@localhost" },
    to,
    cc: cc.length ? cc : undefined,
    bcc: bcc.length ? bcc : undefined,
    subject: fields.subject,
    text: fields.body,
  });
  const bytes = new Uint8Array(content.byteLength);
  bytes.set(content);
  return { filename: `email-draft-${row.id}.eml`, content: bytes.buffer };
}

function recipients(field: string, list: readonly string[]): EmailAddress[] {
  return list.map((value) => {
    const parsed = parseRecipient(value);
    if (!parsed || !isEmailAddress(parsed.address) || parsed.address.length > 320) fail(422, `${field}: "${value.slice(0, 80)}" is not a valid single email address.`);
    if (parsed.name && parsed.name.length > 200) fail(422, `${field}: a display name is too long.`);
    return parsed!;
  });
}

const format = (list: EmailAddress[]) => list.map((entry) => (entry.name ? `${entry.name} <${entry.address}>` : entry.address));

/** Builds the exact payload from the stored revision and the live account. Throws the reason it cannot be sent. */
function prepare(userId: string, row: DraftRow): { review: Omit<EmailDraftReview, "reviewId" | "expiresAt">; mail: ApprovedMail; reply: string | null } {
  if (row.kind === "text") fail(422, "Text drafts cannot be sent as email.");
  const fields = fieldsOf(row);
  if (!fields.accountId) fail(422, "Choose the email account to send from.");
  if (!accountExists(userId, fields.accountId!)) fail(422, "The email account for this draft was removed. Choose another account.");
  // Live send switch, re-read now; the same check runs again inside the send service.
  const account = accountForSend(userId, fields.accountId!);
  const to = recipients("To", fields.to);
  const cc = recipients("Cc", fields.cc);
  const bcc = recipients("Bcc", fields.bcc);
  if (!to.length) fail(422, "Add at least one recipient in To.");
  if (to.length + cc.length + bcc.length > LIMITS.sendRecipients) fail(422, `A message can have at most ${LIMITS.sendRecipients} recipients.`);
  if (fields.inReplyTo && bcc.length) fail(422, "A reply cannot have Bcc recipients. Remove them or send a new message instead.");
  if (hasLineBreak(fields.subject)) fail(422, "A subject cannot contain line breaks.");
  const signature = account.signature.trim();
  if (signature && !fields.body.endsWith(`\n\n-- \n${signature}`)) {
    fail(422, `The body must end with this account's signature exactly:\n\n-- \n${signature}`);
  }
  return {
    review: {
      revision: row.revision,
      accountId: account.id,
      accountLabel: account.label,
      from: account.address,
      to: format(to),
      cc: format(cc),
      bcc: format(bcc),
      subject: fields.subject,
      body: fields.body,
      signature,
      reply: !!fields.inReplyTo,
    },
    mail: { accountId: account.id, from: account.address, to, cc, bcc, subject: fields.subject, body: fields.body },
    reply: fields.inReplyTo,
  };
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const payloadHash = (review: Omit<EmailDraftReview, "reviewId" | "expiresAt">) => sha256(JSON.stringify(review));

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Step one of a user send: the exact payload for the user to confirm, and a single-use token bound to
 * this revision and this payload. A new review replaces any earlier one; any content write clears it.
 */
export function reviewDraft(userId: string, threadId: string, id: string, revision: number): EmailDraftReview {
  const row = rowOf(userId, threadId, id);
  if (row.status === "sending") fail(409, "This draft is being sent.");
  if (row.revision !== revision) fail(409, `This draft changed since it was loaded (now revision ${row.revision}).`);
  let prepared: ReturnType<typeof prepare>;
  try {
    prepared = prepare(userId, row);
  } catch (error) {
    // A failed review invalidates any token from an earlier attempt too.
    clearReview(userId, threadId, id);
    throw error;
  }
  const { review } = prepared;
  const token = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + REVIEW_TTL_MS;
  const result = db.prepare(
    `UPDATE email_drafts SET review_hash = ?, review_revision = ?, review_payload = ?, review_expires = ?
     WHERE user_id = ? AND thread_id = ? AND id = ? AND revision = ? AND status = ?`,
  ).run(sha256(token), row.revision, payloadHash(review), expiresAt, userId, threadId, id, row.revision, row.status);
  if (result.changes !== 1) fail(409, "This draft changed since it was loaded.");
  return { ...review, reviewId: token, expiresAt };
}

export const sendInputSchema = z.object({ reviewId: z.string().min(16).max(200), revision: z.number().int().min(1) }).strict();

/** Step two: sends exactly the reviewed revision, once. */
export async function sendDraft(userId: string, threadId: string, id: string, input: unknown, opts: SendOptions = {}): Promise<EmailDraftSendResult> {
  const { reviewId, revision } = parseInput(sendInputSchema, input);
  const row = rowOf(userId, threadId, id);
  if (row.status === "sending") fail(409, "This draft is already being sent.");
  const valid =
    !!row.review_hash &&
    sameHash(sha256(reviewId), row.review_hash) &&
    row.review_revision === revision &&
    row.revision === revision &&
    (row.review_expires ?? 0) > Date.now();
  if (!valid) fail(409, "This review is no longer valid. Review the draft again before sending.");
  // Rebuilt from the row and the live account: an account address, signature, or send-switch change
  // since review changes the hash (or throws), so the user never sends something they did not see.
  let prepared: ReturnType<typeof prepare>;
  try {
    prepared = prepare(userId, row);
  } catch (error) {
    clearReview(userId, threadId, id);
    throw error;
  }
  if (payloadHash(prepared.review) !== row.review_payload) {
    clearReview(userId, threadId, id);
    fail(409, "The draft or its account changed after review. Review it again before sending.");
  }
  const claimed = db.prepare(
    `UPDATE email_drafts SET status = 'sending', sending_at = ?, sending_from = status, last_error = NULL,
       review_hash = NULL, review_revision = NULL, review_payload = NULL, review_expires = NULL
     WHERE user_id = ? AND thread_id = ? AND id = ? AND revision = ? AND status = ? AND review_hash = ?`,
  ).run(Date.now(), userId, threadId, id, revision, row.status, row.review_hash);
  if (claimed.changes !== 1) fail(409, "This draft is already being sent or changed after review.");
  try {
    const result = prepared.reply
      ? await sendApprovedReply(userId, { ...prepared.mail, messageId: prepared.reply }, opts)
      : await sendApproved(userId, prepared.mail, opts);
    const now = Date.now();
    db.prepare(
      `UPDATE email_drafts SET status = 'sent', sent_at = ?, send_count = send_count + 1, sending_at = NULL, sending_from = NULL, last_error = NULL, updated_at = ?
       WHERE user_id = ? AND thread_id = ? AND id = ? AND status = 'sending'`,
    ).run(now, now, userId, threadId, id);
    return { draft: getDraft(userId, threadId, id), accepted: result.accepted, rejected: result.rejected };
  } catch (error) {
    const status = error instanceof HTTPException ? error.status : 422;
    const message = error instanceof HTTPException ? error.message : mapEmailError(error, "SMTP server").message;
    db.prepare(
      `UPDATE email_drafts SET status = coalesce(sending_from, 'draft'), sending_at = NULL, sending_from = NULL, last_error = ?
       WHERE user_id = ? AND thread_id = ? AND id = ? AND status = 'sending'`,
    ).run(message, userId, threadId, id);
    throw new HTTPException(status === 400 || status === 404 || status === 409 ? status : 422, { message });
  }
}

function clearReview(userId: string, threadId: string, id: string): void {
  db.prepare("UPDATE email_drafts SET review_hash = NULL, review_revision = NULL, review_payload = NULL, review_expires = NULL WHERE user_id = ? AND thread_id = ? AND id = ?").run(userId, threadId, id);
}

/**
 * A branch copies the messages that show a draft card, so it copies those drafts too (ids are per
 * chat, like message ids). Only drafts whose id appears in the copied messages come along; a review
 * in progress never does, and a send interrupted in the source stays a draft in the copy.
 */
export function copyDraftsForBranch(userId: string, sourceId: string, targetId: string, messageJson: readonly string[]): void {
  const rows = db.prepare("SELECT * FROM email_drafts WHERE user_id = ? AND thread_id = ?").all(userId, sourceId) as unknown as DraftRow[];
  const text = messageJson.join("\n");
  const insert = db.prepare(
    `INSERT INTO email_drafts (id, thread_id, user_id, message_id, tool_call_id, account_id, to_json, cc_json, bcc_json, subject, body, in_reply_to,
       revision, status, updated_by, sent_at, send_count, last_error, created_at, updated_at, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  tx(() => {
    for (const row of rows) {
      if (!text.includes(row.id)) continue;
      const status = row.status === "sending" ? (row.sending_from ?? "draft") : row.status;
      insert.run(
        row.id, targetId, userId, row.message_id, row.tool_call_id, row.account_id, row.to_json, row.cc_json, row.bcc_json, row.subject, row.body, row.in_reply_to,
        row.revision, status, row.updated_by, row.sent_at, row.send_count, row.last_error, row.created_at, Date.now(), row.kind,
      );
    }
  });
}

/** Model-facing rendering of a draft. The caller envelopes it: the text may hold the user's edits. */
export function draftForModel(draft: EmailDraft) {
  return {
    draftId: draft.id,
    revision: draft.revision,
    status: draft.status,
    lastWriter: draft.updatedBy,
    accountId: draft.accountId,
    ...(draft.accountMissing ? { accountRemoved: true } : {}),
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    body: draft.body,
    inReplyTo: draft.inReplyTo,
    sentAt: draft.sentAt ? new Date(draft.sentAt).toISOString() : null,
  };
}
