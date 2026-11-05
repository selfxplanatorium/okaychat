import { normalizeTag, MAX_TAGS_PER_THREAD } from "./tags.js";

/**
 * Personal notes: durable Markdown documents owned by one account. They are ordinary account text at
 * rest (like chats and saved prompts), not encrypted, and never part of model context unless the user
 * explicitly inserts one into a new composer. See docs/implementation/notes.md.
 */

export const MAX_NOTES = 5_000;
export const MAX_NOTE_TITLE_CHARS = 200;
export const MAX_NOTE_TITLE_BYTES = 800;
export const MAX_NOTE_BODY_CHARS = 200_000;
export const MAX_NOTE_BODY_BYTES = 512 * 1024;
export const MAX_NOTE_TAGS = MAX_TAGS_PER_THREAD;
export const MAX_NOTE_TAG_INPUT = 10;
export const MAX_NOTE_SEARCH_CHARS = 200;
export const MAX_NOTE_SEARCH_BYTES = 800;
export const MAX_NOTE_SEARCH_TERMS = 20;
export const NOTES_PAGE_DEFAULT = 50;
export const NOTES_PAGE_MAX = 100;
export const NOTE_EXCERPT_CHARS = 160;
export const NOTES_CREATE_LIMIT = 1024 * 1024;
export const NOTES_SOURCE_LIMIT = 4 * 1024;
export const NOTES_SMALL_LIMIT = 4 * 1024;
export const MAX_ID_LENGTH = 120;

export interface NoteWrite {
  title: string;
  body: string;
  favorite: boolean;
  pinned: boolean;
  tags: string[];
  projectId: string | null;
}

export type NoteOrigin =
  | { kind: "message"; threadId: string; messageId: string }
  | { kind: "artifact"; threadId: string; artifactId: string; version: number };

export interface Note extends NoteWrite {
  id: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  /** Historical pointer, not a live access grant. */
  source: NoteOrigin | null;
  /** Whether the pointed-at message/artifact still exists and belongs to this account. */
  sourceAvailable: boolean;
}

export type NoteSummary = Omit<Note, "body"> & { excerpt: string };

export interface NotePage {
  items: NoteSummary[];
  nextCursor: string | null;
}

export interface NoteCreate extends NoteWrite {
  requestId: string;
}

export interface NoteUpdate extends NoteWrite {
  revision: number;
}

export interface NoteFromSource {
  requestId: string;
  source: NoteOrigin;
  title?: string;
  projectId?: string | null;
}

export type NoteTagMatch = "any" | "all";

export interface NoteTagCount {
  tag: string;
  count: number;
}

export type NoteProblem =
  | "invalidTitle"
  | "titleTooLong"
  | "invalidBody"
  | "bodyTooLong"
  | "invalidBoolean"
  | "tooManyTags"
  | "invalidTag"
  | "invalidProject";

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isSafeId = (value: unknown): value is string => typeof value === "string" && ID_PATTERN.test(value);
export const isRequestId = (value: unknown): value is string => typeof value === "string" && UUID_V4.test(value);

/** Unicode code points, not UTF-16 units. */
export const codePointLength = (value: string): number => [...value].length;

const encoder = new TextEncoder();
/** UTF-8 bytes, identical in the browser and Node (never UTF-16 length). */
export const utf8Bytes = (value: string): number => encoder.encode(value).length;

/** NUL is never valid user text. */
export const hasNul = (value: string): boolean => value.includes("\u0000");

/** C0/C1 controls except tab and newline, which body and description may keep. */
const CONTROL = /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

export const hasControl = (value: string): boolean => CONTROL.test(value);

/** First `count` code points, never splitting a surrogate pair. */
export function clipCodePoints(value: string, count: number): string {
  if (count <= 0) return "";
  let out = "";
  let taken = 0;
  for (const char of value) {
    if (taken >= count) break;
    out += char;
    taken++;
  }
  return out;
}

/** Clips to a code-point count and then to a UTF-8 byte budget without splitting a character. */
export function clipText(value: string, maxChars: number, maxBytes: number): string {
  let out = "";
  let chars = 0;
  let bytes = 0;
  for (const char of value) {
    if (chars >= maxChars) break;
    const size = utf8Bytes(char);
    if (bytes + size > maxBytes) break;
    out += char;
    chars++;
    bytes += size;
  }
  return out;
}

