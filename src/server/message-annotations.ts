import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  FEEDBACK_BODY_LIMIT,
  MAX_BOOKMARKS_PER_THREAD,
  MAX_FEEDBACK_COMMENT,
  normalizeFeedbackComment,
  type MessageBookmark,
  type MessageFeedback,
  type ThreadAnnotations,
} from "../shared/message-annotations.js";
import type { AppEnv } from "./auth.js";
import { decrypt, encrypt } from "./crypto.js";
import { db, tx } from "./db.js";
import { AppError, errorJson } from "./errors.js";
import { assertStorage } from "./quota.js";
import { threadBusy } from "./thread-runs.js";
import { getThread, isTemporaryThread } from "./threads.js";
import { assertThreadContentReadable } from "./knowledge/thread-policy.js";

// Private per-message bookmarks and feedback. They hang off (thread id, message id), never enter message
// content, prompts, FTS, exports, or shares, and do not count as chat activity. See
// docs/implementation/message-annotations.md.

// One string for a foreign thread, an absent thread, and an absent message, so ids cannot be probed.
const MESSAGE_NOT_FOUND = "Message not found";
const THREAD_NOT_FOUND = "Thread not found";
const BUSY = "A reply is still being written in this chat. Wait for it to finish.";
const BOOKMARK_INVALID = "Only finished user or assistant messages can be bookmarked.";
const FEEDBACK_INVALID = "Feedback is only for assistant replies.";
const FEEDBACK_CONFLICT = "This feedback changed in another tab or window. Reload it before saving.";

const invalid = (message: string) => new AppError({ code: "validation", message });
const conflict = (message: string) => new AppError({ code: "conflict", message });
const notFound = (message: string) => new AppError({ code: "not_found", message });

interface MessageRow {
  format: string;
  content: string;
  edited_at: number | null;
}

/**
 * The stored message an annotation may target, with its current edit version. Ownership comes first so a
 * foreign thread is indistinguishable from a missing one, and the busy check comes last so a running turn
 * never gets a write it could overwrite.
 */
function annotatable(userId: string, threadId: string, messageId: string, options: { assistantOnly: boolean }): MessageRow {
  if (isTemporaryThread(threadId)) throw notFound(MESSAGE_NOT_FOUND);
  if (!getThread(userId, threadId)) throw notFound(MESSAGE_NOT_FOUND);
  const row = db.prepare("SELECT format, content, edited_at FROM messages WHERE thread_id = ? AND id = ?").get(threadId, messageId) as MessageRow | undefined;
  if (!row) throw notFound(MESSAGE_NOT_FOUND);
  // The lock gate runs only after the route's own not-found answer, so foreign/missing stay identical.
  assertThreadContentReadable(userId, threadId);
  const rejection = options.assistantOnly ? FEEDBACK_INVALID : BOOKMARK_INVALID;
  let role: unknown;
  try {
    const parsed = JSON.parse(row.content) as { role?: unknown } | null;
    role = parsed && typeof parsed === "object" ? parsed.role : undefined;
  } catch {
    throw invalid(rejection);
  }
  if (row.format !== "ai-sdk/v6" || (role !== "user" && role !== "assistant") || (options.assistantOnly && role !== "assistant")) {
    throw invalid(rejection);
  }
  // The client stores a turn when it ends, so a write now could describe a message that is still changing.
  if (threadBusy(threadId)) throw conflict(BUSY);
  return row;
}

