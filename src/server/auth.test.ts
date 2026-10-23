import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { Hono } from "hono";
import { csrf } from "hono/csrf";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-auth-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "auth-test-secret-only-not-for-production";
const { db } = await import("./db.js");
const { authRoutes, resetLoginLimits } = await import("./auth.js");
const app = new Hono().use(csrf()).route("/auth", authRoutes);
after(() => { db.close(); rmSync(dataDir, { recursive: true, force: true }); });
beforeEach(() => { resetLoginLimits(); db.exec("DELETE FROM sessions; DELETE FROM users"); });

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(`http://app/auth${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const alice = { email: "alice@example.test", password: "correct horse" };

test("concurrent first sign-ups create only one admin", async () => {
  const results = await Promise.all([post("/signup", alice), post("/signup", { ...alice, email: "bob@example.test" })]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 403]);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number }).n, 1);
});

test("login works, ignores email case, and rejects wrong passwords and unknown accounts", async () => {
  await post("/signup", alice);
  assert.equal((await post("/login", { ...alice, email: "ALICE@example.test" })).status, 200);
  assert.equal((await post("/login", { ...alice, password: "wrong password" })).status, 401);
  assert.equal((await post("/login", { ...alice, email: "nobody@example.test" })).status, 401);
});

test("repeated failures lock the account, even for the right password", async () => {
  await post("/signup", alice);
  for (let i = 0; i < 10; i++) assert.equal((await post("/login", { ...alice, password: `wrong ${i}xx` })).status, 401);
  assert.equal((await post("/login", alice)).status, 429);
});

test("malformed bodies are rejected without a server error", async () => {
  assert.equal((await post("/login", "{not json")).status, 400);
  assert.equal((await post("/login", { email: "a@b.c", password: ["x"] })).status, 400);
  assert.equal((await post("/signup", { email: "<script>", password: "12345678" })).status, 400);
});

test("cross-site form posts cannot log in", async () => {
  await post("/signup", alice);
  const res = await post("/login", alice, { "content-type": "text/plain", "sec-fetch-site": "cross-site", origin: "https://evil.test" });
  assert.equal(res.status, 403);
});

test("a forged session cookie is unauthorized", async () => {
  const res = await app.request("http://app/auth/status", { headers: { cookie: "okaychat_session=forged" } });
  assert.equal((await res.json()).user, null);
});
