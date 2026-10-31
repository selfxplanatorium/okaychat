import type { UIMessage } from "ai";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { MAX_EDITED_TEXT, type CompactionState, type MessageEditResult, type StoredMessageRow, type ThreadSummary } from "../shared/types.js";
import type { AppEnv } from "./auth.js";
import { decrypt, encrypt } from "./crypto.js";
import { db, tx } from "./db.js";
import { AppError, errorJson } from "./errors.js";
import { assertStorage, messageBytes } from "./quota.js";
import { getSettings } from "./settings.js";
import { threadBusy } from "./thread-runs.js";
import { getThread, isTemporaryThread, setCompaction } from "./threads.js";

// User edits of finished assistant replies. Only text parts change; every other part (reasoning, tools, files,
// sources), the id, the parent, and the position stay as stored. The first original text parts are kept
// encrypted in `original_enc` even after Undo restores them. See docs/implementation/message-editing.md.

interface Row {
  id: string;
  parent_id: string | null;
  format: string;
  content: string;
  bytes: number;
  edited_at: number | null;
  original_enc: string | null;
}

type Part = { type: string; text?: string; state?: string } & Record<string, unknown>;
type Content = { role?: string; parts?: Part[] } & Record<string, unknown>;

const invalid = (message: string) => new AppError({ code: "validation", message });
const conflict = (message: string) => new AppError({ code: "conflict", message });

const TERMINAL_TOOL_STATES = new Set(["output-available", "output-error", "output-denied"]);
const isToolPart = (part: Part) => part.type.startsWith("tool-") || part.type === "dynamic-tool";
const textIndices = (parts: Part[]) => parts.flatMap((part, i) => (part.type === "text" ? [i] : []));

type EditableReply = {
  row: Row;
  content: Content;
  thread: ThreadSummary & { compaction: CompactionState | null };
  branch: string[];
  index: number;
};

/** The stored reply, after every check an edit and an Undo share. */
function editableReply(userId: string, threadId: string, messageId: string): EditableReply {
  if (isTemporaryThread(threadId)) throw invalid("Temporary chats are not stored, so their replies cannot be edited.");
  const thread = getThread(userId, threadId);
  if (!thread) throw new AppError({ code: "not_found", message: "Thread not found" });
  // The client stores a turn when it ends, so an edit now could be overwritten or parent a missing message.
  if (threadBusy(threadId)) throw conflict("A reply is still being written in this chat. Wait for it to finish, then edit.");
  const rows = db
    .prepare("SELECT id, parent_id, format, content, bytes, edited_at, original_enc FROM messages WHERE thread_id = ? ORDER BY created_at, rowid")
    .all(threadId) as unknown as Row[];
  const row = rows.find((r) => r.id === messageId);
  if (!row) throw new AppError({ code: "not_found", message: "Message not found" });
  const content = JSON.parse(row.content) as Content;
  if (content.role !== "assistant") throw invalid("Only assistant replies can be edited. Edit your own message to send it again.");
  // The current branch (newest message and its ancestors) is what later turns, exports, and shares use.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const branch: string[] = [];
  for (let r = rows.at(-1); r; r = r.parent_id ? byId.get(r.parent_id) : undefined) branch.unshift(r.id);
  const index = branch.indexOf(messageId);
  if (index === -1) throw conflict("This reply is not on the chat's latest branch. Switch to that branch to edit it.");
  const parts = Array.isArray(content.parts) ? content.parts : [];
  if (parts.some((part) => isToolPart(part) && !TERMINAL_TOOL_STATES.has(String(part.state)))) {
    throw conflict("This reply is still waiting for a tool. Finish or stop it first.");
  }
  // A summary replaces the messages through its boundary. An edit there would never reach the model, and the
  // summary would still describe the old text, so it is refused rather than silently ignored.
  const boundary = thread.compaction?.summary ? branch.indexOf(thread.compaction.boundaryMessageId ?? "") : -1;
  if (boundary !== -1 && index <= boundary) {
    throw conflict("This reply is part of the chat's summary, which the model reads instead. Edit a reply after the summary.");
  }
  return { row, content: { ...content, parts }, thread, branch, index };
}

/**
 * A trim's `tokensAfter` is the prompt estimate taken when it was made. Editing text after the summary
 * changes the prompt, so shift that estimate by the edited text's rough token count rather than leaving
 * the context meter on a number that is no longer true. `tokensBefore` is historical and stays.
 */
