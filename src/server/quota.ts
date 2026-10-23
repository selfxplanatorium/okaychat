import { HTTPException } from "hono/http-exception";
import { db } from "./db.js";
import { env } from "./env.js";

// Per-user storage quota. Every byte a user owns — uploads, artifact versions (source + built file),
// generated images, run_code outputs, fonts, the profile picture, memories, project files — counts
// against one limit, so the database volume cannot fill up invisibly. Enforced on every write path:
// HTTP routes answer 413, tools throw and the model sees the message.

export class QuotaError extends HTTPException {
  constructor(
    readonly used: number,
    readonly limit: number,
  ) {
    super(413, { message: quotaMessage(used, limit) });
  }
}

export function quotaMessage(used: number, limit: number): string {
  const gb = (n: number) => `${(n / 1024 ** 3).toFixed(2)} GB`;
  return `Storage quota exceeded: ${gb(used)} of ${gb(limit)} already used. Delete old chats, attachments, or fonts to make room.`;
}

/**
 * Stored bytes of one message. Inline data URLs are left out: those attachments are also kept in
 * `uploads` and charged there, so counting them here would bill the same file twice.
 */
export function messageBytes(contentJson: string): number {
  return Buffer.byteLength(contentJson.replace(/data:[^"]*/g, ""));
}

/** SQL for one user's stored bytes. The argument is either `@user` or a users alias like `u.id`. */
export function storageUsedSql(user: string): string {
  // `length(CAST(x AS BLOB))` counts UTF-8 bytes; `length` on TEXT would count characters. The named
  // parameter repeats once per counted table.
  return `COALESCE((SELECT SUM(bytes) FROM (
    SELECT COALESCE(SUM(length(data)), 0) AS bytes FROM uploads WHERE user_id = ${user}
    UNION ALL SELECT COALESCE(SUM(length(CAST(content AS BLOB)) + size), 0) FROM artifacts
      WHERE thread_id IN (SELECT id FROM threads WHERE user_id = ${user})
    UNION ALL SELECT COALESCE(SUM(length(data)), 0) FROM user_fonts WHERE user_id = ${user}
    UNION ALL SELECT COALESCE(SUM(length(data)), 0) FROM user_avatars WHERE user_id = ${user}
    UNION ALL SELECT COALESCE(SUM(size), 0) FROM images WHERE user_id = ${user}
    UNION ALL SELECT COALESCE(SUM(length(data)), 0) FROM sandbox_files WHERE user_id = ${user}
    UNION ALL SELECT COALESCE(SUM(length(CAST(content_enc AS BLOB))), 0) FROM memories WHERE user_id = ${user}
    UNION ALL SELECT COALESCE(SUM(length(CAST(content AS BLOB))), 0) FROM project_files
      WHERE project_id IN (SELECT id FROM projects WHERE user_id = ${user})
    UNION ALL SELECT COALESCE(SUM(length(CAST(name AS BLOB)) + length(CAST(description AS BLOB)) + length(CAST(body AS BLOB))), 0)
      FROM skills WHERE user_id = ${user}
    UNION ALL SELECT COALESCE(SUM(length(CAST(f.name AS BLOB)) + length(CAST(f.content AS BLOB))), 0)
      FROM skill_files f JOIN skills s ON s.id = f.skill_id WHERE s.user_id = ${user}
  )), 0)`;
}

export function storageUsed(userId: string): number {
  return (db.prepare(`SELECT ${storageUsedSql("@user")} AS used`).get({ "@user": userId }) as { used: number }).used;
}

/** The user's own limit, or the server default when no per-user override is set. */
export function userStorageLimit(userId: string): number {
  const row = db.prepare("SELECT storage_limit FROM users WHERE id = ?").get(userId) as { storage_limit: number | null } | undefined;
  return row?.storage_limit ?? env.storageLimit;
}

/** Throws QuotaError when storing `incoming` more bytes would pass the user's limit. */
export function assertStorage(userId: string, incoming: number): { used: number; limit: number } {
  const limit = userStorageLimit(userId);
  const used = storageUsed(userId);
  if (incoming > 0 && used + incoming > limit) throw new QuotaError(used, limit);
  return { used, limit };
}
