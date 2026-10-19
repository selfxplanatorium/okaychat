import { Hono } from "hono";
import { z } from "zod";
import type { AdminUser } from "../shared/types.js";
import { requireAdmin, signupAllowed, type AppEnv } from "./auth.js";
import { deleteConnection, listProviders, saveConnection } from "./catalog/providers.js";
import { hashPassword, newId } from "./crypto.js";
import { db } from "./db.js";

const userInput = z.object({
  email: z.string().trim().email(),
  name: z.string().trim().min(1).max(80),
  password: z.string().min(8).max(200),
  role: z.enum(["admin", "user"]).default("user"),
});

const userPatch = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  role: z.enum(["admin", "user"]).optional(),
  password: z.string().min(8).max(200).optional(),
});

const providerInput = z.object({
  apiKey: z.string().optional(),
  baseURL: z.string().url().or(z.literal("")).optional(),
  name: z.string().max(60).optional(),
  enabled: z.boolean().optional(),
});

const adminCount = () => (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number }).n;

export const adminRoutes = new Hono<AppEnv>()
  .use("/admin/*", requireAdmin)
  .get("/admin/users", (c) => {
    const rows = db
      .prepare(
        `SELECT u.id, u.email, u.name, u.role, u.created_at AS createdAt,
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
    if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(body.data.email)) return c.json({ error: "That email is already registered." }, 409);
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
    if (body.data.role === "user" && target.role === "admin" && adminCount() === 1) return c.json({ error: "Keep at least one admin." }, 400);
    if (body.data.name) db.prepare("UPDATE users SET name = ? WHERE id = ?").run(body.data.name, id);
    if (body.data.role) db.prepare("UPDATE users SET role = ? WHERE id = ?").run(body.data.role, id);
    if (body.data.password) {
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await hashPassword(body.data.password), id);
      // A reset signs the user out everywhere.
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
    }
    return c.json({ ok: true });
  })
  .delete("/admin/users/:id", (c) => {
    const id = c.req.param("id");
    if (id === c.get("user").id) return c.json({ error: "You cannot delete your own account here." }, 400);
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
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
  .get("/admin/providers", async (c) => c.json(await listProviders(null)))
  .put("/admin/providers/:id", async (c) => {
    const body = providerInput.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues[0]?.message }, 400);
    saveConnection(null, c.req.param("id"), body.data);
    return c.json({ ok: true });
  })
  .delete("/admin/providers/:id", (c) => {
    deleteConnection(null, c.req.param("id"));
    return c.json({ ok: true });
  });
