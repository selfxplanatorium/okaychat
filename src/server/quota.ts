import { db } from "./db.js";
import { env } from "./env.js";
import { AppError } from "./errors.js";

// Per-user storage quota. Every byte a user owns — uploads, artifact versions (source + built file),
// generated images, run_code outputs, fonts, the profile picture, memories, project files — counts
// against one limit, so the database volume cannot fill up invisibly. Enforced on every write path:
// HTTP routes answer 413, tools throw and the model sees the message.

export class QuotaError extends AppError {
  constructor(
    readonly used: number,
    readonly limit: number,
  ) {
    // The used/limit numbers are safe to show and make the inline upload error actionable.
    super({ code: "storage_quota", message: quotaMessage(used, limit), details: { used, limit } });
  }
}

export function quotaMessage(used: number, limit: number): string {
  const gb = (n: number) => `${(n / 1024 ** 3).toFixed(2)} GB`;
  return `Storage quota exceeded: ${gb(used)} of ${gb(limit)} already used. Delete old chats, attachments, or fonts to make room.`;
}

/** Matches what `storeInlineAttachments` copies into `uploads`: base64 data URLs up to 25 MB. */
const INLINE_ATTACHMENT = /^data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/=\r\n]*$/;
const MAX_INLINE_LENGTH = Math.ceil((25 * 1024 * 1024) / 3) * 4 + 300;

/**
 * Stored bytes of one message. Inline attachments of user file/image parts are left out: those are
 * also kept in `uploads` and charged there, so counting them here would bill the same file twice.
 * Everything else counts in full, including text that merely contains "data:".
 */
export function messageBytes(contentJson: string): number {
  const total = Buffer.byteLength(contentJson);
  let content: { role?: unknown; parts?: unknown };
  try {
    content = JSON.parse(contentJson) as typeof content;
  } catch {
    return total;
  }
  if (!content || content.role !== "user" || !Array.isArray(content.parts)) return total;
  let inline = 0;
  for (const part of content.parts as Array<{ type?: unknown; url?: unknown; image?: unknown; data?: unknown }>) {
    if (!part || (part.type !== "file" && part.type !== "image")) continue;
    const url = part.url ?? part.image ?? part.data;
    if (typeof url !== "string" || url.length > MAX_INLINE_LENGTH || !INLINE_ATTACHMENT.test(url)) continue;
    // The JSON form without its quotes is what the stored text holds.
    inline += Buffer.byteLength(JSON.stringify(url)) - 2;
  }
  return total - inline;
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
    UNION ALL SELECT COALESCE(SUM(m.bytes + COALESCE(length(CAST(m.original_enc AS BLOB)), 0)), 0) FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.user_id = ${user}
    UNION ALL SELECT COALESCE(SUM(length(CAST(content_enc AS BLOB))), 0) FROM memories WHERE user_id = ${user}
    UNION ALL SELECT COALESCE(SUM(length(CAST(content_enc AS BLOB))), 0) FROM memory_summaries WHERE user_id = ${user}
    UNION ALL SELECT COALESCE(SUM(length(CAST(content AS BLOB))), 0) FROM project_files
      WHERE project_id IN (SELECT id FROM projects WHERE user_id = ${user})
    UNION ALL SELECT COALESCE(SUM(length(CAST(name AS BLOB)) + length(CAST(description AS BLOB)) + length(CAST(body AS BLOB))), 0)
      FROM skills WHERE user_id = ${user}
    UNION ALL SELECT COALESCE(SUM(length(CAST(f.name AS BLOB)) + length(CAST(f.content AS BLOB))), 0)
      FROM skill_files f JOIN skills s ON s.id = f.skill_id WHERE s.user_id = ${user}
    UNION ALL SELECT COALESCE(SUM(length(CAST(text AS BLOB))), 0) FROM knowledge_sources WHERE user_id = ${user}
    UNION ALL SELECT COALESCE(SUM(length(CAST(text AS BLOB)) + COALESCE(length(embedding), 0)), 0)
      FROM knowledge_chunks WHERE user_id = ${user}
    UNION ALL SELECT COALESCE(SUM(COALESCE(length(CAST(knowledge AS BLOB)), 0) + COALESCE(length(CAST(knowledge_ids AS BLOB)), 0)), 0)
      FROM turn_context WHERE user_id = ${user}
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
