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
