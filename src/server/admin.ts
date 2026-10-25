import { rm } from "node:fs/promises";
import path from "node:path";
import { env } from "./env.js";
import { Hono } from "hono";
import { z } from "zod";
import type { AdminUser } from "../shared/types.js";
import { requireAdmin, signupAllowed, type AppEnv } from "./auth.js";
import { deleteConnection, listProviders, saveConnection } from "./catalog/providers.js";
import { hashPassword, newId } from "./crypto.js";
import { db } from "./db.js";
import { createGroup, deleteGroup, listGroups, setAudience, updateGroup } from "./groups.js";
import { listPrompts, MAX_PROMPT_CHARS, setPrompt } from "./prompts.js";
import { storageUsedSql } from "./quota.js";

const userInput = z.object({
  email: z.string().trim().email().toLowerCase(),
  name: z.string().trim().min(1).max(80),
  password: z.string().min(8).max(200),
  role: z.enum(["admin", "user"]).default("user"),
});

const userPatch = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  role: z.enum(["admin", "user"]).optional(),
  password: z.string().min(8).max(200).optional(),
  // Bytes. null removes the override, so the user falls back to the server default.
  storageLimit: z.number().int().min(1024 * 1024).max(1024 ** 4).nullable().optional(),
});

const providerInput = z.object({
  apiKey: z.string().optional(),
  baseURL: z.string().url().or(z.literal("")).optional(),
  name: z.string().max(60).optional(),
  enabled: z.boolean().optional(),
});

const ids = z.array(z.string().max(100)).max(10_000);
const groupInput = z.object({ name: z.string().trim().min(1).max(60), userIds: ids.optional() });
export const audienceInput = z.object({ mode: z.enum(["all", "selected"]), userIds: ids.default([]), groupIds: ids.default([]) });

export const adminRoutes = new Hono<AppEnv>()
  .use("/admin/*", requireAdmin)
  .get("/admin/users", (c) => {
    const rows = db
      .prepare(
        `SELECT u.id, u.email, u.name, u.role, u.created_at AS createdAt, u.storage_limit AS storageLimit,
           ${storageUsedSql("u.id")} AS storageUsed,
           (SELECT COUNT(*) FROM threads t WHERE t.user_id = u.id) AS threads,
           (SELECT COALESCE(SUM(cost), 0) FROM usage g WHERE g.user_id = u.id AND g.created_at > ?) AS cost30d
         FROM users u ORDER BY u.created_at`,
      )
      .all(Date.now() - 30 * 86_400_000) as unknown as AdminUser[];
    return c.json(rows);
  })
  .post("/admin/users", async (c) => {
    const body = userInput.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues[0]?.message }, 400);
    if (db.prepare("SELECT 1 FROM users WHERE lower(email) = ?").get(body.data.email)) return c.json({ error: "That email is already registered." }, 409);
    db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      newId("usr"),
      body.data.email,
      body.data.name,
      await hashPassword(body.data.password),
      body.data.role,
      Date.now(),
    );
    return c.json({ ok: true });
  })
  .patch("/admin/users/:id", async (c) => {
    const body = userPatch.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues[0]?.message }, 400);
    const id = c.req.param("id");
    const target = db.prepare("SELECT role FROM users WHERE id = ?").get(id) as { role: string } | undefined;
    if (!target) return c.json({ error: "Not found" }, 404);
    // The requester is always an admin, so blocking self-demotion also keeps at least one admin.
    if (body.data.role === "user" && id === c.get("user").id) return c.json({ error: "You cannot remove your own admin role." }, 400);
    if (body.data.name) db.prepare("UPDATE users SET name = ? WHERE id = ?").run(body.data.name, id);
    if (body.data.role) db.prepare("UPDATE users SET role = ? WHERE id = ?").run(body.data.role, id);
    if (body.data.storageLimit !== undefined) db.prepare("UPDATE users SET storage_limit = ? WHERE id = ?").run(body.data.storageLimit, id);
    if (body.data.password) {
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await hashPassword(body.data.password), id);
      // A reset signs the user out everywhere.
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
    }
    return c.json({ ok: true });
  })
  .delete("/admin/users/:id", async (c) => {
    const id = c.req.param("id");
    if (id === c.get("user").id) return c.json({ error: "You cannot delete your own account here." }, 400);
    if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get(id)) return c.json({ error: "Not found" }, 404);
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
    await rm(path.join(env.dataDir, "images", id), { recursive: true, force: true });
    return c.json({ ok: true });
  })
  .get("/admin/settings", (c) => c.json({ allowSignup: signupAllowed() }))
  .patch("/admin/settings", async (c) => {
    const body = z.object({ allowSignup: z.boolean() }).safeParse(await c.req.json());
    if (!body.success) return c.json({ error: "Invalid settings" }, 400);
    db.prepare("INSERT INTO server_settings (key, value) VALUES ('allowSignup', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(
      String(body.data.allowSignup),
    );
    return c.json({ allowSignup: signupAllowed() });
  })
  .get("/admin/prompts", (c) => c.json(listPrompts()))
  .put("/admin/prompts/:key", async (c) => {
    // null restores the default. An empty string is a valid override: it removes that prompt.
    const body = z.object({ value: z.string().max(MAX_PROMPT_CHARS).nullable() }).safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues[0]?.message }, 400);
    if (!setPrompt(c.req.param("key"), body.data.value)) return c.json({ error: "Not found" }, 404);
    return c.json(listPrompts().find((p) => p.key === c.req.param("key")));
  })
  .get("/admin/providers", async (c) => c.json(await listProviders(null)))
  .put("/admin/providers/:id", async (c) => {
    const body = providerInput.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues[0]?.message }, 400);
    saveConnection(null, c.req.param("id"), body.data);
    return c.json({ ok: true });
  })
  .put("/admin/providers/:id/access", async (c) => {
    const body = audienceInput.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues[0]?.message }, 400);
    const id = c.req.param("id");
    if (!db.prepare("SELECT 1 FROM shared_connections WHERE provider_id = ?").get(id)) return c.json({ error: "Not found" }, 404);
    setAudience("provider", id, body.data);
    return c.json({ ok: true });
  })
  .get("/admin/groups", (c) => c.json(listGroups()))
  .post("/admin/groups", async (c) => {
    const body = groupInput.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues[0]?.message }, 400);
    return c.json(createGroup(body.data.name, body.data.userIds));
  })
  .patch("/admin/groups/:id", async (c) => {
    const body = groupInput.partial().safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues[0]?.message }, 400);
    return c.json(updateGroup(c.req.param("id"), body.data));
  })
  .delete("/admin/groups/:id", (c) => {
    deleteGroup(c.req.param("id"));
    return c.json({ ok: true });
  })
  .delete("/admin/providers/:id", (c) => {
    deleteConnection(null, c.req.param("id"));
    return c.json({ ok: true });
  });
