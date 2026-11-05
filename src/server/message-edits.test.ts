import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { Hono } from "hono";
import type { UIMessage } from "ai";
import type { MessageEditResult, StoredMessageRow } from "../shared/types.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-message-edits-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "message-edits-test-secret-only-not-for-production";
writeFileSync(path.join(dataDir, "models-dev.json"), JSON.stringify({ data: {}, fetchedAt: Date.now() }));
const { db } = await import("./db.js");
const { sha256, decrypt } = await import("./crypto.js");
const { api } = await import("./routes.js");
const { appendMessage, branchThread, currentBranch, getThread, setCompaction } = await import("./threads.js");
const { updateSettings } = await import("./settings.js");
const { storageUsed } = await import("./quota.js");
const { markBusy } = await import("./thread-runs.js");
const { withStoredEdits } = await import("./message-edits.js");
const { publicShareRoutes } = await import("./shares.js");

const app = new Hono().route("/api/public/shares", publicShareRoutes).route("/api", api);
for (const id of ["alice", "bob"]) {
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, `${id}@example.test`, id, "unused", "user", 1);
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(id), id, Date.now() + 600_000);
}
after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const call = (url: string, init: { method?: string; json?: unknown; body?: string; user?: string } = {}) =>
  app.request(`http://app/api${url}`, {
    method: init.method ?? "GET",
    headers: { cookie: `okaychat_session=${init.user ?? "alice"}`, ...(init.json !== undefined || init.body ? { "content-type": "application/json" } : {}) },
    body: init.body ?? (init.json !== undefined ? JSON.stringify(init.json) : undefined),
  });
const edit = (json: unknown, { thread = "t1", message = "a1", user = "alice" } = {}) =>
  call(`/threads/${thread}/messages/${message}`, { method: "PATCH", json, user });
const undo = ({ thread = "t1", message = "a1", user = "alice" } = {}) =>
  call(`/threads/${thread}/messages/${message}/edit`, { method: "DELETE", user });

const tool = { type: "tool-web_search", toolCallId: "c1", state: "output-available", input: { query: "x" }, output: { results: [1, 2] } };
const reasoning = { type: "reasoning", text: "thinking", providerMetadata: { anthropic: { signature: "sig" } } };
const file = { type: "file", mediaType: "image/png", url: "/api/images/img_1" };
const a1Parts = [{ type: "step-start" }, reasoning, { type: "text", text: "Paris is in Germany.", state: "done", providerMetadata: { openai: { itemId: "msg_1" } } }, tool, file, { type: "text", text: "Sources above.", state: "done" }];

const rawRow = (threadId: string, id: string) =>
  db.prepare("SELECT id, parent_id, content, bytes, created_at, edited_at, original_enc FROM messages WHERE thread_id = ? AND id = ?").get(threadId, id) as {
    id: string; parent_id: string | null; content: string; bytes: number; created_at: number; edited_at: number | null; original_enc: string | null;
  };
const partsOf = (threadId: string, id: string) => (JSON.parse(rawRow(threadId, id).content) as { parts: Array<Record<string, unknown>> }).parts;

beforeEach(() => {
  db.exec("DELETE FROM shares; DELETE FROM messages; DELETE FROM threads; DELETE FROM user_settings;");
  updateSettings("alice", { editAssistantMessages: true });
  for (const [id, user] of [["t1", "alice"], ["t9", "bob"]] as const) {
    db.prepare("INSERT INTO threads (id, user_id, created_at, updated_at) VALUES (?, ?, 1000, 1000)").run(id, user);
  }
  const store = (id: string, parent: string | null, role: string, parts: unknown[], user = "alice", thread = "t1") =>
    appendMessage(user, thread, { id, parent_id: parent, format: "ai-sdk/v6", content: { role, parts, metadata: { custom: { modelRef: "m/x" } } } });
  store("u1", null, "user", [{ type: "text", text: "Where is Paris?" }]);
  store("a1", "u1", "assistant", a1Parts);
  store("u2", "a1", "user", [{ type: "text", text: "Thanks" }]);
  store("a2", "u2", "assistant", [{ type: "text", text: "Welcome." }]);
  store("b1", null, "assistant", [{ type: "text", text: "Bob's" }], "bob", "t9");
});

