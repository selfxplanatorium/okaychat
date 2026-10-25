import type { ModelMessage, UIMessage } from "ai";
import { decrypt, encrypt } from "./crypto.js";
import { db } from "./db.js";

// The date, recalled memory, and the skills index sit beside the user message they were computed for. Providers cache
// by exact prefix, so dropping that block in the next turn would invalidate everything after it: the
// previous user message, the reply, and all of its tool results. Each block is stored and replayed
// verbatim instead. See docs/research/prompt-caching.md.

export interface TurnContext {
  /** The date line, so the system prefix does not change at midnight. */
  date: string;
  memory: string;
  skills: string;
}

interface Row { message_id: string; memory_enc: string | null; memory_revision: number; skills: string | null; date: string | null }

export const contextText = (context: TurnContext) => [context.date, context.memory, context.skills].filter(Boolean).join("\n\n");

/**
 * The stored context per user message id. Memory text is returned only while memory is active for the
 * chat and the account's memory revision is unchanged, so text from a deleted or edited fact is never
 * sent again. The skills index is dropped when the chat currently has none.
 */
export function storedTurnContexts(userId: string, threadId: string, gate: { memoryRevision: number | null; skills: boolean }): Map<string, TurnContext> {
  const rows = db.prepare("SELECT message_id, memory_enc, memory_revision, skills, date FROM turn_context WHERE user_id = ? AND thread_id = ?").all(userId, threadId) as unknown as Row[];
  const out = new Map<string, TurnContext>();
  for (const row of rows) {
    let memory = "";
    if (row.memory_enc && gate.memoryRevision !== null && row.memory_revision === gate.memoryRevision) {
      try { memory = decrypt(row.memory_enc); } catch { memory = ""; }
    }
    out.set(row.message_id, { date: row.date ?? "", memory, skills: gate.skills ? row.skills ?? "" : "" });
  }
  return out;
}

export function saveTurnContext(userId: string, threadId: string, messageId: string, context: TurnContext, memoryRevision: number) {
  db.prepare(`INSERT INTO turn_context (thread_id, message_id, user_id, memory_enc, memory_revision, skills, date) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(thread_id, message_id) DO UPDATE SET memory_enc = excluded.memory_enc, memory_revision = excluded.memory_revision, skills = excluded.skills, date = excluded.date`)
    .run(threadId, messageId, userId, context.memory ? encrypt(context.memory) : null, memoryRevision, context.skills || null, context.date || null);
}

/** Ids of the memory facts a stored block already showed. The block is our own `factsContext` JSON. */
export const shownFactIds = (memory: string) => new Set([...memory.matchAll(/"id":"([^"]+)"/g)].map((match) => match[1]!));

/**
 * Inserts each user message's context as a user message directly before it. `ui` and `model` are the same
 * branch before and after conversion; user messages convert one to one, so the nth of each correspond.
 */
export function insertTurnContexts(ui: UIMessage[], model: ModelMessage[], contexts: Map<string, string>): ModelMessage[] {
  const ids = ui.filter((message) => message.role === "user").map((message) => message.id);
  const users = model.filter((message) => message.role === "user").length;
  if (ids.length !== users) return model;
  const out: ModelMessage[] = [];
  let n = 0;
  for (const message of model) {
    if (message.role === "user") {
      const text = contexts.get(ids[n++]!);
      if (text) out.push({ role: "user", content: text });
    }
    out.push(message);
  }
  return out;
}
