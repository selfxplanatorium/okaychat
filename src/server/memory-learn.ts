import { generateText } from "ai";
import { z } from "zod";
import type { MemoryEntry } from "../shared/memory.js";
import { resolveModel } from "./catalog/providers.js";
import { encrypt } from "./crypto.js";
import { db, tx } from "./db.js";
import { createModel } from "./llm.js";
import { factLine, listMemories, memoryPreferences, rankMemories, saveMemory, scopeFingerprint, summaryRow, transcriptText } from "./memory.js";
import { promptText } from "./prompts.js";
import { assertStorage } from "./quota.js";
import { getSettings } from "./settings.js";
import { currentBranch, getThread } from "./threads.js";
import { costOf, normalizeUsage, recordUsage } from "./usage.js";

// Background memory work, off the reply's critical path (Letta's "sleep-time" agent, ChatGPT's and
// Claude's asynchronous memory generation). Two jobs:
// 1. Review: once a chat has been idle for a while, extract lasting user facts from the messages added
//    since the last review and reconcile them with saved memory as add/update/delete operations (Mem0).
// 2. Summarize: when a scope's facts change, rewrite the summary every chat in that scope starts with.
// Both use the account's utility model and record usage as kind "memory". See docs/implementation/memory.md.

const IDLE_MS = 10 * 60_000;
/** Enabling memory reviews chats active in the last two weeks, not the whole history. */
const LOOKBACK_MS = 14 * 86_400_000;
const SUMMARY_SETTLE_MS = 60_000;
const RETRY_MS = 30 * 60_000;
const JOBS_PER_TICK = 3;

async function backgroundModel(userId: string, preferred?: string | null) {
  const settings = getSettings(userId);
  for (const ref of [settings.utilityModel, preferred, settings.defaultModel]) {
    if (!ref) continue;
    try { return await resolveModel(userId, ref); } catch { /* try the next one */ }
  }
  throw new Error("No model available for memory. Choose a utility model in General settings.");
}