/** Whitespace-collapsed plain-text excerpt, never HTML. */
export function noteExcerpt(body: string): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  return clipCodePoints(collapsed, NOTE_EXCERPT_CHARS);
}

export type Checked<T> = { ok: true; value: T } | { ok: false; problem: NoteProblem };

function checkedString(value: unknown, preserveWhitespace: boolean, maxChars: number, maxBytes: number): Checked<string> {
  if (typeof value !== "string" || hasNul(value) || hasControl(value)) return { ok: false, problem: "invalidBody" };
  const normalized = preserveWhitespace ? value : value.trim();
  if (codePointLength(normalized) > maxChars || utf8Bytes(normalized) > maxBytes) {
    return { ok: false, problem: maxChars === MAX_NOTE_TITLE_CHARS ? "titleTooLong" : "bodyTooLong" };
  }
  return { ok: true, value: normalized };
}

/** Strict, pure note validation shared by the editor and the server. */
export function checkNoteWrite(value: unknown): Checked<NoteWrite> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, problem: "invalidBody" };
  const input = value as Record<string, unknown>;
  if (typeof input.title !== "string" || hasNul(input.title) || hasControl(input.title)) return { ok: false, problem: "invalidTitle" };
  const title = input.title.trim();
  if (codePointLength(title) > MAX_NOTE_TITLE_CHARS || utf8Bytes(title) > MAX_NOTE_TITLE_BYTES) return { ok: false, problem: "titleTooLong" };
  const body = checkedString(input.body, true, MAX_NOTE_BODY_CHARS, MAX_NOTE_BODY_BYTES);
  if (!body.ok) return { ok: false, problem: "bodyTooLong" };
  if (typeof input.favorite !== "boolean" || typeof input.pinned !== "boolean") return { ok: false, problem: "invalidBoolean" };
  if (!Array.isArray(input.tags) || input.tags.length > MAX_NOTE_TAG_INPUT) return { ok: false, problem: "tooManyTags" };
  const tags: string[] = [];
  for (const raw of input.tags) {
    if (typeof raw !== "string") return { ok: false, problem: "invalidTag" };
    const tag = normalizeTag(raw);
    if (!tag) return { ok: false, problem: "invalidTag" };
    if (!tags.includes(tag)) tags.push(tag);
  }
  tags.sort();
  if (tags.length > MAX_NOTE_TAGS) return { ok: false, problem: "tooManyTags" };
  if (input.projectId !== null && !isSafeId(input.projectId)) return { ok: false, problem: "invalidProject" };
  return {
    ok: true,
    value: {
      title,
      body: body.value,
      favorite: input.favorite,
      pinned: input.pinned,
      tags,
      projectId: input.projectId as string | null,
    },
  };
}

/** UTF-8 bytes one note charges against the storage quota. */
export const noteBytes = (write: Pick<NoteWrite, "title" | "body">): number => utf8Bytes(write.title) + utf8Bytes(write.body);

/** Strict note search text: trimmed, bounded, and a no-op blank query. */
export function checkNoteSearch(value: unknown): { ok: true; value: string } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: "" };
  if (typeof value !== "string") return { ok: false };
  const trimmed = value.trim();
  if (codePointLength(trimmed) > MAX_NOTE_SEARCH_CHARS || utf8Bytes(trimmed) > MAX_NOTE_SEARCH_BYTES) return { ok: false };
  return { ok: true, value: trimmed };
}

/** Parses a single `favorite`/`pinned` query value; anything but `0`/`1` is rejected. */
export function parseBooleanFilter(value: string | undefined): { ok: true; value: boolean | null } | { ok: false } {
  if (value === undefined) return { ok: true, value: null };
  if (value === "0") return { ok: true, value: false };
  if (value === "1") return { ok: true, value: true };
  return { ok: false };
}

/** Normalizes a repeated `tag` query into canonical unique tags, rejecting unusable input. */
export function parseTagFilterValues(values: readonly string[]): { ok: true; tags: string[] } | { ok: false } {
  if (values.length > 20) return { ok: false };
  const tags: string[] = [];
  for (const raw of values) {
    const tag = normalizeTag(raw);
    if (!tag) return { ok: false };
    if (!tags.includes(tag)) tags.push(tag);
  }
  tags.sort();
  return { ok: true, tags };
}
