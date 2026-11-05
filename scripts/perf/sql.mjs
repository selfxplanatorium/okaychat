// SQL microbenchmarks for the performance pass (docs/implementation/performance.md).
// Synthetic only: it never imports app modules and never opens the app database. Run with `npm run perf:sql`.
// Node's SQLite is synchronous and in-memory for the query cases, so timings are local CPU, not HTTP latency.
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const median = (samples) => samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)];
/** Warms the statement twice, then reports the median of `count` samples. */
function measure(fn, count = 11) {
  for (let i = 0; i < 2; i++) fn();
  const samples = [];
  for (let i = 0; i < count; i++) {
    const started = performance.now();
    fn();
    samples.push(performance.now() - started);
  }
  return median(samples);
}

const CONTENT = JSON.stringify({ role: "assistant", parts: [{ type: "text", text: "common benchmark text " + "x".repeat(1000) }] });
const OTHER_CONTENT = JSON.stringify({ role: "assistant", parts: [{ type: "text", text: "changed benchmark text " + "y".repeat(1000) }] });
const textOf = (row) =>
  `coalesce((SELECT group_concat(json_extract(p.value, '$.text'), ' ') FROM json_each(${row}.content, '$.parts') p WHERE json_extract(p.value, '$.type') = 'text'), '')`;

const SCHEMA = `
  CREATE TABLE messages (
    id TEXT NOT NULL, thread_id TEXT NOT NULL, parent_id TEXT, format TEXT, content TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY (thread_id, id)
  );
  CREATE VIRTUAL TABLE messages_fts USING fts5(text, thread_id UNINDEXED, message_id UNINDEXED, tokenize = 'unicode61 remove_diacritics 2');
`;

const OLD_TRIGGERS = `
  CREATE TRIGGER messages_fts_update AFTER UPDATE OF content ON messages BEGIN
    DELETE FROM messages_fts WHERE thread_id = old.thread_id AND message_id = old.id;
    INSERT INTO messages_fts (text, thread_id, message_id) VALUES (${textOf("new")}, new.thread_id, new.id);
  END;
`;

const NEW_TRIGGERS = `
  CREATE TRIGGER messages_fts_update AFTER UPDATE OF content ON messages
  WHEN old.content IS NOT new.content AND ${textOf("old")} IS NOT ${textOf("new")}
  BEGIN
    DELETE FROM messages_fts WHERE rowid = (SELECT search_id FROM message_search_keys WHERE thread_id = old.thread_id AND message_id = old.id);
    INSERT INTO messages_fts (rowid, text, thread_id, message_id)
      SELECT k.search_id, ${textOf("new")}, new.thread_id, new.id FROM message_search_keys k
      WHERE k.thread_id = new.thread_id AND k.message_id = new.id;
  END;
`;

const fts = [];
const history = [];
for (const size of [1_000, 10_000, 50_000]) {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  const insert = db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)");
  const insertFts = db.prepare("INSERT INTO messages_fts (text, thread_id, message_id) VALUES (?, ?, ?)");
  db.exec("BEGIN");
  for (let i = 0; i < size; i++) {
    const thread = `t${Math.floor(i / 1_000)}`;
    insert.run(`m${i}`, thread, i % 1_000 ? `m${i - 1}` : null, "ai-sdk/v6", CONTENT, i);
    insertFts.run("common benchmark text", thread, `m${i}`);
  }
  db.exec("COMMIT");

  const update = db.prepare("UPDATE messages SET content = ? WHERE thread_id = ? AND id = ?");
  db.exec(OLD_TRIGGERS);
  const oldScanMs = measure(() => update.run(CONTENT, "t0", "m500"), 23);

  // Rebuild in the new shape: stable keys addressed by the FTS rowid.
  db.exec("DROP TRIGGER messages_fts_update");
  db.exec(`CREATE TABLE message_search_keys (
    search_id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, message_id TEXT NOT NULL,
    UNIQUE(thread_id, message_id), FOREIGN KEY(thread_id, message_id) REFERENCES messages(thread_id, id) ON DELETE CASCADE)`);
  db.exec("INSERT INTO message_search_keys (thread_id, message_id) SELECT thread_id, id FROM messages ORDER BY thread_id, created_at, id");
  db.exec("DELETE FROM messages_fts");
  db.exec(`INSERT INTO messages_fts (rowid, text, thread_id, message_id)
    SELECT k.search_id, ${textOf("m")}, m.thread_id, m.id FROM messages m
    JOIN message_search_keys k ON k.thread_id = m.thread_id AND k.message_id = m.id ORDER BY k.search_id`);
  db.exec(NEW_TRIGGERS);
  const keyLookup = db.prepare("SELECT search_id FROM message_search_keys WHERE thread_id = ? AND message_id = ?");
  const keyLookupMs = measure(() => keyLookup.get("t0", "m500"), 23);
  const newNoOpMs = measure(() => update.run(CONTENT, "t0", "m500"), 23);
  let flip = false;
  const newChangedMs = measure(() => {
    flip = !flip;
    update.run(flip ? OTHER_CONTENT : CONTENT, "t0", "m500");
  }, 15);
  const deleteOld = db.prepare("DELETE FROM messages_fts WHERE thread_id = ? AND message_id = ?");
  const deleteNew = db.prepare("DELETE FROM messages_fts WHERE rowid = ?");
  const reinsertOld = db.prepare("INSERT INTO messages_fts (text, thread_id, message_id) VALUES ('common benchmark text', ?, ?)");
  const reinsertNew = db.prepare("INSERT INTO messages_fts (rowid, text, thread_id, message_id) VALUES (?, 'common benchmark text', ?, ?)");
  const oldDeleteMs = measure(() => {
    deleteOld.run("t0", "m500");
    reinsertOld.run("t0", "m500");
  }, 23);
  const newDeleteMs = measure(() => {
    const key = keyLookup.get("t0", "m500").search_id;
    deleteNew.run(key);
    reinsertNew.run(key, "t0", "m500");
  }, 23);

  // History: the same query the API uses, with and without (thread_id, created_at).
  const historySql = "SELECT id, parent_id, format, content FROM messages WHERE thread_id = ? ORDER BY created_at, rowid";
  const beforeQuery = db.prepare(historySql);
  const beforeIndex = measure(() => beforeQuery.all("t0"), 15);
  const rows = beforeQuery.all("t0");
  const spliceMs = measure(
    () => `[${rows.map((r) => `{"id":${JSON.stringify(r.id)},"content":${r.content}}`).join(",")}]`,
    15,
  );
  const planBefore = db.prepare(`EXPLAIN QUERY PLAN ${historySql}`).all("t0").map((r) => r.detail);
  db.exec("CREATE INDEX messages_thread_time ON messages(thread_id, created_at)");
  const afterQuery = db.prepare(historySql);
  const afterIndex = measure(() => afterQuery.all("t0"), 15);
  const planAfter = db.prepare(`EXPLAIN QUERY PLAN ${historySql}`).all("t0").map((r) => r.detail);

  fts.push({
    messages: size,
    oldIdenticalUpdateMs: oldScanMs,
    newIdenticalUpdateMs: newNoOpMs,
    newChangedUpdateMs: newChangedMs,
    keyLookupMs,
    oldFtsLookupPlan: db.prepare("EXPLAIN QUERY PLAN SELECT rowid FROM messages_fts WHERE thread_id = ? AND message_id = ?").all("t0", "m500").map((r) => r.detail),
    newFtsLookupPlan: db.prepare("EXPLAIN QUERY PLAN SELECT rowid FROM messages_fts WHERE rowid = ?").all(1).map((r) => r.detail),
    oldDeleteMs,
    newDeleteMs,
  });
  history.push({ messages: size, rows: rows.length, beforeIndexMs: beforeIndex, afterIndexMs: afterIndex, spliceMs, planBefore, planAfter });
  db.close();
}

