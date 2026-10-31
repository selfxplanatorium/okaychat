import type { ModelMessage, UIMessage } from "ai";
import { decrypt, encrypt } from "./crypto.js";
import { db, tx } from "./db.js";
import { assertStorage } from "./quota.js";
import { wrapUntrusted } from "./prompt-injection.js";

// The date, recalled memory, the skills index, and retrieved knowledge sit beside the user message they
// were computed for. Providers cache by exact prefix, so dropping that block in the next turn would
// invalidate everything after it: the previous user message, the reply, and all of its tool results.
// Each block is stored and replayed verbatim instead. See docs/implementation/prompt-caching.md.

export interface TurnContext {
  /** The date line, so the system prefix does not change at midnight. */
  date: string;
  memory: string;
  skills: string;
  /** Retrieved knowledge passages and attached collection names; raw here, enveloped at delivery. */
  knowledge: string;
  /** The collections this block was retrieved from. None are replayed after one is detached or deleted. */
  knowledgeIds: string[];
}

interface Row {
  message_id: string;
  memory_enc: string | null;
  memory_revision: number;
  skills: string | null;
  date: string | null;
  knowledge: string | null;
  knowledge_ids: string | null;
}

/**
 * The model-facing form of a stored block. The stored JSON stays raw so `shownFactIds` and the memory
 * revision check keep working; the fact text and knowledge passages are spotlighted at delivery only.
 * That is deterministic, so the replayed block is byte-identical on every turn.
 */
export const contextText = (context: TurnContext) =>
  [
    context.date,
    context.memory ? wrapUntrusted(context.memory, { kind: "past_chat", name: "saved memory" }).text : "",
    context.knowledge ? wrapUntrusted(context.knowledge, { kind: "file", name: "knowledge base" }).text : "",
    context.skills,
  ].filter(Boolean).join("\n\n");

const parseIds = (value: string | null): string[] => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
};

/**
 * The stored context per user message id. Memory text is returned only while memory is active for the
 * chat and the account's memory revision is unchanged, so text from a deleted or edited fact is never
 * sent again. Knowledge text is returned only while every collection it came from is still attached and
 * accessible, so a detached or deleted collection cannot be replayed from history. The skills index is
 * dropped when the chat currently has none.
 */
export function storedTurnContexts(
  userId: string,
  threadId: string,
  gate: { memoryRevision: number | null; skills: boolean; knowledge?: ReadonlySet<string> },
): Map<string, TurnContext> {
  const rows = db.prepare("SELECT message_id, memory_enc, memory_revision, skills, date, knowledge, knowledge_ids FROM turn_context WHERE user_id = ? AND thread_id = ?").all(userId, threadId) as unknown as Row[];
  const out = new Map<string, TurnContext>();
  for (const row of rows) {
    let memory = "";
    if (row.memory_enc && gate.memoryRevision !== null && row.memory_revision === gate.memoryRevision) {
      try { memory = decrypt(row.memory_enc); } catch { memory = ""; }
    }
    const knowledgeIds = parseIds(row.knowledge_ids);
    const knowledge = row.knowledge && knowledgeIds.length && gate.knowledge && knowledgeIds.every((id) => gate.knowledge!.has(id)) ? row.knowledge : "";
    out.set(row.message_id, {
      date: row.date ?? "",
      memory,
      skills: gate.skills ? row.skills ?? "" : "",
      knowledge,
      knowledgeIds: knowledge ? knowledgeIds : [],
    });
  }
  return out;
}

export function saveTurnContext(userId: string, threadId: string, messageId: string, context: TurnContext, memoryRevision: number) {
  return tx(() => {
    const knowledge = context.knowledge || null;
    const knowledgeIds = context.knowledgeIds.length ? JSON.stringify(context.knowledgeIds) : null;
    const bytes = (value: string | null) => (value ? Buffer.byteLength(value) : 0);
    const previous = db
      .prepare("SELECT knowledge, knowledge_ids FROM turn_context WHERE thread_id = ? AND message_id = ? AND user_id = ?")
      .get(threadId, messageId, userId) as { knowledge: string | null; knowledge_ids: string | null } | undefined;
    // Knowledge text duplicates source passages beside every user message, so it is charged to the owner
    // like chunks and memories. A rewrite of the same message charges only net growth.
    assertStorage(userId, bytes(knowledge) + bytes(knowledgeIds) - bytes(previous?.knowledge ?? null) - bytes(previous?.knowledge_ids ?? null));
    db.prepare(`INSERT INTO turn_context (thread_id, message_id, user_id, memory_enc, memory_revision, skills, date, knowledge, knowledge_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id, message_id) DO UPDATE SET memory_enc = excluded.memory_enc, memory_revision = excluded.memory_revision, skills = excluded.skills, date = excluded.date,
        knowledge = excluded.knowledge, knowledge_ids = excluded.knowledge_ids`)
      .run(
        threadId,
        messageId,
        userId,
        context.memory ? encrypt(context.memory) : null,
        memoryRevision,
        context.skills || null,
        context.date || null,
        knowledge,
        knowledgeIds,
      );
  });
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
