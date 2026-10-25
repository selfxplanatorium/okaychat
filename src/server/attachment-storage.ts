import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { HTTPException } from "hono/http-exception";

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Legacy messages and saved temporary chats can contain inline files without a storage marker.
 * Keep those original message bytes unchanged; materialize an owned copy for the Library instead. */
export function storeInlineAttachments(db: DatabaseSync, userId: string, threadId: string, content: unknown, check?: (bytes: number) => void): void {
  if (threadId.startsWith("tmp_") || !content || typeof content !== "object") return;
  const message = content as { role?: string; parts?: Array<{ type: string; url?: unknown; image?: unknown; data?: unknown; filename?: string; text?: string }> };
  if (message.role !== "user" || !Array.isArray(message.parts)) return;
  for (const part of message.parts) {
    if (part.type !== "file" && part.type !== "image") continue;
    const url = part.url ?? part.image ?? part.data;
    if (typeof url !== "string" || !url.startsWith("data:")) continue;
    const match = /^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/=\r\n]*)$/.exec(url);
    if (!match) continue;
    const encoded = match[2]!;
    if (encoded.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4) {
      if (check) throw new HTTPException(413, { message: "File is larger than 25 MB" });
      continue;
    }
    const data = Buffer.from(encoded, "base64");
    if (data.length > MAX_ATTACHMENT_BYTES) {
      if (check) throw new HTTPException(413, { message: "File is larger than 25 MB" });
      continue;
    }
    // Mixed legacy image/PDF messages may have a file_id for only some parts. Deduplicate bytes,
    // rather than assuming that one marker means every attachment was already stored.
    const previous = db.prepare("SELECT id FROM uploads WHERE user_id = ? AND data = ? LIMIT 1").get(userId, data);
    if (previous) continue;
    check?.(data.length);
    const mime = match[1]!;
    const extension = ({ "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "application/pdf": "pdf" } as Record<string, string>)[mime] ?? "bin";
    const name = part.filename || `attachment.${extension}`;
    const digest = createHash("sha256").update(userId).update("\0").update(data).digest("hex");
    db.prepare("INSERT INTO uploads (id, user_id, thread_id, name, mime, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(`upl_inline_${digest}`, userId, threadId, name, mime, data, Date.now());
  }
}