test("edit replaces only text parts, keeps id, parent, order, children, and every other part", async () => {
  const before = rawRow("t1", "a1");
  const order = () => (db.prepare("SELECT id FROM messages WHERE thread_id = 't1' ORDER BY created_at, rowid").all() as Array<{ id: string }>).map((r) => r.id);
  const orderBefore = order();
  const res = await edit({ parts: [{ type: "text", text: "Paris is in France." }, { type: "text", text: "Sources above." }] });
  assert.equal(res.status, 200, await res.clone().text());
  const body = (await res.json()) as MessageEditResult;
  assert.equal(typeof body.editedAt, "number");
  assert.equal(body.message.edited_at, body.editedAt);
  assert.equal(body.message.id, "a1");
  assert.equal(body.message.parent_id, "u1");

  const after = rawRow("t1", "a1");
  assert.equal(after.parent_id, "u1");
  assert.equal(after.created_at, before.created_at);
  assert.deepEqual(order(), orderBefore);
  assert.equal(rawRow("t1", "u2").parent_id, "a1", "children are untouched");
  const parts = partsOf("t1", "a1");
  assert.equal(parts.length, a1Parts.length);
  for (const i of [0, 1, 3, 4]) assert.equal(JSON.stringify(parts[i]), JSON.stringify(a1Parts[i]), `part ${i} is byte-identical`);
  assert.deepEqual(parts[2], { type: "text", text: "Paris is in France.", state: "done" }, "provider item ids are dropped from edited text");
  assert.deepEqual(parts[5], a1Parts[5]);
  assert.deepEqual(currentBranch("alice", "t1").map((m) => m.id), ["u1", "a1", "u2", "a2"], "the current branch did not fork");
  const metadata = (JSON.parse(after.content) as { metadata: unknown }).metadata;
  assert.deepEqual(metadata, { custom: { modelRef: "m/x" } });

  // The messages list carries edited_at on the edited row only.
  const rows = (await (await call("/threads/t1/messages")).json()) as StoredMessageRow[];
  assert.equal(rows.find((r) => r.id === "a1")?.edited_at, body.editedAt);
  assert.equal("edited_at" in rows.find((r) => r.id === "a2")!, false);
  assert.equal("original_enc" in rows.find((r) => r.id === "a1")!, false, "the encrypted original never leaves the server");
  assert.equal("original_enc" in body.message, false);
});

test("text is accepted for a single-text reply and refused for several text parts", async () => {
  assert.equal((await edit({ text: "Hello." }, { message: "a2" })).status, 200);
  assert.equal(partsOf("t1", "a2")[0]!.text, "Hello.");
  const res = await edit({ text: "x" });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { message: string }).message, /2 text sections/);
  assert.equal((await edit({ parts: [{ type: "text", text: "only one" }] })).status, 400);
});

