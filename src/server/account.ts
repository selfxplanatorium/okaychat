import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppEnv } from "./auth.js";
import { accountProfile, limited, passwordSchema, forgiveFailure, recordFailure } from "./auth.js";
import { hashPassword, verifyPassword } from "./crypto.js";
import { db } from "./db.js";
import { errorJson } from "./errors.js";
import { QuotaError } from "./quota.js";
import { chargeReplacement, getMedia, mediaPath, putMedia, releaseMedia } from "./media/store.js";
import { MediaProcessingError, normalizeAvatar, serveImage } from "./media/variants.js";
import { tx } from "./db.js";

export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 16_777_216;

/** Read raster dimensions from the file itself; the browser's MIME type is untrusted. */
export function avatarImage(bytes: Uint8Array): { mime: string; width: number; height: number } | null {
  const data = Buffer.from(bytes);
  let mime: string;
  let width = 0;
  let height = 0;
  if (data.length >= 45 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && data.toString("ascii", 12, 16) === "IHDR" && data.toString("ascii", data.length - 8, data.length - 4) === "IEND") {
    mime = "image/png";
    width = data.readUInt32BE(16);
    height = data.readUInt32BE(20);
  } else if (data.length >= 12 && data[0] === 0xff && data[1] === 0xd8 && data[data.length - 2] === 0xff && data[data.length - 1] === 0xd9) {
    mime = "image/jpeg";
    let offset = 2;
    while (offset + 4 <= data.length) {
      if (data[offset] !== 0xff) return null;
      while (data[offset] === 0xff) offset++;
      const marker = data[offset++]!;
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (offset + 2 > data.length) return null;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) return null;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8) return null;
        height = data.readUInt16BE(offset + 3);
        width = data.readUInt16BE(offset + 5);
        break;
      }
      offset += length;
    }
  } else if (data.length >= 30 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP" && data.readUInt32LE(4) + 8 === data.length) {
    mime = "image/webp";
    const kind = data.toString("ascii", 12, 16);
    if (kind === "VP8X") {
      width = data.readUIntLE(24, 3) + 1;
      height = data.readUIntLE(27, 3) + 1;
    } else if (kind === "VP8 " && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
      width = data.readUInt16LE(26) & 0x3fff;
      height = data.readUInt16LE(28) & 0x3fff;
    } else if (kind === "VP8L" && data[20] === 0x2f) {
      const bits = data.readUInt32LE(21);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    }
  } else return null;
  if (width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > MAX_IMAGE_PIXELS) return null;
  return { mime, width, height };
}

const profilePatch = z.object({ name: z.string().trim().min(1).max(80) }).strict();

