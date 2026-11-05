import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { Hono } from "hono";
import type { AssistantPreset, ThreadAssistant } from "../shared/assistant-presets.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-presets-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "assistant-presets-test-secret-not-for-production";
writeFileSync(path.join(dataDir, "models-dev.json"), JSON.stringify({ data: {}, fetchedAt: Date.now() }));
const { db } = await import("./db.js");
const { sha256 } = await import("./crypto.js");
const { api } = await import("./routes.js");
const { storageUsed } = await import("./quota.js");

const app = new Hono().route("/api", api);
after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

type Call = { method?: string; json?: unknown; user?: string; path?: string };
const call = (url: string, init: Call = {}) =>
  app.request(`http://app/api${url}`, {
    method: init.method ?? "GET",
    headers: {
      cookie: `okaychat_session=${init.user ?? "alice"}`,
      ...(init.json !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });

const body = async <T>(res: Response) => (await res.json()) as T;

const config = (over: Record<string, unknown> = {}) => ({
  modelRef: null,
  instructions: "Be concise.",
  sampling: {},
  tools: { mode: "inherit", builtins: [], mcpTools: [] },
  knowledge: { mode: "inherit", ids: [] },
  ...over,
});

const create = (over: Record<string, unknown> = {}, user = "alice") =>
  call("/assistant-presets", { method: "POST", json: { name: "Writer", description: "", icon: "pen-line", config: config(), visibility: "private", ...over }, user });

beforeEach(() => {
  db.exec("DELETE FROM assistant_presets; DELETE FROM generation_runs; DELETE FROM generation_segments; DELETE FROM threads; UPDATE users SET storage_limit = NULL;");
  for (const id of ["alice", "bob"]) {
    db.prepare("INSERT OR IGNORE INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, `${id}@example.test`, id, "unused", "user", 1);
    db.prepare("INSERT OR IGNORE INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(id), id, Date.now() + 600_000);
  }
});

test("ownership: a private preset is invisible to another account, a published one is readable but not editable", async () => {
  const created = await body<AssistantPreset>(await create());
  assert.match(created.id, /^preset_/);
  assert.equal(created.owned, true);
  assert.equal((await call(`/assistant-presets/${created.id}`, { user: "bob" })).status, 404);

  const published = await body<AssistantPreset>(await create({ visibility: "published" }, "alice"));
  const seen = await body<AssistantPreset>(await call(`/assistant-presets/${published.id}`, { user: "bob" }));
  assert.equal(seen.owned, false);
  assert.equal(seen.config.instructions, "Be concise.");
  assert.equal(seen.owner.name, "alice");

  const foreignEdit = await call(`/assistant-presets/${published.id}`, { method: "PUT", user: "bob", json: { name: "Mine", config: config(), icon: "bot", expectedRevision: 1 } });
  assert.equal(foreignEdit.status, 404);
  const foreignDelete = await call(`/assistant-presets/${published.id}`, { method: "DELETE", user: "bob", json: { expectedRevision: 1 } });
  assert.equal(foreignDelete.status, 404);
});

test("publishing rejects private knowledge ids and MCP selectors instead of stripping them", async () => {
  const knowledge = await create({ visibility: "published", config: config({ knowledge: { mode: "selected", ids: ["knc_1"] } }) });
  assert.equal(knowledge.status, 400);
  const mcp = await create({
    visibility: "published",
    config: config({ tools: { mode: "selected", builtins: ["web"], mcpTools: [{ serverId: "srv_1", toolName: "run" }] } }),
  });
  assert.equal(mcp.status, 400);
  const inherit = await create({ visibility: "published", config: config({ tools: { mode: "selected", builtins: ["web"], mcpTools: [] } }) });
  assert.equal(inherit.status, 201);
});

test("updates use compare-and-set and a stale revision conflicts without overwriting", async () => {
  const preset = await body<AssistantPreset>(await create());
  const first = await call(`/assistant-presets/${preset.id}`, {
    method: "PUT",
    json: { name: "Renamed", description: "", icon: "bot", config: config(), visibility: "private", expectedRevision: preset.revision },
  });
  assert.equal(first.status, 200);
  const updated = await body<AssistantPreset>(first);
  assert.equal(updated.revision, preset.revision + 1);
  assert.equal(updated.name, "Renamed");

  const stale = await call(`/assistant-presets/${preset.id}`, {
    method: "PUT",
    json: { name: "Stale", description: "", icon: "bot", config: config(), visibility: "private", expectedRevision: preset.revision },
  });
  assert.equal(stale.status, 409);
  const stored = await body<AssistantPreset>(await call(`/assistant-presets/${preset.id}`));
  assert.equal(stored.name, "Renamed");
});

test("preset bytes count against the quota, and a write over the limit is refused", async () => {
  const before = storageUsed("alice");
  const created = await body<AssistantPreset>(await create());
  const afterCreate = storageUsed("alice");
  assert.equal(afterCreate - before, Buffer.byteLength(created.name) + Buffer.byteLength(created.description) + Buffer.byteLength(JSON.stringify(created.config)));

  db.prepare("UPDATE users SET storage_limit = ? WHERE id = 'alice'").run(afterCreate);
  const refused = await create({ name: "Another" });
  assert.equal(refused.status, 413);
  assert.equal(storageUsed("alice"), afterCreate);
});

test("selecting copies a snapshot into the chat and survives deleting the library item", async () => {
  db.prepare("INSERT INTO threads (id, user_id, created_at, updated_at) VALUES ('thr_1', 'alice', 1, 1)").run();
  const preset = await body<AssistantPreset>(await create({ visibility: "published" }));
  const applied = await body<ThreadAssistant>(
    await call("/threads/thr_1/assistant", { method: "PUT", json: { expectedRevision: 0, selection: { presetId: preset.id, presetRevision: preset.revision } } }),
  );
  assert.equal(applied.snapshot?.name, "Writer");
  assert.equal(applied.snapshot?.sourceRevision, 1);
  assert.equal(applied.revision, 1);

  assert.equal((await call(`/assistant-presets/${preset.id}`, { method: "DELETE", json: { expectedRevision: 1 } })).status, 200);
  const still = await body<ThreadAssistant>(await call("/threads/thr_1/assistant"));
  assert.equal(still.snapshot?.instructions, "Be concise.");
  const thread = await body<{ assistant: { name: string } | null }>(await call("/threads/thr_1"));
  assert.equal(thread.assistant?.name, "Writer");
});

test("a stale thread revision or a missing source revision is a conflict", async () => {
  db.prepare("INSERT INTO threads (id, user_id, created_at, updated_at) VALUES ('thr_1', 'alice', 1, 1)").run();
  const preset = await body<AssistantPreset>(await create());
  await call("/threads/thr_1/assistant", { method: "PUT", json: { expectedRevision: 0, selection: { presetId: preset.id, presetRevision: preset.revision } } });
  const stale = await call("/threads/thr_1/assistant", { method: "PUT", json: { expectedRevision: 0, selection: null } });
  assert.equal(stale.status, 409);
  const libraryStale = await call("/threads/thr_1/assistant", { method: "PUT", json: { expectedRevision: 1, selection: { presetId: preset.id, presetRevision: 99 } } });
  assert.equal(libraryStale.status, 409);
  const cleared = await call("/threads/thr_1/assistant", { method: "PUT", json: { expectedRevision: 1, selection: null } });
  assert.equal(cleared.status, 200);
});

test("the builder options route is static and lists only the account's models", async () => {
  const options = await call("/assistant-presets/options");
  assert.equal(options.status, 200);
  const parsed = await body<{ models: Array<{ ref: string }>; builtins: Array<{ id: string; available: boolean }>; mcpTools: unknown[]; collections: unknown[] }>(options);
  assert.ok(Array.isArray(parsed.models));
  assert.ok(parsed.builtins.every((entry) => typeof entry.available === "boolean"));
});

test("a temporary chat's supplied assistant is validated and treated as untrusted", async () => {
  const { resolveAssistantForTurn } = await import("./assistant-presets.js");
  const temporary = resolveAssistantForTurn("alice", "tmp_1", { name: "Local", icon: "bot", ...config({ instructions: "Do this." }) });
  assert.equal(temporary.snapshot?.origin, "published");
  assert.equal(temporary.snapshot?.instructions, "Do this.");
  assert.equal(temporary.revision, 0);
  assert.throws(() => resolveAssistantForTurn("alice", "tmp_1", { instructions: "x", sampling: { temperature: "hot" } }));
});
