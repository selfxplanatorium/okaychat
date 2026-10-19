import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { Hono } from "hono";
import type { UserAppearance } from "../shared/appearance.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-appearance-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "appearance-test-secret-only-not-for-production";
const { db } = await import("./db.js");
const { requireUser } = await import("./auth.js");
const { sha256 } = await import("./crypto.js");
const { appearanceRoutes } = await import("./appearance.js");
const { getSettings, updateSettings } = await import("./settings.js");
const app = new Hono().use(requireUser).route("/", appearanceRoutes);
for (const id of ["alice", "bob"]) {
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, `${id}@example.test`, id, "unused", "user", Date.now());
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(id), id, Date.now() + 60_000);
}
after(() => { db.close(); rmSync(dataDir, { recursive: true, force: true }); });
beforeEach(() => db.exec("DELETE FROM user_settings"));

const appearance: UserAppearance = {
  theme: "test-theme", mode: "dark", halves: { light: "ocean" },
  customThemes: [{ id: "test-theme", label: "Test", appearance: "dark", colors: { canvas: "#112233" }, variants: { light: { canvas: "#eeeeee" } } }],
  glassOpacity: 80, appearanceContrast: 100, panelAnimationDurationMs: 0, chatWidth: "comfortable",
  fontFamilySans: "", fontFamilyComposer: "", fontFamilyCode: "", fontSizeInterface: 16, fontSizePrompt: 14, fontSizeCode: 13,
  fontSmoothing: true, wordWrap: true, typographyAdvanced: false,
};
const request = (method: string, body?: unknown, user = "alice") => app.request("http://app/appearance", {
  method, headers: { cookie: `okaychat_session=${user}`, "Content-Type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test("appearance requires an authenticated account", async () => {
  assert.equal((await app.request("http://app/appearance")).status, 401);
});

test("first-device migration is idempotent and preserves custom themes", async () => {
  assert.equal(await (await request("GET")).json(), null);
  assert.deepEqual(await (await request("PUT", appearance)).json(), appearance);
  assert.deepEqual(await (await request("PUT", { ...appearance, theme: "ocean" })).json(), appearance);
});

test("patches merge changed fields and preserve other settings", async () => {
  await request("PUT", appearance);
  await request("PATCH", { chatWidth: "wide" });
  await request("PATCH", { fontSizeCode: 15 });
  updateSettings("alice", { maxSteps: 8 });
  assert.deepEqual(getSettings("alice").appearance, { ...appearance, chatWidth: "wide", fontSizeCode: 15 });
  assert.equal(getSettings("alice").maxSteps, 8);
});

test("invalid appearance values cannot corrupt saved preferences", async () => {
  assert.equal((await request("PATCH", { mode: "dark" })).status, 409);
  await request("PUT", appearance);
  for (const patch of [{ mode: "invalid" }, { glassOpacity: 0 }, { fontSizeCode: 99 }, { chatWidth: "narrow" }, { customThemes: [{ id: "bad" }] }, { wordWrap: "true" }]) {
    assert.equal((await request("PATCH", patch)).status, 400);
  }
  assert.deepEqual(await (await request("GET")).json(), appearance);
});

test("each account has its own appearance", async () => {
  await request("PUT", appearance);
  assert.equal(await (await request("GET", undefined, "bob")).json(), null);
  await request("PUT", { ...appearance, theme: "grove" }, "bob");
  assert.equal((await (await request("GET")).json()).theme, "test-theme");
  assert.equal((await (await request("GET", undefined, "bob")).json()).theme, "grove");
});
