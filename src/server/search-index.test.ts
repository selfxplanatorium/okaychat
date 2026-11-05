import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-search-index-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "search-index-test-secret-only-not-for-production";
const { db } = await import("./db.js");
const { appendMessage, deleteThread, ensureThread, listMessagesJson } = await import("./threads.js");
const { searchMessages } = await import("./search.js");

db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('alice', 'alice@example.test', 'Alice', 'unused', 'user', 1)").run();
beforeEach(() => {
  // Deleting a thread cascades through messages, their keys, and their FTS rows.
  db.exec("DELETE FROM threads");
  ensureThread("alice", "t");
});
after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const parts = (text: string) => [{ type: "text", text }];
const store = (id: string, parent: string | null, text: string, format = "ai-sdk/v6") =>
  appendMessage("alice", "t", { id, parent_id: parent, format, content: { role: "assistant", parts: parts(text) } });
const emptyStore = (id: string) => appendMessage("alice", "t", { id, parent_id: null, format: "ai-sdk/v6", content: { role: "assistant", parts: [] } });
const keyOf = (id: string) => {
  const row = db.prepare("SELECT search_id FROM message_search_keys WHERE thread_id = 't' AND message_id = ?").get(id) as { search_id: number } | undefined;
  return row && { ...row };
};
const ftsRow = (id: string) => {
  const row = db.prepare("SELECT rowid, text FROM messages_fts WHERE thread_id = 't' AND message_id = ?").get(id) as { rowid: number; text: string } | undefined;
  return row && { ...row };
};
const counts = () => ({
  messages: (db.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n,
  keys: (db.prepare("SELECT count(*) AS n FROM message_search_keys").get() as { n: number }).n,
  fts: (db.prepare("SELECT count(*) AS n FROM messages_fts").get() as { n: number }).n,
});
const checkIntegrity = () => db.exec("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')");

test("every message has exactly one key and one FTS row addressed by that key", () => {
  store("m1", null, "hello world");
  emptyStore("m2");
  const one = keyOf("m1")!;
  const two = keyOf("m2")!;
  assert.deepEqual(ftsRow("m1"), { rowid: one.search_id, text: "hello world" });
  // Empty text is still indexed, exactly as before: the corpus and rank behaviour must not change.
  assert.deepEqual(ftsRow("m2"), { rowid: two.search_id, text: "" });
  assert.deepEqual(counts(), { messages: 2, keys: 2, fts: 2 });
  assert.equal(searchMessages("alice", "hello")[0]?.messageId, "m1");
  assert.match(searchMessages("alice", "hello")[0]!.snippet, /hello/);
  checkIntegrity();
});

test("metadata-only content changes and unchanged rows do not churn the inverted index", () => {
  store("m1", null, "alpha beta");
  const before = ftsRow("m1")!;
  // Same text parts, different JSON (another role): the trigger compares extracted text, not the blob.
  db.prepare("UPDATE messages SET content = ? WHERE thread_id = 't' AND id = 'm1'").run(JSON.stringify({ role: "user", parts: parts("alpha beta") }));
  assert.deepEqual(ftsRow("m1"), before);
  // Metadata-only append: content is identical, so the row is updated but the trigger fires no text work.
  store("m1", null, "alpha beta", "ai-sdk/v7");
  assert.equal((db.prepare("SELECT format FROM messages WHERE id = 'm1'").get() as { format: string }).format, "ai-sdk/v7");
  assert.deepEqual(ftsRow("m1"), before);
  // Real text change keeps the address and replaces the indexed text in place.
  store("m1", null, "alpha gamma", "ai-sdk/v7");
  assert.deepEqual(ftsRow("m1"), { rowid: before.rowid, text: "alpha gamma" });
  assert.equal(searchMessages("alice", "beta").length, 0);
  assert.equal(searchMessages("alice", "gamma")[0]?.messageId, "m1");
  checkIntegrity();
});

test("re-sending an identical message writes nothing and does not bump the chat's activity", () => {
  store("m1", null, "same words");
  db.prepare("UPDATE threads SET updated_at = 500 WHERE id = 't'").run();
  const before = counts();
  const result = store("m1", null, "same words");
  assert.deepEqual(result.content, { role: "assistant", parts: parts("same words") });
  assert.equal((db.prepare("SELECT updated_at FROM threads WHERE id = 't'").get() as { updated_at: number }).updated_at, 500);
  assert.deepEqual(counts(), before);
  assert.equal((db.prepare("SELECT rowid FROM messages_fts WHERE message_id = 'm1'").get() as { rowid: number }).rowid, keyOf("m1")!.search_id);
});

test("deleting a thread removes its keys and FTS rows; the index stays consistent after VACUUM", () => {
  store("m1", null, "first");
  store("m2", "m1", "second");
  const addresses = [keyOf("m1")!.search_id, keyOf("m2")!.search_id];
  checkIntegrity();
  db.exec("VACUUM");
  assert.deepEqual([keyOf("m1")!.search_id, keyOf("m2")!.search_id], addresses, "VACUUM must not renumber search keys");
  assert.equal(searchMessages("alice", "second").length, 1);
  checkIntegrity();
  deleteThread("alice", "t");
  assert.deepEqual(counts(), { messages: 0, keys: 0, fts: 0 });
  assert.deepEqual(searchMessages("alice", "first"), []);
  checkIntegrity();
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("deleting an account cascades through its threads, messages, keys, and FTS rows", () => {
  db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('bob', 'bob@example.test', 'Bob', 'unused', 'user', 1)").run();
  ensureThread("bob", "bob-chat");
  appendMessage("bob", "bob-chat", { id: "b1", parent_id: null, format: "ai-sdk/v6", content: { role: "user", parts: parts("bob words") } });
  assert.equal(searchMessages("bob", "bob").length, 1);
  db.prepare("DELETE FROM users WHERE id = 'bob'").run();
  assert.deepEqual(
    {
      threads: (db.prepare("SELECT count(*) AS n FROM threads WHERE id = 'bob-chat'").get() as { n: number }).n,
      keys: (db.prepare("SELECT count(*) AS n FROM message_search_keys WHERE thread_id = 'bob-chat'").get() as { n: number }).n,
      fts: (db.prepare("SELECT count(*) AS n FROM messages_fts WHERE thread_id = 'bob-chat'").get() as { n: number }).n,
    },
    { threads: 0, keys: 0, fts: 0 },
  );
  assert.deepEqual(searchMessages("bob", "bob"), []);
});

test("directories keep insert order for equal timestamps and the history query uses the new index", () => {
  const insert = db.prepare("INSERT INTO messages (id, thread_id, parent_id, format, content, created_at) VALUES (?, 't', NULL, 'ai-sdk/v6', ?, 100)");
  insert.run("mz", JSON.stringify({ role: "user", parts: parts("first inserted") }));
  insert.run("ma", JSON.stringify({ role: "assistant", parts: parts("second inserted") }));
  const rows = JSON.parse(listMessagesJson("alice", "t")) as Array<{ id: string }>;
  assert.deepEqual(rows.map((row) => row.id), ["mz", "ma"], "rowid breaks created_at ties, not the lexical id");
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id, parent_id, format, content FROM messages WHERE thread_id = 't' ORDER BY created_at, rowid").all() as Array<{ detail: string }>;
  assert.ok(plan.some((row) => row.detail.includes("messages_thread_time")), JSON.stringify(plan));
  assert.ok(!plan.some((row) => /TEMP B-TREE/i.test(row.detail)), JSON.stringify(plan));
});

test("cycle detection rejects direct and indirect cycles, tolerates stored cycles, and skips unchanged parents", () => {
  assert.throws(() => store("m1", "m1", "self"), /ancestor/);
  store("m1", null, "one");
  store("m2", "m1", "two");
  // Re-parenting the root under its child would close a loop.
  assert.throws(() => store("m1", "m2", "one"), /ancestor/);
  // A re-sent row with its stored parent needs no walk.
  assert.doesNotThrow(() => store("m2", "m1", "two"));
  // A cycle that already exists in the stored graph terminates the walk instead of looping forever.
  db.prepare("INSERT INTO messages (id, thread_id, parent_id, format, content, created_at) VALUES ('c1', 't', 'c2', 'ai-sdk/v6', ?, 200)").run(JSON.stringify({ role: "assistant", parts: parts("c1") }));
  db.prepare("INSERT INTO messages (id, thread_id, parent_id, format, content, created_at) VALUES ('c2', 't', 'c1', 'ai-sdk/v6', ?, 201)").run(JSON.stringify({ role: "assistant", parts: parts("c2") }));
  assert.doesNotThrow(() => store("c3", "c1", "three"));
});

const runWithDb = (directory: string, code: string) =>
  execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    env: { ...process.env, OKAYCHAT_DATA_DIR: directory, OKAYCHAT_SECRET: "search-index-migration-secret-not-for-production" },
    encoding: "utf8",
  });

test("the FTS addressing migration rebuilds a populated index, survives two reopens and VACUUM", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "okaychat-search-migration-"));
  const dbUrl = new URL("./db.ts", import.meta.url).href;
  try {
    // Phase 1: a populated database at the last pre-migration version, with the old trigger shape.
    const before = JSON.parse(runWithDb(directory, `
      const { db } = await import(${JSON.stringify(dbUrl)});
      db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u', 'u@example.test', 'U', 'x', 'user', 1)").run();
      db.prepare("INSERT INTO threads (id, user_id, created_at, updated_at) VALUES ('t', 'u', 1, 1)").run();
      const insert = db.prepare("INSERT INTO messages (id, thread_id, parent_id, format, content, created_at) VALUES (?, 't', ?, 'ai-sdk/v6', ?, ?)");
      insert.run('m1', null, JSON.stringify({ role: 'user', parts: [{ type: 'text', text: 'migration alpha' }] }), 1);
      insert.run('m2', 'm1', JSON.stringify({ role: 'assistant', parts: [{ type: 'text', text: 'migration beta' }] }), 2);
      db.exec("DROP TRIGGER messages_fts_insert; DROP TRIGGER messages_fts_update; DROP TRIGGER messages_fts_delete; DROP TABLE message_search_keys; DROP INDEX messages_thread_time; DELETE FROM messages_fts");
      db.exec("DROP TABLE IF EXISTS chatgpt_login_attempts; DROP TABLE IF EXISTS chatgpt_registrations; DROP TABLE IF EXISTS chatgpt_controls; DROP TABLE IF EXISTS chatgpt_hosts; DROP TABLE IF EXISTS n8n_agent_sessions; DROP TABLE IF EXISTS n8n_agent_runs; DROP TABLE IF EXISTS n8n_agents; DROP TABLE IF EXISTS permission_leases; DROP TABLE IF EXISTS permission_rate_windows; DROP TABLE IF EXISTS permission_audit; DROP TABLE IF EXISTS user_model_instructions; DROP TABLE IF EXISTS prompt_rules; DROP TABLE IF EXISTS permission_policies; DROP TABLE IF EXISTS permission_state; DROP TABLE IF EXISTS saved_prompts; DROP TABLE IF EXISTS message_bookmarks; DROP TABLE IF EXISTS message_feedback; DROP TABLE IF EXISTS assistant_presets; DROP TABLE IF EXISTS generation_segments; DROP TABLE IF EXISTS generation_runs; DROP TABLE IF EXISTS archive_jobs");
      db.exec("DROP TABLE IF EXISTS evaluation_scores; DROP TABLE IF EXISTS evaluation_results; DROP TABLE IF EXISTS evaluation_runs; DROP TABLE IF EXISTS evaluation_cases; DROP TABLE IF EXISTS evaluation_datasets");
      db.exec("DROP INDEX IF EXISTS user_groups_prompt_order; ALTER TABLE user_groups DROP COLUMN prompt_order; ALTER TABLE threads DROP COLUMN custom_instructions; ALTER TABLE threads DROP COLUMN instructions_revision; ALTER TABLE threads DROP COLUMN assistant_json; ALTER TABLE threads DROP COLUMN assistant_revision; ALTER TABLE threads DROP COLUMN imported_assistant_json; ALTER TABLE threads DROP COLUMN preferred_head; ALTER TABLE messages DROP COLUMN imported");
      for (const table of ['channel_messages_fts', 'channel_search_keys', 'channel_events', 'channel_event_state', 'channel_rate_windows', 'channel_moderation_audit', 'channel_create_keys', 'channel_ai_runs', 'channel_reactions', 'channel_mentions', 'channel_messages', 'channel_exclusions', 'channel_invites', 'channel_members', 'channel_groups', 'channels', 'notifications', 'tag_filter_presets', 'thread_tags', 'comparison_panes', 'comparison_groups', 'notes_fts', 'note_tags', 'notes', 'calendar_events_fts', 'calendar_reminders', 'calendar_events']) db.exec('DROP TABLE IF EXISTS ' + table);
      db.exec("DROP INDEX IF EXISTS usage_channel_run; ALTER TABLE usage DROP COLUMN channel_id; ALTER TABLE usage DROP COLUMN channel_run_id");
      for (const index of ['shares_user_time', 'shares_thread', 'shares_expiry', 'threads_compare']) db.exec('DROP INDEX IF EXISTS ' + index);
      db.exec('ALTER TABLE threads DROP COLUMN compare_group_id');
      db.exec("CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN INSERT INTO messages_fts (text, thread_id, message_id) VALUES ('', new.thread_id, new.id); END");
      db.exec("CREATE TRIGGER messages_fts_update AFTER UPDATE OF content ON messages BEGIN DELETE FROM messages_fts WHERE thread_id = old.thread_id AND message_id = old.id; INSERT INTO messages_fts (text, thread_id, message_id) VALUES ('', new.thread_id, new.id); END");
      db.exec("CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN DELETE FROM messages_fts WHERE thread_id = old.thread_id AND message_id = old.id; END");
      const fts = db.prepare("INSERT INTO messages_fts (text, thread_id, message_id) VALUES (?, ?, ?)");
      for (const row of db.prepare("SELECT id, thread_id, content FROM messages ORDER BY created_at").all()) {
        const body = JSON.parse(row.content);
        fts.run(body.parts.filter((p) => p.type === 'text').map((p) => p.text).join(' '), row.thread_id, row.id);
      }
      db.exec("PRAGMA user_version = 35");
      console.log(JSON.stringify({ version: db.prepare("PRAGMA user_version").get().user_version, fts: db.prepare("SELECT text FROM messages_fts ORDER BY rowid").all() }));
      db.close();
    `));

    const inspect = (directoryPath: string) => JSON.parse(runWithDb(directoryPath, `
      const { db } = await import(${JSON.stringify(dbUrl)});
      const state = {
        version: db.prepare("PRAGMA user_version").get().user_version,
        keys: db.prepare("SELECT search_id, thread_id, message_id FROM message_search_keys ORDER BY search_id").all(),
        fts: db.prepare("SELECT rowid, text, thread_id, message_id FROM messages_fts ORDER BY rowid").all(),
        hits: db.prepare("SELECT message_id FROM messages_fts WHERE messages_fts MATCH 'migration' ORDER BY rank").all().map((r) => r.message_id),
        foreignKeys: db.prepare("PRAGMA foreign_key_check").all(),
      };
      db.exec("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')");
      db.exec("VACUUM");
      state.afterVacuum = db.prepare("SELECT rowid, message_id FROM messages_fts ORDER BY rowid").all();
      // The rebuilt triggers address the migrated rows without a full scan.
      db.prepare("UPDATE messages SET content = ? WHERE id = 'm2'").run(JSON.stringify({ role: 'assistant', parts: [{ type: 'text', text: 'migration delta' }] }));
      state.updated = db.prepare("SELECT rowid, text FROM messages_fts WHERE message_id = 'm2'").get();
      state.updatedHits = db.prepare("SELECT message_id FROM messages_fts WHERE messages_fts MATCH 'delta'").all().map((r) => r.message_id);
      db.close();
      console.log(JSON.stringify(state));
    `));

    assert.equal(before.version, 35);
    assert.deepEqual(before.fts.map((row: { text: string }) => row.text), ["migration alpha", "migration beta"]);
    const migrated = inspect(directory);
    assert.ok(migrated.version >= 36);
    assert.deepEqual(migrated.keys, [
      { search_id: 1, thread_id: "t", message_id: "m1" },
      { search_id: 2, thread_id: "t", message_id: "m2" },
    ]);
    assert.deepEqual(migrated.fts, [
      { rowid: 1, text: "migration alpha", thread_id: "t", message_id: "m1" },
      { rowid: 2, text: "migration beta", thread_id: "t", message_id: "m2" },
    ]);
    assert.deepEqual(migrated.hits, ["m1", "m2"]);
    assert.deepEqual(migrated.afterVacuum, [
      { rowid: 1, message_id: "m1" },
      { rowid: 2, message_id: "m2" },
    ]);
    assert.deepEqual(migrated.updated, { rowid: 2, text: "migration delta" });
    assert.deepEqual(migrated.updatedHits, ["m2"]);
    assert.deepEqual(migrated.foreignKeys, []);
    // Second reopen: nothing reruns, and the mapping is still one-to-one after the update and VACUUM.
    const reopened = inspect(directory);
    assert.deepEqual(reopened.keys, migrated.keys);
    assert.deepEqual(reopened.fts, [
      { rowid: 1, text: "migration alpha", thread_id: "t", message_id: "m1" },
      { rowid: 2, text: "migration delta", thread_id: "t", message_id: "m2" },
    ]);
    assert.deepEqual(reopened.foreignKeys, []);
    assert.equal((db.prepare("SELECT count(*) AS n FROM message_search_keys WHERE thread_id = 't'").get() as { n: number }).n, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
