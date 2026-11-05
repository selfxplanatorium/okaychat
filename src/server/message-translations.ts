import { generateText } from "ai";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { canonicalLocaleTag } from "../shared/locale-tag.js";
import {
  MAX_TRANSLATIONS_PER_MESSAGE,
  MAX_TRANSLATIONS_PER_THREAD,
  MAX_TRANSLATION_SOURCE_CHARS,
  MAX_TRANSLATION_TEXT_BYTES,
  TRANSLATION_BODY_LIMIT,
  type MessageTranslation,
  type MessageTranslationList,
  type TranslateMessageInput,
} from "../shared/message-translations.js";
import type { AppEnv } from "./auth.js";
import { resolveModel } from "./catalog/providers.js";
import { sha256 } from "./crypto.js";
import { db, tx } from "./db.js";
import { AppError, errorJson } from "./errors.js";
import { createModel } from "./llm.js";
import { requireFeature } from "./permissions/guard.js";
import { wrapUntrusted } from "./prompt-injection.js";
import { resolvePrompt } from "./prompt-policy.js";
import { assertStorage } from "./quota.js";
import { getSettings } from "./settings.js";
import { threadBusy } from "./thread-runs.js";
import { attachmentName, getThread, isTemporaryThread } from "./threads.js";
import { costOf, normalizeUsage, recordUsage } from "./usage.js";

// Per-message translations are derived text: a standalone model call whose answer is stored beside the
// message. They never enter `messages`, `turn_context`, FTS, prompts, shares, exports, or archives, and
// they never bump chat activity. See docs/implementation/message-translation.md.

const MESSAGE_NOT_FOUND = "Message not found";
const BUSY = "A reply is still being written in this chat. Wait for it to finish.";
const OFF = "Message translation is off. Turn it on in Settings → General.";
const SOURCE_CHANGED = "The message changed while it was being translated. Try again.";
const INVALID_MESSAGE = "Only stored user and assistant messages can be translated.";
const EMPTY_TEXT = "This message has no text to translate.";
const INVALID_LANG = "That is not a language this app can translate into.";
const THREAD_LIMIT = "This chat has reached its translation limit. Remove translations you no longer need.";
const MESSAGE_LIMIT = `This message already has translations in ${MAX_TRANSLATIONS_PER_MESSAGE} languages.`;
const NO_MODEL = "Choose a utility model in Settings → General to translate messages.";
const EMPTY_ANSWER = "The model returned an empty translation.";

const invalid = (message: string) => new AppError({ code: "validation", message });
const conflict = (message: string) => new AppError({ code: "conflict", message });
const notFound = (message: string) => new AppError({ code: "not_found", message });

export interface TranslatableMessage {
  role: "user" | "assistant";
  /** Text parts in order, attachment placeholders removed. */
  texts: string[];
  /** "\n\n"-joined text that is sent to the model. */
  source: string;
  sourceHash: string;
  sourceChars: number;
}

interface TranslationRow {
  message_id: string;
  lang: string;
  source_hash: string;
  source_chars: number;
  translated: string;
  truncated: number;
  model_ref: string;
  created_at: number;
  updated_at: number;
}

interface StoredMessage {
  format: string;
  role: unknown;
  parts: unknown;
}

/** Text parts in order, without attachment placeholders, which carry a file name and not the author's words. */
function textParts(parts: unknown): string[] {
  if (!Array.isArray(parts)) return [];
  return parts.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const { type, text } = part as { type?: unknown; text?: unknown };
    return type === "text" && typeof text === "string" && text !== "" && attachmentName(text) === undefined ? [text] : [];
  });
}

/** The source cut, at a paragraph break when there is one: a partial sentence reads worse than a shorter one. */
function cutSource(source: string): { source: string; truncated: boolean } {
  if (source.length <= MAX_TRANSLATION_SOURCE_CHARS) return { source, truncated: false };
  const cap = MAX_TRANSLATION_SOURCE_CHARS;
  const paragraph = source.lastIndexOf("\n\n", cap);
  return { source: source.slice(0, paragraph > 0 ? paragraph : cap), truncated: true };
}

/** Stored output is capped by UTF-8 bytes; cut on a code point so a surrogate pair is never split. */
function cutBytes(text: string, max: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= max) return { text, truncated: false };
  let used = 0;
  let prefix = "";
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (used + size > max) break;
    used += size;
    prefix += char;
  }
  // Prefer the last whitespace close to the cap; fall back to the raw byte cut for unbroken text.
  const space = Math.max(prefix.lastIndexOf(" "), prefix.lastIndexOf("\n"), prefix.lastIndexOf("\t"));
  const cut = (space > prefix.length / 2 ? prefix.slice(0, space) : prefix).trimEnd();
  return { text: cut || prefix.trimEnd(), truncated: true };
}

