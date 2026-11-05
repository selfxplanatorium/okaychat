/** Characters of one message's text sent to the model. Longer messages are cut at a paragraph break. */
export const MAX_TRANSLATION_SOURCE_CHARS = 12_000;
/** UTF-8 bytes kept for one stored translation. */
export const MAX_TRANSLATION_TEXT_BYTES = 32 * 1024;
export const MAX_TRANSLATIONS_PER_MESSAGE = 20;
export const MAX_TRANSLATIONS_PER_THREAD = 5_000;
/** HTTP body cap for a translate request, checked before JSON parsing. */
export const TRANSLATION_BODY_LIMIT = 8 * 1024;

export interface MessageTranslation {
  messageId: string;
  /** Canonical BCP 47 tag. */
  lang: string;
  text: string;
  /** sha256 of the message's text parts, 64 hex. A different hash means the cached text is stale. */
  sourceHash: string;
  /** Characters of the message text before any cut. */
  sourceChars: number;
  /** The source or the stored output was cut at a limit. */
  truncated: boolean;
  modelRef: string;
  createdAt: number;
  updatedAt: number;
}

export interface MessageTranslationList {
  messageId: string;
  /** Hash of the message's current text parts. Rows with another hash are stale. */
  sourceHash: string;
  sourceChars: number;
  translations: Array<MessageTranslation & { stale: boolean }>;
}

export interface TranslateMessageInput {
  /** Fallback when the account has no utility model; the chat's active model. Validated by resolveModel. */
  modelRef?: string;
  /** Ignore a cached row and translate again. */
  refresh?: boolean;
}