const ancestry = [];
for (const depth of [10, 100, 1_000, 10_000]) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE messages (id TEXT NOT NULL, thread_id TEXT NOT NULL, parent_id TEXT, PRIMARY KEY (thread_id, id))");
  db.exec("BEGIN");
  const insert = db.prepare("INSERT INTO messages VALUES (?, ?, ?)");
  for (let i = 0; i < depth; i++) insert.run(`m${i}`, "t", i ? `m${i - 1}` : null);
  db.exec("COMMIT");
  const parent = db.prepare("SELECT parent_id FROM messages WHERE thread_id = ? AND id = ?");
  const loop = () => {
    const seen = new Set();
    for (let current = `m${depth - 1}`; current !== null && !seen.has(current); ) {
      if (current === "new") return true;
      seen.add(current);
      current = parent.get("t", current)?.parent_id ?? null;
    }
    return false;
  };
  const cte = db.prepare(`WITH RECURSIVE chain(id, parent_id) AS (
      SELECT id, parent_id FROM messages WHERE thread_id = ? AND id = ?
      UNION
      SELECT m.id, m.parent_id FROM messages m JOIN chain c ON m.thread_id = ? AND m.id = c.parent_id
    ) SELECT 1 AS found FROM chain WHERE id = ? LIMIT 1`);
  const walk = () => cte.get("t", `m${depth - 1}`, "t", "new") !== undefined;
  ancestry.push({ depth, preparedGetLoopMs: measure(loop, 15), recursiveCteMs: measure(walk, 15) });
  db.close();
}

// Migration rebuild cost on a file-backed WAL database, as the app stores it.
const rebuild = [];
const directory = mkdtempSync(path.join(os.tmpdir(), "okaychat-perf-sql-"));
try {
  for (const size of [50_000, 200_000]) {
    const file = path.join(directory, `rebuild-${size}.db`);
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    db.exec(SCHEMA);
    const insert = db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)");
    const insertFts = db.prepare("INSERT INTO messages_fts (text, thread_id, message_id) VALUES (?, ?, ?)");
    db.exec("BEGIN");
    for (let i = 0; i < size; i++) {
      const thread = `t${Math.floor(i / 1_000)}`;
      insert.run(`m${i}`, thread, null, "ai-sdk/v6", CONTENT, i);
      insertFts.run("common benchmark text", thread, `m${i}`);
    }
    db.exec("COMMIT");
    const started = performance.now();
    db.exec("BEGIN");
    db.exec(`CREATE TABLE message_search_keys (
      search_id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, message_id TEXT NOT NULL,
      UNIQUE(thread_id, message_id), FOREIGN KEY(thread_id, message_id) REFERENCES messages(thread_id, id) ON DELETE CASCADE)`);
    db.exec("INSERT INTO message_search_keys (thread_id, message_id) SELECT thread_id, id FROM messages ORDER BY thread_id, created_at, id");
    db.exec("DELETE FROM messages_fts");
    db.exec(`INSERT INTO messages_fts (rowid, text, thread_id, message_id)
      SELECT k.search_id, ${textOf("m")}, m.thread_id, m.id FROM messages m
      JOIN message_search_keys k ON k.thread_id = m.thread_id AND k.message_id = m.id ORDER BY k.search_id`);
    db.exec("COMMIT");
    const rebuildMs = performance.now() - started;
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    rebuild.push({ messages: size, rebuildMs, fileBytes: statSync(file).size });
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, fts, history, ancestry, rebuild }, null, 2));
