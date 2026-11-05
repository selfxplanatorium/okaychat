import type { Note } from "@shared/notes";
import { transientNonce } from "@/lib/ids";

/**
 * Single-use handoff from a note to a new chat composer. Account-bound, expires after five minutes,
 * consumed once by the newly created composer, and never submitted. Only title and body travel; tags,
 * source pointers, and project links do not.
 */

export interface NoteHandoff {
  nonce: string;
  accountId: string;
  noteId: string;
  text: string;
  createdAt: number;
}

export const HANDOFF_TTL_MS = 5 * 60_000;

let pending: NoteHandoff | null = null;

/** `# title` plus a blank line and the body; an empty title starts with the body. */
export function noteChatText(note: Pick<Note, "title" | "body">): string {
  const title = note.title.trim();
  return title ? `# ${title}\n\n${note.body}` : note.body;
}

export const NOTE_HANDOFF_EVENT = "okaychat:note-handoff";

export function offerNoteToChat(accountId: string, note: Pick<Note, "id" | "title" | "body">, now = Date.now()): NoteHandoff {
  pending = { nonce: transientNonce(), accountId, noteId: note.id, text: noteChatText(note), createdAt: now };
  // The new chat may already be the open empty chat, so an effect on `thread.isEmpty` would not rerun.
  if (typeof window !== "undefined") window.dispatchEvent(new Event(NOTE_HANDOFF_EVENT));
  return pending;
}

/** Consumes the pending handoff. Wrong account, expiry, or a second call returns null. */
export function takeNoteHandoff(accountId: string, now = Date.now()): NoteHandoff | null {
  if (!pending) return null;
  const handoff = pending;
  if (handoff.accountId !== accountId || now - handoff.createdAt > HANDOFF_TTL_MS) {
    pending = null;
    return null;
  }
  pending = null;
  return handoff;
}

export function peekNoteHandoff(): NoteHandoff | null {
  return pending;
}

export function clearNoteHandoff(): void {
  pending = null;
}
