import { Hono, type Context } from "hono";
import { z } from "zod";
import { MAX_TOKEN_CREDIT } from "../../shared/token-credits.js";
import { requireAdmin, type AppEnv } from "../auth.js";
import { db } from "../db.js";
import { AppError } from "../errors.js";
import { CreditError, getCreditBalance, listCreditAudit, mutateCreditAccount } from "./store.js";

// Session routes for the token allowance: the account's own snapshot and the administrator's
// set/clear/reset/audit. Credits are runtime state, never part of settings or permission drafts.

const MAX_BODY_BYTES = 4096;
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);
const reason = z.string().min(1).max(2000);
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const setBody = z.strictObject({
  creditTokens: z.number().int().min(0).max(MAX_TOKEN_CREDIT).nullable(),
  expectedVersion: version,
  mutationId: uuid,
  reason,
});
const resetBody = z.strictObject({
  expectedVersion: version,
  mutationId: uuid,
  reason,
  acknowledgeUnknown: z.boolean(),
});

// Reads 120/minute and mutations 20/minute per account, in memory and bounded like the API key routes.
const windows = new Map<string, { read: number; mutate: number; resetAt: number }>();
function limited(userId: string, kind: "read" | "mutate"): void {
  const now = Date.now();
  let entry = windows.get(userId);
  if (!entry || entry.resetAt <= now) {
    if (windows.size >= 10_000) windows.clear();
    entry = { read: 0, mutate: 0, resetAt: now + 60_000 };
    windows.set(userId, entry);
  }
  entry[kind]++;
  if (entry[kind] > (kind === "read" ? 120 : 20)) {
    throw new AppError({ code: "rate_limited", message: "Too many token allowance requests. Try again shortly.", retryAfterMs: entry.resetAt - now });
  }
}

/** Test seam. */
export function resetCreditRouteLimits(): void {
  windows.clear();
}

async function strictJson<T>(c: Context<AppEnv>, schema: z.ZodType<T>): Promise<T> {
  const text = await c.req.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new CreditError("validation", "The request body is too large.");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CreditError("validation", "The request body is not valid JSON.");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new CreditError("validation", "The token allowance request is not valid.");
  return parsed.data;
}

function targetUser(c: Context<AppEnv>): string {
  const id = c.req.param("id") ?? "";
  if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get(id)) throw new CreditError("not_found", "That account does not exist.");
  return id;
}

export const creditRoutes = new Hono<AppEnv>()
  .use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  })
  // The account's own balance. Readable without any model or feature permission, also at zero.
  .get("/credits", (c) => {
    const user = c.get("user");
    limited(user.id, "read");
    return c.json(getCreditBalance(user.id));
  })
  .use("/admin/users/:id/credits", requireAdmin)
  .use("/admin/users/:id/credits/*", requireAdmin)
  .get("/admin/users/:id/credits", (c) => {
    limited(c.get("user").id, "read");
    return c.json(getCreditBalance(targetUser(c)));
  })
  .patch("/admin/users/:id/credits", async (c) => {
    const admin = c.get("user").id;
    limited(admin, "mutate");
    const userId = targetUser(c);
    const body = await strictJson(c, setBody);
    const balance = mutateCreditAccount(admin, userId, {
      action: body.creditTokens === null ? "clear" : "set",
      creditTokens: body.creditTokens,
      expectedVersion: body.expectedVersion,
      mutationId: body.mutationId,
      reason: body.reason,
    });
    return c.json({ balance });
  })
  .post("/admin/users/:id/credits/reset", async (c) => {
    const admin = c.get("user").id;
    limited(admin, "mutate");
    const userId = targetUser(c);
    const body = await strictJson(c, resetBody);
    const balance = mutateCreditAccount(admin, userId, { action: "reset", ...body });
    return c.json({ balance });
  })
  .get("/admin/users/:id/credits/audit", (c) => {
    limited(c.get("user").id, "read");
    const userId = targetUser(c);
    const integer = (value: string | undefined, fallback: number) => {
      if (value === undefined) return fallback;
      if (!/^\d{1,16}$/u.test(value)) throw new CreditError("validation", "Use a whole-number cursor and limit.");
      return Number(value);
    };
    return c.json(listCreditAudit(userId, integer(c.req.query("before"), Number.MAX_SAFE_INTEGER), integer(c.req.query("limit"), 50)));
  });