test("the first original is stored once, encrypted, and Undo restores it after repeated edits", async () => {
  await edit({ text: "First edit." }, { message: "a2" });
  const first = rawRow("t1", "a2").original_enc!;
  assert.ok(first.startsWith("v1."));
  assert.equal(first.includes("Welcome"), false, "the original is not readable at rest");
  assert.deepEqual(JSON.parse(decrypt(first)), [{ type: "text", text: "Welcome." }]);
  await edit({ text: "Second edit." }, { message: "a2" });
  assert.equal(rawRow("t1", "a2").original_enc, first, "a later edit keeps the first original");
  assert.equal(partsOf("t1", "a2")[0]!.text, "Second edit.");

  const res = await undo({ message: "a2" });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as MessageEditResult).editedAt, null);
  const restored = rawRow("t1", "a2");
  assert.deepEqual(JSON.parse(restored.content).parts, [{ type: "text", text: "Welcome." }]);
  assert.equal(restored.edited_at, null);
  assert.equal(restored.original_enc, first, "Undo keeps the encrypted first original");
  assert.equal((await undo({ message: "a2" })).status, 409, "nothing left to undo");
  // A stale tab still sends the edited text after Undo; the turn must receive the restored original.
  const stale: UIMessage[] = [{ id: "a2", role: "assistant", parts: [{ type: "text", text: "Second edit." }] }];
  assert.equal((withStoredEdits("alice", "t1", stale)[0]!.parts[0] as { text: string }).text, "Welcome.");
  // Editing again after Undo reuses the original ciphertext instead of encrypting the restored text twice.
  await edit({ text: "Third edit." }, { message: "a2" });
  assert.equal(rawRow("t1", "a2").original_enc, first);

  // Undo restores provider metadata too: the original parts come back byte for byte.
  const beforeA1 = rawRow("t1", "a1").content;
  await edit({ parts: [{ type: "text", text: "A" }, { type: "text", text: "B" }] });
  await undo();
  assert.equal(rawRow("t1", "a1").content, beforeA1);
});

test("search, export, live shares, and the model request use the edited text", async () => {
  await edit({ text: "Bonjour from the edit." }, { message: "a2" });
  const markdown = await (await call("/threads/t1/export?format=markdown")).text();
  assert.match(markdown, /Bonjour from the edit\./);
  assert.doesNotMatch(markdown, /Welcome\./);
  const { token } = (await (await call("/threads/t1/share", { method: "POST" })).json()) as { token: string };
  const shared = await (await app.request(`http://app/api/public/shares/${token}`)).text();
  assert.match(shared, /Bonjour from the edit\./);
  assert.doesNotMatch(shared, /Welcome\./);
  const search = (await (await call("/search?q=Bonjour")).json()) as unknown[];
  assert.equal(search.length, 1);
  assert.equal(((await (await call("/search?q=Welcome")).json()) as unknown[]).length, 0);
  assert.equal((currentBranch("alice", "t1").at(-1)!.parts[0] as { text: string }).text, "Bonjour from the edit.");
  // A stale tab still sends the old reply; the turn gets the stored edit.
  const stale: UIMessage[] = [
    { id: "a2", role: "assistant", parts: [{ type: "text", text: "Welcome." }] },
    { id: "u3", role: "user", parts: [{ type: "text", text: "Next" }] },
  ];
  const sent = withStoredEdits("alice", "t1", stale);
  assert.equal((sent[0]!.parts[0] as { text: string }).text, "Bonjour from the edit.");
  assert.equal(sent[1], stale[1]);
  assert.equal(withStoredEdits("bob", "t1", stale)[0], stale[0], "another user's edits never apply");
});

test("a generic upsert cannot overwrite an edited reply", async () => {
  await edit({ text: "Edited." }, { message: "a2" });
  const stale = { id: "a2", parent_id: "u2", format: "ai-sdk/v6", content: { role: "assistant", parts: [{ type: "text", text: "Welcome." }] } };
  const res = await call("/threads/t1/messages", { method: "POST", json: stale });
  assert.equal(res.status, 409);
  assert.equal(partsOf("t1", "a2")[0]!.text, "Edited.");
  // The identical content is a harmless no-op.
  const same = { ...stale, content: JSON.parse(rawRow("t1", "a2").content) as unknown };
  assert.equal((await call("/threads/t1/messages", { method: "POST", json: same })).status, 200);
  assert.notEqual(rawRow("t1", "a2").edited_at, null);
});

test("a fork keeps the edited text, its edit state, and the encrypted original", async () => {
  await edit({ text: "Edited before the fork." }, { message: "a2" });
  branchThread("alice", "t1", "a2", "t2");
  const source = rawRow("t1", "a2");
  const fork = rawRow("t2", "a2");
  assert.equal(partsOf("t2", "a2")[0]!.text, "Edited before the fork.");
  assert.equal(fork.edited_at, source.edited_at);
  assert.equal(fork.original_enc, source.original_enc);
  // Undo in the fork restores its own copy and leaves the source's edit alone.
  assert.equal((await undo({ thread: "t2", message: "a2" })).status, 200);
  assert.equal(partsOf("t2", "a2")[0]!.text, "Welcome.");
  assert.equal(partsOf("t1", "a2")[0]!.text, "Edited before the fork.");
  assert.equal(fork.original_enc, source.original_enc);
});

