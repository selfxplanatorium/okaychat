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
  glassOpacity: 80, appearanceContrast: 100, panelAnimationDurationMs: 0, motionOff: [], squareCorners: false, sidebarStyle: "floating", chatWidth: "comfortable", messageLayout: "timeline",
  fontFamilySans: "", fontFamilyComposer: "", fontFamilyCode: "", fontSizePrompt: 14, fontSizeCode: 13,
  fontSmoothing: true, wordWrap: true, typographyAdvanced: false,
};
// A snapshot saved before the message layout existed.
const { messageLayout: _layout, ...legacy } = appearance;
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

test("patches leave defaulted fields they do not send", async () => {
  await request("PUT", { ...appearance, sidebarStyle: "docked", squareCorners: true, motionOff: ["icons"] });
  await request("PATCH", { chatWidth: "wide" });
  assert.deepEqual(getSettings("alice").appearance, { ...appearance, sidebarStyle: "docked", squareCorners: true, motionOff: ["icons"], chatWidth: "wide" });
});

test("the interface size stays on each device", async () => {
  await request("PUT", { ...appearance, fontSizeInterface: 20 });
  assert.deepEqual(await (await request("GET")).json(), appearance);
  // Snapshots saved before the size became per-device still carry it.
  updateSettings("alice", { appearance: { ...appearance, fontSizeInterface: 20 } as UserAppearance });
  assert.deepEqual(await (await request("GET")).json(), appearance);
  await request("PATCH", { fontSizeInterface: 12, chatWidth: "wide" });
  assert.deepEqual(getSettings("alice").appearance, { ...appearance, chatWidth: "wide" });
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

test("snapshots saved before the message layout read with its default without being rewritten", async () => {
  updateSettings("alice", { appearance: legacy as UserAppearance });
  const read = await (await request("GET")).json();
  assert.deepEqual(read, appearance);
  assert.deepEqual(getSettings("alice").appearance, legacy);
});

test("the message layout persists through a one-key patch and survives other patches", async () => {
  await request("PUT", appearance);
  assert.equal((await request("PATCH", { messageLayout: "bubbles" })).status, 200);
  assert.deepEqual(getSettings("alice").appearance, { ...appearance, messageLayout: "bubbles" });
  await request("PATCH", { chatWidth: "wide" });
  assert.deepEqual(await (await request("GET")).json(), { ...appearance, messageLayout: "bubbles", chatWidth: "wide" });
});

test("an invalid message layout is rejected and leaves the row unchanged", async () => {
  await request("PUT", appearance);
  assert.equal((await request("PATCH", { messageLayout: "bubble" })).status, 400);
  assert.deepEqual(getSettings("alice").appearance, appearance);
});

test("a corrupt stored snapshot still reads a total appearance with a valid layout", async () => {
  updateSettings("alice", { appearance: { ...appearance, glassOpacity: 5, messageLayout: "chat" } as unknown as UserAppearance });
  assert.equal((await (await request("GET")).json()).messageLayout, "timeline");
  updateSettings("alice", { appearance: { ...appearance, glassOpacity: 5, messageLayout: "bubbles" } as unknown as UserAppearance });
  assert.equal((await (await request("GET")).json()).messageLayout, "bubbles");
});
