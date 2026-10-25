import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-groups-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "groups-test-secret-only-not-for-production";
const { db } = await import("./db.js");
const { createGroup, deleteGroup, getAudience, setAudience, updateGroup } = await import("./groups.js");
const { deleteConnection, getConnection, saveConnection } = await import("./catalog/providers.js");
const mcp = await import("./mcp/store.js");

for (const [id, role] of [["admin", "admin"], ["alice", "user"], ["bob", "user"], ["carol", "user"]]) {
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, `${id}@example.test`, id, "unused", role, Date.now());
}
after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => db.exec("DELETE FROM shared_connections; DELETE FROM share_audiences; DELETE FROM user_groups; DELETE FROM mcp_servers"));

const sees = (userId: string) => getConnection(userId, "openai")?.shared === true;
const who = () => ["alice", "bob", "carol"].filter(sees);

test("a shared provider reaches everyone, then only its groups and users", () => {
  saveConnection(null, "openai", { apiKey: "sk-server", enabled: true });
  assert.deepEqual(who(), ["alice", "bob", "carol"]);

  const team = createGroup("Team", ["alice"]);
  setAudience("provider", "openai", { mode: "selected", groupIds: [team.id], userIds: ["carol", "ghost"] });
  assert.deepEqual(who(), ["alice", "carol"]);
  assert.deepEqual(getAudience("provider", "openai"), { mode: "selected", groupIds: [team.id], userIds: ["carol"] });

  updateGroup(team.id, { userIds: ["bob"] });
  assert.deepEqual(who(), ["bob", "carol"]);
  deleteGroup(team.id);
  assert.deepEqual(who(), ["carol"]);

  setAudience("provider", "openai", { mode: "all", groupIds: [], userIds: [] });
  assert.deepEqual(who(), ["alice", "bob", "carol"]);
});

test("a user's own key still works outside the audience, and a re-added provider starts shared with everyone", () => {
  saveConnection(null, "openai", { apiKey: "sk-server", enabled: true });
  setAudience("provider", "openai", { mode: "selected", groupIds: [], userIds: [] });
  assert.deepEqual(who(), []);
  saveConnection("bob", "openai", { apiKey: "sk-bob", enabled: true });
  assert.equal(getConnection("bob", "openai")?.apiKey, "sk-bob");
  deleteConnection("bob", "openai");

  deleteConnection(null, "openai");
  saveConnection(null, "openai", { apiKey: "sk-server-2", enabled: true });
  assert.deepEqual(who(), ["alice", "bob", "carol"]);
});

test("a shared MCP server is visible only to its audience", () => {
  const id = mcp.createServer("admin", { name: "docs", transport: "http", config: { url: "https://example.test/mcp" }, enabled: true, shared: true });
  const visible = () => ["alice", "bob", "carol"].filter((u) => mcp.visibleServers(u).some((s) => s.id === id));
  assert.deepEqual(visible(), ["alice", "bob", "carol"]);
  const team = createGroup("Support", ["bob", "carol"]);
  setAudience("mcp", id, { mode: "selected", groupIds: [team.id], userIds: [] });
  assert.deepEqual(visible(), ["bob", "carol"]);
  assert.equal(mcp.visibleServers("admin").some((s) => s.id === id), true);
  mcp.deleteServer("admin", id);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM share_audiences").get()!.n, 0);
});

test("group names are unique regardless of case", () => {
  createGroup("Ops");
  assert.throws(() => createGroup("ops"), /exists/);
});
