import { getConnInfo } from "@hono/node-server/conninfo";
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

/** `session` is the hash of the request's session token, so account actions can keep the current device signed in. */
export type AppEnv = { Variables: { user: Me; session: string } };

/** True when the browser reached us over HTTPS, including through a TLS-terminating proxy. */
function isHttps(c: Context) {
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  return (proto ?? new URL(c.req.url).protocol.replace(":", "")) === "https";
}

function createSession(c: Context, userId: string) {
  const token = randomToken();
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(
    sha256(token),
    userId,
    Date.now() + SESSION_TTL_MS,
  );
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: env.production && isHttps(c),
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

/** True while the session row behind a socket's cold hash still exists. Voice calls check this on every ping. */
export function sessionAlive(tokenHash: string, now = Date.now()): boolean {
  return !!db.prepare("SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ?").get(tokenHash, now);
}

export function accountProfile(userId: string): Me | null {
  const row = db.prepare(`SELECT u.id, u.email, u.name, u.role, a.updated_at AS avatarVersion
    FROM users u LEFT JOIN user_avatars a ON a.user_id = u.id WHERE u.id = ?`).get(userId) as (Me & { avatarVersion: number | null }) | undefined;
  if (!row) return null;
  const { avatarVersion, ...user } = row;
  return { ...user, ...(avatarVersion === null ? {} : { avatarUrl: `/api/account/avatar?v=${avatarVersion}` }) };
}

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, COOKIE);
  const user = userFromToken(token);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  c.set("user", user);
  c.set("session", sha256(token!));
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

// Failed logins per email and per client address, kept in memory. A restart resets them, which only
// helps an attacker who can also restart the server.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_EMAIL = 10;
const MAX_PER_CLIENT = 50;
const failures = new Map<string, { count: number; resetAt: number }>();

/**
 * Socket address plus the last X-Forwarded-For hop. Behind a reverse proxy the last hop is the real
 * client, so one attacker cannot lock out everyone sharing the proxy address. Without a proxy the
 * header is forgeable, which only weakens this limit; the per-email limit still applies.
 */
export function clientKey(c: Context) {
  let socket = "unknown";
  try {
    socket = getConnInfo(c).remote.address ?? socket;
  } catch {}
  const forwarded = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim() ?? "";
  return `ip:${socket}|${forwarded}`;
}

export function limited(key: string, max: number) {
  const entry = failures.get(key);
  if (!entry) return false;
  if (entry.resetAt <= Date.now()) {
    failures.delete(key);
    return false;
  }
  return entry.count >= max;
}

export function recordFailure(key: string) {
  const now = Date.now();
  if (failures.size > 10_000) for (const [k, v] of failures) if (v.resetAt <= now) failures.delete(k);
  const entry = failures.get(key);
  if (entry && entry.resetAt > now) entry.count++;
  else failures.set(key, { count: 1, resetAt: now + WINDOW_MS });
}

/** Gives back an attempt recorded up front by a request that turned out to succeed. */
export function forgiveFailure(key: string) {
  const entry = failures.get(key);
  if (!entry) return;
  if (entry.count <= 1) failures.delete(key);
  else entry.count--;
}

/** Test hook: forget failed attempts. */
export const resetLoginLimits = () => failures.clear();

// Unknown emails still pay for one scrypt run, so response time does not reveal which accounts exist.
const dummyHash = hashPassword(randomToken());

const readJson = (c: Context) => c.req.json().catch(() => null);

/** The same rules as sign-up. */
export const passwordSchema = z.string().min(8).max(200);

const credentials = z.object({
  // Lowercased, so case variants cannot register a second account or dodge the per-email login limit.
  email: z.string().trim().email().toLowerCase(),
  password: passwordSchema,
  name: z.string().trim().min(1).max(80).optional(),
});

export const authRoutes = new Hono<AppEnv>()
  .get("/status", (c) => {
    const user = userFromToken(getCookie(c, COOKIE));
    const count = userCount();
    return c.json({ user, needsSetup: count === 0, signupOpen: count === 0 || signupAllowed() });
  })
  .post("/signup", async (c) => {
    const client = clientKey(c);
    if (limited(client, MAX_PER_CLIENT)) return c.json({ error: "Too many attempts. Try again later." }, 429);
    const body = credentials.safeParse(await readJson(c));
    if (!body.success) return c.json({ error: "Enter a valid email and a password of 8+ characters." }, 400);
    if (userCount() > 0 && !signupAllowed()) return c.json({ error: "Sign-up is closed. Ask an admin." }, 403);
    recordFailure(client);
    // Hash before the checks below: nothing may await between reading the user count and the insert,
    // or two concurrent sign-ups on an empty server could both become admin.
    const passwordHash = await hashPassword(body.data.password);
    const first = userCount() === 0;
    if (!first && !signupAllowed()) return c.json({ error: "Sign-up is closed. Ask an admin." }, 403);
    const exists = db.prepare("SELECT 1 FROM users WHERE lower(email) = ?").get(body.data.email);
    if (exists) return c.json({ error: "That email is already registered." }, 409);
    const id = newId("usr");
    db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      id,
      body.data.email,
      body.data.name ?? body.data.email.split("@")[0]!,
      passwordHash,
      first ? "admin" : "user",
      Date.now(),
    );
    createSession(c, id);
    return c.json({ ok: true });
  })
  .post("/login", async (c) => {
    const body = credentials.safeParse(await readJson(c));
    if (!body.success) return c.json({ error: "Invalid email or password." }, 400);
    const client = clientKey(c);
    const account = `email:${body.data.email}`;
    if (limited(client, MAX_PER_CLIENT) || limited(account, MAX_PER_EMAIL)) {
      return c.json({ error: "Too many failed attempts. Try again in 15 minutes." }, 429);
    }
    // Accounts created before emails were lowercased may be stored with mixed case.
    const row = db.prepare("SELECT id, password_hash FROM users WHERE lower(email) = ? ORDER BY created_at LIMIT 1").get(body.data.email) as
      | { id: string; password_hash: string }
      | undefined;
    // Count the attempt before awaiting scrypt, so a burst of parallel guesses cannot all pass the check.
    recordFailure(client);
    recordFailure(account);
    const valid = await verifyPassword(body.data.password, row?.password_hash ?? (await dummyHash));
    if (!row || !valid) return c.json({ error: "Invalid email or password." }, 401);
    // A password reset during verification revokes sessions; the old password must not mint a new one.
    const current = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(row.id) as { password_hash: string } | undefined;
    if (current?.password_hash !== row.password_hash) return c.json({ error: "Invalid email or password." }, 401);
    forgiveFailure(client);
    failures.delete(account);
    createSession(c, row.id);
    return c.json({ ok: true });
  })
  .post("/logout", (c) => {
    const token = getCookie(c, COOKIE);
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
    deleteCookie(c, COOKIE, { path: "/" });
    return c.json({ ok: true });
  });