export const accountRoutes = new Hono<AppEnv>()
  .get("/", (c) => c.json(accountProfile(c.get("user").id)!))
  .patch("/", async (c) => {
    const parsed = profilePatch.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Enter a display name between 1 and 80 characters." }, 400);
    db.prepare("UPDATE users SET name = ? WHERE id = ?").run(parsed.data.name, c.get("user").id);
    return c.json(accountProfile(c.get("user").id)!);
  })
  .post("/password", async (c) => {
    const parsed = z.object({ current: z.string().min(1).max(200), next: passwordSchema }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Enter your current password and a new password of 8 to 200 characters." }, 400);
    const { id } = c.get("user");
    // A stolen session must not be able to guess the password it needs to take the account over.
    const key = `password:${id}`;
    if (limited(key, 10)) return c.json({ error: "Too many failed attempts. Try again in 15 minutes." }, 429);
    const row = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(id) as { password_hash: string };
    // Counted before the await, so parallel guesses cannot all pass the limit.
    recordFailure(key);
    if (!(await verifyPassword(parsed.data.current, row.password_hash))) {
      return c.json({ error: "Your current password is incorrect." }, 403);
    }
    forgiveFailure(key);
    const nextHash = await hashPassword(parsed.data.next);
    // Another change that finished meanwhile wins; this request verified a password that is gone.
    const changed = db.prepare("UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?").run(nextHash, id, row.password_hash);
    if (!changed.changes) return c.json({ error: "Your password was just changed. Sign in again." }, 409);
    // Every other device signs in again with the new password.
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(id, c.get("session"));
    return c.json({ ok: true });
  })
  .post("/sessions/revoke-others", (c) => {
    const result = db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(c.get("user").id, c.get("session"));
    return c.json({ revoked: Number(result.changes) });
  })
  .put("/avatar", bodyLimit({ maxSize: MAX_AVATAR_BYTES + 64 * 1024, onError: (c) => c.json({ error: "Choose a profile picture smaller than 5 MB." }, 413) }), async (c) => {
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return c.json({ error: "Choose a PNG, JPEG, or WebP image." }, 400);
    if (file.size > MAX_AVATAR_BYTES) return c.json({ error: "Choose a profile picture smaller than 5 MB." }, 413);
    const image = avatarImage(new Uint8Array(await file.arrayBuffer()));
    if (!image) return c.json({ error: "Choose a valid PNG, JPEG, or WebP image up to 16 megapixels." }, 422);
    const userId = c.get("user").id;
    // Direct API clients skip the browser's resize, so the server reproduces it: a full decode within the
    // pixel bound, orientation applied, metadata stripped, at most 512 px, WebP.
    let data: Buffer;
    try {
      data = await normalizeAvatar(Buffer.from(await file.arrayBuffer()));
    } catch (error) {
      if (error instanceof MediaProcessingError) return c.json({ error: "Choose a valid PNG, JPEG, or WebP image up to 16 megapixels." }, 422);
      throw error;
    }
    const previous = db.prepare("SELECT updated_at, media_id, length(data) AS bytes FROM user_avatars WHERE user_id = ?").get(userId) as { updated_at: number; media_id: string | null; bytes: number } | undefined;
    const version = Math.max(Date.now(), (previous?.updated_at ?? 0) + 1);
    try {
      tx(() => {
        // Net growth: the old picture frees its bytes only when nothing else (an upload of the same file) holds them.
        const { media } = putMedia(userId, data, chargeReplacement(userId, previous && { mediaId: previous.media_id, blobBytes: previous.bytes }));
        db.prepare(`INSERT INTO user_avatars (user_id, mime, data, media_id, updated_at) VALUES (?, ?, x'', ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, media_id = excluded.media_id, updated_at = excluded.updated_at`).run(userId, media.mime, media.id, version);
      });
    } catch (error) {
      if (error instanceof QuotaError) return errorJson(c, error);
      throw error;
    }
    // After the commit, so a rollback can never point back at a deleted file.
    releaseMedia(previous?.media_id);
    return c.json(accountProfile(userId)!);
  })
  .get("/avatar", async (c) => {
    const userId = c.get("user").id;
    const row = db.prepare("SELECT mime, data, media_id FROM user_avatars WHERE user_id = ?").get(userId) as { mime: string; data: Uint8Array; media_id: string | null } | undefined;
    if (!row) return c.json({ error: "No profile picture." }, 404);
    const media = row.media_id ? getMedia(row.media_id) : undefined;
    // The URL is the same for every account; the digest validator and the per-request owner lookup make sure
    // a device that switches accounts never reuses the previous account's image.
    if (media && media.user_id === userId) {
      return serveImage(c, { userId, key: media.id, file: mediaPath(media), mime: media.mime, size: media.size, etag: media.sha256.slice(0, 32) });
    }
    return c.body(new Uint8Array(row.data), 200, { "Content-Type": row.mime, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
  })
  .delete("/avatar", (c) => {
    const previous = db.prepare("SELECT media_id FROM user_avatars WHERE user_id = ?").get(c.get("user").id) as { media_id: string | null } | undefined;
    db.prepare("DELETE FROM user_avatars WHERE user_id = ?").run(c.get("user").id);
    releaseMedia(previous?.media_id);
    return c.json(accountProfile(c.get("user").id)!);
  });
