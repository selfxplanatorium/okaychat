import { Hono } from "hono";
import type { AppEnv } from "./auth.js";
import { db } from "./db.js";

// Snippet markers that cannot appear in user text, so the client can split on them safely.
const OPEN = "\u0002";
const CLOSE = "\u0003";

export interface SearchHit {
  threadId: string;
  title: string | null;
  messageId: string;
  snippet: string;
}

/** Each word quoted (no FTS syntax from users), the last one as a prefix so results appear while typing. */
function toFtsQuery(input: string): string | null {
  const words = input.match(/[\p{L}\p{N}_]+/gu);
  if (!words?.length) return null;
  return words.map((w, i) => `"${w}"${i === words.length - 1 ? "*" : ""}`).join(" ");
}

export function searchMessages(userId: string, query: string, projectId?: string): SearchHit[] {
  const fts = toFtsQuery(query);
  if (!fts) return [];
  const rows = db
    .prepare(
      `SELECT f.thread_id AS threadId, f.message_id AS messageId, t.title, snippet(messages_fts, 0, '${OPEN}', '${CLOSE}', '…', 12) AS snippet
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
