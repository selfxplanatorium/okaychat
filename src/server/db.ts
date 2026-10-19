import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { env } from "./env.js";

export const db = new DatabaseSync(path.join(env.dataDir, "okaychat.db"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

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
