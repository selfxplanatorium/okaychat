import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { Hono } from "hono";
import { z } from "zod";
import type { Me } from "../shared/types.js";
import { hashPassword, newId, randomToken, sha256, verifyPassword } from "./crypto.js";
import { db } from "./db.js";
import { env } from "./env.js";

const COOKIE = "okaychat_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type AppEnv = { Variables: { user: Me } };

function createSession(c: Context, userId: string) {
  const token = randomToken();
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(
    sha256(token),
    userId,
    Date.now() + SESSION_TTL_MS,
  );
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: env.production && c.req.url.startsWith("https:"),
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

function userFromToken(token: string | undefined): Me | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(sha256(token), Date.now()) as { id: string } | undefined;
  return row ? accountProfile(row.id) : null;
}

export function accountProfile(userId: string): Me | null {
  const row = db.prepare(`SELECT u.id, u.email, u.name, u.role, a.updated_at AS avatarVersion
    FROM users u LEFT JOIN user_avatars a ON a.user_id = u.id WHERE u.id = ?`).get(userId) as (Me & { avatarVersion: number | null }) | undefined;
  if (!row) return null;
  const { avatarVersion, ...user } = row;
  return { ...user, ...(avatarVersion === null ? {} : { avatarUrl: `/api/account/avatar?v=${avatarVersion}` }) };
}

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = userFromToken(getCookie(c, COOKIE));
  if (!user) return c.json({ error: "unauthorized" }, 401);
  c.set("user", user);
  await next();
};

/** Admin setting in the database, falling back to OKAYCHAT_ALLOW_SIGNUP. */
export function signupAllowed(): boolean {
  const row = db.prepare("SELECT value FROM server_settings WHERE key = 'allowSignup'").get() as { value: string } | undefined;
  return row ? row.value === "true" : env.allowSignup;
}

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("user").role !== "admin") return c.json({ error: "Admins only" }, 403);
  await next();
};

const userCount = () => (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;

const credentials = z.object({
  email: z.string().trim().email(),
  password: z.string().min(8).max(200),
  name: z.string().trim().min(1).max(80).optional(),
});

export const authRoutes = new Hono<AppEnv>()
  .get("/status", (c) => {
    const user = userFromToken(getCookie(c, COOKIE));
    const count = userCount();
    return c.json({ user, needsSetup: count === 0, signupOpen: count === 0 || signupAllowed() });
  })
  .post("/signup", async (c) => {
    const body = credentials.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: "Enter a valid email and a password of 8+ characters." }, 400);
    const first = userCount() === 0;
    if (!first && !signupAllowed()) return c.json({ error: "Sign-up is closed. Ask an admin." }, 403);
    const exists = db.prepare("SELECT 1 FROM users WHERE email = ?").get(body.data.email);
    if (exists) return c.json({ error: "That email is already registered." }, 409);
    const id = newId("usr");
    db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      id,
      body.data.email,
      body.data.name ?? body.data.email.split("@")[0]!,
      await hashPassword(body.data.password),
      first ? "admin" : "user",
      Date.now(),
    );
    createSession(c, id);
    return c.json({ ok: true });
  })
  .post("/login", async (c) => {
    const body = credentials.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: "Invalid email or password." }, 400);
    const row = db.prepare("SELECT id, password_hash FROM users WHERE email = ?").get(body.data.email) as
      | { id: string; password_hash: string }
      | undefined;
    if (!row || !(await verifyPassword(body.data.password, row.password_hash))) {
      return c.json({ error: "Invalid email or password." }, 401);
    }
    createSession(c, row.id);
    return c.json({ ok: true });
  })
  .post("/logout", (c) => {
    const token = getCookie(c, COOKIE);
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
    deleteCookie(c, COOKIE, { path: "/" });
    return c.json({ ok: true });
  });
