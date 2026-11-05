import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("integrated migrations are repeatable and backfill legacy generated image sizes", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "okaychat-migrations-"));
  const environment = { ...process.env, OKAYCHAT_DATA_DIR: directory, OKAYCHAT_SECRET: "migration-tests-secret-not-for-production" };
  const run = (code: string) => execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { env: environment, encoding: "utf8" });
  const dbUrl = new URL("./db.ts", import.meta.url).href;
  try {
    run(`const { db } = await import(${JSON.stringify(dbUrl)});
      db.exec("INSERT INTO users (id,email,name,password_hash,role,created_at) VALUES ('legacy','legacy@example.test','Legacy','unused','user',1)");
      db.exec("INSERT INTO images (id,user_id,prompt,created_at) VALUES ('legacy-image','legacy','legacy image',1)");
      db.exec("INSERT INTO threads (id,user_id,created_at,updated_at) VALUES ('historical','legacy',1,1)");
      db.prepare("INSERT INTO messages (id,thread_id,format,content,created_at) VALUES ('m1','historical','ai-sdk/v6',?,1)").run(JSON.stringify({role:'user',parts:[{type:'file',filename:'legacy.png',mediaType:'image/png',url:'data:image/png;base64,bGVnYWN5LWZpbGU='},{type:'text',text:'<attachment file_id=\"upl_pdf\"></attachment>'}]}));
      // Rewind to just before the inline-file migration (15), undoing the later threads.pinned (16), images.mime (17), threads.branched_from (18), memory v2 (19), and messages.bytes changes.
      // The FTS addressing table and history index are dropped so their migrations can run again on a
      // populated database; the triggers they replace are dropped and rebuilt by that migration itself.
      // The triggers must go before their key table, or a later table rewrite fires them against a missing table.
      db.exec("DROP TRIGGER messages_fts_insert; DROP TRIGGER messages_fts_update; DROP TRIGGER messages_fts_delete");
      db.exec("DROP TABLE message_search_keys");
      db.exec("DROP INDEX messages_thread_time");
      for (const table of ["chatgpt_login_attempts", "chatgpt_registrations", "chatgpt_hosts", "chatgpt_controls", "provider_model_grants", "provider_model_policies", "knowledge_chunks_fts", "knowledge_chunks", "knowledge_sources", "knowledge_collections", "share_groups", "share_users", "share_audiences", "user_group_members", "user_groups", "n8n_agent_sessions", "n8n_agent_runs", "n8n_agents", "permission_leases", "permission_rate_windows", "permission_audit", "user_model_instructions", "prompt_rules", "permission_policies", "permission_state"]) db.exec("DROP TABLE " + table);
      for (const column of ["custom_instructions", "instructions_revision"]) db.exec("ALTER TABLE threads DROP COLUMN " + column);
      db.exec("ALTER TABLE threads DROP COLUMN knowledge_ids");
      db.exec("DROP TABLE image_threads");
      db.exec("DROP TABLE media");
      for (const index of ["uploads_media", "sandbox_files_media"]) db.exec("DROP INDEX " + index);
      for (const table of ["uploads", "sandbox_files", "user_avatars"]) db.exec("ALTER TABLE " + table + " DROP COLUMN media_id");
      db.exec("DROP TABLE turn_context");
      db.exec("DROP TABLE speech_recordings");
      db.exec("DROP TABLE email_drafts");
      db.exec("DROP TABLE email_accounts");
      db.exec("DROP TABLE mcp_server_users");
      db.exec("ALTER TABLE mcp_servers DROP COLUMN shared");
      db.exec("DROP TABLE memory_summaries");
      db.exec("ALTER TABLE memory_preferences DROP COLUMN chat_search");
      for (const column of ["memory_cursor", "memory_scanned_at", "memory_snapshot_enc", "memory_snapshot_at"]) db.exec("ALTER TABLE threads DROP COLUMN " + column);
      db.exec("ALTER TABLE threads DROP COLUMN pinned");
      db.exec("ALTER TABLE images DROP COLUMN mime");
      db.exec("ALTER TABLE threads DROP COLUMN branched_from");
      db.exec("ALTER TABLE messages DROP COLUMN bytes");
      for (const column of ["edited_at", "original_enc"]) db.exec("ALTER TABLE messages DROP COLUMN " + column);
      for (const column of ["thread_mode", "thread_attached", "project_id"]) db.exec("ALTER TABLE schedules DROP COLUMN " + column);
      db.prepare("INSERT INTO server_settings (key, value) VALUES ('prompt:anonymous', ?)").run("Keep this temporary chat out of history.");
      db.exec('PRAGMA user_version = 14');
      db.close();`);
    mkdirSync(path.join(directory, "images", "legacy"), { recursive: true });
    writeFileSync(path.join(directory, "images", "legacy", "legacy-image.png"), Buffer.alloc(42));
    for (let i = 0; i < 2; i++) {
      const result = JSON.parse(run(`const { db } = await import(${JSON.stringify(dbUrl)});
        console.log(JSON.stringify({
          image: db.prepare("SELECT size FROM images WHERE id='legacy-image'").get().size,
          skills: db.prepare("SELECT count(*) AS n FROM skills").get().n,
          sandbox: db.prepare("SELECT count(*) AS n FROM sandbox_files").get().n,
          uploads: db.prepare("SELECT count(*) AS n FROM uploads").get().n,
          temporaryPrompt: db.prepare("SELECT value FROM server_settings WHERE key='prompt:temporary'").get().value,
          oldPromptCount: db.prepare("SELECT count(*) AS n FROM server_settings WHERE key='prompt:anonymous'").get().n,
          original: JSON.parse(db.prepare("SELECT content FROM messages WHERE id='m1'").get().content).parts[0].url,
          users: db.prepare("SELECT count(*) AS n FROM users").get().n,
          integratedTables: ["provider_model_policies", "provider_model_grants", "email_accounts", "knowledge_collections", "knowledge_sources", "knowledge_chunks", "knowledge_chunks_fts", "email_drafts", "media", "image_threads", "message_search_keys"].map(table => db.prepare("SELECT count(*) AS n FROM " + table).get().n),
          edits: db.prepare("SELECT edited_at, original_enc FROM messages WHERE id = 'm1'").get(),
          version: db.prepare("PRAGMA user_version").get().user_version,
          foreignKeys: db.prepare("PRAGMA foreign_key_check").all()
        })); db.exec("DELETE FROM uploads"); db.close();`));
      // The version only grows with appended migrations; the FTS addressing migration is version 36.
      assert.ok(result.version >= 36, `user_version ${result.version}`);
      const { version: _version, ...state } = result as Record<string, unknown>;
      assert.deepEqual(state, { image: 42, skills: 0, sandbox: 0, users: 1, uploads: i === 0 ? 1 : 0, temporaryPrompt: "Keep this temporary chat out of history.", oldPromptCount: 0, original: "data:image/png;base64,bGVnYWN5LWZpbGU=", integratedTables: [...Array(10).fill(0), 1], edits: { edited_at: null, original_enc: null }, foreignKeys: [] });
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('n8n migration preserves selected audiences and rolls back schema and version together', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'okaychat-n8n-migration-'));
  const environment = { ...process.env, OKAYCHAT_DATA_DIR: directory, OKAYCHAT_SECRET: 'migration-tests-secret-not-for-production' };
  const run = (code: string, extra: Record<string, string> = {}) => execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { env: { ...environment, ...extra }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const dbUrl = new URL('./db.ts', import.meta.url).href;
  const setup = `const { db } = await import(${JSON.stringify(dbUrl)});
    const version = db.prepare('PRAGMA user_version').get().user_version;
    db.exec("INSERT INTO users (id,email,name,password_hash,role,created_at) VALUES ('u','u@example.test','U','unused','admin',1)");
    db.exec("INSERT INTO user_groups (id,name,created_at) VALUES ('g','Group',1)");
    db.exec("INSERT INTO user_group_members (group_id,user_id) VALUES ('g','u')");
    db.exec("INSERT INTO share_audiences VALUES ('provider','p'),('mcp','m'),('mcp','empty')");
    db.exec("INSERT INTO share_users VALUES ('provider','p','u')");
    db.exec("INSERT INTO share_groups VALUES ('mcp','m','g')");
    db.exec('DROP TABLE n8n_agent_sessions; DROP TABLE n8n_agent_runs; DROP TABLE n8n_agents');
    db.exec('DROP TABLE permission_leases; DROP TABLE permission_rate_windows; DROP TABLE permission_audit; DROP TABLE user_model_instructions; DROP TABLE prompt_rules; DROP TABLE permission_policies; DROP TABLE permission_state');
    db.exec('DROP INDEX user_groups_prompt_order');
    db.exec('ALTER TABLE user_groups DROP COLUMN prompt_order');
    db.exec('ALTER TABLE threads DROP COLUMN custom_instructions');
    db.exec('ALTER TABLE threads DROP COLUMN instructions_revision');
    // Migration 39 is n8n agents and 40 is granular permissions. Versions are append-only, so
    // replaying from 38 exercises the n8n migration and everything appended after it.
    db.exec('PRAGMA user_version = 38');
    console.log(version); db.close();`;
  try {
    const tail = Number(run(setup).trim());
    assert.throws(() => run(`await import(${JSON.stringify(dbUrl)})`, { OKAYCHAT_TEST_FAIL_MIGRATION: 'n8n-agents' }));
    const dbFile = path.join(directory, 'okaychat.db');
    // Read with SQLite directly so the verification itself cannot run the pending migration.
    const result = JSON.parse(run(`import { DatabaseSync } from 'node:sqlite';
      import fs from 'node:fs';
      const file = fs.readdirSync(${JSON.stringify(directory)}).find(name => /\.(db|sqlite)$/.test(name));
      const db = new DatabaseSync(${JSON.stringify(directory)} + '/' + file);
      console.log(JSON.stringify({version:db.prepare('PRAGMA user_version').get().user_version,tables:db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'n8n_%' OR name LIKE '%_new'").all()})); db.close();`));
    assert.equal(result.version, 38, 'the failed n8n migration leaves the pre-n8n version');
    assert.deepEqual(result.tables, []);
    for (let i = 0; i < 2; i++) {
      const state = JSON.parse(run(`const { db } = await import(${JSON.stringify(dbUrl)});
        db.exec("INSERT OR IGNORE INTO share_audiences VALUES ('n8n','a')");
        console.log(JSON.stringify({version:db.prepare('PRAGMA user_version').get().user_version, audiences:db.prepare('SELECT * FROM share_audiences ORDER BY kind,resource_id').all(), users:db.prepare('SELECT * FROM share_users').all(), groups:db.prepare('SELECT * FROM share_groups').all(), fks:db.prepare('PRAGMA foreign_key_check').all()})); db.close();`));
      assert.equal(state.version, tail);
      assert.deepEqual(state.audiences, [{ kind: 'mcp', resource_id: 'empty' }, { kind: 'mcp', resource_id: 'm' }, { kind: 'n8n', resource_id: 'a' }, { kind: 'provider', resource_id: 'p' }]);
      assert.deepEqual(state.users, [{ kind: 'provider', resource_id: 'p', user_id: 'u' }]);
      assert.deepEqual(state.groups, [{ kind: 'mcp', resource_id: 'm', group_id: 'g' }]);
      assert.deepEqual(state.fks, []);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