test("a trim's context estimate follows the edited text and Undo", async () => {
  setCompaction("alice", "t1", {
    trim: { throughMessageId: "u2", lastMessageId: "a2", tokensBefore: 100, tokensAfter: 100, createdAt: 1 },
  } as never);
  const tokensAfter = () => getThread("alice", "t1")!.compaction!.trim!.tokensAfter;
  const before = tokensAfter();
  await edit({ text: "A much longer edited reply, with enough words to move the estimate." }, { message: "a2" });
  assert.ok(tokensAfter() > before, "a longer trimmed reply raises the prompt estimate");
  await undo({ message: "a2" });
  assert.equal(tokensAfter(), before, "Undo restores the estimate");
  // A reply appended after the trim was not part of tokensAfter; its edit must not shift that number twice.
  appendMessage("alice", "t1", { id: "a3", parent_id: "a2", format: "ai-sdk/v6", content: { role: "assistant", parts: [{ type: "text", text: "New." }] } });
  await edit({ text: "A much longer reply added after the trim." }, { message: "a3" });
  assert.equal(tokensAfter(), before);
});

test("auth and ownership", async () => {
  const anonymous = await app.request("http://app/api/threads/t1/messages/a2", { method: "PATCH", body: JSON.stringify({ text: "x" }), headers: { "content-type": "application/json" } });
  assert.equal(anonymous.status, 401);
  updateSettings("bob", { editAssistantMessages: true });
  assert.equal((await edit({ text: "x" }, { message: "a2", user: "bob" })).status, 404);
  assert.equal((await edit({ text: "x" }, { thread: "t9", message: "b1" })).status, 404, "alice cannot edit bob's thread");
  assert.equal((await undo({ thread: "t9", message: "b1" })).status, 404);
  assert.equal((await edit({ text: "x" }, { message: "missing" })).status, 404);
  assert.equal(partsOf("t9", "b1")[0]!.text, "Bob's");
});

test("user messages, temporary chats, and the account setting are enforced", async () => {
  const user = await edit({ text: "x" }, { message: "u1" });
  assert.equal(user.status, 400);
  assert.match(((await user.json()) as { message: string }).message, /Only assistant replies/);
  assert.equal((await edit({ text: "x" }, { thread: "tmp_abc", message: "a1" })).status, 400);
  updateSettings("alice", { editAssistantMessages: false });
  const off = await edit({ text: "x" }, { message: "a2" });
  assert.equal(off.status, 403);
  assert.equal(partsOf("t1", "a2")[0]!.text, "Welcome.");
  // Turning the setting off never traps an edit: Undo still works.
  updateSettings("alice", { editAssistantMessages: true });
  await edit({ text: "x" }, { message: "a2" });
  updateSettings("alice", { editAssistantMessages: false });
  assert.equal((await undo({ message: "a2" })).status, 200);
  // The settings API accepts the flag and defaults to off.
  db.exec("DELETE FROM user_settings");
  assert.equal(((await (await call("/settings")).json()) as { editAssistantMessages?: boolean }).editAssistantMessages, false);
  assert.equal((await call("/settings", { method: "PATCH", json: { editAssistantMessages: true } })).status, 200);
  assert.equal(((await (await call("/settings")).json()) as { editAssistantMessages?: boolean }).editAssistantMessages, true);
});

test("edits wait for an active run, interactive or scheduled", async () => {
  const release = markBusy("t1");
  const res = await edit({ text: "x" }, { message: "a2" });
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { message: string }).message, /still being written/);
  assert.equal((await undo({ message: "a2" })).status, 409);
  release();
  assert.equal((await edit({ text: "x" }, { message: "a2" })).status, 200);
});

