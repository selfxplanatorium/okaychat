import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import { Hono } from "hono";
import { z } from "zod";
import type { ComparisonGroupSummary, ComparisonPaneDetail } from "../shared/compare.js";
import { COMPARE_MAX_GROUPS, COMPARE_MAX_PANES, COMPARE_MAX_PROMPT, COMPARE_MIN_PANES, COMPARE_RETENTION_DAYS } from "../shared/compare.js";
import type { AppEnv } from "./auth.js";
import { resolveChatTarget } from "./catalog/chat-targets.js";
import { newId } from "./crypto.js";
import { db, tx } from "./db.js";
import { AppError } from "./errors.js";
import { assertModelAllowed } from "./permissions/guard.js";
import { getProject } from "./projects.js";
import { appendMessage, branchThread, currentBranch, deleteThread, ensureThread, getThread, updateThread } from "./threads.js";
import { threadBusy } from "./thread-runs.js";
import { deleteThreadImages } from "./tools/image.js";
import { deleteSandboxWorkspace } from "./tools/sandbox.js";

/**
 * Side-by-side model comparison. Each pane is a real hidden chat (`threads.compare_group_id`) that runs
 * the normal `/api/chat` turn, so usage, cancellation, permissions, caching, compaction, and branch
 * semantics are the chat's own. Creating and deleting groups is the only comparison-specific storage.
 */

interface GroupRow {
  id: string;
  user_id: string;
  title: string;
  prompt: string;
  project_id: string | null;
  source_thread_id: string | null;
  created_at: number;
  updated_at: number;
  pane_count?: number;
}

interface PaneRow {
  group_id: string;
  thread_id: string;
  position: number;
  model_ref: string;
}

