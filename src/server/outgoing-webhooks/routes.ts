import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth.js";
import { AppError } from "../errors.js";
import { assertFeature } from "../permissions/guard.js";
import {
  clearDeliveries,
  consumeManagementRate,
  createEndpoint,
  deleteEndpoint,
  getDelivery,
  getEndpoint,
  listDeliveries,
  listEndpoints,
  prepareTest,
  retryDelivery,
  rotateSecret,
  sendTest,
  updateEndpoint,
} from "./store.js";
import {
  trimmedName,
  validateChannelIds,
  validateEndpointUrl,
  validateHeaders,
  validateSubscriptions,
  validationError,
} from "./schemas.js";
import { DELIVERY_STATUSES, WEBHOOK_LIMITS } from "../../shared/outgoing-webhooks.js";

/** Authenticated webhook management. Every response is private and uncached; reads never contact a URL. */

const privateHeaders = { "Cache-Control": "private, no-store" } as const;

async function jsonBody(c: { req: { text: () => Promise<string> } }): Promise<unknown> {
  const text = await c.req.text();
  if (Buffer.byteLength(text, "utf8") > 16 * 1024) throw new AppError({ code: "validation", status: 413, message: "This request is too large." });
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw validationError("Send a JSON body.");
  }
}

const revisionInput = z.object({ revision: z.number().int().min(1) }).strict();
const createInput = z.object({
  name: z.unknown(),
  url: z.unknown(),
  headers: z.record(z.string(), z.unknown()).optional(),
  subscriptions: z.array(z.unknown()).max(WEBHOOK_LIMITS.subscriptions),
  channelIds: z.array(z.unknown()).max(WEBHOOK_LIMITS.channelIds),
  includeMessageText: z.boolean(),
  enabled: z.boolean().optional(),
}).strict();
const patchInput = z.object({
  revision: z.number().int().min(1),
  name: z.unknown().optional(),
  url: z.unknown().optional(),
  headerChanges: z.record(z.string(), z.union([z.string(), z.null()])).optional(),
  replaceHeaders: z.record(z.string(), z.string()).optional(),
  subscriptions: z.array(z.unknown()).max(WEBHOOK_LIMITS.subscriptions).optional(),
  channelIds: z.array(z.unknown()).max(WEBHOOK_LIMITS.channelIds).optional(),
  includeMessageText: z.boolean().optional(),
  enabled: z.boolean().optional(),
}).strict();
const testSendInput = z.object({ revision: z.number().int().min(1), preparationId: z.string().min(1).max(200) }).strict();
const retryInput = z.object({ revision: z.number().int().min(1), version: z.number().int().min(1) }).strict();

