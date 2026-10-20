import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { env } from "./env.js";

export const db = new DatabaseSync(path.join(env.dataDir, "okaychat.db"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

/** SQL for the joined text parts of a stored UI message (`{ role, parts, metadata }`). */
const MESSAGE_TEXT = (row: string) =>
  `coalesce((SELECT group_concat(json_extract(p.value, '$.text'), ' ') FROM json_each(${row}.content, '$.parts') p WHERE json_extract(p.value, '$.type') = 'text'), '')`;

// Append-only. Each entry runs once, in order, tracked by user_version.
const migrations: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE user_settings (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    json TEXT NOT NULL
  );
  CREATE TABLE provider_connections (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider_id TEXT NOT NULL,
    api_key_enc TEXT,
    base_url TEXT,
    config_json TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, provider_id)
  );
  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT,
    status TEXT NOT NULL DEFAULT 'regular',
    model_ref TEXT,
    compaction_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX threads_user ON threads(user_id, updated_at DESC);
  CREATE TABLE messages (
    id TEXT NOT NULL,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    parent_id TEXT,
    format TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (thread_id, id)
  );
  CREATE TABLE usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    thread_id TEXT,
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX usage_user_time ON usage(user_id, created_at);
  CREATE TABLE mcp_servers (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    transport TEXT NOT NULL CHECK (transport IN ('http', 'sse', 'stdio')),
    config_enc TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    disabled_tools TEXT NOT NULL DEFAULT '[]',
    oauth_enc TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, name)
  );
  `,
  `
  CREATE TABLE artifacts (
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    version INTEGER NOT NULL,
    title TEXT NOT NULL,
    kind TEXT NOT NULL,
    language TEXT,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (thread_id, id, version)
  );
  `,
  `
  CREATE TABLE codex_auth (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    auth_enc TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE images (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    thread_id TEXT,
    prompt TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    created_at INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE schedules (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    thread_id TEXT,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    model_ref TEXT NOT NULL,
    spec_json TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    next_run_at INTEGER,
    last_run_at INTEGER,
    last_status TEXT,
    last_error TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX schedules_due ON schedules(enabled, next_run_at);
  `,
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    instructions TEXT NOT NULL DEFAULT '',
    default_model TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE project_files (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  ALTER TABLE threads ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
  CREATE INDEX threads_project ON threads(user_id, project_id, updated_at DESC);
  `,
  // Full-text search over the text parts of messages. Triggers keep it in sync with every writer.
  `
  CREATE VIRTUAL TABLE messages_fts USING fts5(text, thread_id UNINDEXED, message_id UNINDEXED, tokenize = 'unicode61 remove_diacritics 2');
  CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts (text, thread_id, message_id) VALUES (${MESSAGE_TEXT("new")}, new.thread_id, new.id);
  END;
  CREATE TRIGGER messages_fts_update AFTER UPDATE OF content ON messages BEGIN
    DELETE FROM messages_fts WHERE thread_id = old.thread_id AND message_id = old.id;
    INSERT INTO messages_fts (text, thread_id, message_id) VALUES (${MESSAGE_TEXT("new")}, new.thread_id, new.id);
  END;
  CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
    DELETE FROM messages_fts WHERE thread_id = old.thread_id AND message_id = old.id;
  END;
  INSERT INTO messages_fts (text, thread_id, message_id) SELECT ${MESSAGE_TEXT("messages")}, thread_id, id FROM messages;
  `,
  `
  CREATE TABLE shares (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL UNIQUE REFERENCES threads(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE shared_connections (
    provider_id TEXT PRIMARY KEY,
    api_key_enc TEXT,
    base_url TEXT,
    config_json TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE server_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE user_fonts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    family TEXT NOT NULL,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    data BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, family)
  );
  `,
  // Document artifacts keep their source text in `content` and the built file in `data`, so an edit can
  // rebuild the file instead of patching a binary. `uploads` holds an attached file until the model
  // imports it as an artifact.
  `
  ALTER TABLE artifacts ADD COLUMN data BLOB;
  ALTER TABLE artifacts ADD COLUMN size INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE uploads (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    data BLOB NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX uploads_user ON uploads(user_id, created_at DESC);
  `,
  `
  CREATE TABLE user_avatars (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    mime TEXT NOT NULL,
    data BLOB NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE memory_preferences (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 0,
    auto_save INTEGER NOT NULL DEFAULT 1,
    revision INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE memories (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope TEXT NOT NULL DEFAULT '',
    content_enc TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(user_id, scope, content_hash)
  );
  CREATE INDEX memories_user ON memories(user_id, scope, created_at);
  ALTER TABLE threads ADD COLUMN memory_disabled INTEGER NOT NULL DEFAULT 0;
  `,
];

const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
for (let i = current; i < migrations.length; i++) {
  db.exec("BEGIN");
  try {
    db.exec(migrations[i]!);
    db.exec(`PRAGMA user_version = ${i + 1}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function tx<T>(fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