function trimAfterEdit(thread: EditableReply["thread"], branch: string[], index: number, before: string[], after: string[]): CompactionState | null {
  const compaction = thread.compaction;
  const trim = compaction?.trim;
  if (!compaction || !trim) return null;
  // The check in editableReply already refuses edits covered by a summary; keep the same rule here.
  const boundary = compaction.summary ? branch.indexOf(compaction.boundaryMessageId ?? "") : -1;
  if (boundary !== -1 && index <= boundary) return null;
  // `tokensAfter` described the prompt through `lastMessageId` when the trim was made. Messages appended later
  // are counted separately, so only edits up to that point shift the estimate.
  const last = branch.indexOf(trim.lastMessageId);
  if (last === -1 || index > last) return null;
  const estimate = (texts: string[]) => Math.ceil(JSON.stringify(texts).length / 4);
  const delta = estimate(after) - estimate(before);
  if (!delta) return null;
  return { ...compaction, trim: { ...trim, tokensAfter: Math.max(0, trim.tokensAfter + delta) } };
}

const toResult = (row: Pick<Row, "id" | "parent_id" | "format">, json: string, editedAt: number | null): MessageEditResult => {
  const message: StoredMessageRow = { id: row.id, parent_id: row.parent_id, format: row.format, content: JSON.parse(json) as unknown };
  if (editedAt !== null) message.edited_at = editedAt;
  return { message, editedAt };
};

/**
 * Replaces the text parts of a stored assistant reply, in order. `text` is for a reply with one text part;
 * `parts` lists one `{ type: "text", text }` per text part.
 */
export function editMessage(userId: string, threadId: string, messageId: string, input: { text?: string; parts?: Array<{ text: string }> }): MessageEditResult {
  if (getSettings(userId).editAssistantMessages !== true) {
    throw new AppError({ code: "forbidden", message: "Editing assistant replies is off. Turn on Edit assistant messages in Settings → General." });
  }
  return tx(() => {
    const { row, content, thread, branch, index } = editableReply(userId, threadId, messageId);
    const parts = content.parts!;
    const indices = textIndices(parts);
    if (!indices.length) throw invalid("This reply has no text to edit.");
    let texts: string[];
    if (input.text !== undefined) {
      if (indices.length !== 1) throw invalid(`This reply has ${indices.length} text sections. Send one text per section.`);
      texts = [input.text];
    } else {
      texts = (input.parts ?? []).map((part) => part.text);
      if (texts.length !== indices.length) throw invalid(`This reply has ${indices.length} text sections. Send one text per section.`);
    }
    if (texts.reduce((sum, text) => sum + text.length, 0) > MAX_EDITED_TEXT) throw invalid(`An edited reply can hold at most ${MAX_EDITED_TEXT} characters.`);
    if (texts.every((text) => !text.trim())) throw invalid("An edited reply cannot be empty.");
    const before = indices.map((i) => parts[i]!.text ?? "");
    if (indices.every((i, n) => parts[i]!.text === texts[n])) return toResult(row, row.content, row.edited_at);
    // An edited row must keep its first original. Without it the edit could not be undone or audited, and a
    // later edit would save the edited text as if the model had written it.
    if (row.original_enc === null && row.edited_at !== null) throw conflict("The original text of this reply is missing, so it cannot be edited again.");

    const next = parts.slice();
    indices.forEach((i, n) => {
      // Provider metadata (OpenAI item ids) describes the original output item. Kept, it could make a provider
      // replay that item by reference instead of the edited text.
      const { providerMetadata: _metadata, ...rest } = parts[i]!;
      next[i] = { ...rest, text: texts[n] };
    });
    const json = JSON.stringify({ ...content, parts: next });
    const bytes = messageBytes(json);
    // The first original is encrypted once and kept through every later edit and Undo, so Undo always returns
    // to what the model wrote and the edit stays auditable.
    const firstEdit = row.original_enc === null;
    const original = row.original_enc ?? encrypt(JSON.stringify(indices.map((i) => parts[i])));
    const growth = bytes - row.bytes + (firstEdit ? Buffer.byteLength(original) : 0);
    assertStorage(userId, growth);
    const editedAt = Date.now();
    // created_at, parent_id, and the id stay, so the branch and every child are unchanged. FTS follows via its trigger.
    db.prepare("UPDATE messages SET content = ?, bytes = ?, edited_at = ?, original_enc = ? WHERE thread_id = ? AND id = ?")
      .run(json, bytes, editedAt, original, threadId, messageId);
    const compaction = trimAfterEdit(thread, branch, index, before, texts);
    if (compaction) setCompaction(userId, threadId, compaction);
    return toResult(row, json, editedAt);
  });
}

