import { Hono } from "hono";
import type { AppEnv } from "./auth.js";
import { db } from "./db.js";
import { SNIPPET_CLOSE, SNIPPET_OPEN, toFtsQuery } from "./fts.js";

export interface SearchHit {
  threadId: string;
  title: string | null;
  messageId: string;
  snippet: string;
}

export function searchMessages(userId: string, query: string, projectId?: string): SearchHit[] {
  const fts = toFtsQuery(query);
  if (!fts) return [];
  const rows = db
    .prepare(
      `SELECT f.thread_id AS threadId, f.message_id AS messageId, t.title, snippet(messages_fts, 0, '${SNIPPET_OPEN}', '${SNIPPET_CLOSE}', '…', 12) AS snippet
       FROM messages_fts f JOIN threads t ON t.id = f.thread_id
       WHERE messages_fts MATCH ? AND t.user_id = ? AND t.compare_group_id IS NULL ${projectId ? "AND t.project_id = ?" : ""}
       ORDER BY rank LIMIT 100`,
    )
    .all(...[fts, userId, ...(projectId ? [projectId] : [])]) as unknown as SearchHit[];
  // Best hit per thread.
  const seen = new Set<string>();
  return rows.filter((r) => !seen.has(r.threadId) && seen.add(r.threadId)).slice(0, 20);
}

export const searchRoutes = new Hono<AppEnv>().get("/search", (c) =>
  c.json(searchMessages(c.get("user").id, c.req.query("q") ?? "", c.req.query("project") || undefined)),
);
