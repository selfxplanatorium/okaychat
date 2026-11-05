import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requireUser, type AppEnv } from "../auth.js";
import { requireFeature } from "../permissions/guard.js";
import { AppError, errorJson } from "../errors.js";
import { QuotaError } from "../quota.js";
import { CHANNEL_LIMITS } from "../../shared/channels.js";
import { assertChannelMember, assertWritable } from "./access.js";
import { deletePendingAttachment, storeChannelAttachment } from "./attachments.js";
import { attachmentProjection } from "./projections.js";

/**
 * Attachment bytes need their own router: the JSON channel routes cap bodies at 128 KiB, and a file
 * upload must never inherit that ceiling. Mounted before `channelRoutes` at the same prefix.
 */

export const channelAttachmentRoutes = new Hono<AppEnv>()
  .use("*", requireUser)
  .use("*", requireFeature("channels"))
  .post(
    "/:id/attachments",
    bodyLimit({
      maxSize: CHANNEL_LIMITS.attachmentBytes + 64 * 1024,
      onError: (c) => c.json({ error: "That file is too large." }, 413),
    }),
    async (c) => {
      const userId = c.get("user").id;
      const { channel } = assertChannelMember(userId, c.req.param("id"));
      assertWritable(channel);
      try {
        const form = await c.req.formData();
        const file = form.get("file");
        if (!(file instanceof File)) return errorJson(c, new AppError({ code: "validation", status: 422, message: "No file was uploaded." }));
        if (file.size > CHANNEL_LIMITS.attachmentBytes) {
          return errorJson(c, new AppError({ code: "validation", status: 413, message: "That file is too large." }));
        }
        if (file.size === 0) {
          return errorJson(c, new AppError({ code: "validation", status: 422, message: "That file is empty.", details: { reason: "attachment_type" } }));
        }
        const row = storeChannelAttachment(userId, channel, {
          name: file.name,
          mime: file.type,
          data: new Uint8Array(await file.arrayBuffer()),
        });
        return c.json({ attachment: attachmentProjection(row) }, 201, { "Cache-Control": "private, no-store" });
      } catch (error) {
        if (error instanceof QuotaError || error instanceof AppError) return errorJson(c, error);
        throw error;
      }
    },
  )
  .delete("/:id/attachments/:attachmentId", (c) => {
    deletePendingAttachment(c.get("user").id, c.req.param("id"), c.req.param("attachmentId"));
    return c.json({ ok: true }, 200, { "Cache-Control": "private, no-store" });
  });
