import type { NoteWrite } from "@shared/notes";

/**
 * Unsaved note outbox. Plain browser storage, keyed per account and note, bounded so a runaway tab
 * cannot exhaust localStorage. Dirty entries are never evicted to make room; if the budget is full the
 * caller shows the "only in this tab" warning instead.
 */

export const OUTBOX_VERSION = 1;
export const MAX_OUTBOX_ENTRIES = 20;
export const MAX_OUTBOX_BYTES = 2 * 1024 * 1024;

export interface OutboxEntry {
  version: 1;
  baseRevision: number;
  baseValue: NoteWrite;
  value: NoteWrite;
  editSequence: number;
  savedAt: number;
}

const prefix = (accountId: string) => `okaychat:note-outbox:${accountId}:`;

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const byteLength = (value: string) => new TextEncoder().encode(value).length;

export function outboxKey(accountId: string, noteId: string): string {
  return `${prefix(accountId)}${noteId}`;
}

export function readOutbox(accountId: string, noteId: string): OutboxEntry | null {
  const store = storage();
  if (!store) return null;
  try {
    const parsed = JSON.parse(store.getItem(outboxKey(accountId, noteId)) ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const entry = parsed as Partial<OutboxEntry>;
    if (entry.version !== OUTBOX_VERSION || typeof entry.baseRevision !== "number" || typeof entry.savedAt !== "number") return null;
    if (!entry.value || !entry.baseValue) return null;
    return entry as OutboxEntry;
  } catch {
    return null;
  }
}

export function listOutbox(accountId: string): Array<{ noteId: string; entry: OutboxEntry }> {
  const store = storage();
  if (!store) return [];
  const out: Array<{ noteId: string; entry: OutboxEntry }> = [];
  for (let index = 0; index < store.length; index++) {
    const key = store.key(index);
    if (!key?.startsWith(prefix(accountId))) continue;
    const noteId = key.slice(prefix(accountId).length);
    const entry = readOutbox(accountId, noteId);
    if (entry) out.push({ noteId, entry });
  }
  return out.sort((a, b) => a.entry.savedAt - b.entry.savedAt);
}

export type OutboxWriteResult = "saved" | "full" | "unavailable";

/** Writes one entry, evicting only older entries that are not dirty, then enforcing the byte budget. */
export function writeOutbox(accountId: string, noteId: string, entry: OutboxEntry): OutboxWriteResult {
  const store = storage();
  if (!store) return "unavailable";
  const serialized = JSON.stringify(entry);
  const entries = listOutbox(accountId);
  const kept = entries.filter((item) => item.noteId !== noteId);
  let total = byteLength(serialized) + kept.reduce((sum, item) => sum + byteLength(JSON.stringify(item.entry)), 0);
  // Oldest first; an entry whose value equals its base is acknowledged and safe to drop.
  for (const item of [...kept]) {
    if (kept.length < MAX_OUTBOX_ENTRIES && total <= MAX_OUTBOX_BYTES) break;
    const clean = JSON.stringify(item.entry.value) === JSON.stringify(item.entry.baseValue);
    if (!clean) continue;
    store.removeItem(outboxKey(accountId, item.noteId));
    total -= byteLength(JSON.stringify(item.entry));
    kept.splice(kept.indexOf(item), 1);
  }
  if (kept.length >= MAX_OUTBOX_ENTRIES || total > MAX_OUTBOX_BYTES) return "full";
  try {
    store.setItem(outboxKey(accountId, noteId), serialized);
    return "saved";
  } catch {
    return "unavailable";
  }
}

export function removeOutbox(accountId: string, noteId: string): void {
  try {
    storage()?.removeItem(outboxKey(accountId, noteId));
  } catch {
    // A denied storage removal leaves a recoverable entry behind; never surface it as data loss.
  }
}

/** Used by sign-out: returns every entry for copying, then clears this account's keys. */
export function clearOutbox(accountId: string): Array<{ noteId: string; entry: OutboxEntry }> {
  const entries = listOutbox(accountId);
  for (const item of entries) removeOutbox(accountId, item.noteId);
  return entries;
}
