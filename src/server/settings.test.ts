import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { Hono } from "hono";
import type { UserSettings } from "../shared/types.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-settings-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "settings-test-secret-only-not-for-production";
const { db } = await import("./db.js");
const { getSettings, updateSettings, subagentModelRefs } = await import("./settings.js");
for (const id of ["alice", "bob"]) {
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, `${id}@example.test`, id, "unused", "user", Date.now());
}
const app = new Hono().patch("/settings", async (c) => c.json(updateSettings("alice", await c.req.json())));
after(() => { db.close(); rmSync(dataDir, { recursive: true, force: true }); });
beforeEach(() => db.exec("DELETE FROM user_settings"));

test("reasoning defaults to Medium for new and existing accounts and persists per account", async () => {
  assert.equal(getSettings("alice").defaultReasoningEffort, "medium");
  db.prepare("INSERT INTO user_settings VALUES (?, ?)").run("alice", JSON.stringify({ reasoningEffort: { "provider/model": "low" } }));
  assert.equal(getSettings("alice").defaultReasoningEffort, "medium");
  updateSettings("alice", { defaultReasoningEffort: "high" });
  assert.equal(getSettings("alice").defaultReasoningEffort, "high");
  assert.equal(getSettings("alice").reasoningEffort["provider/model"], "low");
  assert.equal(getSettings("bob").defaultReasoningEffort, "medium");
  for (const value of [null, "auto", 3]) {
    const response = await app.request("http://app/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ defaultReasoningEffort: value }) });
    assert.equal(response.status, 400);
  }
  db.prepare("UPDATE user_settings SET json = ? WHERE user_id = ?").run(JSON.stringify({ defaultReasoningEffort: "invalid" }), "alice");
  assert.equal(getSettings("alice").defaultReasoningEffort, "medium");
});

test("sub-agents can independently follow the utility model or the chat model", () => {
  const settings = updateSettings("alice", { utilityModel: "provider/utility", subagentModel: null });
  assert.deepEqual(subagentModelRefs(settings, "provider/chat"), ["provider/utility", "provider/chat"]);
  const followChat = updateSettings("alice", { subagentModel: "chat" });
  assert.equal(getSettings("alice").subagentModel, "chat");
  assert.deepEqual(subagentModelRefs(followChat, "provider/chat"), ["provider/chat", "provider/utility"]);
  assert.deepEqual(subagentModelRefs(followChat, "provider/other-chat"), ["provider/other-chat", "provider/utility"]);
  assert.deepEqual(subagentModelRefs({ ...settings, utilityModel: null }, "provider/chat"), ["provider/chat"]);
  assert.deepEqual(subagentModelRefs({ ...settings, subagentModel: "provider/custom" }, "provider/chat"), ["provider/custom", "provider/utility", "provider/chat"]);
});

test("model overrides can be selected and cleared through JSON patches", async () => {
  for (const key of ["defaultModel", "utilityModel", "subagentModel"] as const) {
    for (const value of ["provider/luna", null]) {
      const response = await app.request("http://app/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ [key]: value }) });
      assert.equal(response.status, 200);
      assert.equal((await response.json())[key], value);
      assert.equal(getSettings("alice")[key], value);
      assert.equal(getSettings("bob")[key], undefined);
    }
  }
});

test("legacy accounts receive an independent conservative search default", () => {
  db.prepare("INSERT INTO user_settings VALUES (?, ?)").run("alice", JSON.stringify({ maxSteps: 30 }));
  assert.equal(getSettings("alice").maxSteps, 30);
  assert.equal(getSettings("alice").maxSearches, 5);
});

test("search and agent settings remain independent and account-scoped", () => {
  updateSettings("alice", { maxSearches: 0, maxSteps: 50 });
  assert.equal(getSettings("alice").maxSearches, 0);
  assert.equal(getSettings("alice").maxSteps, 50);
  assert.equal(getSettings("bob").maxSearches, 5);
  assert.equal(getSettings("bob").maxSteps, 20);
});

test("invalid limits return 400 without partially updating settings", async () => {
  updateSettings("alice", { maxSearches: 3, maxSteps: 12 });
  for (const [key, values] of [["maxSteps", [0, -1, 51, 1.5, "20", null]], ["maxSearches", [-1, 51, 2.5, "5", null]]] as const) {
    for (const value of values) {
      const res = await app.request("http://app/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ [key]: value, systemPrompt: "must not persist" }) });
      assert.equal(res.status, 400, `${key}: ${String(value)}`);
    }
  }
  assert.equal(getSettings("alice").maxSearches, 3);
  assert.equal(getSettings("alice").maxSteps, 12);
  assert.equal(getSettings("alice").systemPrompt, "");
  assert.throws(() => updateSettings("alice", { maxSearches: NaN } as Partial<UserSettings>));
});

test("invalid persisted limits recover to defaults before model execution", () => {
  db.prepare("INSERT INTO user_settings VALUES (?, ?)").run("alice", JSON.stringify({ maxSteps: -5, maxSearches: "unlimited" }));
  assert.equal(getSettings("alice").maxSteps, 20);
  assert.equal(getSettings("alice").maxSearches, 5);
});


test("sidebar visibility persists per account, including hiding every shortcut", async () => {
  assert.equal(getSettings("alice").sidebarItems, undefined);
  updateSettings("alice", { sidebarItems: ["newChat", "projects"] });
  // An older saved list receives the new channels item once.
  assert.deepEqual(getSettings("alice").sidebarItems, ["newChat", "projects", "channels"]);
  assert.equal(getSettings("bob").sidebarItems, undefined);
  updateSettings("alice", { maxSearches: 2 });
  assert.deepEqual(getSettings("alice").sidebarItems, ["newChat", "projects", "channels"]);
  // Removing it after that does not append it again.
  updateSettings("alice", { sidebarItems: ["newChat", "projects"] });
  assert.deepEqual(getSettings("alice").sidebarItems, ["newChat", "projects"]);
  updateSettings("alice", { sidebarItems: [] });
  assert.deepEqual(getSettings("alice").sidebarItems, []);
  for (const sidebarItems of [null, "projects", ["unknown"], ["projects", "projects"], [1]]) {
    const res = await app.request("http://app/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sidebarItems }) });
    assert.equal(res.status, 400);
  }
  assert.deepEqual(getSettings("alice").sidebarItems, []);
});

test("invalid legacy sidebar visibility falls back to all shortcuts", () => {
  db.prepare("INSERT INTO user_settings VALUES (?, ?)").run("alice", JSON.stringify({ sidebarItems: ["unknown"] }));
  assert.equal(getSettings("alice").sidebarItems, undefined);
});

test("notification preferences round-trip and a malformed stored object is dropped", () => {
  assert.deepEqual(getSettings("alice").notifications, { browser: false, scheduleSuccess: false });
  const saved = updateSettings("alice", { notifications: { browser: true, scheduleSuccess: false } });
  assert.deepEqual(saved.notifications, { browser: true, scheduleSuccess: false });
  assert.deepEqual(getSettings("alice").notifications, { browser: true, scheduleSuccess: false });
  assert.throws(() => updateSettings("alice", { notifications: { browser: true } as never }));
  assert.throws(() => updateSettings("alice", { notifications: { browser: true, scheduleSuccess: false, extra: true } as never }));
  db.prepare("UPDATE user_settings SET json = ? WHERE user_id = ?").run(JSON.stringify({ notifications: { browser: "yes", scheduleSuccess: 1 } }), "alice");
  // Dropped, so clients fall back to DEFAULT_USER_SETTINGS.notifications.
  assert.equal(getSettings("alice").notifications, undefined);
});

test("activity indicator preferences default, validate strictly and survive unrelated patches", async () => {
  assert.deepEqual(getSettings("alice").channelActivity, { sharePresence: true, shareTyping: true });
  db.prepare("INSERT INTO user_settings VALUES (?, ?)").run("alice", JSON.stringify({ channelActivity: { sharePresence: "yes", shareTyping: true } }));
  assert.deepEqual(getSettings("alice").channelActivity, { sharePresence: true, shareTyping: true });

  const patch = async (body: unknown) => app.request("http://app/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  for (const invalid of [
    { sharePresence: false },
    { sharePresence: false, shareTyping: true, extra: true },
    { sharePresence: "no", shareTyping: true },
    null,
    "off",
  ]) {
    assert.equal((await patch({ channelActivity: invalid })).status, 400, JSON.stringify(invalid));
  }
  assert.equal((await patch({ channelActivity: { sharePresence: false, shareTyping: true } })).status, 200);
  assert.deepEqual(getSettings("alice").channelActivity, { sharePresence: false, shareTyping: true });
  // An absent property leaves the pair unchanged.
  assert.equal((await patch({ maxSteps: 7 })).status, 200);
  assert.deepEqual(getSettings("alice").channelActivity, { sharePresence: false, shareTyping: true });
  assert.deepEqual(getSettings("bob").channelActivity, { sharePresence: true, shareTyping: true });
});

test("UI and translation languages accept any valid tag, store it canonical, and are read back canonical", async () => {
  const patch = (body: unknown) => app.request("http://app/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  for (const [input, canonical] of [["FR-fr", "fr-FR"], ["IT-it", "it-IT"], ["pt-pt", "pt-PT"], ["fr", "fr"], ["it-IT", "it-IT"], ["pt", "pt"], ["pt-BR", "pt-BR"], ["nl-BE", "nl-BE"]] as const) {
    const response = await patch({ locale: input });
    assert.equal(response.status, 200, input);
    assert.equal(((await response.json()) as UserSettings).locale, canonical);
    assert.equal(getSettings("alice").locale, canonical);
  }
  // A stored regional choice stays regional; shipping pt-PT does not rewrite pt-BR.
  updateSettings("alice", { locale: "pt-BR" });
  assert.equal(getSettings("alice").locale, "pt-BR");
  // Omission leaves the value alone, null clears it.
  updateSettings("alice", { translationTarget: "IT-ch" });
  assert.equal(getSettings("alice").locale, "pt-BR");
  assert.equal(getSettings("alice").translationTarget, "it-CH");
  updateSettings("alice", { locale: null });
  assert.equal(getSettings("alice").locale, null);
  assert.equal(getSettings("alice").translationTarget, "it-CH");
  for (const bad of ["pt_PT", "x", "en-", `en-${"a".repeat(40)}`, "de-1996-1996"]) {
    assert.equal((await patch({ locale: bad })).status, 400, bad);
    assert.equal((await patch({ translationTarget: bad })).status, 400, bad);
  }
  assert.equal(getSettings("alice").translationTarget, "it-CH");
});

test("reading settings canonicalizes valid legacy language tags and drops invalid ones without rewriting the row", () => {
  const stored = { locale: "pt-pt", translationTarget: "FR-ca" };
  db.prepare("INSERT INTO user_settings VALUES (?, ?)").run("alice", JSON.stringify(stored));
  const read = getSettings("alice");
  assert.equal(read.locale, "pt-PT");
  assert.equal(read.translationTarget, "fr-CA");
  const row = db.prepare("SELECT json FROM user_settings WHERE user_id = ?").get("alice") as { json: string };
  assert.deepEqual({ locale: JSON.parse(row.json).locale, translationTarget: JSON.parse(row.json).translationTarget }, stored);
  db.prepare("UPDATE user_settings SET json = ? WHERE user_id = ?").run(JSON.stringify({ locale: "pt_PT", translationTarget: 42 }), "alice");
  const dropped = getSettings("alice");
  assert.equal(dropped.locale ?? null, null);
  assert.equal(dropped.translationTarget ?? null, null);
});