export const webhookRoutes = new Hono<AppEnv>()
  .use(async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    await next();
    c.header("Cache-Control", "private, no-store");
  })
  .get("/", (c) => c.json({ items: listEndpoints(c.get("user").id) }, 200, privateHeaders))
  .post("/", async (c) => {
    const userId = c.get("user").id;
    assertFeature(userId, "outgoingWebhooks");
    consumeManagementRate(userId);
    const parsed = createInput.safeParse(await jsonBody(c));
    if (!parsed.success) return c.json({ error: "Check the endpoint fields." }, 400, privateHeaders);
    if (parsed.data.enabled === true) return c.json({ error: "Create the endpoint disabled, then enable it explicitly." }, 400, privateHeaders);
    const name = trimmedName(parsed.data.name);
    const url = validateEndpointUrl(parsed.data.url);
    const headers = Object.fromEntries(validateHeaders(parsed.data.headers));
    const subscriptions = validateSubscriptions(parsed.data.subscriptions);
    const channelIds = validateChannelIds(parsed.data.channelIds);
    const result = createEndpoint(userId, { name, url, headers, subscriptions, channelIds, includeMessageText: parsed.data.includeMessageText });
    return c.json({ endpoint: result.endpoint, signingSecret: result.signingSecret }, 201, privateHeaders);
  })
  .get("/:id", (c) => {
    const endpoint = getEndpoint(c.get("user").id, c.req.param("id"));
    if (!endpoint) return c.json({ error: "Webhook endpoint not found." }, 404, privateHeaders);
    return c.json({ endpoint }, 200, privateHeaders);
  })
  .patch("/:id", async (c) => {
    const userId = c.get("user").id;
    consumeManagementRate(userId);
    const parsed = patchInput.safeParse(await jsonBody(c));
    if (!parsed.success) return c.json({ error: "Check the endpoint fields." }, 400, privateHeaders);
    const cleanupDisable = parsed.data.enabled === false && Object.keys(parsed.data).every((key) => key === "revision" || key === "enabled");
    if (!cleanupDisable) assertFeature(userId, "outgoingWebhooks");
    const patch = { ...parsed.data };
    if (patch.name !== undefined) patch.name = trimmedName(patch.name);
    if (patch.url !== undefined) {
      patch.url = validateEndpointUrl(patch.url);
      if (patch.replaceHeaders === undefined) return c.json({ error: "A URL change must replace the headers too." }, 400, privateHeaders);
      if (patch.headerChanges !== undefined) return c.json({ error: "Send either replaceHeaders or headerChanges, not both." }, 400, privateHeaders);
    } else if (patch.replaceHeaders !== undefined) {
      return c.json({ error: "Replace headers only when the URL changes." }, 400, privateHeaders);
    }
    if (patch.replaceHeaders !== undefined) patch.replaceHeaders = Object.fromEntries(validateHeaders(patch.replaceHeaders));
    if (patch.subscriptions !== undefined) patch.subscriptions = validateSubscriptions(patch.subscriptions);
    if (patch.channelIds !== undefined) patch.channelIds = validateChannelIds(patch.channelIds);
    return c.json({ endpoint: updateEndpoint(userId, c.req.param("id"), patch as Parameters<typeof updateEndpoint>[2]) }, 200, privateHeaders);
  })
  .delete("/:id", async (c) => {
    consumeManagementRate(c.get("user").id);
    const parsed = revisionInput.safeParse(await jsonBody(c));
    if (!parsed.success) return c.json({ error: "Reload the endpoint and try again." }, 400, privateHeaders);
    deleteEndpoint(c.get("user").id, c.req.param("id"), parsed.data.revision);
    return c.json({ ok: true }, 200, privateHeaders);
  })
  .post("/:id/rotate-secret", async (c) => {
    const userId = c.get("user").id;
    assertFeature(userId, "outgoingWebhooks");
    consumeManagementRate(userId);
    const parsed = revisionInput.safeParse(await jsonBody(c));
    if (!parsed.success) return c.json({ error: "Reload the endpoint and try again." }, 400, privateHeaders);
    const result = rotateSecret(userId, c.req.param("id"), parsed.data.revision);
    return c.json({ endpoint: result.endpoint, signingSecret: result.signingSecret }, 200, privateHeaders);
  })
  .post("/:id/test/prepare", async (c) => {
    const userId = c.get("user").id;
    const parsed = revisionInput.safeParse(await jsonBody(c));
    if (!parsed.success) return c.json({ error: "Reload the endpoint and try again." }, 400, privateHeaders);
    return c.json(prepareTest(userId, c.req.param("id"), parsed.data.revision), 200, privateHeaders);
  })
  .post("/:id/test/send", async (c) => {
    const userId = c.get("user").id;
    const parsed = testSendInput.safeParse(await jsonBody(c));
    if (!parsed.success) return c.json({ error: "Prepare the test again." }, 400, privateHeaders);
    const result = sendTest(userId, c.req.param("id"), parsed.data.revision, parsed.data.preparationId);
    return c.json(result, 202, privateHeaders);
  })
  .get("/:id/deliveries", (c) => {
    const status = c.req.query("status");
    if (status !== undefined && !(DELIVERY_STATUSES as readonly string[]).includes(status)) {
      return c.json({ error: "Unknown delivery status." }, 400, privateHeaders);
    }
    const limit = Number(c.req.query("limit") ?? "30");
    if (!Number.isSafeInteger(limit)) return c.json({ error: "Invalid limit." }, 400, privateHeaders);
    const page = listDeliveries(c.get("user").id, c.req.param("id"), {
      status: status as (typeof DELIVERY_STATUSES)[number] | undefined,
      cursor: c.req.query("cursor"),
      limit,
    });
    return c.json(page, 200, privateHeaders);
  })
  .get("/:id/deliveries/:deliveryId", (c) => {
    return c.json({ delivery: getDelivery(c.get("user").id, c.req.param("id"), c.req.param("deliveryId")) }, 200, privateHeaders);
  })
  .post("/:id/deliveries/:deliveryId/retry", async (c) => {
    const userId = c.get("user").id;
    consumeManagementRate(userId);
    const parsed = retryInput.safeParse(await jsonBody(c));
    if (!parsed.success) return c.json({ error: "Reload the delivery and try again." }, 400, privateHeaders);
    const result = retryDelivery(userId, c.req.param("id"), c.req.param("deliveryId"), parsed.data.revision, parsed.data.version);
    return c.json(result, 202, privateHeaders);
  })
  .delete("/:id/deliveries", (c) => {
    consumeManagementRate(c.get("user").id);
    return c.json(clearDeliveries(c.get("user").id, c.req.param("id")), 200, privateHeaders);
  });