test("only the latest branch, finished tools, and replies after a summary are editable", async () => {
  // A newer sibling of u2 makes a2 an older branch.
  appendMessage("alice", "t1", { id: "u2b", parent_id: "a1", format: "ai-sdk/v6", content: { role: "user", parts: [{ type: "text", text: "Other" }] } });
  const branch = await edit({ text: "x" }, { message: "a2" });
  assert.equal(branch.status, 409);
  assert.match(((await branch.json()) as { message: string }).message, /latest branch/);
  // a1 is an ancestor of the newest message, so it is still on the current branch.
  assert.equal((await edit({ parts: [{ type: "text", text: "A" }, { type: "text", text: "B" }] })).status, 200);
  await undo();

  appendMessage("alice", "t1", { id: "a3", parent_id: "u2b", format: "ai-sdk/v6", content: { role: "assistant", parts: [{ type: "text", text: "wait" }, { type: "tool-show_widget", toolCallId: "c2", state: "input-available", input: {} }] } });
  assert.equal((await edit({ text: "x" }, { message: "a3" })).status, 409, "a reply waiting for a browser tool");

  setCompaction("alice", "t1", { boundaryMessageId: "u2b", summary: "Summary", tokensBefore: 10, createdAt: 1 });
  const summarized = await edit({ parts: [{ type: "text", text: "A" }, { type: "text", text: "B" }] });
  assert.equal(summarized.status, 409);
  assert.match(((await summarized.json()) as { message: string }).message, /summary/);
  // A trim alone keeps text, so edits behind it still reach the model.
  setCompaction("alice", "t1", { trim: { throughMessageId: "u2b", lastMessageId: "a3", tokensAfter: 5 } } as never);
  assert.equal((await edit({ parts: [{ type: "text", text: "A" }, { type: "text", text: "B" }] })).status, 200);
});

test("limits: size, empty text, malformed bodies", async () => {
  assert.equal((await edit({ text: "x".repeat(200_001) }, { message: "a2" })).status, 400);
  assert.equal((await edit({ text: "   " }, { message: "a2" })).status, 400);
  assert.equal((await edit({}, { message: "a2" })).status, 400);
  assert.equal((await edit({ text: "x", parts: [{ type: "text", text: "x" }] }, { message: "a2" })).status, 400);
  assert.equal((await edit({ parts: [{ type: "reasoning", text: "x" }] }, { message: "a2" })).status, 400, "only text parts can be sent");
  assert.equal((await edit({ text: "x", hidden: "not allowed" }, { message: "a2" })).status, 400, "unknown fields cannot hide an edit");
  assert.equal((await edit({ parts: [{ type: "text", text: "x", extra: true }] }, { message: "a2" })).status, 400);
  assert.equal((await call("/threads/t1/messages/a2", { method: "PATCH", body: "x".repeat(900_001) })).status, 400, "oversized bodies are refused before parsing");
  assert.equal((await call("/threads/t1/messages/a2", { method: "PATCH", body: "{" })).status, 400);
  assert.equal(partsOf("t1", "a2")[0]!.text, "Welcome.");
});

test("quota counts the stored original and refuses growth past the limit", async () => {
  const before = storageUsed("alice");
  await edit({ text: "Welcome, and more." }, { message: "a2" });
  const row = rawRow("t1", "a2");
  assert.equal(storageUsed("alice"), before + (row.bytes - Buffer.byteLength(JSON.stringify({ role: "assistant", parts: [{ type: "text", text: "Welcome." }], metadata: { custom: { modelRef: "m/x" } } }))) + Buffer.byteLength(row.original_enc!));
  const original = row.original_enc!;
  await undo({ message: "a2" });
  assert.equal(storageUsed("alice"), before + Buffer.byteLength(original), "Undo keeps and still charges the audit original");

  db.prepare("UPDATE users SET storage_limit = ? WHERE id = 'alice'").run(storageUsed("alice") + 10);
  const res = await edit({ text: "A much longer reply than the limit allows." }, { message: "a2" });
  assert.equal(res.status, 413);
  assert.equal(partsOf("t1", "a2")[0]!.text, "Welcome.");
  db.prepare("UPDATE users SET storage_limit = NULL WHERE id = 'alice'").run();
});

