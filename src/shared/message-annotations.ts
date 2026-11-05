// Private per-message annotations: bookmarks and feedback. They live beside messages, keyed by
// (thread id, message id), and never enter message content, prompts, search, exports, or shares.
// See docs/implementation/message-annotations.md.

export interface MessageBookmark {
  messageId: string;
  createdAt: number;
}

export type FeedbackRating = "positive" | "negative";

export interface MessageFeedback {
  messageId: string;
  /** Null is a removed rating; the row stays so its revision keeps counting. */
  rating: FeedbackRating | null;
  comment: string | null;
  revision: number;
  /** The reply's `edited_at` when the feedback was saved. */
  messageEditedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ThreadAnnotations {
  bookmarks: MessageBookmark[];
  feedback: MessageFeedback[];
}

export interface FeedbackWrite {
  rating: FeedbackRating | null;
  comment: string | null;
  /** 0 when no feedback row exists yet. */
  expectedRevision: number;
}

export const MAX_BOOKMARKS_PER_THREAD = 100;
export const MAX_FEEDBACK_COMMENT = 2_000;
/** HTTP body cap for a feedback write, checked before JSON parsing. */
export const FEEDBACK_BODY_LIMIT = 16 * 1024;

/** Blank comments are no comment; anything else keeps its whitespace. */
export const normalizeFeedbackComment = (comment: string | null) => (comment === null || !comment.trim() ? null : comment);