const toSummary = (row: GroupRow, paneCount: number): ComparisonGroupSummary => ({
  id: row.id,
  title: row.title,
  prompt: row.prompt,
  projectId: row.project_id,
  sourceThreadId: row.source_thread_id,
  paneCount,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const ownedGroup = (userId: string, id: string) =>
  db.prepare("SELECT * FROM comparison_groups WHERE id = ? AND user_id = ?").get(id, userId) as GroupRow | undefined;

const panesOf = (groupId: string) =>
  db.prepare("SELECT * FROM comparison_panes WHERE group_id = ? ORDER BY position").all(groupId) as unknown as PaneRow[];

const paneCount = (groupId: string) =>
  (db.prepare("SELECT COUNT(*) AS n FROM comparison_panes WHERE group_id = ?").get(groupId) as { n: number }).n;

const summaryOf = (row: GroupRow): ComparisonGroupSummary => toSummary(row, row.pane_count ?? paneCount(row.id));

function panesDetail(userId: string, panes: PaneRow[]): ComparisonPaneDetail[] {
  return panes.map((pane) => {
    const thread = getThread(userId, pane.thread_id);
    const model = thread?.modelRef ?? pane.model_ref;
    return {
      threadId: pane.thread_id,
      modelRef: model,
      modelName: model.split("/").at(-1) ?? model,
      title: thread?.title ?? null,
      messages: currentBranch(userId, pane.thread_id),
    };
  });
}

/** True only for a hidden pane owned by this account. */
export function isCompareThread(userId: string, threadId: string): boolean {
  return !!db.prepare("SELECT 1 FROM threads WHERE id = ? AND user_id = ? AND compare_group_id IS NOT NULL").get(threadId, userId);
}

const groupOfThread = (userId: string, threadId: string) =>
  (db.prepare("SELECT compare_group_id FROM threads WHERE id = ? AND user_id = ?").get(threadId, userId) as
    | { compare_group_id: string | null }
    | undefined)?.compare_group_id ?? null;

const touchGroup = (groupId: string) => db.prepare("UPDATE comparison_groups SET updated_at = ? WHERE id = ?").run(Date.now(), groupId);

/**
 * Stores the pane's user message. A retry of the same id/content is a no-op.
 *
 * `previousId` is the message the client showed before this one. The reply-persistence drain runs
 * beside the response, so "newest stored row" can lag a just-finished reply; the client's own branch
 * is the truth when that row is stored here. A foreign or missing id falls back to the newest row.
 */
export function persistCompareUserMessage(userId: string, threadId: string, message: UIMessage, previousId?: string): void {
  if (!isCompareThread(userId, threadId)) throw new AppError({ code: "not_found", message: "Comparison pane not found." });
  // A retry re-sends the same user row. Keep its stored parent: recomputing it would make the
  // assistant reply that already answered it the parent, closing a cycle.
  const existing = db.prepare("SELECT parent_id FROM messages WHERE thread_id = ? AND id = ?").get(threadId, message.id) as
    | { parent_id: string | null }
    | undefined;
  const hinted = previousId && previousId !== message.id
    ? (db.prepare("SELECT id FROM messages WHERE thread_id = ? AND id = ?").get(threadId, previousId) as { id: string } | undefined)
    : undefined;
  const parent = existing
    ? { id: existing.parent_id }
    : (hinted ?? (db.prepare("SELECT id FROM messages WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(threadId) as { id: string } | undefined));
  const { id, role, parts, metadata } = message;
  const content = { role, parts, ...(metadata ? { metadata } : {}) };
  tx(() => {
    appendMessage(userId, threadId, { id, parent_id: parent?.id ?? null, format: "ai-sdk/v6", content });
    const groupId = groupOfThread(userId, threadId);
    if (groupId) touchGroup(groupId);
  });
}

/**
 * Drains the duplicated stream and stores the final assistant message. A stopped pane keeps only its
 * user message, so Retry after reload answers it again.
 */
export function persistCompareReply(
  userId: string,
  threadId: string,
  userMessageId: string,
  stream: ReadableStream<UIMessageChunk>,
  signal: AbortSignal,
): void {
  void (async () => {
    try {
      let assistant: UIMessage | undefined;
      for await (const message of readUIMessageStream({ stream })) assistant = message;
      if (signal.aborted || !assistant || !assistant.parts.length) return;
      // A deleted chat stays deleted.
      if (!isCompareThread(userId, threadId)) return;
      const { id: _id, ...content } = assistant;
      tx(() => {
        appendMessage(userId, threadId, { id: assistant!.id, parent_id: userMessageId, format: "ai-sdk/v6", content });
        const groupId = groupOfThread(userId, threadId);
        if (groupId) touchGroup(groupId);
      });
    } catch (error) {
      // Only the message: a provider body or a prompt must not be logged.
      console.warn("[compare] a pane reply was not stored:", (error as Error).message);
    }
  })();
}

const bodyInput = z.object({
  prompt: z.string().trim().min(1).max(COMPARE_MAX_PROMPT),
  models: z.array(z.object({ ref: z.string().min(3).max(300), effort: z.string().max(20).optional() })).min(COMPARE_MIN_PANES).max(COMPARE_MAX_PANES),
  projectId: z.string().max(200).nullable().optional(),
  sourceThreadId: z.string().max(200).nullable().optional(),
});

/** Deletes every pane chat (messages, images, sandbox workspace) and then the group. */
async function deleteGroup(userId: string, groupId: string): Promise<void> {
  const panes = panesOf(groupId);
  db.prepare("DELETE FROM comparison_groups WHERE id = ? AND user_id = ?").run(groupId, userId);
  for (const pane of panes) {
    deleteThread(userId, pane.thread_id);
    await deleteThreadImages(userId, pane.thread_id).catch(() => {});
    await deleteSandboxWorkspace(userId, pane.thread_id).catch(() => {});
  }
}

export const compareRoutes = new Hono<AppEnv>()
  .get("/compare", (c) => {
    const rows = db
      .prepare(
        `SELECT g.*, (SELECT COUNT(*) FROM comparison_panes p WHERE p.group_id = g.id) AS pane_count
           FROM comparison_groups g WHERE g.user_id = ?
          ORDER BY g.updated_at DESC, g.id DESC LIMIT ?`,
      )
      .all(c.get("user").id, COMPARE_MAX_GROUPS) as unknown as GroupRow[];
    return c.json({ groups: rows.map(summaryOf) });
  })
  .get("/compare/:id", (c) => {
    const userId = c.get("user").id;
    const group = ownedGroup(userId, c.req.param("id"));
    if (!group) return c.json({ error: "Not found" }, 404);
    return c.json({ group: summaryOf(group), panes: panesDetail(userId, panesOf(group.id)) });
  })
  .post("/compare", async (c) => {
    const userId = c.get("user").id;
    const body = bodyInput.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: `A comparison needs a prompt and ${COMPARE_MIN_PANES} to ${COMPARE_MAX_PANES} different models.` }, 400);
    const refs = body.data.models.map((model) => model.ref);
    if (new Set(refs).size !== refs.length) return c.json({ error: "Pick a different model for each pane." }, 400);
    const groups = (db.prepare("SELECT COUNT(*) AS n FROM comparison_groups WHERE user_id = ?").get(userId) as { n: number }).n;
    if (groups >= COMPARE_MAX_GROUPS) return c.json({ error: "Delete an old comparison first." }, 409);
    const projectId = body.data.projectId && getProject(userId, body.data.projectId) ? body.data.projectId : null;
    if (body.data.projectId && !projectId) return c.json({ error: "Project not found" }, 404);
    const sourceThreadId = body.data.sourceThreadId ?? null;
    if (sourceThreadId) {
      const source = getThread(userId, sourceThreadId);
      if (!source) return c.json({ error: "Chat not found" }, 404);
      if (source.compareGroupId) return c.json({ error: "Start from a normal chat, not a comparison pane." }, 409);
    }
    // Model checks touch the catalog and the account's policies; do them before any write.
    const resolved: Array<{ ref: string; name: string }> = [];
    for (const ref of refs) {
      const target = await resolveChatTarget(userId, ref).catch(() => null);
      if (!target || target.kind !== "llm") return c.json({ error: "Pick a language model for every pane." }, 400);
      assertModelAllowed(userId, ref);
      resolved.push({ ref, name: target.model.name });
    }
    const groupId = newId("cmp");
    const now = Date.now();
    const title = body.data.prompt.slice(0, 60);
    const sourceLeaf = sourceThreadId ? currentBranch(userId, sourceThreadId).at(-1)?.id : undefined;
    tx(() => {
      db.prepare(
        `INSERT INTO comparison_groups (id, user_id, title, prompt, project_id, source_thread_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(groupId, userId, title, body.data.prompt, projectId, sourceThreadId, now, now);
      const insertPane = db.prepare("INSERT INTO comparison_panes (group_id, thread_id, position, model_ref) VALUES (?, ?, ?, ?)");
      resolved.forEach((model, position) => {
        const threadId = newId("thr");
        const paneTitle = `${title.slice(0, 40)} · ${model.name}`;
        if (sourceThreadId && sourceLeaf) {
          branchThread(userId, sourceThreadId, sourceLeaf, threadId, model.ref);
          updateThread(userId, threadId, { title: paneTitle, modelRef: model.ref, compareGroupId: groupId });
        } else {
          ensureThread(userId, threadId, projectId);
          updateThread(userId, threadId, { title: paneTitle, modelRef: model.ref, compareGroupId: groupId });
        }
        insertPane.run(groupId, threadId, position, model.ref);
      });
    });
    const group = ownedGroup(userId, groupId)!;
    return c.json({ group: summaryOf(group), panes: panesDetail(userId, panesOf(groupId)) }, 201);
  })
  .post("/compare/:id/panes/:threadId/promote", async (c) => {
    const userId = c.get("user").id;
    const group = ownedGroup(userId, c.req.param("id"));
    if (!group) return c.json({ error: "Not found" }, 404);
    const threadId = c.req.param("threadId");
    const pane = db.prepare("SELECT * FROM comparison_panes WHERE group_id = ? AND thread_id = ?").get(group.id, threadId) as PaneRow | undefined;
    if (!pane) return c.json({ error: "Not found" }, 404);
    if (threadBusy(threadId)) return c.json({ error: "Stop the reply first." }, 409);
    db.prepare("DELETE FROM comparison_panes WHERE group_id = ? AND thread_id = ?").run(group.id, threadId);
    db.prepare("UPDATE threads SET compare_group_id = NULL WHERE id = ? AND user_id = ?").run(threadId, userId);
    const remaining = panesOf(group.id);
    let nextGroup: ComparisonGroupSummary | null = null;
    if (remaining.length < COMPARE_MIN_PANES) {
      // A comparison with one pane is no comparison: what is left becomes ordinary chats too.
      const clear = db.prepare("UPDATE threads SET compare_group_id = NULL WHERE id = ? AND user_id = ?");
      for (const other of remaining) clear.run(other.thread_id, userId);
      db.prepare("DELETE FROM comparison_groups WHERE id = ? AND user_id = ?").run(group.id, userId);
    } else {
      touchGroup(group.id);
      nextGroup = summaryOf(ownedGroup(userId, group.id)!);
    }
    return c.json({ thread: getThread(userId, threadId), group: nextGroup });
  })
  .delete("/compare/:id", async (c) => {
    const userId = c.get("user").id;
    const group = ownedGroup(userId, c.req.param("id"));
    if (!group) return c.json({ error: "Not found" }, 404);
    if (panesOf(group.id).some((pane) => threadBusy(pane.thread_id))) return c.json({ error: "Stop the reply first." }, 409);
    await deleteGroup(userId, group.id);
    return c.json({ ok: true });
  });

/** Expired comparisons are removed on a slow timer; deleting a group is the same path as the route. */
export function startCompareMaintenance(): void {
  setInterval(() => {
    const cutoff = Date.now() - COMPARE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const rows = db.prepare("SELECT id, user_id FROM comparison_groups WHERE updated_at < ?").all(cutoff) as Array<{ id: string; user_id: string }>;
    if (!rows.length) return;
    void (async () => {
      let removed = 0;
      for (const row of rows) {
        try {
          await deleteGroup(row.user_id, row.id);
          removed++;
        } catch {
          // A failed sweep tries again in six hours.
        }
      }
      if (removed) console.log(`[compare] removed ${removed} expired comparisons`);
    })();
  }, 6 * 60 * 60 * 1000).unref();
}