/**
 * Restores the reply's first original text parts and clears the edit. Allowed with the setting off too.
 * The encrypted original stays: it is the audit record and keeps an old tab from sending edited text after Undo.
 */
export function undoMessageEdit(userId: string, threadId: string, messageId: string): MessageEditResult {
  return tx(() => {
    const { row, content, thread, branch, index } = editableReply(userId, threadId, messageId);
    if (row.edited_at === null || row.original_enc === null) throw conflict("This reply has not been edited.");
    const parts = content.parts!;
    const indices = textIndices(parts);
    const originals = JSON.parse(decrypt(row.original_enc)) as Part[];
    // Edits never add or remove parts, so the positions still match. Anything else is a damaged row.
    if (!Array.isArray(originals) || originals.length !== indices.length) throw conflict("The original text of this reply cannot be restored.");
    const next = parts.slice();
    indices.forEach((i, n) => (next[i] = originals[n]!));
    const json = JSON.stringify({ ...content, parts: next });
    const bytes = messageBytes(json);
    assertStorage(userId, bytes - row.bytes);
    db.prepare("UPDATE messages SET content = ?, bytes = ?, edited_at = NULL WHERE thread_id = ? AND id = ?")
      .run(json, bytes, threadId, messageId);
    const before = indices.map((i) => parts[i]!.text ?? "");
    const after = originals.map((part) => part.text ?? "");
    const compaction = trimAfterEdit(thread, branch, index, before, after);
    if (compaction) setCompaction(userId, threadId, compaction);
    return toResult(row, json, null);
  });
}

/**
 * The request's copy of the conversation with every reply that has ever been edited replaced by the stored
 * one. A tab that loaded the chat before an edit still sends the old text; the model must see what the user
 * saved (and, after Undo, the restored original). `original_enc` outlives Undo, so it marks those replies.
 */
export function withStoredEdits(userId: string, threadId: string, messages: UIMessage[]): UIMessage[] {
  const edited = db
    .prepare(`SELECT m.id, m.content FROM messages m JOIN threads t ON t.id = m.thread_id
      WHERE t.user_id = ? AND m.thread_id = ? AND m.original_enc IS NOT NULL`)
    .all(userId, threadId) as Array<{ id: string; content: string }>;
  if (!edited.length) return messages;
  const stored = new Map(edited.map((r) => [r.id, r.content]));
  return messages.map((message) => {
    const json = stored.get(message.id);
    if (json === undefined || message.role !== "assistant") return message;
    try {
      const parts = (JSON.parse(json) as { parts?: UIMessage["parts"] }).parts;
      return Array.isArray(parts) ? { ...message, parts } : message;
    } catch {
      // A damaged row must not take the whole turn down; the request keeps its own copy.
      return message;
    }
  });
}

const editInput = z
  .object({
    text: z.string().max(MAX_EDITED_TEXT).optional(),
    parts: z.array(z.object({ type: z.literal("text"), text: z.string().max(MAX_EDITED_TEXT) }).strict()).min(1).max(200).optional(),
  })
  .strict()
  .refine((value) => (value.text === undefined) !== (value.parts === undefined), "Send either text or parts");

// JSON escaping can at most double-ish the text; anything larger is not an edit.
const EDIT_BODY_LIMIT = 4 * MAX_EDITED_TEXT + 64 * 1024;

export const messageEditRoutes = new Hono<AppEnv>()
  .patch(
    "/threads/:id/messages/:messageId",
    bodyLimit({ maxSize: EDIT_BODY_LIMIT, onError: (c) => errorJson(c, invalid("The edited reply is too large.")) }),
    async (c) => {
      const parsed = editInput.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? "Invalid edit");
      return c.json(editMessage(c.get("user").id, c.req.param("id"), c.req.param("messageId"), parsed.data));
    },
  )
  .delete("/threads/:id/messages/:messageId/edit", (c) =>
    c.json(undoMessageEdit(c.get("user").id, c.req.param("id"), c.req.param("messageId"))),
  );
