import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth.js";
import { requireAdmin } from "../auth.js";
import { adminDeleteShared, decodeCursor, sharedCollectionMetadata } from "./access.js";

// Metadata-only cleanup for shared knowledge. It deliberately exposes no name, description, passage,
// source name/URL, reader chat id, or private collection. Admin status alone is not a reading grant.

const reasonInput = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

export const adminKnowledgeRoutes = new Hono<AppEnv>()
  .use("/admin/*", requireAdmin)
  .use(async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  })
  .get("/admin/knowledge", (c) => {
    const cursorValue = c.req.query("cursor");
    const cursor = decodeCursor(cursorValue);
    if (cursorValue && !cursor) return c.json({ error: "Invalid cursor" }, 400);
    const limit = Math.max(1, Math.min(100, Number(c.req.query("limit") ?? 50) || 50));
    const ownerId = c.req.query("ownerId") ?? null;
    const page = sharedCollectionMetadata(ownerId, limit, cursor);
    return c.json({ collections: page.items, nextCursor: page.nextCursor });
  })
  .delete("/admin/knowledge/:id", async (c) => {
    const parsed = reasonInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Enter a reason of 1–500 characters." }, 400);
    // The live role is rechecked by requireAdmin on this request, not captured from an older session.
    if (!adminDeleteShared(c.req.param("id"), c.get("user").id, parsed.data.reason)) {
      return c.json({ error: "Shared collection not found" }, 404);
    }
    return c.json({ ok: true });
  });
