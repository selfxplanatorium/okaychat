import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { appearanceSchema, DEFAULT_MESSAGE_LAYOUT, isMessageLayout, parseAppearancePatch, type UserAppearance } from "../shared/appearance.js";
import type { AppEnv } from "./auth.js";
import { getSettings, updateSettings } from "./settings.js";

// The interface size is per device. Older snapshots still carry it; drop it so no device adopts another's size.
// Snapshots written before a field existed read with its default, without rewriting the row on GET.
const stored = (userId: string): UserAppearance | undefined => {
  const appearance = getSettings(userId).appearance as (UserAppearance & { fontSizeInterface?: unknown }) | undefined;
  if (!appearance) return undefined;
  const { fontSizeInterface: _device, ...synced } = appearance;
  const parsed = appearanceSchema.safeParse(synced);
  return parsed.success ? parsed.data : {
    ...synced,
    // The fallback must stay a total UserAppearance; a corrupt stored layout falls back to timeline.
    messageLayout: isMessageLayout(synced.messageLayout) ? synced.messageLayout : DEFAULT_MESSAGE_LAYOUT,
  };
};

export const appearanceRoutes = new Hono<AppEnv>()
  // A cross-tab focus refresh must never be served an older snapshot from the browser cache.
  .use("/appearance", async (c, next) => {
    await next();
    c.header("Cache-Control", "private, no-store");
  })
  .use("/appearance", bodyLimit({ maxSize: 1_000_000 }))
  .get("/appearance", (c) => c.json(stored(c.get("user").id) ?? null))
  .put("/appearance", async (c) => {
    const parsed = appearanceSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "Invalid appearance settings." }, 400);
    const userId = c.get("user").id;
    // First device wins migration; a simultaneous login must not replace an existing preference set.
    const appearance = stored(userId) ?? parsed.data;
    updateSettings(userId, { appearance });
    return c.json(appearance);
  })
  .patch("/appearance", async (c) => {
    const parsed = parseAppearancePatch(await c.req.json());
    if (!parsed.success) return c.json({ error: "Invalid appearance settings." }, 400);
    const userId = c.get("user").id;
    const current = stored(userId);
    if (!current) return c.json({ error: "Initialize appearance settings first." }, 409);
    const merged = appearanceSchema.safeParse({ ...current, ...parsed.data });
    if (!merged.success) return c.json({ error: "Invalid appearance settings." }, 400);
    const appearance = merged.data;
    updateSettings(userId, { appearance });
    return c.json(appearance);
  });
