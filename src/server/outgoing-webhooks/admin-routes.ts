import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth.js";
import { db, tx } from "../db.js";
import { recordRevision } from "../permissions/audit.js";
import { adminDisable, adminEndpointPage } from "./store.js";
import { outgoingWebhookWorkerStats } from "./worker.js";

/**
 * Admin visibility: counts, states, and a metadata-only disable. No name, hostname, URL, header,
 * secret, body, source id, or remote error prose is ever returned, tested, resent, or enabled here.
 */

const disableInput = z.object({
  revision: z.number().int().min(1),
  reason: z.string().trim().min(1).max(500).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Use plain text."),
}).strict();

export const adminWebhookRoutes = new Hono<AppEnv>()
  .use(async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    await next();
    c.header("Cache-Control", "private, no-store");
  })
  .get("/", (c) => {
    const limit = Number(c.req.query("limit") ?? "30");
    if (!Number.isSafeInteger(limit)) return c.json({ error: "Invalid limit." }, 400);
    const page = adminEndpointPage({ cursor: c.req.query("cursor"), limit });
    page.totals.lastPumpAt = outgoingWebhookWorkerStats().lastPumpAt;
    return c.json(page, 200, { "Cache-Control": "private, no-store" });
  })
  .post("/:id/disable", async (c) => {
    const parsed = disableInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Reload the endpoint and give a reason." }, 400);
    const row = db.prepare("SELECT user_id FROM outgoing_webhook_endpoints WHERE id = ?").get(c.req.param("id")) as { user_id: string } | undefined;
    if (!row) return c.json({ error: "Webhook endpoint not found." }, 404);
    const endpoint = tx(() => {
      const result = adminDisable(row.user_id, c.req.param("id"), parsed.data.revision, parsed.data.reason);
      // The existing permission audit is the only admin write trail. The reason and ids stay encrypted.
      recordRevision(
        "policy",
        c.get("user").id,
        [{ destination: `webhook:${result.id}`, before: { enabled: true, revision: parsed.data.revision }, after: { enabled: false, revision: result.revision, reason: parsed.data.reason } }],
        { webhookEndpointId: result.id, webhookOwnerId: row.user_id, action: "disable" },
      );
      return result;
    });
    return c.json({ endpointId: endpoint.id, enabled: endpoint.enabled, revision: endpoint.revision }, 200, { "Cache-Control": "private, no-store" });
  });
