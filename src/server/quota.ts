import { CUSTOM_LIMITS } from "../shared/custom-tools.js";
import { EVAL_RESULT_RESERVATION } from "../shared/evaluations.js";
import { db } from "./db.js";
import { env } from "./env.js";
import { AppError } from "./errors.js";

// Per-user storage quota. Every byte a user owns — uploads, artifact versions (source + built file),
// generated images, run_code outputs, fonts, the profile picture, memories, project files — counts
// (raster originals once per account in `media`, however many uploads/outputs point at them; their
// regenerable previews in media-cache are not charged)
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
/** The fixed reservation per generation receipt, covering usage, status, and bounded segments. */
export const RUN_RECEIPT_BYTES = 64 * 1024;

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
    UNION ALL SELECT COALESCE(SUM(size), 0) FROM media WHERE user_id = ${user}
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
    UNION ALL SELECT COALESCE(SUM(length(CAST(name AS BLOB)) + length(CAST(description AS BLOB)) + length(CAST(avatar AS BLOB)) + length(CAST(config_enc AS BLOB))), 0)
      FROM n8n_agents WHERE owner_id = ${user}
    UNION ALL SELECT COALESCE(SUM(length(CAST(session_enc AS BLOB)) + length(CAST(history_hash AS BLOB))), 0)
      FROM n8n_agent_sessions WHERE user_id = ${user}
    UNION ALL SELECT COALESCE(SUM(length(CAST(text AS BLOB))), 0) FROM user_model_instructions WHERE user_id = ${user}
    UNION ALL SELECT COALESCE(SUM(length(CAST(custom_instructions AS BLOB))), 0) FROM threads WHERE user_id = ${user}
    UNION ALL SELECT COALESCE(SUM(length(CAST(name AS BLOB)) + length(CAST(shortcut AS BLOB)) + length(CAST(body AS BLOB))), 0)
      FROM saved_prompts WHERE user_id = ${user}
    UNION ALL SELECT COALESCE(SUM(length(CAST(name AS BLOB)) + length(CAST(description AS BLOB)) + length(CAST(config_json AS BLOB))), 0)
      FROM assistant_presets WHERE user_id = ${user}
    UNION ALL SELECT COALESCE(SUM(COALESCE(length(CAST(assistant_json AS BLOB)), 0) + COALESCE(length(CAST(imported_assistant_json AS BLOB)), 0)), 0)
      FROM threads WHERE user_id = ${user}
    -- A run receipt reserves a fixed 64 KiB for its status, usage, and bounded segments, so the final
    -- numeric write cannot fail after the provider has already been paid. Config bytes are charged on top.
    UNION ALL SELECT COALESCE(SUM(${RUN_RECEIPT_BYTES} + length(CAST(config_json AS BLOB))), 0)
      FROM generation_runs WHERE thread_id IN (SELECT id FROM threads WHERE user_id = ${user})
    UNION ALL SELECT COALESCE(SUM(length(CAST(comment_enc AS BLOB))), 0)
      FROM message_feedback WHERE thread_id IN (SELECT id FROM threads WHERE user_id = ${user})
    -- Frozen share snapshots are stored user content; live links hold no bytes of their own.
    UNION ALL SELECT COALESCE(SUM(COALESCE(length(CAST(snapshot_json AS BLOB)), 0) + COALESCE(length(CAST(snapshot_assets_json AS BLOB)), 0)), 0)
      FROM shares WHERE user_id = ${user}
    UNION ALL SELECT COALESCE(SUM(length(CAST(d.name AS BLOB)) + length(CAST(d.description AS BLOB))), 0)
      FROM evaluation_datasets d WHERE d.user_id = ${user}
    UNION ALL SELECT COALESCE(SUM(
        length(CAST(c.input AS BLOB)) + length(CAST(c.instructions AS BLOB)) + length(CAST(c.expected AS BLOB))
        + length(CAST(c.notes AS BLOB)) + length(CAST(c.tags_json AS BLOB))), 0)
      FROM evaluation_cases c JOIN evaluation_datasets d ON d.id = c.dataset_id WHERE d.user_id = ${user}
    UNION ALL SELECT COALESCE(SUM(
        length(CAST(r.target_json AS BLOB)) + length(CAST(r.label AS BLOB))
        + COALESCE(length(CAST(r.judge_json AS BLOB)), 0)
        + COALESCE(length(CAST(r.error_message AS BLOB)), 0)), 0)
      FROM evaluation_runs r WHERE r.user_id = ${user}
    -- Keep output/error/judge capacity reserved durably; concurrent writes cannot spend it.
    UNION ALL SELECT COALESCE(SUM(
        length(CAST(x.case_json AS BLOB)) + MAX(${EVAL_RESULT_RESERVATION},
          length(CAST(x.output AS BLOB)) + COALESCE(length(CAST(x.error_message AS BLOB)), 0)
          + COALESCE((SELECT length(CAST(j.rationale AS BLOB)) FROM evaluation_scores j
              WHERE j.run_id = x.run_id AND j.case_id = x.case_id AND j.source = 'judge'), 0))), 0)
      FROM evaluation_results x JOIN evaluation_runs r ON r.id = x.run_id WHERE r.user_id = ${user}
    UNION ALL SELECT COALESCE(SUM(
        COALESCE(length(CAST(s.comment_enc AS BLOB)), 0)), 0)
      FROM evaluation_scores s JOIN evaluation_runs r ON r.id = s.run_id WHERE r.user_id = ${user}
    -- Channels are paid for by the current room owner, including other members' messages and AI output.
    -- A run's open output reservation is counted as a top-up to 64 KiB, so a growing body is charged once.
    UNION ALL SELECT COALESCE(SUM(
        length(CAST(c.name AS BLOB)) + length(CAST(c.description AS BLOB)) + COALESCE(length(CAST(c.ai_json AS BLOB)), 0)), 0)
      FROM channels c WHERE c.owner_id = ${user}
    UNION ALL SELECT COALESCE(SUM(length(CAST(m.body AS BLOB))), 0)
      FROM channel_messages m JOIN channels c ON c.id = m.channel_id WHERE c.owner_id = ${user}
    UNION ALL SELECT COALESCE(SUM(
        length(CAST(r.config_json AS BLOB)) + COALESCE(length(CAST(r.input_enc AS BLOB)), 0) + 1024
        + CASE WHEN r.state IN ('queued', 'running')
            THEN MAX(0, 65536 - length(CAST(m.body AS BLOB))) ELSE 0 END), 0)
      FROM channel_ai_runs r JOIN channels c ON c.id = r.channel_id JOIN channel_messages m ON m.id = r.message_id
      WHERE c.owner_id = ${user}
    -- Custom definitions charge their visible text and full encrypted config/secrets once. Every run
    -- reserves a fixed 128 KiB, so a terminal result write can never exceed the quota after side effects.
    UNION ALL SELECT COALESCE(SUM(
        length(CAST(name AS BLOB)) + length(CAST(description AS BLOB)) + length(CAST(icon AS BLOB))
        + length(CAST(input_schema_json AS BLOB)) + length(CAST(base_key AS BLOB))
        + length(CAST(config_enc AS BLOB)) + length(CAST(secrets_enc AS BLOB))), 0)
      FROM custom_tools WHERE user_id = ${user}
    UNION ALL SELECT COALESCE(SUM(${CUSTOM_LIMITS.resultReservation}), 0)
      FROM custom_tool_runs WHERE user_id = ${user}
    -- Notes and calendar events are ordinary account text; only their visible text columns count.
    UNION ALL SELECT COALESCE(SUM(length(CAST(title AS BLOB)) + length(CAST(body AS BLOB))), 0)
      FROM notes WHERE user_id = ${user}
    UNION ALL SELECT COALESCE(SUM(length(CAST(title AS BLOB)) + length(CAST(description AS BLOB))
      + length(CAST(location AS BLOB)) + length(CAST(url AS BLOB))), 0)
      FROM calendar_events WHERE user_id = ${user}
    -- API key metadata reserves a fixed 1 KiB per retained row. Requests, audit, rate, and usage rows are
    -- bounded operational metadata, excluded like the other operational counters.
    UNION ALL SELECT COUNT(*) * 1024 FROM api_keys WHERE user_id = ${user}
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
