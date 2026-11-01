import { createHash } from "node:crypto";
import type { UIMessage } from "ai";
import { newId } from "../crypto.js";
import { db } from "../db.js";
import { AppError } from "../errors.js";
import { putMedia, readUpload, type MediaRow } from "./store.js";
import { RASTER_EXTENSION, sniffRaster } from "./sniff.js";

// Stored chats reference images as `okaychat-upload:<uploadId>#sha256=<digest>` file-part URLs instead of carrying
// base64 originals in every history load and chat request. The scheme is not fetchable, so nothing outside
// this server can resolve it; `resolveImageRefs` swaps in the owner's original bytes at the model boundary.
// assistant-ui wraps relative paths as data URLs, which is why this is an absolute custom URL. The digest
// fragment identifies the content even after the upload is deleted; references the web client makes for
// fresh uploads carry none.

export const UPLOAD_REF = "okaychat-upload:";
const MAX_INLINE_BYTES = 25 * 1024 * 1024;
const INLINE_RASTER = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\r\n]*)$/;
const APP_UPLOAD = /^\/api\/uploads\/([A-Za-z0-9_.-]+)\/file(?:\?[^#]*)?$/;
const DIGEST = /#sha256=([0-9a-f]{64})$/;

export const uploadRef = (id: string, sha256?: string) => `${UPLOAD_REF}${id}${sha256 ? `#sha256=${sha256}` : ""}`;

/** The upload id behind an owned image reference, or null for anything else. */
export function refUploadId(url: unknown): string | null {
  if (typeof url !== "string") return null;
  if (url.startsWith(UPLOAD_REF)) {
    const id = url.slice(UPLOAD_REF.length).replace(DIGEST, "");
    return /^[A-Za-z0-9_.-]{1,200}$/.test(id) ? id : null;
  }
  return APP_UPLOAD.exec(url)?.[1] ?? null;
}

type FilePart = { type: string; url?: unknown; mediaType?: string; filename?: string };

function decodeInline(url: string): { mime: string; data: Buffer } | null {
  const match = INLINE_RASTER.exec(url);
  if (!match || match[2]!.length > Math.ceil(MAX_INLINE_BYTES / 3) * 4) return null;
  const data = Buffer.from(match[2]!, "base64");
  return sniffRaster(data) ? { mime: match[1]!, data } : null;
}

/**
 * An upload that already holds these bytes for this account, so re-saving a legacy message or a reopened
 * temporary chat does not create a second Library entry.
 */
function existingUpload(userId: string, mediaId: string): string | undefined {
  return (db.prepare("SELECT id FROM uploads WHERE user_id = ? AND media_id = ? ORDER BY created_at LIMIT 1").get(userId, mediaId) as { id: string } | undefined)?.id;
}

/** The content digest of a stored reference: its fragment, else the live upload's media digest. */
function refDigest(userId: string, url: unknown): string | null {
  if (typeof url !== "string") return null;
  const fragment = DIGEST.exec(url)?.[1];
  if (fragment) return fragment;
  const id = refUploadId(url);
  const row = id ? db.prepare("SELECT m.sha256 FROM uploads u JOIN media m ON m.id = u.media_id WHERE u.id = ? AND u.user_id = ? AND m.user_id = ?").get(id, userId, userId) as { sha256: string } | undefined : undefined;
  return row?.sha256 ?? null;
}

const isInlineImage = (part: FilePart | null | undefined): part is FilePart & { url: string } =>
  part?.type === "file" && typeof part.url === "string" && part.url.startsWith("data:image/");

export interface NormalizeOptions {
  /** Quota check for new bytes; runs only when a new original is written. */
  charge?: (bytes: number) => void;
  /** The stored row being overwritten. */
  previous?: unknown;
  /** False: only map parts back to the previous row's references, never store new bytes (edited replies). */
  store?: boolean;
  /** Leave a part that fails image validation inline instead of throwing (migration, provider output). */
  keepInvalid?: boolean;
}

/**
 * Rewrites the inline raster image file parts of a stored user or assistant message into owned references,
 * storing each original once (lossless, deduplicated per account). Returns the content unchanged when there
 * is nothing to move. Identity is the content digest: a part whose bytes match a reference in `previous` (the
 * stored row being overwritten) keeps that reference, so a stale tab resending the old inline bytes cannot
 * recreate a file the user deleted, while different bytes are a real replacement and are stored.
 */
export function normalizeImages(userId: string, threadId: string, content: unknown, opts: NormalizeOptions = {}): unknown {
  if (threadId.startsWith("tmp_") || !content || typeof content !== "object") return content;
  const message = content as { role?: string; parts?: FilePart[] };
  if ((message.role !== "user" && message.role !== "assistant") || !Array.isArray(message.parts)) return content;
  if (!message.parts.some(isInlineImage)) return content;
  const before = (opts.previous as { parts?: FilePart[] } | undefined)?.parts ?? [];
  const known = new Map<string, FilePart>();
  const undigested = new Map<number, FilePart>();
  before.forEach((part, index) => {
    if (part?.type !== "file" || !refUploadId(part.url)) return;
    const digest = refDigest(userId, part.url);
    if (digest) known.set(digest, part);
    else undigested.set(index, part);
  });
  const keepInvalid = opts.keepInvalid ?? message.role === "assistant";
  const parts = message.parts.map((part, index) => {
    if (!isInlineImage(part)) return part;
    const inline = decodeInline(part.url);
    if (!inline) return part;
    const sha256 = createHash("sha256").update(inline.data).digest("hex");
    const kept = known.get(sha256);
    if (kept) return kept;
    // A reference from before digests whose upload is gone: the bytes cannot be compared, so the same slot and
    // name count as the same image rather than risk recreating a deleted file.
    const legacy = undigested.get(index);
    if (legacy && legacy.filename === part.filename) return legacy;
    if (opts.store === false) return part;
    let media: MediaRow;
    try {
      media = putMedia(userId, inline.data, opts.charge).media;
    } catch (error) {
      if (keepInvalid && error instanceof AppError && error.code === "validation") return part;
      throw error;
    }
    let id = existingUpload(userId, media.id);
    if (!id) {
      id = newId("upl");
      const name = part.filename || `image.${RASTER_EXTENSION[media.mime]}`;
      db.prepare("INSERT INTO uploads (id, user_id, thread_id, name, mime, data, media_id, created_at) VALUES (?, ?, ?, ?, ?, x'', ?, ?)")
        .run(id, userId, threadId, name, media.mime, media.id, Date.now());
    }
    return { ...part, url: uploadRef(id, media.sha256), mediaType: media.mime };
  });
  return { ...message, parts };
}

/**
 * The model boundary: owned references become the account's original bytes (never a URL a provider would
 * fetch), a reference this account does not own or that was deleted becomes a note, and any other non-data
 * file URL is withheld so the SDK never downloads a client-chosen address.
 */
export async function resolveImageRefs(userId: string, messages: UIMessage[]): Promise<UIMessage[]> {
  return messages.map((message) => {
    if (!message.parts.some((p) => p.type === "file" && !p.url.startsWith("data:"))) return message;
    const parts = message.parts.map((part): UIMessage["parts"][number] => {
      if (part.type !== "file" || part.url.startsWith("data:")) return part;
      const name = (part.filename ?? "image").replaceAll('"', "'");
      const id = refUploadId(part.url);
      const upload = id ? readUpload(userId, id) : undefined;
      if (!upload || (part.mediaType?.startsWith("image/") && !upload.mime.startsWith("image/"))) {
        return { type: "text", text: id ? `[Attached file "${name}" is no longer available.]` : `[Attached file "${name}" was not sent: only files stored in this app are read.]` };
      }
      const mime = upload.mime || part.mediaType;
      return { ...part, mediaType: mime, url: `data:${mime};base64,${Buffer.from(upload.data).toString("base64")}` };
    });
    return { ...message, parts };
  });
}
