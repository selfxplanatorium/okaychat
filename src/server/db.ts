import path from "node:path";
import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { storeInlineAttachments } from "./attachment-storage.js";
import { resultPaths } from "./sandbox-paths.js";
import { env } from "./env.js";
import { newId } from "./crypto.js";

export const db = new DatabaseSync(path.join(env.dataDir, "okaychat.db"));
// FULL makes rotating-token sending markers durable; WAL still permits concurrent readers.
db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

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
  // User edits of assistant replies: when the text was last edited, and the first original text parts,
  // encrypted, so Undo can restore them. Both stay NULL for messages that were never edited.
  `
  ALTER TABLE messages ADD COLUMN edited_at INTEGER;
  ALTER TABLE messages ADD COLUMN original_enc TEXT;
  `,
  // Writing drafts reuse the owned, revision-checked draft lifecycle without mail actions.
  `ALTER TABLE email_drafts ADD COLUMN kind TEXT NOT NULL DEFAULT 'email' CHECK (kind IN ('email', 'text'));`,
  // Raster originals move out of SQLite into files (docs/implementation/media.md). `media` holds metadata and
  // the digest; uploads, sandbox outputs, and avatars point at it. Their old BLOBs are moved by a resumable
  // background job (media/maintenance.ts), which leaves `data` as an empty BLOB. `media_id` has no foreign key so
  // the column stays droppable; lifetime is managed by releaseMedia and GC. `image_threads` lets a fork keep
  // a generated image alive after its source chat is deleted.
  `
  CREATE TABLE media (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sha256 TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX media_user_digest ON media(user_id, sha256);
  ALTER TABLE uploads ADD COLUMN media_id TEXT;
  ALTER TABLE sandbox_files ADD COLUMN media_id TEXT;
  ALTER TABLE user_avatars ADD COLUMN media_id TEXT;
  CREATE INDEX uploads_media ON uploads(media_id) WHERE media_id IS NOT NULL;
  CREATE INDEX sandbox_files_media ON sandbox_files(media_id) WHERE media_id IS NOT NULL;
  CREATE TABLE image_threads (
    image_id TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    PRIMARY KEY (image_id, thread_id)
  );
  CREATE INDEX image_threads_thread ON image_threads(thread_id);
  INSERT OR IGNORE INTO image_threads (image_id, thread_id)
    SELECT i.id, i.thread_id FROM images i JOIN threads t ON t.id = i.thread_id AND t.user_id = i.user_id;
  `,
  // FTS addressing (docs/implementation/performance.md). The old triggers located a message's FTS row by
  // scanning the two UNINDEXED metadata columns, making every UPDATE and DELETE corpus-linear. A stable
  // integer key addresses the FTS rowid directly. The key has an explicit AUTOINCREMENT primary key, so
  // VACUUM cannot renumber it, unlike messages.rowid under a composite TEXT primary key. The FTS table
  // keeps its shape, tokenizer, and columns, so ranking and snippets are unchanged.
  `
  DROP TRIGGER IF EXISTS messages_fts_insert;
  DROP TRIGGER IF EXISTS messages_fts_update;
  DROP TRIGGER IF EXISTS messages_fts_delete;
  CREATE TABLE message_search_keys (
    search_id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    UNIQUE(thread_id, message_id),
    FOREIGN KEY(thread_id, message_id) REFERENCES messages(thread_id, id) ON DELETE CASCADE
  );
  INSERT INTO message_search_keys (thread_id, message_id)
    SELECT thread_id, id FROM messages ORDER BY thread_id, created_at, id;
  DELETE FROM messages_fts;
  INSERT INTO messages_fts (rowid, text, thread_id, message_id)
    SELECT k.search_id, ${MESSAGE_TEXT("m")}, m.thread_id, m.id
    FROM messages m JOIN message_search_keys k ON k.thread_id = m.thread_id AND k.message_id = m.id
    ORDER BY k.search_id;
  CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO message_search_keys (thread_id, message_id) VALUES (new.thread_id, new.id);
    INSERT INTO messages_fts (rowid, text, thread_id, message_id)
      VALUES ((SELECT search_id FROM message_search_keys WHERE thread_id = new.thread_id AND message_id = new.id), ${MESSAGE_TEXT("new")}, new.thread_id, new.id);
  END;
  CREATE TRIGGER messages_fts_update AFTER UPDATE OF content ON messages
  WHEN old.content IS NOT new.content AND ${MESSAGE_TEXT("old")} IS NOT ${MESSAGE_TEXT("new")}
  BEGIN
    DELETE FROM messages_fts WHERE rowid = (SELECT search_id FROM message_search_keys WHERE thread_id = old.thread_id AND message_id = old.id);
    INSERT INTO messages_fts (rowid, text, thread_id, message_id)
      SELECT k.search_id, ${MESSAGE_TEXT("new")}, new.thread_id, new.id
      FROM message_search_keys k WHERE k.thread_id = new.thread_id AND k.message_id = new.id;
  END;
  CREATE TRIGGER messages_fts_delete BEFORE DELETE ON messages BEGIN
    DELETE FROM messages_fts WHERE rowid = (SELECT search_id FROM message_search_keys WHERE thread_id = old.thread_id AND message_id = old.id);
    DELETE FROM message_search_keys WHERE thread_id = old.thread_id AND message_id = old.id;
  END;
  `,
  // History reads order by (created_at,rowid) for every thread; the composite primary key cannot serve that
  // order, so SQLite sorted each thread's rows in a temporary B-tree.
  `CREATE INDEX messages_thread_time ON messages(thread_id, created_at);`,
  // Sign in with ChatGPT for chat (docs/implementation/codex-chat.md), independent of codex_auth (images).
  // One host id per user, saved registrations (one active), session-bound login attempts, and a durable
  // control revision that disconnects and new attempts bump. Old personal chatgpt rows keep only their
  // switch; a shared chatgpt row was never usable and is removed with its audience.
  `
  CREATE TABLE chatgpt_hosts (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    host_id TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE chatgpt_registrations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    identity_enc TEXT NOT NULL,
    credentials_enc TEXT,
    state TEXT NOT NULL CHECK (state IN ('ready', 'plan_disabled', 'reconnect_required', 'disconnected')),
    active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
    generation INTEGER NOT NULL DEFAULT 1,
    token_version INTEGER NOT NULL DEFAULT 0,
    refresh_state TEXT NOT NULL DEFAULT 'idle' CHECK (refresh_state IN ('idle', 'sending', 'uncertain')),
    access_expires_at INTEGER,
    connected_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_error_code TEXT,
    welcome_seen_at INTEGER,
    UNIQUE (user_id, client_id)
  );
  CREATE UNIQUE INDEX chatgpt_one_active ON chatgpt_registrations(user_id) WHERE active = 1;
  CREATE TABLE chatgpt_login_attempts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
    registration_id TEXT REFERENCES chatgpt_registrations(id) ON DELETE CASCADE,
    state_hash TEXT NOT NULL UNIQUE,
    secrets_enc TEXT,
    helper_cap_hash TEXT NOT NULL UNIQUE,
    helper_bound_hash TEXT,
    redirect_uri TEXT,
    status TEXT NOT NULL CHECK (status IN ('preparing', 'waiting', 'exchanging', 'succeeded', 'failed', 'cancelled')),
    intent TEXT NOT NULL DEFAULT 'connect',
    expected_generation INTEGER,
    connection_revision INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    error_code TEXT
  );
  CREATE INDEX chatgpt_attempts_user ON chatgpt_login_attempts(user_id, status, expires_at);
  CREATE TABLE chatgpt_controls (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 0
  );
  UPDATE provider_connections SET api_key_enc = NULL, base_url = NULL, config_json = '{}' WHERE provider_id = 'chatgpt';
  DELETE FROM provider_model_policies WHERE provider_id = 'chatgpt';
  DELETE FROM shared_connections WHERE provider_id = 'chatgpt';
  DELETE FROM share_audiences WHERE kind = 'provider' AND resource_id = 'chatgpt';
  `,
  // n8n webhook agents (docs/implementation/n8n-agents.md): encrypted definitions, per-thread remote sessions,
  // and run counters without bodies. Shared agents use the audience tables, whose kind CHECK only SQLite's
  // table rebuild can widen: copy into new tables, drop the old children before their parent, then rename
  // (SQLite rewrites the children's foreign keys to the renamed parent).
  () => {
    db.exec(`
    CREATE TABLE n8n_agents (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      shared INTEGER NOT NULL DEFAULT 0 CHECK (shared IN (0, 1)),
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      avatar TEXT NOT NULL DEFAULT 'workflow',
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      config_enc TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX n8n_agents_owner ON n8n_agents(owner_id, shared);
    CREATE INDEX n8n_agents_shared ON n8n_agents(shared, enabled);
    CREATE TABLE n8n_agent_sessions (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES n8n_agents(id) ON DELETE CASCADE,
      agent_revision INTEGER NOT NULL,
      session_enc TEXT NOT NULL,
      history_hash TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, thread_id, agent_id)
    );
    CREATE TABLE n8n_agent_runs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
      agent_id TEXT, -- no foreign key: usage counters survive deleting the agent
      status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'aborted')),
      duration_ms INTEGER NOT NULL,
      input_bytes INTEGER NOT NULL,
      output_bytes INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX n8n_agent_runs_user_time ON n8n_agent_runs(user_id, created_at);
    -- A migration-test rewind can leave a later shared-knowledge trigger behind; it references the table
    -- this block rebuilds, so drop it before touching the audience tables.
    DROP TRIGGER IF EXISTS knowledge_audience_cleanup;
    CREATE TABLE share_audiences_new (
      kind TEXT NOT NULL CHECK (kind IN ('provider', 'mcp', 'n8n')),
      resource_id TEXT NOT NULL,
      PRIMARY KEY (kind, resource_id)
    );
    CREATE TABLE share_users_new (
      kind TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (kind, resource_id, user_id),
      FOREIGN KEY (kind, resource_id) REFERENCES share_audiences_new(kind, resource_id) ON DELETE CASCADE
    );
    CREATE TABLE share_groups_new (
      kind TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      group_id TEXT NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
      PRIMARY KEY (kind, resource_id, group_id),
      FOREIGN KEY (kind, resource_id) REFERENCES share_audiences_new(kind, resource_id) ON DELETE CASCADE
    );
    INSERT INTO share_audiences_new (kind, resource_id) SELECT kind, resource_id FROM share_audiences;
    INSERT INTO share_users_new (kind, resource_id, user_id) SELECT kind, resource_id, user_id FROM share_users;
    INSERT INTO share_groups_new (kind, resource_id, group_id) SELECT kind, resource_id, group_id FROM share_groups;
    `);
    // Test seam: proves a failure midway rolls back every table above together with the version.
    if (process.env.OKAYCHAT_TEST_FAIL_MIGRATION === "n8n-agents") throw new Error("Injected migration failure");
    db.exec(`
    DROP TABLE share_users;
    DROP TABLE share_groups;
    DROP TABLE share_audiences;
    ALTER TABLE share_audiences_new RENAME TO share_audiences;
    ALTER TABLE share_users_new RENAME TO share_users;
    ALTER TABLE share_groups_new RENAME TO share_groups;
    `);
    db.exec(`CREATE TRIGGER n8n_agent_audience_cleanup AFTER DELETE ON n8n_agents BEGIN
      DELETE FROM share_audiences WHERE kind = 'n8n' AND resource_id = OLD.id;
    END`);
    // Refuse to commit any broken references after the audience rebuild.
    const broken = db.prepare("PRAGMA foreign_key_check").all();
    if (broken.length) throw new Error(`Audience rebuild left ${broken.length} broken foreign keys`);
  },
  // Granular permissions (docs/implementation/granular-permissions.md): admin policy documents and prompt rules per
  // subject and model selector, personal per-model instructions, per-chat instructions, a global revision with an
  // encrypted audit trail, and the rate windows / leases that enforce operation limits. Subjects are polymorphic,
  // so user and group deletion remove their rows explicitly; resolvers also join live subjects.
  () => {
    db.exec(`
    CREATE TABLE permission_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      revision INTEGER NOT NULL CHECK (revision >= 0)
    );
    INSERT INTO permission_state VALUES (1, 1);
    ALTER TABLE user_groups ADD COLUMN prompt_order INTEGER;
    `);
    // Stable id order, 10 apart so a later reorder never needs to renumber everything to insert one group.
    const groups = db.prepare("SELECT id FROM user_groups ORDER BY id").all() as Array<{ id: string }>;
    const order = db.prepare("UPDATE user_groups SET prompt_order = ? WHERE id = ?");
    groups.forEach((group, index) => order.run((index + 1) * 10, group.id));
    db.exec(`
    CREATE UNIQUE INDEX user_groups_prompt_order ON user_groups(prompt_order);
    CREATE TABLE permission_policies (
      subject_kind TEXT NOT NULL CHECK (subject_kind IN ('everyone', 'group', 'user')),
      subject_id TEXT NOT NULL,
      model_ref TEXT NOT NULL DEFAULT '',
      document TEXT NOT NULL CHECK (json_valid(document) AND json_type(document) = 'object'),
      updated_at INTEGER NOT NULL,
      updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      PRIMARY KEY (subject_kind, subject_id, model_ref),
      CHECK ((subject_kind = 'everyone' AND subject_id = '') OR (subject_kind <> 'everyone' AND length(subject_id) > 0))
    );
    CREATE INDEX permission_policies_model ON permission_policies(model_ref);
    CREATE TABLE prompt_rules (
      subject_kind TEXT NOT NULL CHECK (subject_kind IN ('everyone', 'group', 'user')),
      subject_id TEXT NOT NULL,
      model_ref TEXT NOT NULL DEFAULT '',
      prompt_key TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('replace', 'append')),
      text TEXT NOT NULL CHECK (length(text) <= 50000),
      updated_at INTEGER NOT NULL,
      updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      PRIMARY KEY (subject_kind, subject_id, model_ref, prompt_key),
      CHECK ((subject_kind = 'everyone' AND subject_id = '' AND model_ref <> '') OR (subject_kind IN ('group', 'user') AND length(subject_id) > 0)),
      CHECK (mode <> 'append' OR length(trim(text)) > 0)
    );
    CREATE TABLE user_model_instructions (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      model_ref TEXT NOT NULL CHECK (length(model_ref) > 0),
      mode TEXT NOT NULL CHECK (mode IN ('replace', 'append')),
      text TEXT NOT NULL CHECK (length(text) <= 50000),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, model_ref),
      CHECK (mode <> 'append' OR length(trim(text)) > 0)
    );
    ALTER TABLE threads ADD COLUMN custom_instructions TEXT NOT NULL DEFAULT '';
    ALTER TABLE threads ADD COLUMN instructions_revision INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE permission_audit (
      revision INTEGER PRIMARY KEY,
      actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      occurred_at INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('policy', 'prompt', 'audience', 'entitlement', 'membership', 'group_order', 'subject_delete', 'migration')),
      summary_json TEXT NOT NULL CHECK (json_valid(summary_json)),
      changes_enc TEXT NOT NULL
    );
    INSERT INTO permission_audit (revision, actor_id, occurred_at, kind, summary_json, changes_enc)
      VALUES (1, NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'migration', '{"groups":0}', '');
    CREATE TABLE permission_rate_windows (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      scope_key TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      used INTEGER NOT NULL CHECK (used >= 0),
      PRIMARY KEY (user_id, scope_key, window_start)
    );
    CREATE TABLE permission_leases (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      model_ref TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL CHECK (kind IN ('operation', 'turn')),
      operation_key TEXT NOT NULL,
      process_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      UNIQUE (user_id, kind, operation_key)
    );
    CREATE INDEX permission_leases_active ON permission_leases(user_id, kind, expires_at, model_ref);
    `);
    db.prepare("UPDATE permission_audit SET summary_json = ? WHERE revision = 1").run(JSON.stringify({ groups: groups.length }));
  },
  // Personal saved prompts and private message annotations (docs/implementation/saved-prompts.md,
  // message-annotations.md). Annotations have no user_id: ownership comes from the thread, and the composite
  // foreign key removes them with their message. A feedback row with a NULL rating is a removal kept for its revision.
  `
  CREATE TABLE saved_prompts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    shortcut TEXT NOT NULL COLLATE NOCASE,
    body TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (user_id, shortcut)
  );
  CREATE INDEX saved_prompts_user ON saved_prompts(user_id, updated_at DESC, id);
  CREATE TABLE message_bookmarks (
    thread_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (thread_id, message_id),
    FOREIGN KEY (thread_id, message_id) REFERENCES messages(thread_id, id) ON DELETE CASCADE
  );
  CREATE TABLE message_feedback (
    thread_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    rating TEXT CHECK (rating IN ('positive', 'negative')),
    comment_enc TEXT,
    message_edited_at INTEGER,
    revision INTEGER NOT NULL CHECK (revision > 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (thread_id, message_id),
    FOREIGN KEY (thread_id, message_id) REFERENCES messages(thread_id, id) ON DELETE CASCADE,
    CHECK (rating IS NOT NULL OR comment_enc IS NULL)
  );
  `,
  // Parity wave 2 (docs/implementation/assistant-presets.md, continuation.md, chat-archives.md): named
  // assistant presets with a per-chat copied snapshot, generation receipts/segments for trustworthy
  // finish reasons and explicit continuation, and portable archive jobs. One append-only migration.
  () => {
    db.exec(`
    CREATE TABLE assistant_presets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT 'sparkles',
      config_json TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'published')),
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX assistant_presets_owner ON assistant_presets(user_id, updated_at DESC, id);
    CREATE INDEX assistant_presets_published ON assistant_presets(visibility, updated_at DESC, id);
    ALTER TABLE threads ADD COLUMN assistant_json TEXT;
    ALTER TABLE threads ADD COLUMN assistant_revision INTEGER NOT NULL DEFAULT 0 CHECK (assistant_revision >= 0);
    ALTER TABLE threads ADD COLUMN imported_assistant_json TEXT;
    ALTER TABLE threads ADD COLUMN preferred_head TEXT;
    ALTER TABLE messages ADD COLUMN imported INTEGER NOT NULL DEFAULT 0 CHECK (imported IN (0, 1));
    CREATE TABLE generation_runs (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      user_message_id TEXT NOT NULL,
      assistant_message_id TEXT NOT NULL,
      config_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('running', 'waiting', 'finished', 'aborted', 'error', 'interrupted')),
      finish_reason TEXT CHECK (finish_reason IN ('stop', 'length', 'tool-calls', 'content-filter', 'error', 'other', 'unknown')),
      usage_json TEXT NOT NULL DEFAULT '{}',
      cost REAL NOT NULL DEFAULT 0,
      context_tokens INTEGER,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (thread_id, assistant_message_id)
    );
    CREATE INDEX generation_runs_thread_user ON generation_runs(thread_id, user_message_id, created_at);
    CREATE INDEX generation_runs_open ON generation_runs(state, thread_id);
    -- A protected Continue double-click cannot create two receipts for the same request turn.
    CREATE UNIQUE INDEX generation_runs_continue ON generation_runs(thread_id, user_message_id)
      WHERE json_extract(config_json, '$.requestKind') = 'continue';
    CREATE TABLE generation_segments (
      run_id TEXT NOT NULL REFERENCES generation_runs(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      usage_json TEXT NOT NULL,
      cost REAL NOT NULL,
      PRIMARY KEY (run_id, id)
    );
    CREATE TABLE archive_jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('import', 'export')),
      state TEXT NOT NULL CHECK (state IN ('preparing', 'ready', 'committing', 'done', 'failed', 'cancelled')),
      summary_json TEXT,
      result_json TEXT,
      error_code TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX archive_jobs_owner ON archive_jobs(user_id, created_at DESC);
    CREATE UNIQUE INDEX archive_jobs_active ON archive_jobs(user_id)
      WHERE state IN ('preparing', 'ready', 'committing');
    `);
    if (process.env.OKAYCHAT_TEST_FAIL_MIGRATION === "parity-wave2") throw new Error("Injected migration failure");
  },
  // Parity wave 3 (docs/implementation/share-links.md, thread-tags.md, notifications.md,
  // model-comparison.md): several share links per chat with live/frozen modes, expiry and passwords;
  // flat tags and their saved sidebar filters; durable notices; and hidden comparison pane threads.
  () => {
    db.exec(`
    -- One row per link. Existing links survive as live links with no expiry and no password.
    ALTER TABLE shares RENAME TO shares_legacy;
    CREATE TABLE shares (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      label TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT 'live' CHECK (mode IN ('live', 'frozen')),
      expires_at INTEGER,
      password_hash TEXT,
      snapshot_json TEXT,
      snapshot_assets_json TEXT,
      snapshot_at INTEGER,
      view_count INTEGER NOT NULL DEFAULT 0,
      last_viewed_at INTEGER,
      created_at INTEGER NOT NULL
    );
    INSERT INTO shares (token, user_id, thread_id, created_at)
      SELECT token, user_id, thread_id, created_at FROM shares_legacy;
    DROP TABLE shares_legacy;
    CREATE INDEX shares_user_time ON shares(user_id, created_at DESC, token);
    CREATE INDEX shares_thread ON shares(thread_id);
    CREATE INDEX shares_expiry ON shares(expires_at) WHERE expires_at IS NOT NULL;

    CREATE TABLE thread_tags (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (thread_id, tag)
    );
    CREATE INDEX thread_tags_thread ON thread_tags(thread_id);
    CREATE INDEX thread_tags_tag ON thread_tags(tag, thread_id);
    CREATE TABLE tag_filter_presets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL COLLATE NOCASE,
      filter_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (user_id, name)
    );
    CREATE INDEX tag_filter_presets_user ON tag_filter_presets(user_id, updated_at DESC, id);

    -- thread_id is deliberately not a foreign key: deleting a chat must not erase the record that
    -- its scheduled run or import finished.
    CREATE TABLE notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('schedule', 'import', 'export')),
      level TEXT NOT NULL CHECK (level IN ('info', 'success', 'error')),
      title_key TEXT NOT NULL,
      body_key TEXT,
      params_json TEXT NOT NULL DEFAULT '{}',
      thread_id TEXT,
      action_path TEXT,
      source_key TEXT,
      read_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX notifications_source ON notifications(user_id, source_key) WHERE source_key IS NOT NULL;
    CREATE INDEX notifications_user_time ON notifications(user_id, created_at DESC, id);
    CREATE INDEX notifications_unread ON notifications(user_id, created_at DESC) WHERE read_at IS NULL;

    -- compare_group_id has no foreign key: SQLite cannot drop a column that carries one, and group
    -- deletion is handled explicitly by compare.ts. Pane rows cascade from both sides.
    CREATE TABLE comparison_groups (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      project_id TEXT,
      source_thread_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX comparison_groups_user_time ON comparison_groups(user_id, updated_at DESC, id);
    ALTER TABLE threads ADD COLUMN compare_group_id TEXT;
    CREATE INDEX threads_compare ON threads(user_id, compare_group_id) WHERE compare_group_id IS NOT NULL;
    CREATE TABLE comparison_panes (
      group_id TEXT NOT NULL REFERENCES comparison_groups(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      model_ref TEXT NOT NULL,
      PRIMARY KEY (group_id, position),
      UNIQUE (thread_id)
    );
    `);
    if (process.env.OKAYCHAT_TEST_FAIL_MIGRATION === "parity-wave3") throw new Error("Injected migration failure");
  },
  () => {
    db.exec(`
    -- Private evaluation workspace. These tables deliberately reference no thread, message, upload, or
    -- generation row: an evaluation turn is not a chat and may never create one.
    -- A dataset is a named, ordered fixture. Revision is the compare-and-set guard for every case write.
    CREATE TABLE evaluation_datasets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
      description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 500),
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX evaluation_datasets_user ON evaluation_datasets(user_id, updated_at DESC, id);

    -- No UNIQUE(dataset_id, position): a reorder is a set of UPDATEs inside one tx, and (position, id) is
    -- a total order on its own. \`position\` starts at 1 and is dense after every reorder.
    CREATE TABLE evaluation_cases (
      id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL REFERENCES evaluation_datasets(id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK (position >= 1),
      input TEXT NOT NULL CHECK (length(input) BETWEEN 1 AND 8000),
      instructions TEXT NOT NULL DEFAULT '' CHECK (length(instructions) <= 8000),
      expected TEXT NOT NULL DEFAULT '' CHECK (length(expected) <= 8000),
      notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
      tags_json TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(tags_json) AND json_type(tags_json) = 'array' AND json_array_length(tags_json) <= 10),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX evaluation_cases_dataset ON evaluation_cases(dataset_id, position, id);

    -- One row per launch. \`target_json\` and the per-result \`case_json\` snapshots make a run immutable.
    CREATE TABLE evaluation_runs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      dataset_id TEXT NOT NULL REFERENCES evaluation_datasets(id) ON DELETE CASCADE,
      dataset_revision INTEGER NOT NULL CHECK (dataset_revision >= 1),
      label TEXT NOT NULL DEFAULT '' CHECK (length(label) <= 80),
      target_json TEXT NOT NULL CHECK (json_valid(target_json) AND json_type(target_json) = 'object'),
      score_mode TEXT NOT NULL CHECK (score_mode IN ('scale5', 'pass_fail')),
      concurrency INTEGER NOT NULL CHECK (concurrency BETWEEN 1 AND 8),
      budget_tokens INTEGER NOT NULL CHECK (budget_tokens BETWEEN 10000 AND 20000000),
      budget_micros INTEGER NOT NULL CHECK (budget_micros BETWEEN 10000 AND 20000000),
      state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'cancelling', 'done', 'failed', 'cancelled')),
      stop_reason TEXT CHECK (stop_reason IN ('completed', 'budget', 'cancelled', 'error', 'interrupted')),
      error_code TEXT,
      error_message TEXT,
      total_cases INTEGER NOT NULL CHECK (total_cases BETWEEN 1 AND 200),
      completed_cases INTEGER NOT NULL DEFAULT 0,
      failed_cases INTEGER NOT NULL DEFAULT 0,
      skipped_cases INTEGER NOT NULL DEFAULT 0,
      usage_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(usage_json)),
      cost REAL NOT NULL DEFAULT 0,
      latency_total_ms INTEGER NOT NULL DEFAULT 0,
      judge_json TEXT CHECK (judge_json IS NULL OR (json_valid(judge_json) AND json_type(judge_json) = 'object')),
      judge_state TEXT NOT NULL DEFAULT 'idle'
        CHECK (judge_state IN ('idle', 'queued', 'running', 'done', 'failed', 'cancelled')),
      judge_done_cases INTEGER NOT NULL DEFAULT 0,
      judge_failed_cases INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER,
      ended_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    -- One active run per account, enforced by the database rather than by a count-then-insert race.
    CREATE UNIQUE INDEX evaluation_runs_active ON evaluation_runs(user_id)
      WHERE state IN ('queued', 'running', 'cancelling');
    CREATE INDEX evaluation_runs_dataset ON evaluation_runs(dataset_id, created_at DESC, id);
    CREATE INDEX evaluation_runs_user ON evaluation_runs(user_id, created_at DESC, id);

    -- case_id deliberately has no foreign key: the dataset may change or shrink; \`case_json\` is what ran.
    CREATE TABLE evaluation_results (
      run_id TEXT NOT NULL REFERENCES evaluation_runs(id) ON DELETE CASCADE,
      case_id TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (position >= 1),
      state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'done', 'error', 'skipped')),
      case_json TEXT NOT NULL CHECK (json_valid(case_json) AND json_type(case_json) = 'object'),
      output TEXT NOT NULL DEFAULT '',
      output_bytes INTEGER NOT NULL DEFAULT 0,
      truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
      finish_reason TEXT,
      error_code TEXT,
      error_message TEXT,
      usage_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(usage_json)),
      cost REAL NOT NULL DEFAULT 0,
      latency_ms INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, case_id)
    );
    CREATE INDEX evaluation_results_run ON evaluation_results(run_id, position, case_id);

    -- Manual and judged scores coexist: the primary key keeps one of each per case.
    -- The rubric itself lives once in runs.judge_json; a row keeps only its hash.
    CREATE TABLE evaluation_scores (
      run_id TEXT NOT NULL,
      case_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('manual', 'judge')),
      scale TEXT NOT NULL CHECK (scale IN ('scale5', 'pass_fail')),
      value REAL NOT NULL,
      comment_enc TEXT,
      rationale TEXT,
      judge_model_ref TEXT,
      judge_rubric_hash TEXT,
      usage_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(usage_json)),
      cost REAL NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, case_id, source),
      FOREIGN KEY (run_id, case_id) REFERENCES evaluation_results(run_id, case_id) ON DELETE CASCADE,
      CHECK ((scale = 'scale5' AND value = CAST(value AS INTEGER) AND value BETWEEN 1 AND 5)
          OR (scale = 'pass_fail' AND value IN (0, 1))),
      CHECK (source = 'manual' OR comment_enc IS NULL),
      CHECK (source = 'judge' OR (rationale IS NULL AND judge_model_ref IS NULL AND judge_rubric_hash IS NULL))
    );
    `);
    if (process.env.OKAYCHAT_TEST_FAIL_MIGRATION === "evaluations") throw new Error("Injected migration failure");
  },
  // Team channels (docs/implementation/channels.md). A separate aggregate: no thread, message, upload,
  // generation, memory, knowledge, or share row belongs to a room. Exactly one appended migration keeps
  // the previous history intact; notifications is rebuilt to add the channel kind and ACL columns.
  () => {
    db.exec(`
    CREATE TABLE channels (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', icon TEXT NOT NULL DEFAULT 'hash',
      visibility TEXT NOT NULL CHECK(visibility IN ('public','private','group')),
      ai_json TEXT, revision INTEGER NOT NULL DEFAULT 1,
      next_seq INTEGER NOT NULL DEFAULT 1,
      archived_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX channels_owner ON channels(owner_id);
    CREATE INDEX channels_directory ON channels(visibility, archived_at, updated_at DESC, id);

    CREATE TABLE channel_groups (
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      group_id TEXT NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
      PRIMARY KEY(channel_id,group_id)
    );
    CREATE INDEX channel_groups_group ON channel_groups(group_id,channel_id);

    CREATE TABLE channel_members (
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('owner','moderator','member')),
      read_seq INTEGER NOT NULL DEFAULT 0, notify_mode TEXT NOT NULL DEFAULT 'mentions'
      CHECK(notify_mode IN ('all','mentions','none')),
      joined_at INTEGER NOT NULL, PRIMARY KEY(channel_id,user_id)
    );
    CREATE UNIQUE INDEX channel_one_owner ON channel_members(channel_id) WHERE role='owner';
    CREATE INDEX channel_members_user ON channel_members(user_id,channel_id);

    CREATE TABLE channel_invites (
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL, PRIMARY KEY(channel_id,user_id)
    );

    CREATE TABLE channel_exclusions (
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, PRIMARY KEY(channel_id,user_id)
    );

    CREATE TABLE channel_messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      kind TEXT NOT NULL CHECK(kind IN ('human','ai')),
      body TEXT NOT NULL DEFAULT '', reply_to TEXT,
      client_id TEXT, request_hash TEXT, revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, edited_at INTEGER, deleted_at INTEGER,
      UNIQUE(channel_id,seq), UNIQUE(channel_id,id),
      FOREIGN KEY(channel_id,reply_to) REFERENCES channel_messages(channel_id,id)
    );
    CREATE UNIQUE INDEX channel_message_client ON channel_messages(channel_id,author_id,client_id)
      WHERE kind='human' AND client_id IS NOT NULL;
    CREATE INDEX channel_messages_author ON channel_messages(author_id);

    CREATE TABLE channel_mentions (
      message_id TEXT NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL,
      PRIMARY KEY(message_id,user_id)
    );

    CREATE TABLE channel_reactions (
      message_id TEXT NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL CHECK(emoji IN ('👍','❤️','🎉','😄','👀','✅')),
      created_at INTEGER NOT NULL, PRIMARY KEY(message_id,user_id,emoji)
    );

    CREATE TABLE channel_ai_runs (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      requester_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      source_id TEXT NOT NULL, message_id TEXT NOT NULL UNIQUE,
      client_id TEXT NOT NULL, request_hash TEXT NOT NULL,
      model_ref TEXT NOT NULL, config_json TEXT NOT NULL, input_enc TEXT,
      state TEXT NOT NULL CHECK(state IN ('queued','running','finished','cancelled','failed','interrupted')),
      output_version INTEGER NOT NULL DEFAULT 0,
      finish_reason TEXT, error_code TEXT,
      usage_json TEXT, cost REAL NOT NULL DEFAULT 0,
      usage_recorded INTEGER NOT NULL DEFAULT 0,
      reserved_bytes INTEGER NOT NULL,
      created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,
      UNIQUE(channel_id,requester_id,client_id),
      FOREIGN KEY(channel_id,source_id) REFERENCES channel_messages(channel_id,id),
      FOREIGN KEY(channel_id,message_id) REFERENCES channel_messages(channel_id,id)
    );
    CREATE UNIQUE INDEX channel_ai_open ON channel_ai_runs(channel_id)
      WHERE state IN ('queued','running');
    CREATE UNIQUE INDEX channel_ai_requester_open ON channel_ai_runs(requester_id)
      WHERE state IN ('queued','running');
    CREATE INDEX channel_ai_requester ON channel_ai_runs(requester_id,state);

    CREATE TABLE channel_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE,
      target_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('channel.changed','message.changed','members.changed','read.changed','sync')),
      entity_id TEXT, version INTEGER, created_at INTEGER NOT NULL
    );
    CREATE INDEX channel_events_room ON channel_events(channel_id,id);
    CREATE INDEX channel_events_user ON channel_events(target_user_id,id);

    CREATE TABLE channel_create_keys (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      client_id TEXT NOT NULL,
      channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
      request_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(user_id,client_id)
    );

    CREATE TABLE channel_event_state (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      epoch TEXT NOT NULL, floor_id INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE channel_rate_windows (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      bucket TEXT NOT NULL, window_start INTEGER NOT NULL, used INTEGER NOT NULL,
      PRIMARY KEY(user_id,bucket,window_start)
    );

    CREATE TABLE channel_moderation_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      channel_id TEXT, action TEXT NOT NULL, target_id TEXT,
      reason TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
    );
    CREATE INDEX channel_audit_time ON channel_moderation_audit(created_at,id);

    CREATE TABLE channel_search_keys (
      search_id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL UNIQUE REFERENCES channel_messages(id) ON DELETE CASCADE
    );

    CREATE VIRTUAL TABLE channel_messages_fts USING fts5(
      body, tokenize='unicode61 remove_diacritics 2'
    );

    -- FTS rows are addressed only through the integer search key. The BEFORE DELETE on the key table
    -- survives cascade ordering: a message delete cascades to its key, which removes the FTS row first.
    CREATE TRIGGER channel_messages_fts_insert AFTER INSERT ON channel_messages
      WHEN NEW.deleted_at IS NULL AND NEW.body <> ''
    BEGIN
      INSERT OR IGNORE INTO channel_search_keys(message_id) VALUES (NEW.id);
      INSERT INTO channel_messages_fts(rowid, body)
        SELECT search_id, NEW.body FROM channel_search_keys WHERE message_id = NEW.id;
    END;
    CREATE TRIGGER channel_messages_fts_update AFTER UPDATE OF body, deleted_at ON channel_messages
    BEGIN
      DELETE FROM channel_messages_fts
        WHERE rowid IN (SELECT search_id FROM channel_search_keys WHERE message_id = NEW.id);
      INSERT OR IGNORE INTO channel_search_keys(message_id) VALUES (NEW.id);
      INSERT INTO channel_messages_fts(rowid, body)
        SELECT search_id, NEW.body FROM channel_search_keys
        WHERE message_id = NEW.id AND NEW.deleted_at IS NULL AND NEW.body <> '';
    END;
    CREATE TRIGGER channel_messages_fts_delete AFTER DELETE ON channel_messages
    BEGIN
      DELETE FROM channel_messages_fts
        WHERE rowid IN (SELECT search_id FROM channel_search_keys WHERE message_id = OLD.id);
      DELETE FROM channel_search_keys WHERE message_id = OLD.id;
    END;
    CREATE TRIGGER channel_search_keys_fts_delete BEFORE DELETE ON channel_search_keys
    BEGIN
      DELETE FROM channel_messages_fts WHERE rowid = OLD.search_id;
    END;

    ALTER TABLE usage ADD COLUMN channel_id TEXT;
    ALTER TABLE usage ADD COLUMN channel_run_id TEXT;
    CREATE UNIQUE INDEX usage_channel_run ON usage(channel_run_id) WHERE channel_run_id IS NOT NULL;

    -- Rebuild notifications instead of editing the old CHECK: the kind list is part of the table definition.
    ALTER TABLE notifications RENAME TO notifications_legacy;
    CREATE TABLE notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('schedule', 'import', 'export', 'channel')),
      level TEXT NOT NULL CHECK (level IN ('info', 'success', 'error')),
      title_key TEXT NOT NULL,
      body_key TEXT,
      params_json TEXT NOT NULL DEFAULT '{}',
      thread_id TEXT,
      channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE,
      channel_message_id TEXT,
      action_path TEXT,
      source_key TEXT,
      read_at INTEGER,
      created_at INTEGER NOT NULL
    );
    INSERT INTO notifications (id, user_id, kind, level, title_key, body_key, params_json, thread_id, action_path, source_key, read_at, created_at)
      SELECT id, user_id, kind, level, title_key, body_key, params_json, thread_id, action_path, source_key, read_at, created_at
      FROM notifications_legacy;
    DROP TABLE notifications_legacy;
    CREATE UNIQUE INDEX notifications_source ON notifications(user_id, source_key) WHERE source_key IS NOT NULL;
    CREATE INDEX notifications_user_time ON notifications(user_id, created_at DESC, id);
    CREATE INDEX notifications_unread ON notifications(user_id, created_at DESC) WHERE read_at IS NULL;
    `);
    db.prepare("INSERT INTO channel_event_state (singleton, epoch, floor_id) VALUES (1, ?, 0)").run(newId("chev"));
    if (process.env.OKAYCHAT_TEST_FAIL_MIGRATION === "channels") throw new Error("Injected migration failure");
  },
  `
  CREATE TABLE IF NOT EXISTS custom_tools (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    base_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK(kind IN ('python','http')),
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    icon TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
    input_schema_json TEXT NOT NULL,
    config_enc TEXT NOT NULL,
    secrets_enc TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 2147483647),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(user_id,id)
  );
  CREATE INDEX IF NOT EXISTS custom_tools_owner ON custom_tools(user_id,created_at,id);

  CREATE TABLE IF NOT EXISTS custom_tool_runs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tool_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('chat','test')),
    thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
    execution_key TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('prepared','running','succeeded','failed','cancelled','unknown','denied','expired')),
    input_enc TEXT,
    input_hash TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    review_enc TEXT,
    approval_id TEXT,
    token_hash TEXT,
    session_hash TEXT NOT NULL,
    payload_pruned INTEGER NOT NULL DEFAULT 0 CHECK(payload_pruned IN (0,1)),
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    duration_ms INTEGER,
    dispatched INTEGER NOT NULL DEFAULT 0 CHECK(dispatched IN (0,1)),
    input_bytes INTEGER NOT NULL,
    output_bytes INTEGER NOT NULL DEFAULT 0,
    http_status INTEGER,
    result_enc TEXT,
    error_code TEXT,
    FOREIGN KEY(user_id,tool_id) REFERENCES custom_tools(user_id,id) ON DELETE CASCADE,
    UNIQUE(user_id,execution_key)
  );
  CREATE INDEX IF NOT EXISTS custom_runs_recent ON custom_tool_runs(user_id,tool_id,created_at DESC,id DESC);
  CREATE INDEX IF NOT EXISTS custom_runs_state ON custom_tool_runs(state,created_at);

  CREATE TABLE IF NOT EXISTS custom_tool_rate_windows (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    window_start INTEGER NOT NULL,
    attempts INTEGER NOT NULL CHECK(attempts BETWEEN 0 AND 30),
    PRIMARY KEY(user_id,window_start)
  );

  CREATE TABLE IF NOT EXISTS custom_tool_counters (
    user_id TEXT NOT NULL,
    tool_id TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    succeeded INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    cancelled INTEGER NOT NULL DEFAULT 0,
    unknown INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(user_id,tool_id),
    FOREIGN KEY(user_id,tool_id) REFERENCES custom_tools(user_id,id) ON DELETE CASCADE
  );
  `,
  // Personal notes and calendar. One combined migration: the tables, their FTS mirrors, the reminder
  // ledger, and the notifications rebuild that admits the `calendar` kind and its event link.
  () => {
    db.exec(`
CREATE TABLE notes (
  search_id INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0,1)),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)),
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  source_kind TEXT CHECK(source_kind IN ('message','artifact')),
  source_thread_id TEXT,
  source_item_id TEXT,
  source_version INTEGER,
  create_key TEXT NOT NULL,
  create_hash TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, create_key),
  CHECK((source_kind IS NULL AND source_thread_id IS NULL AND source_item_id IS NULL AND source_version IS NULL)
    OR (source_kind IS NOT NULL AND source_kind = 'message' AND source_thread_id IS NOT NULL AND source_item_id IS NOT NULL AND source_version IS NULL)
    OR (source_kind IS NOT NULL AND source_kind = 'artifact' AND source_thread_id IS NOT NULL AND source_item_id IS NOT NULL AND source_version IS NOT NULL AND source_version >= 1))
);
CREATE INDEX notes_user_order ON notes(user_id, pinned DESC, updated_at DESC, id DESC);
CREATE INDEX notes_user_project ON notes(user_id, project_id, pinned DESC, updated_at DESC, id DESC);
CREATE TABLE note_tags (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY(note_id, tag)
);
CREATE INDEX note_tags_tag ON note_tags(tag, note_id);
CREATE VIRTUAL TABLE notes_fts USING fts5(
  title, body, content='notes', content_rowid='search_id',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER notes_fts_insert AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid,title,body) VALUES(new.search_id,new.title,new.body);
END;
CREATE TRIGGER notes_fts_delete AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts,rowid,title,body) VALUES('delete',old.search_id,old.title,old.body);
END;
CREATE TRIGGER notes_fts_update AFTER UPDATE OF title,body ON notes
WHEN old.title IS NOT new.title OR old.body IS NOT new.body BEGIN
  INSERT INTO notes_fts(notes_fts,rowid,title,body) VALUES('delete',old.search_id,old.title,old.body);
  INSERT INTO notes_fts(rowid,title,body) VALUES(new.search_id,new.title,new.body);
END;

CREATE TABLE calendar_events (
  search_id INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  all_day INTEGER NOT NULL CHECK(all_day IN (0,1)),
  time_zone TEXT NOT NULL,
  start_at INTEGER,
  end_at INTEGER,
  start_date TEXT,
  end_date TEXT,
  effective_start_at INTEGER NOT NULL,
  effective_end_at INTEGER NOT NULL,
  reminder_offsets_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(reminder_offsets_json)),
  reminder_revision INTEGER NOT NULL DEFAULT 1 CHECK(reminder_revision >= 1),
  thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  create_key TEXT NOT NULL,
  create_hash TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id,create_key),
  CHECK(effective_end_at > effective_start_at),
  CHECK((all_day=0 AND start_at IS NOT NULL AND end_at IS NOT NULL AND end_at > start_at AND start_date IS NULL AND end_date IS NULL)
    OR (all_day=1 AND start_at IS NULL AND end_at IS NULL AND start_date IS NOT NULL AND end_date IS NOT NULL AND end_date > start_date))
);
CREATE INDEX calendar_user_range ON calendar_events(user_id,effective_start_at,id);
CREATE INDEX calendar_user_end ON calendar_events(user_id,effective_end_at,id);
CREATE INDEX calendar_user_project ON calendar_events(user_id,project_id,effective_start_at,id);
CREATE INDEX calendar_thread ON calendar_events(thread_id) WHERE thread_id IS NOT NULL;
CREATE VIRTUAL TABLE calendar_events_fts USING fts5(
  title,description,location,content='calendar_events',content_rowid='search_id',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER calendar_fts_insert AFTER INSERT ON calendar_events BEGIN
  INSERT INTO calendar_events_fts(rowid,title,description,location)
    VALUES(new.search_id,new.title,new.description,new.location);
END;
CREATE TRIGGER calendar_fts_delete AFTER DELETE ON calendar_events BEGIN
  INSERT INTO calendar_events_fts(calendar_events_fts,rowid,title,description,location)
    VALUES('delete',old.search_id,old.title,old.description,old.location);
END;
CREATE TRIGGER calendar_fts_update AFTER UPDATE OF title,description,location ON calendar_events
WHEN old.title IS NOT new.title OR old.description IS NOT new.description OR old.location IS NOT new.location BEGIN
  INSERT INTO calendar_events_fts(calendar_events_fts,rowid,title,description,location)
    VALUES('delete',old.search_id,old.title,old.description,old.location);
  INSERT INTO calendar_events_fts(rowid,title,description,location)
    VALUES(new.search_id,new.title,new.description,new.location);
END;
CREATE TABLE calendar_reminders (
  event_id TEXT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  reminder_revision INTEGER NOT NULL CHECK(reminder_revision >= 1),
  offset_minutes INTEGER NOT NULL CHECK(offset_minutes BETWEEN 0 AND 40320),
  due_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','delivered','suppressed')),
  processed_at INTEGER,
  PRIMARY KEY(event_id,reminder_revision,offset_minutes),
  CHECK((state='pending' AND processed_at IS NULL) OR (state<>'pending' AND processed_at IS NOT NULL))
);
CREATE INDEX calendar_reminders_due ON calendar_reminders(due_at,event_id,offset_minutes) WHERE state='pending';

ALTER TABLE notifications RENAME TO notifications_before_calendar;
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('schedule','import','export','channel','calendar')),
  level TEXT NOT NULL CHECK(level IN ('info','success','error')),
  title_key TEXT NOT NULL,
  body_key TEXT,
  params_json TEXT NOT NULL DEFAULT '{}',
  thread_id TEXT,
  channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE,
  channel_message_id TEXT,
  calendar_event_id TEXT REFERENCES calendar_events(id) ON DELETE CASCADE,
  action_path TEXT,
  source_key TEXT,
  read_at INTEGER,
  created_at INTEGER NOT NULL
);
INSERT INTO notifications(id,user_id,kind,level,title_key,body_key,params_json,thread_id,
  channel_id,channel_message_id,action_path,source_key,read_at,created_at)
SELECT id,user_id,kind,level,title_key,body_key,params_json,thread_id,
  channel_id,channel_message_id,action_path,source_key,read_at,created_at
FROM notifications_before_calendar;
DROP TABLE notifications_before_calendar;
CREATE UNIQUE INDEX notifications_source ON notifications(user_id,source_key) WHERE source_key IS NOT NULL;
CREATE INDEX notifications_user_time ON notifications(user_id,created_at DESC,id);
CREATE INDEX notifications_unread ON notifications(user_id,created_at DESC) WHERE read_at IS NULL;
CREATE INDEX notifications_calendar ON notifications(calendar_event_id) WHERE calendar_event_id IS NOT NULL;
    `);
    if (process.env.OKAYCHAT_TEST_FAIL_MIGRATION === "notes-calendar") throw new Error("Injected migration failure");
  },
  // External API access (docs/implementation/api-access.md). Credentials are hashed, never recoverable;
  // requests, rate windows, audit, and telemetry floors are bounded operational metadata, not user content.
  () => {
    db.exec(`
    CREATE TABLE api_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      prefix TEXT NOT NULL UNIQUE CHECK(length(prefix) = 27),
      secret_hash BLOB NOT NULL CHECK(length(secret_hash) = 32),
      label TEXT NOT NULL CHECK(length(CAST(label AS BLOB)) BETWEEN 1 AND 320),
      scopes INTEGER NOT NULL CHECK(scopes IN (1,2,3)),
      created_at INTEGER NOT NULL,
      expires_at INTEGER CHECK(expires_at IS NULL OR expires_at > created_at),
      last_used_at INTEGER,
      revoked_at INTEGER
    );
    CREATE INDEX api_keys_owner ON api_keys(user_id, created_at DESC, id DESC);

    CREATE TABLE api_rate_windows (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key_id TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      used INTEGER NOT NULL CHECK(used >= 0),
      PRIMARY KEY(user_id, key_id, window_start)
    );

    CREATE TABLE api_requests (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key_id TEXT NOT NULL,
      model_ref TEXT NOT NULL CHECK(length(CAST(model_ref AS BLOB)) <= 1200),
      stream INTEGER NOT NULL CHECK(stream IN (0,1)),
      started_at INTEGER NOT NULL,
      dispatched_at INTEGER,
      finished_at INTEGER,
      state TEXT NOT NULL CHECK(state IN ('admitted','running','succeeded','failed','cancelled','interrupted')),
      http_status INTEGER,
      error_code TEXT,
      finish_reason TEXT CHECK(finish_reason IS NULL OR finish_reason IN ('stop','length','content_filter')),
      usage_state TEXT NOT NULL DEFAULT 'unknown' CHECK(usage_state IN ('unknown','reported')),
      input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(input_tokens >= 0),
      output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(output_tokens >= 0),
      reasoning_tokens INTEGER NOT NULL DEFAULT 0 CHECK(reasoning_tokens >= 0),
      cache_read_tokens INTEGER NOT NULL DEFAULT 0 CHECK(cache_read_tokens >= 0),
      cache_write_tokens INTEGER NOT NULL DEFAULT 0 CHECK(cache_write_tokens >= 0),
      cost REAL NOT NULL DEFAULT 0 CHECK(cost >= 0),
      usage_recorded INTEGER NOT NULL DEFAULT 0 CHECK(usage_recorded IN (0,1))
    );
    CREATE INDEX api_requests_owner ON api_requests(user_id, started_at DESC, id DESC);
    CREATE INDEX api_requests_key ON api_requests(user_id, key_id, started_at DESC, id DESC);

    CREATE TABLE api_key_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key_id TEXT NOT NULL,
      event TEXT NOT NULL CHECK(event IN ('created','revoked','password_revoked','expired')),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX api_key_audit_owner ON api_key_audit(user_id, id DESC);
    CREATE UNIQUE INDEX api_key_expired_once ON api_key_audit(key_id, event) WHERE event = 'expired';

    CREATE TABLE api_telemetry_floors (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      since_at INTEGER NOT NULL
    );

    ALTER TABLE usage ADD COLUMN api_key_id TEXT;
    ALTER TABLE usage ADD COLUMN api_request_id TEXT;
    CREATE UNIQUE INDEX usage_api_request ON usage(api_request_id) WHERE api_request_id IS NOT NULL;
    CREATE INDEX usage_api_key_time ON usage(user_id, api_key_id, created_at)
      WHERE api_key_id IS NOT NULL;
    `);
    if (process.env.OKAYCHAT_TEST_FAIL_MIGRATION === "api-access") throw new Error("Injected migration failure");
  },
  // Per-message translations (docs/implementation/message-translation.md). Derived text: never message
  // content, never chat activity, never shared. The composite FK mirrors message_bookmarks.
  () => {
    db.exec(`
    CREATE TABLE message_translations (
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      lang TEXT NOT NULL CHECK(length(CAST(lang AS BLOB)) BETWEEN 2 AND 35),
      source_hash TEXT NOT NULL CHECK(length(source_hash) = 64),
      source_chars INTEGER NOT NULL CHECK(source_chars >= 0),
      translated TEXT NOT NULL CHECK(length(CAST(translated AS BLOB)) BETWEEN 1 AND 32768),
      truncated INTEGER NOT NULL CHECK(truncated IN (0,1)),
      model_ref TEXT NOT NULL CHECK(length(CAST(model_ref AS BLOB)) BETWEEN 1 AND 1200),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (thread_id, message_id, lang),
      FOREIGN KEY (thread_id, message_id) REFERENCES messages(thread_id, id) ON DELETE CASCADE
    );
    CREATE INDEX message_translations_message ON message_translations(thread_id, message_id);
    `);
    if (process.env.OKAYCHAT_TEST_FAIL_MIGRATION === "message-translations") throw new Error("Injected migration failure");
  },
  // Channels v2 (docs/implementation/channels.md): attachments, one level of thread replies, and DMs as
  // channel rows. One appended migration: rebuilding `channels`, `channel_messages`, or `channel_events`
  // would reset the event AUTOINCREMENT high-water and invalidate every live cursor.
  () => {
    db.exec(`
    -- kind is validated in code: SQLite cannot add a CHECK constraint in place, and rebuilding
    -- channels would require rebuilding every child table's foreign keys.
    ALTER TABLE channels ADD COLUMN kind TEXT NOT NULL DEFAULT 'room';
    ALTER TABLE channels ADD COLUMN dm_key TEXT;

    CREATE UNIQUE INDEX channel_dm_key ON channels(dm_key) WHERE dm_key IS NOT NULL;
    CREATE INDEX channels_kind_owner ON channels(kind, owner_id);

    -- One level only: a reply names its top-level message. Same-room integrity is enforced in
    -- channel_store (a composite FK is impossible on an added column).
    ALTER TABLE channel_messages ADD COLUMN thread_root TEXT REFERENCES channel_messages(id) ON DELETE CASCADE;
    CREATE INDEX channel_messages_thread ON channel_messages(channel_id, thread_root, seq) WHERE thread_root IS NOT NULL;

    -- Denormalized thread counters: the room list, message projection, and search hits read one row
    -- instead of counting replies per message.
    CREATE TABLE channel_thread_state (
      root_id TEXT PRIMARY KEY REFERENCES channel_messages(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      reply_count INTEGER NOT NULL DEFAULT 0 CHECK(reply_count >= 0),
      last_seq INTEGER NOT NULL DEFAULT 0,
      last_at INTEGER NOT NULL,
      last_author_id TEXT REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX channel_thread_state_room ON channel_thread_state(channel_id, last_seq DESC);

    CREATE TABLE channel_thread_reads (
      root_id TEXT NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      read_seq INTEGER NOT NULL DEFAULT 0 CHECK(read_seq >= 0),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(root_id, user_id)
    );
    CREATE INDEX channel_thread_reads_user ON channel_thread_reads(user_id, channel_id);

    CREATE TABLE channel_attachments (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      message_id TEXT REFERENCES channel_messages(id) ON DELETE CASCADE,
      uploader_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL CHECK(size > 0),
      -- 1: raster original in dataDir/channel-media/<channelId>/<id>.<ext>, data NULL.
      -- 0: opaque bytes in data (never a second source of truth for the same bytes).
      file INTEGER NOT NULL CHECK(file IN (0,1)),
      data BLOB,
      width INTEGER, height INTEGER,
      created_at INTEGER NOT NULL,
      deleted_at INTEGER,
      CHECK ((file = 1 AND data IS NULL) OR (file = 0 AND data IS NOT NULL))
    );
    CREATE INDEX channel_attachments_message ON channel_attachments(message_id, id);
    CREATE INDEX channel_attachments_owner ON channel_attachments(owner_id);
    CREATE INDEX channel_attachments_channel ON channel_attachments(channel_id, id);
    CREATE INDEX channel_attachments_pending ON channel_attachments(uploader_id, created_at)
      WHERE message_id IS NULL;
    CREATE INDEX channel_attachments_purge ON channel_attachments(deleted_at)
      WHERE deleted_at IS NOT NULL;

    -- Person-level DM blocks. Existing group DMs are untouched; only new DMs and new memberships check it.
    CREATE TABLE channel_dm_blocks (
      blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(blocker_id, blocked_id),
      CHECK (blocker_id <> blocked_id)
    );
    CREATE INDEX channel_dm_blocks_blocked ON channel_dm_blocks(blocked_id, blocker_id);

    -- The root a thread invalidation or thread read refers to. Plain column: no CHECK, so no rebuild.
    ALTER TABLE channel_events ADD COLUMN root_id TEXT;
    ALTER TABLE notifications ADD COLUMN channel_root_id TEXT;
    `);
    if (process.env.OKAYCHAT_TEST_FAIL_MIGRATION === "channels-v2") throw new Error("Injected migration failure");
  },
  // Shared team knowledge (docs/implementation/knowledge.md): publication state, an embedding connection pin,
  // durable chat dependencies, and a `knowledge` audience kind. The dependency has no foreign key to the
  // collection on purpose: deleting a shared collection must leave a deny-all tombstone in the reader's chat,
  // never unlock it by cascading the row away. No existing private data is published or re-indexed.
  () => {
    db.exec(`
    ALTER TABLE knowledge_collections ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'
      CHECK (visibility IN ('private', 'shared'));
    ALTER TABLE knowledge_collections ADD COLUMN access_revision INTEGER NOT NULL DEFAULT 1
      CHECK (access_revision > 0);
    ALTER TABLE knowledge_collections ADD COLUMN embedding_connection_scope TEXT
      CHECK (embedding_connection_scope IN ('own', 'shared'));
    ALTER TABLE knowledge_collections ADD COLUMN embedding_connection_created_at INTEGER;
    ALTER TABLE knowledge_collections ADD COLUMN embedding_endpoint_hash TEXT;
    CREATE INDEX knowledge_collections_visibility ON knowledge_collections(visibility, updated_at DESC, id);

    CREATE TABLE knowledge_thread_dependencies (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      collection_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (thread_id, collection_id)
    );
    CREATE INDEX knowledge_dependencies_collection ON knowledge_thread_dependencies(collection_id, thread_id);

    -- Rebuild the audience tables to admit the knowledge kind. The old CHECK cannot be altered in place.
    DROP TRIGGER n8n_agent_audience_cleanup;
    -- A database rewound for a migration test can still carry the shared-knowledge trigger from a later
    -- version; it references share_audiences, so it must not survive the rebuild below.
    DROP TRIGGER IF EXISTS knowledge_audience_cleanup;
    CREATE TABLE share_audiences_new (
      kind TEXT NOT NULL CHECK(kind IN ('provider','mcp','n8n','knowledge')),
      resource_id TEXT NOT NULL,
      PRIMARY KEY(kind, resource_id)
    );
    CREATE TABLE share_users_new (
      kind TEXT NOT NULL, resource_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY(kind, resource_id, user_id),
      FOREIGN KEY(kind, resource_id) REFERENCES share_audiences_new(kind, resource_id) ON DELETE CASCADE
    );
    CREATE TABLE share_groups_new (
      kind TEXT NOT NULL, resource_id TEXT NOT NULL,
      group_id TEXT NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
      PRIMARY KEY(kind, resource_id, group_id),
      FOREIGN KEY(kind, resource_id) REFERENCES share_audiences_new(kind, resource_id) ON DELETE CASCADE
    );
    INSERT INTO share_audiences_new SELECT kind, resource_id FROM share_audiences;
    INSERT INTO share_users_new SELECT kind, resource_id, user_id FROM share_users;
    INSERT INTO share_groups_new SELECT kind, resource_id, group_id FROM share_groups;
    `);
    if (process.env.OKAYCHAT_TEST_FAIL_MIGRATION === "team-knowledge") throw new Error("Injected migration failure");
    db.exec(`
    DROP TABLE share_users;
    DROP TABLE share_groups;
    DROP TABLE share_audiences;
    ALTER TABLE share_audiences_new RENAME TO share_audiences;
    ALTER TABLE share_users_new RENAME TO share_users;
    ALTER TABLE share_groups_new RENAME TO share_groups;
    CREATE TRIGGER n8n_agent_audience_cleanup AFTER DELETE ON n8n_agents BEGIN
      DELETE FROM share_audiences WHERE kind='n8n' AND resource_id=OLD.id;
    END;
    CREATE TRIGGER knowledge_audience_cleanup AFTER DELETE ON knowledge_collections BEGIN
      DELETE FROM share_audiences WHERE kind='knowledge' AND resource_id=OLD.id;
    END;
    -- A shared collection is global: its owner project id/title must never become an audience-visible field.
    CREATE TRIGGER knowledge_shared_project_insert BEFORE INSERT ON knowledge_collections
    WHEN NEW.visibility='shared' AND NEW.project_id IS NOT NULL BEGIN
      SELECT RAISE(ABORT, 'shared knowledge must be global');
    END;
    CREATE TRIGGER knowledge_shared_project_update BEFORE UPDATE OF visibility, project_id ON knowledge_collections
    WHEN NEW.visibility='shared' AND NEW.project_id IS NOT NULL BEGIN
      SELECT RAISE(ABORT, 'shared knowledge must be global');
    END;
    `);
    const broken = db.prepare("PRAGMA foreign_key_check").all();
    if (broken.length) throw new Error(`Knowledge migration left ${broken.length} broken foreign keys`);
  },
  // Room archive v1 (docs/implementation/room-archives.md). Append-only: imported rooms reuse the native
  // channels/channel_messages tables, keep provenance beside them, and job receipts live in their own
  // table. Existing channel/event tables are never rebuilt, so live cursors and the event high-water stand.
  `
  ALTER TABLE channels ADD COLUMN imported_meta_json TEXT;
  ALTER TABLE channel_messages ADD COLUMN imported_json TEXT;

  CREATE TABLE channel_import_identities (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    local_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    historical_role TEXT CHECK(historical_role IN ('owner','moderator','member')),
    historical_joined_at INTEGER,
    UNIQUE(channel_id,id)
  );
  CREATE INDEX channel_import_identities_room ON channel_import_identities(channel_id,id);
  CREATE INDEX channel_import_identities_user ON channel_import_identities(local_user_id);

  CREATE TABLE room_archive_jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('export','import')),
    authority TEXT NOT NULL CHECK(authority IN ('owner','admin','importer')),
    source_channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
    admin_reason TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL CHECK(state IN
      ('uploading','queued','preparing','ready','committing','done','failed','cancelled','expired')),
    phase TEXT NOT NULL CHECK(phase IN
      ('upload','snapshot','zip','validate','inspect','promote','commit','download','cleanup','complete')),
    cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
    reservation_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reservation_bytes>=0),
    staged_bytes INTEGER NOT NULL DEFAULT 0 CHECK(staged_bytes>=0),
    progress_done INTEGER NOT NULL DEFAULT 0 CHECK(progress_done>=0),
    progress_total INTEGER CHECK(progress_total IS NULL OR progress_total>=0),
    request_json TEXT,
    summary_json TEXT,
    review_digest TEXT,
    confirm_hash TEXT,
    target_channel_id TEXT,
    result_json TEXT,
    error_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX room_archive_one_active ON room_archive_jobs(user_id)
    WHERE state IN ('uploading','queued','preparing','ready','committing');
  CREATE INDEX room_archive_expiry ON room_archive_jobs(expires_at,id);
  CREATE INDEX room_archive_queue ON room_archive_jobs(state,created_at,id);
  `,
  // Outgoing event webhooks (docs/implementation/outgoing-webhooks.md): per-account private endpoints, a
  // durable outbox, one consumable test preparation, and fixed-minute rate windows. Source ids in the
  // outbox deliberately have no foreign keys: deleting a source must cancel/scrub an export, not recreate it.
  () => {
    db.exec(`
    CREATE TABLE outgoing_webhook_endpoints (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      config_enc TEXT NOT NULL,
      signing_secret_enc TEXT NOT NULL,
      key_id TEXT NOT NULL,
      subscriptions_json TEXT NOT NULL CHECK(json_valid(subscriptions_json)),
      channel_ids_json TEXT NOT NULL CHECK(json_valid(channel_ids_json)),
      include_message_text INTEGER NOT NULL DEFAULT 0 CHECK(include_message_text IN (0,1)),
      enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
      next_sequence INTEGER NOT NULL DEFAULT 1 CHECK(next_sequence >= 1),
      consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failures >= 0),
      failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK(failed_attempts >= 0),
      dropped_count INTEGER NOT NULL DEFAULT 0 CHECK(dropped_count >= 0),
      last_drop_reason TEXT CHECK(last_drop_reason IN ('quota','capacity','rate','projection')),
      last_drop_at INTEGER,
      auto_disabled_at INTEGER,
      last_delivery_id TEXT,
      last_status TEXT CHECK(last_status IN ('succeeded','failed')),
      last_http_status INTEGER CHECK(last_http_status BETWEEN 100 AND 599),
      last_attempt_at INTEGER,
      last_duration_ms INTEGER CHECK(last_duration_ms >= 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(id,user_id)
    );
    CREATE INDEX outgoing_endpoints_owner ON outgoing_webhook_endpoints(user_id,id);

    CREATE TABLE outgoing_webhook_deliveries (
      id TEXT PRIMARY KEY,
      endpoint_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      endpoint_revision INTEGER NOT NULL CHECK(endpoint_revision >= 1),
      event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK(sequence >= 1),
      occurred_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      body_enc TEXT,
      source_thread_id TEXT,
      source_channel_id TEXT,
      source_message_id TEXT,
      source_root_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('queued','sending','backoff','succeeded','dead','cancelled')),
      version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 10),
      attempts_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(attempts_json)),
      next_attempt_at INTEGER NOT NULL,
      last_error_code TEXT,
      last_http_status INTEGER CHECK(last_http_status BETWEEN 100 AND 599),
      finished_at INTEGER,
      is_test INTEGER NOT NULL DEFAULT 0 CHECK(is_test IN (0,1)),
      FOREIGN KEY(endpoint_id,user_id) REFERENCES outgoing_webhook_endpoints(id,user_id) ON DELETE CASCADE,
      UNIQUE(endpoint_id,event_id),
      UNIQUE(endpoint_id,sequence)
    );
    CREATE INDEX outgoing_deliveries_due ON outgoing_webhook_deliveries(next_attempt_at,endpoint_id,sequence)
      WHERE status IN ('queued','backoff');
    CREATE INDEX outgoing_deliveries_owner ON outgoing_webhook_deliveries(user_id,created_at DESC,id DESC);
    CREATE INDEX outgoing_deliveries_endpoint ON outgoing_webhook_deliveries(endpoint_id,created_at DESC,id DESC);
    CREATE INDEX outgoing_deliveries_active ON outgoing_webhook_deliveries(user_id,endpoint_id,status)
      WHERE status IN ('queued','sending','backoff');
    CREATE INDEX outgoing_deliveries_terminal ON outgoing_webhook_deliveries(status,created_at,id);

    CREATE TABLE outgoing_webhook_test_preparations (
      id TEXT PRIMARY KEY,
      endpoint_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      endpoint_revision INTEGER NOT NULL,
      body_enc TEXT,
      event_id TEXT NOT NULL,
      delivery_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      CHECK((consumed_at IS NULL AND body_enc IS NOT NULL) OR (consumed_at IS NOT NULL AND body_enc IS NULL)),
      FOREIGN KEY(endpoint_id,user_id) REFERENCES outgoing_webhook_endpoints(id,user_id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX outgoing_test_unconsumed ON outgoing_webhook_test_preparations(endpoint_id)
      WHERE consumed_at IS NULL;
    CREATE INDEX outgoing_tests_expiry ON outgoing_webhook_test_preparations(expires_at);

    CREATE TABLE outgoing_webhook_rate_windows (
      scope TEXT NOT NULL CHECK(scope IN ('admission','account_dispatch','endpoint_dispatch','test','management')),
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      bucket_id TEXT NOT NULL,
      minute INTEGER NOT NULL,
      count INTEGER NOT NULL CHECK(count >= 0),
      PRIMARY KEY(scope,user_id,bucket_id,minute)
    );

    ALTER TABLE schedules ADD COLUMN webhook_invocation_id TEXT;
    ALTER TABLE schedules ADD COLUMN webhook_started_at INTEGER;
    `);
    if (process.env.OKAYCHAT_TEST_FAIL_MIGRATION === "outgoing-webhooks") throw new Error("Injected migration failure");
    db.exec(`
    CREATE INDEX outgoing_rate_windows_age ON outgoing_webhook_rate_windows(minute);
    `);
    const broken = db.prepare("PRAGMA foreign_key_check").all();
    if (broken.length) throw new Error(`Outgoing webhooks migration left ${broken.length} broken foreign keys`);
  },
  () => {
    db.exec(`
CREATE TABLE video_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
  llm_run_id TEXT,
  assistant_message_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt BETWEEN 0 AND 7),
  retry_of TEXT,
  service TEXT NOT NULL CHECK(service IN ('xai','replicate')),
  model_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  connection_fingerprint TEXT NOT NULL,
  request_enc TEXT,
  parameters_json TEXT NOT NULL CHECK(json_valid(parameters_json)),
  price_json TEXT NOT NULL CHECK(json_valid(price_json)),
  provider_id_enc TEXT,
  state TEXT NOT NULL CHECK(state IN ('queued','submitting','polling','downloading','validating',
    'cancel_requested','succeeded','failed','cancelled','timed_out','submission_unknown')),
  stage TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  submitted_at INTEGER,
  deadline_at INTEGER NOT NULL,
  next_poll_at INTEGER,
  poll_failures INTEGER NOT NULL DEFAULT 0 CHECK(poll_failures >= 0),
  lease_until INTEGER,
  lease_epoch INTEGER NOT NULL DEFAULT 0,
  cancel_requested_at INTEGER,
  remote_cancellation TEXT NOT NULL DEFAULT 'not_requested'
    CHECK(remote_cancellation IN ('not_requested','unsupported','confirmed','unconfirmed')),
  error_code TEXT,
  may_have_charged INTEGER NOT NULL DEFAULT 0 CHECK(may_have_charged IN (0,1)),
  reservation_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reservation_bytes >= 0),
  estimated_cost_microusd INTEGER NOT NULL CHECK(estimated_cost_microusd >= 0),
  settled_cost_microusd INTEGER CHECK(settled_cost_microusd >= 0),
  cost_state TEXT NOT NULL DEFAULT 'unknown' CHECK(cost_state IN ('unknown','estimated','reported')),
  billed_seconds REAL CHECK(billed_seconds > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  UNIQUE(thread_id, assistant_message_id, tool_call_id, attempt)
);
CREATE INDEX video_jobs_due ON video_jobs(state, next_poll_at, lease_until);
CREATE INDEX video_jobs_owner ON video_jobs(user_id, created_at DESC, id);
CREATE INDEX video_jobs_thread ON video_jobs(thread_id, created_at, id);
CREATE UNIQUE INDEX video_jobs_one_active_owner ON video_jobs(user_id)
  WHERE state IN ('queued','submitting','polling','downloading','validating','cancel_requested');
CREATE UNIQUE INDEX video_jobs_retry_once ON video_jobs(retry_of) WHERE retry_of IS NOT NULL;
CREATE TABLE videos (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL UNIQUE REFERENCES video_jobs(id),
  origin_thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
  label TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'video/mp4' CHECK(mime = 'video/mp4'),
  size INTEGER NOT NULL CHECK(size > 0 AND size <= 67108864),
  sha256 TEXT NOT NULL,
  duration_ms INTEGER NOT NULL CHECK(duration_ms > 0 AND duration_ms <= 8500),
  width INTEGER NOT NULL CHECK(width > 0 AND width <= 1920),
  height INTEGER NOT NULL CHECK(height > 0 AND height <= 1920),
  has_audio INTEGER NOT NULL CHECK(has_audio IN (0,1)),
  created_at INTEGER NOT NULL
);
CREATE INDEX videos_owner ON videos(user_id, created_at DESC, id);
CREATE TABLE video_threads (
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  PRIMARY KEY(video_id,thread_id)
);
CREATE INDEX video_threads_thread ON video_threads(thread_id,video_id);
ALTER TABLE usage ADD COLUMN video_job_id TEXT;
ALTER TABLE usage ADD COLUMN cost_state TEXT NOT NULL DEFAULT 'estimated'
  CHECK(cost_state IN ('unknown','estimated','reported'));
CREATE UNIQUE INDEX usage_video_job ON usage(video_job_id) WHERE video_job_id IS NOT NULL;
    `);
    if (process.env.OKAYCHAT_TEST_FAIL_MIGRATION === "video-generation") throw new Error("Injected migration failure");
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Video migration left broken foreign keys");
  },
  // How a knowledge source's text was obtained (docs/implementation/extraction.md); null for pasted text and older rows.
  `ALTER TABLE knowledge_sources ADD COLUMN extraction TEXT CHECK (extraction IN ('text','ocr'));`,

  `CREATE TABLE conversation_import_jobs (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('import','export')),
    state TEXT NOT NULL CHECK(state IN ('receiving','validating','ready','queued','importing','paused','cancelling','done','cancelled','failed','expired')),
    adapter TEXT CHECK(adapter IN ('mapping-v1','portable-v1')), adapter_version INTEGER,
    project_id TEXT, model_ref TEXT, admission_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, terminal_at INTEGER, input_sha256 TEXT, manifest_sha256 TEXT,
    confirmation_sha256 TEXT, reservation_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reservation_bytes >= 0),
    cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)), error_code TEXT,
    selection_json TEXT CHECK(selection_json IS NULL OR json_valid(selection_json))
  );
  CREATE UNIQUE INDEX conversation_import_one_active ON conversation_import_jobs(user_id)
    WHERE state IN ('receiving','validating','ready','queued','importing','paused','cancelling');
  CREATE INDEX conversation_import_jobs_expiry ON conversation_import_jobs(expires_at,state);
  CREATE INDEX conversation_import_jobs_owner ON conversation_import_jobs(user_id,admission_at DESC);
  CREATE TABLE conversation_import_items (
    job_id TEXT NOT NULL REFERENCES conversation_import_jobs(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0), item_key TEXT NOT NULL, source_namespace TEXT, source_id TEXT,
    payload_sha256 TEXT, title TEXT, created_at INTEGER, updated_at INTEGER,
    message_count INTEGER NOT NULL DEFAULT 0, normalized_bytes INTEGER NOT NULL DEFAULT 0,
    warnings_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(warnings_json)),
    state TEXT NOT NULL CHECK(state IN ('valid','invalid','pending','imported','duplicate','failed','cancelled','unselected')),
    selected INTEGER NOT NULL DEFAULT 0 CHECK(selected IN (0,1)),
    thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL, error_code TEXT,
    PRIMARY KEY(job_id,ordinal), UNIQUE(job_id,item_key)
  );
  CREATE TABLE conversation_source_ids (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    namespace TEXT NOT NULL CHECK(namespace IN ('mapping-v1','portable-v1')), source_id TEXT NOT NULL,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    payload_sha256 TEXT NOT NULL, title_bytes INTEGER NOT NULL CHECK(title_bytes >= 0), created_at INTEGER NOT NULL,
    PRIMARY KEY(user_id,namespace,source_id)
  );
  CREATE UNIQUE INDEX conversation_source_thread ON conversation_source_ids(thread_id);`,
  `ALTER TABLE conversation_import_jobs ADD COLUMN received_bytes INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE conversation_import_jobs ADD COLUMN total_bytes INTEGER;
   ALTER TABLE conversation_import_jobs ADD COLUMN staging_present INTEGER NOT NULL DEFAULT 0 CHECK(staging_present IN (0,1));
   ALTER TABLE conversation_source_ids ADD COLUMN origin TEXT NOT NULL DEFAULT 'import' CHECK(origin IN ('import','export'));`,
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
  commitHooks.push([]);
  try {
    const result = fn();
    db.exec(`RELEASE ${name}`);
    const hooks = commitHooks.pop()!;
    // An inner savepoint's hooks wait for the outermost commit; a rollback above drops them with it.
    if (commitHooks.length) commitHooks.at(-1)!.push(...hooks);
    else runHooks(hooks);
    return result;
  } catch (error) {
    commitHooks.pop();
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    throw error;
  }
}

const commitHooks: Array<Array<() => void>> = [];

function runHooks(hooks: Array<() => void>): void {
  for (const hook of hooks) {
    try {
      hook();
    } catch (error) {
      // The write is committed; a failed clean-up is left to garbage collection.
      console.error("[db] after-commit step failed:", (error as Error).message);
    }
  }
}

/**
 * Runs `hook` once the enclosing `tx()` commits, or now outside one. For side effects outside SQLite
 * (deleting files) that a rollback could not undo.
 */
export function afterCommit(hook: () => void): void {
  if (commitHooks.length) commitHooks.at(-1)!.push(hook);
  else hook();
}