test("migration adds the edit columns and leaves existing rows unedited", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "okaychat-edit-migration-"));
  const environment = { ...process.env, OKAYCHAT_DATA_DIR: directory, OKAYCHAT_SECRET: "edit-migration-secret-not-for-production" };
  const run = (code: string) => execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { env: environment, encoding: "utf8" });
  const dbUrl = new URL("./db.ts", import.meta.url).href;
  const threadsUrl = new URL("./threads.ts", import.meta.url).href;
  try {
    run(`const { db } = await import(${JSON.stringify(dbUrl)});
      db.exec("INSERT INTO users (id,email,name,password_hash,role,created_at) VALUES ('old','old@example.test','Old','unused','user',1)");
      db.exec("INSERT INTO threads (id,user_id,created_at,updated_at) VALUES ('t','old',1,1)");
      db.prepare("INSERT INTO messages (id,thread_id,format,content,bytes,created_at) VALUES ('m','t','ai-sdk/v6',?,10,1)").run(JSON.stringify({ role: "assistant", parts: [{ type: "text", text: "Old reply" }] }));
      // The later search-index artifacts must go before rewriting messages, or their triggers fire against a missing table.
      db.exec("DROP TRIGGER messages_fts_insert; DROP TRIGGER messages_fts_update; DROP TRIGGER messages_fts_delete");
      db.exec("DROP TABLE message_search_keys; DROP INDEX messages_thread_time");
      db.exec("ALTER TABLE messages DROP COLUMN edited_at");
      db.exec("ALTER TABLE messages DROP COLUMN original_enc");
      // Recreate schema 32, before reply editing (33), writing drafts (34), and media (35).
      // A fixed historical version stays valid when future migrations are appended.
      db.exec("ALTER TABLE email_drafts DROP COLUMN kind");
      db.exec("DROP TABLE message_feedback; DROP TABLE message_bookmarks; DROP TABLE message_translations; DROP TABLE saved_prompts; DROP TABLE assistant_presets; DROP TABLE generation_segments; DROP TABLE generation_runs; DROP TABLE archive_jobs");
      db.exec("DROP TABLE image_threads; DROP TABLE media; DROP INDEX uploads_media; DROP INDEX sandbox_files_media");
      for (const table of ["evaluation_scores", "evaluation_results", "evaluation_runs", "evaluation_cases", "evaluation_datasets"]) db.exec("DROP TABLE IF EXISTS " + table);
      for (const table of ["notifications", "tag_filter_presets", "thread_tags", "comparison_panes", "comparison_groups"]) db.exec("DROP TABLE IF EXISTS " + table);
      for (const index of ["shares_user_time", "shares_thread", "shares_expiry", "threads_compare"]) db.exec("DROP INDEX IF EXISTS " + index);
      db.exec("ALTER TABLE threads DROP COLUMN compare_group_id");
      for (const table of ["uploads", "sandbox_files", "user_avatars"]) db.exec("ALTER TABLE " + table + " DROP COLUMN media_id");
      // Tables added by later migrations must be absent before the historical replay.
      db.exec("DROP TABLE IF EXISTS chatgpt_login_attempts; DROP TABLE IF EXISTS chatgpt_registrations; DROP TABLE IF EXISTS chatgpt_controls; DROP TABLE IF EXISTS chatgpt_hosts");
      for (const table of ["n8n_agent_sessions", "n8n_agent_runs", "n8n_agents", "permission_leases", "permission_rate_windows", "permission_audit", "user_model_instructions", "prompt_rules", "permission_policies", "permission_state"]) db.exec("DROP TABLE " + table);
      db.exec("DROP INDEX user_groups_prompt_order");
      db.exec("ALTER TABLE user_groups DROP COLUMN prompt_order");
      for (const column of ["custom_instructions", "instructions_revision", "assistant_json", "assistant_revision", "imported_assistant_json", "preferred_head"]) db.exec("ALTER TABLE threads DROP COLUMN " + column);
      db.exec("ALTER TABLE messages DROP COLUMN imported");
      db.exec("DROP TRIGGER IF EXISTS channel_messages_fts_insert; DROP TRIGGER IF EXISTS channel_messages_fts_update; DROP TRIGGER IF EXISTS channel_messages_fts_delete; DROP TRIGGER IF EXISTS channel_search_keys_fts_delete");
      db.exec("DROP TABLE IF EXISTS channel_messages_fts; DROP TABLE IF EXISTS channel_search_keys; DROP TABLE IF EXISTS channel_events; DROP TABLE IF EXISTS channel_event_state; DROP TABLE IF EXISTS channel_rate_windows; DROP TABLE IF EXISTS channel_moderation_audit; DROP TABLE IF EXISTS channel_create_keys; DROP TABLE IF EXISTS channel_ai_runs; DROP TABLE IF EXISTS channel_reactions; DROP TABLE IF EXISTS channel_mentions; DROP TABLE IF EXISTS channel_messages; DROP TABLE IF EXISTS channel_exclusions; DROP TABLE IF EXISTS channel_invites; DROP TABLE IF EXISTS channel_members; DROP TABLE IF EXISTS channel_groups; DROP TABLE IF EXISTS channel_attachments; DROP TABLE IF EXISTS channel_thread_reads; DROP TABLE IF EXISTS channel_thread_state; DROP TABLE IF EXISTS channel_dm_blocks; DROP TABLE IF EXISTS channels");
      for (const table of ["notes_fts", "note_tags", "notes", "calendar_events_fts", "calendar_reminders", "calendar_events"]) db.exec("DROP TABLE IF EXISTS " + table);
      db.exec("DROP INDEX IF EXISTS usage_channel_run; ALTER TABLE usage DROP COLUMN channel_id; ALTER TABLE usage DROP COLUMN channel_run_id");
      db.exec("DROP TABLE IF EXISTS api_requests; DROP TABLE IF EXISTS api_rate_windows; DROP TABLE IF EXISTS api_key_audit; DROP TABLE IF EXISTS api_telemetry_floors; DROP TABLE IF EXISTS api_keys");
      db.exec("DROP INDEX IF EXISTS usage_api_request; DROP INDEX IF EXISTS usage_api_key_time; ALTER TABLE usage DROP COLUMN api_key_id; ALTER TABLE usage DROP COLUMN api_request_id");
      db.exec("DROP TRIGGER IF EXISTS knowledge_audience_cleanup; DROP TRIGGER IF EXISTS knowledge_shared_project_insert; DROP TRIGGER IF EXISTS knowledge_shared_project_update");
      db.exec("DROP TABLE IF EXISTS knowledge_thread_dependencies; DROP INDEX IF EXISTS knowledge_collections_visibility");
      for (const column of ["visibility", "access_revision", "embedding_connection_scope", "embedding_connection_created_at", "embedding_endpoint_hash"]) db.exec("ALTER TABLE knowledge_collections DROP COLUMN " + column);
      db.exec("PRAGMA user_version = 32");
      db.close();`);
    const result = JSON.parse(run(`const { db } = await import(${JSON.stringify(dbUrl)});
      const { listMessagesJson } = await import(${JSON.stringify(threadsUrl)});
      const row = db.prepare("SELECT content, edited_at, original_enc FROM messages WHERE id = 'm'").get();
      console.log(JSON.stringify({ row: { ...row }, list: JSON.parse(listMessagesJson("old", "t")) })); db.close();`)) as { row: Record<string, unknown>; list: unknown[] };
    assert.deepEqual(result.row, { content: JSON.stringify({ role: "assistant", parts: [{ type: "text", text: "Old reply" }] }), edited_at: null, original_enc: null });
    assert.deepEqual(result.list, [{ id: "m", parent_id: null, format: "ai-sdk/v6", content: { role: "assistant", parts: [{ type: "text", text: "Old reply" }] } }]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
