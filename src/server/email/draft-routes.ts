import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppEnv } from "../auth.js";
import { deleteDraft, draftEml, getDraft, reviewDraft, sendDraft, updateDraft } from "./drafts.js";
import { assertFeature } from "../permissions/guard.js";

// Draft card API, mounted under /api/email. Every route is scoped to the signed-in user and the chat
// in the path; drafts.ts re-checks both on each call, so a deleted chat or another user's id is a 404.
// Sending is review (exact payload + single-use token) then send (that token only).

const reviewInput = z.object({ revision: z.number().int().min(1) }).strict();
// The 100k-character body plus JSON overhead for recipients and the worst-case control escapes.
const limit = bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: "The draft is too large." }, 413) });

export const draftRoutes = new Hono<AppEnv>()
  // Draft text and the review token are per-user data; never let a proxy or browser cache them.
  .use(async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  })
  .get("/threads/:threadId/drafts/:id", (c) => c.json(getDraft(c.get("user").id, c.req.param("threadId"), c.req.param("id"))))
  .patch("/threads/:threadId/drafts/:id", limit, async (c) => {
    assertFeature(c.get("user").id, "email");
    return c.json(updateDraft(c.get("user").id, c.req.param("threadId"), c.req.param("id"), await c.req.json().catch(() => null), "user"));
  })
  .delete("/threads/:threadId/drafts/:id", (c) => {
    deleteDraft(c.get("user").id, c.req.param("threadId"), c.req.param("id"));
    return c.json({ ok: true });
  })
  .get("/threads/:threadId/drafts/:id/eml", async (c) => {
    const draft = await draftEml(c.get("user").id, c.req.param("threadId"), c.req.param("id"));
    return c.body(draft.content, 200, {
      "Content-Type": "message/rfc822",
      "Content-Disposition": `attachment; filename="${draft.filename}"`,
      "Cache-Control": "no-store",
    });
  })
  .post("/threads/:threadId/drafts/:id/review", limit, async (c) => {
    assertFeature(c.get("user").id, "email");
    const parsed = reviewInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Missing draft revision." }, 400);
    return c.json(reviewDraft(c.get("user").id, c.req.param("threadId"), c.req.param("id"), parsed.data.revision));
  })
  .post("/threads/:threadId/drafts/:id/send", limit, async (c) => {
    assertFeature(c.get("user").id, "email");
    return c.json(await sendDraft(c.get("user").id, c.req.param("threadId"), c.req.param("id"), await c.req.json().catch(() => null)));
  });