/** Ownership → message → role → busy, then the text parts. Every lookup failure reads the same. */
function inspect(userId: string, threadId: string, messageId: string) {
  if (isTemporaryThread(threadId)) throw notFound(MESSAGE_NOT_FOUND);
  const thread = getThread(userId, threadId);
  if (!thread) throw notFound(MESSAGE_NOT_FOUND);
  const row = db.prepare("SELECT format, content FROM messages WHERE thread_id = ? AND id = ?").get(threadId, messageId) as
    | { format: string; content: string }
    | undefined;
  if (!row) throw notFound(MESSAGE_NOT_FOUND);
  if (threadBusy(threadId)) throw conflict(BUSY);
  let stored: StoredMessage;
  try {
    stored = JSON.parse(row.content) as StoredMessage;
  } catch {
    throw invalid(INVALID_MESSAGE);
  }
  const role: "user" | "assistant" | undefined =
    stored?.role === "user" ? "user" : stored?.role === "assistant" ? "assistant" : undefined;
  if (row.format !== "ai-sdk/v6" || !role) throw invalid(INVALID_MESSAGE);
  const texts = textParts(stored.parts);
  if (texts.length === 0) throw invalid(EMPTY_TEXT);
  const source = texts.join("\n\n");
  return { thread, role, texts, source, sourceHash: sha256(JSON.stringify(texts)), sourceChars: source.length };
}

const rowOf = (threadId: string, messageId: string, lang: string) =>
  db
    .prepare(`SELECT message_id, lang, source_hash, source_chars, translated, truncated, model_ref, created_at, updated_at
      FROM message_translations WHERE thread_id = ? AND message_id = ? AND lang = ?`)
    .get(threadId, messageId, lang) as TranslationRow | undefined;