function readAnnotations(userId: string, threadId: string): ThreadAnnotations {
  if (isTemporaryThread(threadId) || !getThread(userId, threadId)) throw notFound(THREAD_NOT_FOUND);
  assertThreadContentReadable(userId, threadId);
  const bookmarkRows = db
    .prepare("SELECT message_id, created_at FROM message_bookmarks WHERE thread_id = ? ORDER BY created_at, message_id")
    .all(threadId) as unknown as Array<{ message_id: string; created_at: number }>;
  const feedbackRows = db
    .prepare(`SELECT message_id, rating, comment_enc, message_edited_at, revision, created_at, updated_at
      FROM message_feedback WHERE thread_id = ? ORDER BY created_at, message_id`)
    .all(threadId) as unknown as Array<{
      message_id: string;
      rating: MessageFeedback["rating"];
      comment_enc: string | null;
      message_edited_at: number | null;
      revision: number;
      created_at: number;
      updated_at: number;
    }>;
  const bookmarks: MessageBookmark[] = bookmarkRows.map((row) => ({ messageId: row.message_id, createdAt: row.created_at }));
  const feedback: MessageFeedback[] = feedbackRows.map((row) => ({
    messageId: row.message_id,
    rating: row.rating,
    // The plaintext leaves the server only here.
    comment: row.comment_enc === null ? null : decrypt(row.comment_enc),
    revision: row.revision,
    messageEditedAt: row.message_edited_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
  return { bookmarks, feedback };
}

function addBookmark(userId: string, threadId: string, messageId: string): MessageBookmark {
  return tx(() => {
    annotatable(userId, threadId, messageId, { assistantOnly: false });
    // Idempotent: a repeated PUT keeps the original creation time so the jump list order stays stable.
    const existing = db.prepare("SELECT message_id, created_at FROM message_bookmarks WHERE thread_id = ? AND message_id = ?").get(threadId, messageId) as
      | { message_id: string; created_at: number }
      | undefined;
    if (existing) return { messageId: existing.message_id, createdAt: existing.created_at };
    const count = (db.prepare("SELECT COUNT(*) AS n FROM message_bookmarks WHERE thread_id = ?").get(threadId) as { n: number }).n;
    // The cap only blocks a new row; an existing mark stays usable at the limit.
    if (count >= MAX_BOOKMARKS_PER_THREAD) throw conflict(`A chat can have at most ${MAX_BOOKMARKS_PER_THREAD} bookmarks.`);
    const createdAt = Date.now();
    db.prepare("INSERT INTO message_bookmarks (thread_id, message_id, created_at) VALUES (?, ?, ?)").run(threadId, messageId, createdAt);
    return { messageId, createdAt };
  });
}

function removeBookmark(userId: string, threadId: string, messageId: string) {
  return tx(() => {
    annotatable(userId, threadId, messageId, { assistantOnly: false });
    db.prepare("DELETE FROM message_bookmarks WHERE thread_id = ? AND message_id = ?").run(threadId, messageId);
    return { ok: true };
  });
}

function writeFeedback(userId: string, threadId: string, messageId: string, input: { rating: MessageFeedback["rating"]; comment: string | null; expectedRevision: number }): MessageFeedback {
  return tx(() => {
    const target = annotatable(userId, threadId, messageId, { assistantOnly: true });
    const comment = normalizeFeedbackComment(input.comment);
    // A tombstone carries no text: the rating is what makes a comment meaningful, and removal clears it.
    if (comment !== null && input.rating === null) throw invalid("Choose Helpful or Not helpful before adding a comment.");
    if (comment !== null && [...comment].length > MAX_FEEDBACK_COMMENT) {
      throw invalid(`Feedback comments can be at most ${MAX_FEEDBACK_COMMENT} characters.`);
    }
    const existing = db
      .prepare("SELECT rating, comment_enc, message_edited_at, revision, created_at FROM message_feedback WHERE thread_id = ? AND message_id = ?")
      .get(threadId, messageId) as
      | { rating: MessageFeedback["rating"]; comment_enc: string | null; message_edited_at: number | null; revision: number; created_at: number }
      | undefined;
    // A missing row is revision 0, so two tabs that both opened it cannot both insert.
    const current = existing?.revision ?? 0;
    if (input.expectedRevision !== current) throw conflict(FEEDBACK_CONFLICT);
    const commentEnc = comment === null ? null : encrypt(comment);
    // Ciphertext grows with the plaintext; only the ciphertext is stored, so only it is charged.
    assertStorage(userId, Buffer.byteLength(commentEnc ?? "") - Buffer.byteLength(existing?.comment_enc ?? ""));
    const now = Date.now();
    if (!existing) {
      db.prepare(`INSERT INTO message_feedback (thread_id, message_id, rating, comment_enc, message_edited_at, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)`).run(threadId, messageId, input.rating, commentEnc, target.edited_at, now, now);
      return { messageId, rating: input.rating, comment, revision: 1, messageEditedAt: target.edited_at, createdAt: now, updatedAt: now };
    }
    const result = db
      .prepare(`UPDATE message_feedback SET rating = ?, comment_enc = ?, message_edited_at = ?, revision = revision + 1, updated_at = ?
        WHERE thread_id = ? AND message_id = ? AND revision = ?`)
      .run(input.rating, commentEnc, target.edited_at, now, threadId, messageId, current);
    // The revision check above already ran in this transaction; keep the guard so a stray writer cannot slide by.
    if (result.changes === 0) throw conflict(FEEDBACK_CONFLICT);
    return {
      messageId,
      rating: input.rating,
      comment,
      revision: current + 1,
      messageEditedAt: target.edited_at,
      createdAt: existing.created_at,
      updatedAt: now,
    };
  });
}

const bookmarkBody = z.object({}).strict();

// JSON escaping can at most double a string, plus room for the other fields.
const BOOKMARK_BODY_LIMIT = 1024;

const feedbackInput = z
  .object({
    rating: z.enum(["positive", "negative"]).nullable(),
    // Two UTF-16 units per code point at most; the exact code-point cap is checked after normalization.
    comment: z.string().max(MAX_FEEDBACK_COMMENT * 2).nullable(),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();

const json = (c: Context<AppEnv>) => c.req.json().catch(() => null);

// These answers are private per account and change without a URL, so no store may keep them.
const noStore: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.header("Cache-Control", "private, no-store");
};

export const messageAnnotationRoutes = new Hono<AppEnv>()
  .use("/threads/:id/annotations", noStore)
  .use("/threads/:id/messages/:messageId/bookmark", noStore)
  .use("/threads/:id/messages/:messageId/feedback", noStore)
  .get("/threads/:id/annotations", (c) => c.json(readAnnotations(c.get("user").id, c.req.param("id"))))
  .put(
    "/threads/:id/messages/:messageId/bookmark",
    bodyLimit({ maxSize: BOOKMARK_BODY_LIMIT, onError: (c) => errorJson(c, invalid("The bookmark request is too large.")) }),
    async (c) => {
      const parsed = bookmarkBody.safeParse(await json(c));
      if (!parsed.success) throw invalid("Bookmark requests take no fields.");
      return c.json(addBookmark(c.get("user").id, c.req.param("id"), c.req.param("messageId")));
    },
  )
  .delete("/threads/:id/messages/:messageId/bookmark", (c) => c.json(removeBookmark(c.get("user").id, c.req.param("id"), c.req.param("messageId"))))
  .put(
    "/threads/:id/messages/:messageId/feedback",
    bodyLimit({ maxSize: FEEDBACK_BODY_LIMIT, onError: (c) => errorJson(c, invalid("The feedback is too large.")) }),
    async (c) => {
      const parsed = feedbackInput.safeParse(await json(c));
      if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? "Invalid feedback");
      return c.json(writeFeedback(c.get("user").id, c.req.param("id"), c.req.param("messageId"), parsed.data));
    },
  );