async function complete(userId: string, prompt: string, opts: { threadId?: string; preferred?: string | null; maxOutputTokens: number }): Promise<string> {
  const { model, conn } = await backgroundModel(userId, opts.preferred);
  const handle = createModel(model, conn, { userId });
  const result = await generateText({ model: handle.model, providerOptions: handle.providerOptions, maxOutputTokens: opts.maxOutputTokens, prompt });
  const usage = normalizeUsage(result.totalUsage);
  recordUsage({ userId, threadId: opts.threadId, providerId: model.providerId, modelId: model.id, kind: "memory", usage, cost: costOf(model.cost, usage) });
  return result.text;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const operationsSchema = z.object({
  operations: z.array(z.discriminatedUnion("op", [
    z.object({ op: z.literal("add"), content: z.string().trim().min(1).max(2000) }),
    z.object({ op: z.literal("update"), id: z.string(), content: z.string().trim().min(1).max(2000) }),
    z.object({ op: z.literal("delete"), id: z.string() }),
  ])).max(30),
});
export type MemoryOperation = z.infer<typeof operationsSchema>["operations"][number];

/** Models wrap JSON in fences or prose despite instructions. Take the outermost object. */
export function parseOperations(text: string): MemoryOperation[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Memory review returned no JSON");
  return operationsSchema.parse(JSON.parse(text.slice(start, end + 1))).operations;
}

interface ReviewState { user_id: string; id: string; updated_at: number; memory_cursor: string | null; model_ref: string | null }

/**
 * Reviews the messages added to a chat since its last review. Facts are added to the chat's scope;
 * updates and deletes may target any fact the chat can see (its project and account memory).
 * Returns the applied operations, or null when the chat is not eligible.
 */
export async function reviewThread(userId: string, threadId: string): Promise<MemoryOperation[] | null> {
  const preferences = memoryPreferences(userId);
  const thread = getThread(userId, threadId);
  const state = db.prepare("SELECT user_id, id, updated_at, memory_cursor, model_ref FROM threads WHERE user_id = ? AND id = ?").get(userId, threadId) as ReviewState | undefined;
  if (!preferences.enabled || !preferences.autoSave || !thread || thread.memoryDisabled || !state) return null;
  const branch = currentBranch(userId, threadId);
  const done = () => db.prepare("UPDATE threads SET memory_cursor = ?, memory_scanned_at = ? WHERE id = ?").run(branch.at(-1)?.id ?? null, state.updated_at, threadId);
  // An edited or regenerated branch no longer contains the cursor; review the whole branch again.
  const from = branch.findIndex((m) => m.id === state.memory_cursor) + 1;
  const added = branch.slice(from);
  if (!added.some((m) => m.role === "user")) { done(); return []; }
  const transcript = transcriptText(added);
  const scope = thread.projectId;
  const visible = listMemories(userId, scope);
  const candidates = rankMemories(visible, transcript).slice(0, 60);
  const text = await complete(userId, promptText("memoryExtract", {
    date: day(Date.now()),
    memories: candidates.length ? candidates.map((e) => JSON.stringify(factLine(e))).join("\n") : "(none)",
    transcript,
  }), { threadId, preferred: state.model_ref, maxOutputTokens: 2000 });
  const operations = parseOperations(text);
  const applied: MemoryOperation[] = [];
  tx(() => {
    // The user may have paused memory, excluded this chat, moved it, or edited memory meanwhile.
    const now = memoryPreferences(userId);
    const current = getThread(userId, threadId);
    if (!now.enabled || !now.autoSave || now.revision !== preferences.revision || !current || current.memoryDisabled || current.projectId !== scope) return;
    const known = new Map<string, MemoryEntry>(candidates.map((e) => [e.id, e]));
    for (const op of operations) {
      try {
        if (op.op === "add") {
          if (!saveMemory(userId, { content: op.content, scope }, "conversation").duplicate) applied.push(op);
        } else if (known.has(op.id)) {
          const entry = known.get(op.id)!;
          if (op.op === "update") saveMemory(userId, { content: op.content, scope: entry.scope }, "conversation", entry.id);
          else db.prepare("DELETE FROM memories WHERE user_id = ? AND id = ?").run(userId, entry.id);
          known.delete(op.id);
          applied.push(op);
        }
      } catch (error) {
        // A full memory or a duplicate correction skips that operation, not the review.
        console.warn("[memory] skipped operation:", (error as Error).message);
      }
    }
    done();
  });
  return applied;
}

/** Rewrites one scope's summary from its facts. Without facts (or with a deleted project) the summary is removed. */
export async function refreshSummary(userId: string, scope: string, { force = false } = {}): Promise<void> {
  const preferences = memoryPreferences(userId);
  const project = scope ? db.prepare("SELECT name FROM projects WHERE id = ? AND user_id = ?").get(scope, userId) as { name: string } | undefined : undefined;
  const facts = listMemories(userId, scope || null).filter((e) => (e.scope ?? "") === scope);
  if (!facts.length || (scope && !project)) {
    db.prepare("DELETE FROM memory_summaries WHERE user_id = ? AND scope = ?").run(userId, scope);
    return;
  }
  if (!force && !preferences.enabled) return;
  const fingerprint = scopeFingerprint(userId, scope);
  const now = Date.now();
  db.prepare(`INSERT INTO memory_summaries (user_id, scope, attempted_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id, scope) DO UPDATE SET attempted_at = excluded.attempted_at`).run(userId, scope, now);
  try {
    // Newest first, so the bound drops the oldest facts when a library is very large.
    let chars = 0;
    const lines = rankMemories(facts, "").filter((e) => (chars += e.content.length) <= 60_000).map((e) => `- (${day(e.updatedAt)}) ${e.content.replace(/\n/g, " ")}`);
    const text = (await complete(userId, promptText("memorySummary", {
      date: day(now),
      scope: project ? `memory of the project "${project.name}", used only in that project's chats` : "account memory, used in every chat",
      memories: lines.join("\n"),
    }), { maxOutputTokens: 2000 })).trim().slice(0, 8000);
    if (!text) throw new Error("The model returned an empty summary");
    const encrypted = encrypt(text);
    const previous = summaryRow(userId, scope)?.content_enc ?? "";
    assertStorage(userId, Buffer.byteLength(encrypted) - Buffer.byteLength(previous));
    // Stored with the revision it was written under. If the user edited memory meanwhile, it is unusable
    // and the next tick rewrites it.
    db.prepare("UPDATE memory_summaries SET content_enc = ?, fingerprint = ?, revision = ?, error = NULL, updated_at = ? WHERE user_id = ? AND scope = ?")
      .run(encrypted, fingerprint, preferences.revision, Date.now(), userId, scope);
  } catch (error) {
    db.prepare("UPDATE memory_summaries SET error = ? WHERE user_id = ? AND scope = ?").run((error as Error).message.slice(0, 500), userId, scope);
    if (force) throw error;
  }
}

/** One pass of background memory work. Bounded per tick so a backlog never floods a provider. */
export async function memoryTick(now = Date.now()): Promise<void> {
  let jobs = 0;
  const threads = db.prepare(`SELECT t.user_id, t.id FROM threads t JOIN memory_preferences p ON p.user_id = t.user_id
    WHERE p.enabled = 1 AND p.auto_save = 1 AND t.memory_disabled = 0 AND t.updated_at > t.memory_scanned_at
      AND t.updated_at < ? AND t.updated_at > ? ORDER BY t.updated_at LIMIT ?`).all(now - IDLE_MS, now - LOOKBACK_MS, JOBS_PER_TICK) as Array<{ user_id: string; id: string }>;
  for (const t of threads) {
    jobs++;
    try { await reviewThread(t.user_id, t.id); } catch (error) {
      // Mark it reviewed anyway: retrying a failing model every minute costs more than a missed fact.
      console.warn("[memory] chat review failed:", (error as Error).message);
      db.prepare("UPDATE threads SET memory_scanned_at = updated_at WHERE id = ?").run(t.id);
    }
  }
  const scopes = db.prepare(`SELECT p.user_id, s.scope FROM memory_preferences p
    JOIN (SELECT user_id, scope, MAX(updated_at) AS changed FROM memories GROUP BY user_id, scope
          UNION SELECT user_id, scope, 0 FROM memory_summaries) s ON s.user_id = p.user_id
    WHERE p.enabled = 1 GROUP BY p.user_id, s.scope HAVING MAX(s.changed) < ?`).all(now - SUMMARY_SETTLE_MS) as Array<{ user_id: string; scope: string }>;
  for (const { user_id: userId, scope } of scopes) {
    if (jobs >= JOBS_PER_TICK * 2) break;
    const row = summaryRow(userId, scope);
    const { revision } = memoryPreferences(userId);
    const current = !!row?.content_enc && row.revision === revision && row.fingerprint === scopeFingerprint(userId, scope);
    if (current || (row?.error && now - row.attempted_at < RETRY_MS)) continue;
    jobs++;
    await refreshSummary(userId, scope).catch((error: Error) => console.warn("[memory] summary failed:", error.message));
  }
}

let started = false;
export function startMemoryWorker() {
  if (started) return;
  started = true;
  let ticking = false;
  setInterval(() => {
    if (ticking) return;
    ticking = true;
    void memoryTick().catch((error: Error) => console.warn("[memory]", error.message)).finally(() => (ticking = false));
  }, 60_000).unref();
}