const toTranslation = (row: TranslationRow): MessageTranslation => ({
  messageId: row.message_id,
  lang: row.lang,
  text: row.translated,
  sourceHash: row.source_hash,
  sourceChars: row.source_chars,
  truncated: row.truncated === 1,
  modelRef: row.model_ref,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** The message a translation may target, with the exact text that is sent to the model. Throws AppError. */
export function translatableMessage(userId: string, threadId: string, messageId: string): TranslatableMessage {
  const { role, texts, source, sourceHash, sourceChars } = inspect(userId, threadId, messageId);
  return { role, texts, source, sourceHash, sourceChars };
}

export function listTranslations(userId: string, threadId: string, messageId: string): MessageTranslationList {
  const { sourceHash, sourceChars } = inspect(userId, threadId, messageId);
  const rows = db
    .prepare(`SELECT message_id, lang, source_hash, source_chars, translated, truncated, model_ref, created_at, updated_at
      FROM message_translations WHERE thread_id = ? AND message_id = ? ORDER BY updated_at DESC, lang`)
    .all(threadId, messageId) as unknown as TranslationRow[];
  return {
    messageId,
    sourceHash,
    sourceChars,
    translations: rows.map((row) => ({ ...toTranslation(row), stale: row.source_hash !== sourceHash })),
  };
}

/** Rechecked at commit: another request can add or remove a row while the model runs. */
function checkRowLimits(threadId: string, messageId: string, existing: TranslationRow | undefined): void {
  const threadRows = (db.prepare("SELECT COUNT(*) AS n FROM message_translations WHERE thread_id = ?").get(threadId) as { n: number }).n;
  if (threadRows >= MAX_TRANSLATIONS_PER_THREAD && !existing) throw conflict(THREAD_LIMIT);
  const languageRows = (db.prepare("SELECT COUNT(*) AS n FROM message_translations WHERE thread_id = ? AND message_id = ?").get(threadId, messageId) as {
    n: number;
  }).n;
  if (languageRows >= MAX_TRANSLATIONS_PER_MESSAGE && !existing) throw conflict(MESSAGE_LIMIT);
}

/** The language name the model is told, always in English so an instruction never follows the UI language. */
function englishLanguageName(lang: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(lang) ?? lang;
  } catch {
    return lang;
  }
}

export async function translateMessage(
  userId: string,
  threadId: string,
  messageId: string,
  lang: string,
  input: TranslateMessageInput,
  signal?: AbortSignal,
): Promise<MessageTranslation> {
  const settings = getSettings(userId);
  if (settings.translateMessages === false) throw new AppError({ code: "forbidden", message: OFF });
  const message = inspect(userId, threadId, messageId);
  const canonical = canonicalLocaleTag(lang);
  if (canonical === null) throw invalid(INVALID_LANG);

  // A cache hit costs nothing: before resolving a model, so a repeated request never calls the provider.
  const existing = rowOf(threadId, messageId, canonical);
  if (existing && existing.source_hash === message.sourceHash && input.refresh !== true) return toTranslation(existing);

  checkRowLimits(threadId, messageId, existing);

  // Utility model first, then the request's chat model, then the chat's stored model. An agent is not a model.
  const ref = [settings.utilityModel, input.modelRef, message.thread.modelRef].find((candidate): candidate is string => !!candidate && !candidate.startsWith("n8n/"));
  if (!ref) throw conflict(NO_MODEL);
  const { model, conn } = await resolveModel(userId, ref);
  const handle = createModel(model, conn, { userId });
  const system = resolvePrompt("translation", { userId, modelRef: model.ref }, { language: englishLanguageName(canonical) });
  const { source, truncated: sourceTruncated } = cutSource(message.source);
  const result = await generateText({
    model: handle.model,
    providerOptions: handle.providerOptions,
    maxRetries: 0,
    maxOutputTokens: 6000,
    abortSignal: signal,
    system,
    messages: [{ role: "user", content: wrapUntrusted(source, { kind: "message_translation", name: "chat message" }).text }],
  });

  // Recorded before storage: a quota refusal must not hide a request the provider was already paid for.
  const usage = normalizeUsage(result.totalUsage);
  recordUsage({ userId, threadId, providerId: model.providerId, modelId: model.id, kind: "translation", usage, cost: costOf(model.cost, usage) });

  // The message may have been edited while the model answered; storing this would label old text as new.
  if (inspect(userId, threadId, messageId).sourceHash !== message.sourceHash) throw conflict(SOURCE_CHANGED);
  const answer = result.text.trim();
  if (answer === "") throw invalid(EMPTY_ANSWER);
  const output = cutBytes(answer, MAX_TRANSLATION_TEXT_BYTES);
  const now = Date.now();
  const createdAt = existing?.created_at ?? now;
  const bytes = Buffer.byteLength(output.text);
  return tx(() => {
    const current = rowOf(threadId, messageId, canonical);
    checkRowLimits(threadId, messageId, current);
    const previousBytes = current ? Buffer.byteLength(current.translated) : 0;
    assertStorage(userId, bytes - previousBytes);
    db.prepare(
      `INSERT INTO message_translations (thread_id, message_id, lang, source_hash, source_chars, translated, truncated, model_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (thread_id, message_id, lang) DO UPDATE SET
         source_hash = excluded.source_hash, source_chars = excluded.source_chars, translated = excluded.translated,
         truncated = excluded.truncated, model_ref = excluded.model_ref, updated_at = excluded.updated_at`,
    ).run(
      threadId,
      messageId,
      canonical,
      message.sourceHash,
      message.sourceChars,
      output.text,
      sourceTruncated || output.truncated ? 1 : 0,
      model.ref,
      createdAt,
      now,
    );
    const stored = rowOf(threadId, messageId, canonical);
    if (!stored) throw new AppError({ code: "unknown", message: "The translation was not stored." });
    return toTranslation(stored);
  });
}

export function removeTranslation(userId: string, threadId: string, messageId: string, lang: string): { ok: true } {
  inspect(userId, threadId, messageId);
  const canonical = canonicalLocaleTag(lang);
  if (canonical === null) throw invalid(INVALID_LANG);
  db.prepare("DELETE FROM message_translations WHERE thread_id = ? AND message_id = ? AND lang = ?").run(threadId, messageId, canonical);
  return { ok: true };
}

const json = (c: Context<AppEnv>) => c.req.json().catch(() => null);

const translateInput = z
  .object({
    modelRef: z.string().min(1).max(300).optional(),
    refresh: z.boolean().optional(),
  })
  .strict();

// These answers are private per account and change without a URL, so no store may keep them.
const noStore: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.header("Cache-Control", "private, no-store");
};

const base = "/threads/:id/messages/:messageId/translations";

export const messageTranslationRoutes = new Hono<AppEnv>()
  .use(base, noStore, requireFeature("translation"))
  .use(`${base}/:lang`, noStore, requireFeature("translation"))
  .get(base, (c) => c.json(listTranslations(c.get("user").id, c.req.param("id"), c.req.param("messageId"))))
  .put(
    `${base}/:lang`,
    bodyLimit({ maxSize: TRANSLATION_BODY_LIMIT, onError: (c) => errorJson(c, invalid("The translation request is too large.")) }),
    async (c) => {
      const parsed = translateInput.safeParse(await json(c));
      if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? "Invalid translation request");
      const translation = await translateMessage(
        c.get("user").id,
        c.req.param("id"),
        c.req.param("messageId"),
        c.req.param("lang"),
        parsed.data,
        c.req.raw.signal,
      );
      return c.json(translation);
    },
  )
  .delete(`${base}/:lang`, (c) => c.json(removeTranslation(c.get("user").id, c.req.param("id"), c.req.param("messageId"), c.req.param("lang"))));
