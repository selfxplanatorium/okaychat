import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { appearanceSchema } from "../shared/appearance.js";
import type { AppEnv } from "./auth.js";
import { getSettings, updateSettings } from "./settings.js";

export const appearanceRoutes = new Hono<AppEnv>()
  .use("/appearance", bodyLimit({ maxSize: 1_000_000 }))
  .get("/appearance", (c) => c.json(getSettings(c.get("user").id).appearance ?? null))
  .put("/appearance", async (c) => {
    const parsed = appearanceSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "Invalid appearance settings." }, 400);
    const userId = c.get("user").id;
    // First device wins migration; a simultaneous login must not replace an existing preference set.
    const appearance = getSettings(userId).appearance ?? parsed.data;
    updateSettings(userId, { appearance });
    return c.json(appearance);
  })
  .patch("/appearance", async (c) => {
    const parsed = appearanceSchema.partial().safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "Invalid appearance settings." }, 400);
    const userId = c.get("user").id;
    const current = getSettings(userId).appearance;
    if (!current) return c.json({ error: "Initialize appearance settings first." }, 409);
    const appearance = { ...current, ...parsed.data };
    updateSettings(userId, { appearance });
    return c.json(appearance);
  });
