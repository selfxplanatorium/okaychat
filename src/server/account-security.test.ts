import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { Hono } from "hono";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-account-security-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "account-security-test-secret-not-for-production";
writeFileSync(path.join(dataDir, "models-dev.json"), JSON.stringify({ data: {}, fetchedAt: Date.now() }));
const { db } = await import("./db.js");
const { authRoutes, requireUser, resetLoginLimits } = await import("./auth.js");
const { accountRoutes } = await import("./account.js");
const { getConnection, saveConnection } = await import("./catalog/providers.js");
const app = new Hono().route("/auth", authRoutes).route("/account", new Hono().use(requireUser).route("/", accountRoutes));
after(() => { db.close(); rmSync(dataDir, { recursive: true, force: true }); });
beforeEach(() => { resetLoginLimits(); db.exec("DELETE FROM sessions; DELETE FROM users; DELETE FROM provider_connections"); });

const request = (url: string, body?: unknown, cookie?: string) =>
  app.request(`http://app${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const cookieOf = (res: Response) => res.headers.get("set-cookie")!.split(";")[0]!;
const alice = { email: "alice@example.test", password: "correct horse" };

async function twoDevices() {
  const first = cookieOf(await request("/auth/signup", alice));
  const second = cookieOf(await request("/auth/login", alice));
  return { first, second };
}
const signedIn = async (cookie: string) => (await app.request("http://app/account", { headers: { cookie } })).status === 200;

test("changing the password needs the current one and signs out every other device", async () => {
  const { first, second } = await twoDevices();
  assert.equal((await request("/account/password", { current: "wrong password", next: "new password 1" }, first)).status, 403);
  assert.equal((await request("/account/password", { current: alice.password, next: "short" }, first)).status, 400);
  assert.equal((await request("/account/password", { current: alice.password, next: "new password 1" }, first)).status, 200);
  assert.equal(await signedIn(first), true);
  assert.equal(await signedIn(second), false);
  assert.equal((await request("/auth/login", alice)).status, 401);
  assert.equal((await request("/auth/login", { ...alice, password: "new password 1" })).status, 200);
});

test("a stolen session cannot guess the current password indefinitely", async () => {
  const { first } = await twoDevices();
  for (let i = 0; i < 10; i++) await request("/account/password", { current: `guess ${i}`, next: "new password 1" }, first);
  assert.equal((await request("/account/password", { current: alice.password, next: "new password 1" }, first)).status, 429);
});

test("signing out other devices keeps this one", async () => {
  const { first, second } = await twoDevices();
  const res = await request("/account/sessions/revoke-others", undefined, first);
  assert.deepEqual(await res.json(), { revoked: 1 });
  assert.equal(await signedIn(first), true);
  assert.equal(await signedIn(second), false);
});

test("a stored API key never follows a changed base URL", async () => {
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u', 'u@example.test', 'U', 'unused', 'admin', 1)").run();
  saveConnection("u", "openai", { apiKey: "sk-secret", baseURL: "https://api.openai.com/v1" });
  assert.throws(() => saveConnection("u", "openai", { baseURL: "https://attacker.example/v1" }), /API key again/);
  assert.equal(getConnection("u", "openai")?.baseURL, "https://api.openai.com/v1");
  // Same origin, or a new key with the new URL, is fine.
  saveConnection("u", "openai", { baseURL: "https://api.openai.com/v2" });
  saveConnection("u", "openai", { apiKey: "sk-other", baseURL: "https://proxy.example/v1" });
  assert.equal(getConnection("u", "openai")?.apiKey, "sk-other");
});
