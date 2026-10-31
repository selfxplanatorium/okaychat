import path from "node:path";
import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { storeInlineAttachments } from "./attachment-storage.js";
import { resultPaths } from "./sandbox-paths.js";
import { env } from "./env.js";

export const db = new DatabaseSync(path.join(env.dataDir, "okaychat.db"));
// synchronous = NORMAL is the WAL setting SQLite recommends: commits skip an fsync each, and a crash cannot corrupt
// the database (a power loss can only drop the last commits).
db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

/** SQL for the joined text parts of a stored UI message (`{ role, parts, metadata }`). */
const MESSAGE_TEXT = (row: string) =>
  `coalesce((SELECT group_concat(json_extract(p.value, '$.text'), ' ') FROM json_each(${row}.content, '$.parts') p WHERE json_extract(p.value, '$.type') = 'text'), '')`;

// Append-only. Each entry runs once, in order, tracked by user_version.
const migrations: Array<string | (() => void)> = [
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
  // Per-user storage quota: an optional per-user byte limit (null = server default). Generated images
  // were the only user files not counted in a table, so they get a size column. sandbox_files keeps
  // run_code outputs after the sandbox container wipes its workspaces (docs/implementation/code-sandbox.md).
  `
  ALTER TABLE users ADD COLUMN storage_limit INTEGER;
  ALTER TABLE images ADD COLUMN size INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE sandbox_files (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    mime TEXT NOT NULL,
    data BLOB NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, thread_id, path)
  );
  `,
  // Agent Skills: per-account SKILL.md packages plus the remote sources they were installed from.
  `
  CREATE TABLE skill_preferences (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE skill_sources (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('github', 'raw')),
    url TEXT NOT NULL,
    branch TEXT,
    subpath TEXT,
    token_enc TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, name)
  );
  CREATE TABLE skills (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    body TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    origin TEXT NOT NULL DEFAULT 'manual',
    source_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (user_id, name)
  );
  CREATE INDEX skills_user ON skills(user_id, name);
  CREATE TABLE skill_files (
    skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    PRIMARY KEY (skill_id, name)
  );
  `,
  `
  ALTER TABLE uploads ADD COLUMN thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL;
  ALTER TABLE project_files ADD COLUMN upload_id TEXT REFERENCES uploads(id) ON DELETE SET NULL;
  CREATE INDEX project_files_upload ON project_files(upload_id);
  CREATE INDEX sandbox_files_user ON sandbox_files(user_id, created_at);
  `,
  // Materialize legacy inline files once, in the same transaction as this migration version.
  () => {
    for (const row of db.prepare(`SELECT m.content, m.thread_id, t.user_id FROM messages m
      JOIN threads t ON t.id = m.thread_id WHERE m.content LIKE '%data:%'`).iterate() as Iterable<{ content: string; thread_id: string; user_id: string }>) {
      let content: unknown;
      try { content = JSON.parse(row.content); } catch { continue; }
      storeInlineAttachments(db, row.user_id, row.thread_id, content);
    }
  },
  `ALTER TABLE threads ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;`,
  // Image APIs return JPEG and WebP too. Codex output and older rows are PNG.
  `ALTER TABLE images ADD COLUMN mime TEXT NOT NULL DEFAULT 'image/png';`,
  // A fork remembers its source chat for the "Branched from" link. No foreign key: deleting the source keeps the fork.
  `ALTER TABLE threads ADD COLUMN branched_from TEXT;`,
  // Memory v2 (docs/implementation/memory.md): a synthesized summary per scope, background extraction from idle
  // chats (cursor per thread), past-chat search, and a per-thread summary snapshot that keeps the prompt prefix stable.
  `
  ALTER TABLE memory_preferences ADD COLUMN chat_search INTEGER NOT NULL DEFAULT 1;
  CREATE TABLE memory_summaries (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope TEXT NOT NULL DEFAULT '',
    content_enc TEXT,
    fingerprint TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    attempted_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, scope)
  );
  ALTER TABLE threads ADD COLUMN memory_cursor TEXT;
  ALTER TABLE threads ADD COLUMN memory_scanned_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE threads ADD COLUMN memory_snapshot_enc TEXT;
  ALTER TABLE threads ADD COLUMN memory_snapshot_at INTEGER NOT NULL DEFAULT 0;
  `,
  // Message text counts toward the storage quota. Inline data URLs are charged as uploads instead.
  () => {
    db.exec("ALTER TABLE messages ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0");
    const update = db.prepare("UPDATE messages SET bytes = ? WHERE rowid = ?");
    for (const row of db.prepare("SELECT rowid, content FROM messages").iterate() as Iterable<{ rowid: number; content: string }>) {
      update.run(Buffer.byteLength(row.content.replace(/data:[^"]*/g, "")), row.rowid);
    }
  },
  // Preserve admin overrides when renaming the temporary-chat prompt.
  `
  INSERT OR IGNORE INTO server_settings (key, value)
    SELECT 'prompt:temporary', value FROM server_settings WHERE key = 'prompt:anonymous';
  DELETE FROM server_settings WHERE key = 'prompt:anonymous';
  `,
  // Admins share MCP servers with every user. Each viewer keeps their own switch, tool toggles, and OAuth tokens.
  `
  ALTER TABLE mcp_servers ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE mcp_server_users (
    server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 1,
    disabled_tools TEXT NOT NULL DEFAULT '[]',
    oauth_enc TEXT,
    PRIMARY KEY (server_id, user_id)
  );
  `,
  // The memory/skills context sent beside each user message, replayed verbatim in later turns so the
  // conversation prefix stays byte-identical for provider caches. Memory text is encrypted and dropped
  // when the account's memory revision changes.
  `
  CREATE TABLE turn_context (
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    memory_enc TEXT,
    memory_revision INTEGER NOT NULL DEFAULT 0,
    skills TEXT,
    PRIMARY KEY (thread_id, message_id)
  );
  CREATE INDEX turn_context_user ON turn_context(user_id);
  `,
  // The date moved from the system prompt into each turn's context, so midnight no longer invalidates a chat.
  `ALTER TABLE turn_context ADD COLUMN date TEXT;`,
  // Admin-defined user groups, and who may use a shared provider connection or MCP server. A resource without
  // a share_audiences row is shared with everyone; with one, only with the listed users and groups.
  `
  CREATE TABLE user_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE user_group_members (
    group_id TEXT NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, user_id)
  );
  CREATE INDEX user_group_members_user ON user_group_members(user_id);
  CREATE TABLE share_audiences (
    kind TEXT NOT NULL CHECK (kind IN ('provider', 'mcp')),
    resource_id TEXT NOT NULL,
    PRIMARY KEY (kind, resource_id)
  );
  CREATE TABLE share_users (
    kind TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (kind, resource_id, user_id),
    FOREIGN KEY (kind, resource_id) REFERENCES share_audiences(kind, resource_id) ON DELETE CASCADE
  );
  CREATE TABLE share_groups (
    kind TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    group_id TEXT NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
    PRIMARY KEY (kind, resource_id, group_id),
    FOREIGN KEY (kind, resource_id) REFERENCES share_audiences(kind, resource_id) ON DELETE CASCADE
  );
  `,
  // thread_mode 'new' starts a chat per run. thread_attached marks a chat the user picked, which the schedule never recreates.
  `
  ALTER TABLE schedules ADD COLUMN thread_mode TEXT NOT NULL DEFAULT 'same';
  ALTER TABLE schedules ADD COLUMN thread_attached INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE schedules ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
  `,
  // Package installs (pip --user, uv, npm) used to land in the workspace HOME and were stored as outputs.
  () => {
    const rows = db.prepare("SELECT id, thread_id, path FROM sandbox_files").all() as Array<{ id: string; thread_id: string; path: string }>;
    const byThread = new Map<string, typeof rows>();
    for (const row of rows) byThread.set(row.thread_id, [...(byThread.get(row.thread_id) ?? []), row]);
    const drop = db.prepare("DELETE FROM sandbox_files WHERE id = ?");
    for (const list of byThread.values()) {
      const keep = resultPaths(list.map((r) => r.path));
      for (const row of list) if (!keep.has(row.path)) drop.run(row.id);
    }
  },
  // Recordings kept for an admin-set retention period (encrypted, purged by speech/retention.ts). Off by default.
  `
  CREATE TABLE speech_recordings (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    engine TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    audio_enc BLOB NOT NULL,
    transcript_enc TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX speech_recordings_created ON speech_recordings(created_at);
  CREATE INDEX speech_recordings_user ON speech_recordings(user_id);
  `,
  // Per-audience model access on a shared provider connection. A missing policy row means every model,
  // which keeps every legacy audience and connection on the old behaviour. Targets are the same audience
  // entries as share_users/share_groups, plus "everyone" when the connection has no share_audiences row.
  // Deleting the connection clears its policies through the foreign key and clearAudience().
  `
  CREATE TABLE provider_model_policies (
    provider_id TEXT NOT NULL REFERENCES shared_connections(provider_id) ON DELETE CASCADE,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('everyone', 'user', 'group')),
    target_id TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL CHECK (mode IN ('all', 'selected')),
    PRIMARY KEY (provider_id, target_kind, target_id)
  );
  CREATE TABLE provider_model_grants (
    provider_id TEXT NOT NULL,
    target_kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    PRIMARY KEY (provider_id, target_kind, target_id, model_id),
    FOREIGN KEY (provider_id, target_kind, target_id)
      REFERENCES provider_model_policies(provider_id, target_kind, target_id) ON DELETE CASCADE
  );
  `,
  // Email accounts (IMAP read, SMTP send). Server endpoints and the password are AES-256-GCM
  // encrypted. The password is separate so a host/username change can be refused unless the user
  // re-enters it, rather than sending a stored secret to a new destination.
  `
  CREATE TABLE email_accounts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    address TEXT NOT NULL,
    imap_enc TEXT NOT NULL,
    smtp_enc TEXT NOT NULL,
    password_enc TEXT NOT NULL,
    security_json TEXT NOT NULL DEFAULT '{}',
    read_enabled INTEGER NOT NULL DEFAULT 1,
    send_enabled INTEGER NOT NULL DEFAULT 1,
    is_default INTEGER NOT NULL DEFAULT 0,
    signature TEXT NOT NULL DEFAULT '',
    last_check_at INTEGER,
    last_check_status TEXT CHECK (last_check_status IN ('ok', 'failed')),
    last_check_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (user_id, address)
  );
  CREATE INDEX email_accounts_user ON email_accounts(user_id, is_default DESC, created_at);
  CREATE UNIQUE INDEX email_accounts_one_default ON email_accounts(user_id) WHERE is_default = 1;
  `,
  // Knowledge base (docs/implementation/knowledge.md): account collections, sources with original bytes
  // in `uploads` plus extracted text here, deterministic chunks with normalized float32 embeddings, and
  // an FTS5 index kept in sync by triggers. `generation` invalidates writes from a superseded job (retry,
  // reindex, delete), and `vectors_revision` invalidates the bounded retrieval cache.
  `
  CREATE TABLE knowledge_collections (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    embedding_provider TEXT NOT NULL DEFAULT 'none',
    embedding_provider_id TEXT,
    embedding_model TEXT,
    embedding_dim INTEGER,
    status TEXT NOT NULL DEFAULT 'empty',
    vectors_revision INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (user_id, name)
  );
  CREATE INDEX knowledge_collections_user ON knowledge_collections(user_id, updated_at DESC);

  CREATE TABLE knowledge_sources (
    id TEXT PRIMARY KEY,
    collection_id TEXT NOT NULL REFERENCES knowledge_collections(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    upload_id TEXT REFERENCES uploads(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('file', 'paste', 'url')),
    url TEXT,
    mime TEXT NOT NULL DEFAULT 'text/plain',
    bytes INTEGER NOT NULL DEFAULT 0,
    text_bytes INTEGER NOT NULL DEFAULT 0,
    text TEXT,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'extracting', 'embedding', 'ready', 'failed', 'cancelled')),
    progress REAL NOT NULL DEFAULT 0,
    error TEXT,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    generation INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX knowledge_sources_collection ON knowledge_sources(collection_id, created_at);
  CREATE INDEX knowledge_sources_user ON knowledge_sources(user_id, status);

  CREATE TABLE knowledge_chunks (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
    collection_id TEXT NOT NULL REFERENCES knowledge_collections(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    start INTEGER NOT NULL,
    "end" INTEGER NOT NULL,
    text TEXT NOT NULL,
    tokens INTEGER NOT NULL,
    embedding BLOB,
    embedding_dim INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE (source_id, ordinal)
  );
  CREATE INDEX knowledge_chunks_collection ON knowledge_chunks(collection_id, ordinal);
  CREATE INDEX knowledge_chunks_user ON knowledge_chunks(user_id);

  CREATE VIRTUAL TABLE knowledge_chunks_fts USING fts5(
    text, chunk_id UNINDEXED, source_id UNINDEXED, collection_id UNINDEXED, user_id UNINDEXED,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER knowledge_chunks_fts_insert AFTER INSERT ON knowledge_chunks BEGIN
    INSERT INTO knowledge_chunks_fts (rowid, text, chunk_id, source_id, collection_id, user_id)
    VALUES (new.rowid, new.text, new.id, new.source_id, new.collection_id, new.user_id);
  END;
  CREATE TRIGGER knowledge_chunks_fts_update AFTER UPDATE OF text ON knowledge_chunks BEGIN
    DELETE FROM knowledge_chunks_fts WHERE rowid = old.rowid;
    INSERT INTO knowledge_chunks_fts (rowid, text, chunk_id, source_id, collection_id, user_id)
    VALUES (new.rowid, new.text, new.id, new.source_id, new.collection_id, new.user_id);
  END;
  CREATE TRIGGER knowledge_chunks_fts_delete AFTER DELETE ON knowledge_chunks BEGIN
    DELETE FROM knowledge_chunks_fts WHERE rowid = old.rowid;
  END;

  ALTER TABLE threads ADD COLUMN knowledge_ids TEXT;
  ALTER TABLE turn_context ADD COLUMN knowledge TEXT;
  ALTER TABLE turn_context ADD COLUMN knowledge_ids TEXT;
  `,
  // Editable email drafts (src/server/email/drafts.ts). Owned by a user and a chat; ids repeat across
  // a branch's copy, so the key is per thread like messages. `revision` is the compare-and-set token
  // for every content write. `account_id` has no foreign key on purpose: a removed account must stay
  // visible so edits and sends can be refused until the user picks another one. The review columns
  // hold one single-use confirmation: a hashed token bound to a revision and a payload hash.
  `
  CREATE TABLE email_drafts (
    id TEXT NOT NULL,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id TEXT,
    tool_call_id TEXT,
    account_id TEXT,
    to_json TEXT NOT NULL DEFAULT '[]',
    cc_json TEXT NOT NULL DEFAULT '[]',
    bcc_json TEXT NOT NULL DEFAULT '[]',
    subject TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    in_reply_to TEXT,
    revision INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sending', 'sent')),
    updated_by TEXT NOT NULL DEFAULT 'model' CHECK (updated_by IN ('user', 'model')),
    sending_at INTEGER,
    sending_from TEXT,
    sent_at INTEGER,
    send_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    review_hash TEXT,
    review_revision INTEGER,
    review_payload TEXT,
    review_expires INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (thread_id, id)
  );
  CREATE INDEX email_drafts_user ON email_drafts(user_id, thread_id);
  `,
];

const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
for (let i = current; i < migrations.length; i++) {
  db.exec("BEGIN");
  try {
    const migration = migrations[i]!;
    if (typeof migration === "string") db.exec(migration);
    else migration();
    db.exec(`PRAGMA user_version = ${i + 1}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// Legacy generated images predate size accounting. Backfill once; missing files own zero bytes.
for (const row of db.prepare("SELECT id, user_id FROM images WHERE size = 0").all() as Array<{ id: string; user_id: string }>) {
  try {
    const size = statSync(path.join(env.dataDir, "images", row.user_id, `${row.id}.png`)).size;
    db.prepare("UPDATE images SET size = ? WHERE id = ? AND user_id = ?").run(size, row.id, row.user_id);
  } catch { /* A missing legacy file has no bytes to count. */ }
}

let transactionId = 0;
export function tx<T>(fn: () => T): T {
  const name = `tx_${++transactionId}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    throw error;
  }
}
