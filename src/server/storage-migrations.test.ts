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
      for (const table of ["evaluation_scores", "evaluation_results", "evaluation_runs", "evaluation_cases", "evaluation_datasets", "chatgpt_login_attempts", "chatgpt_registrations", "chatgpt_hosts", "chatgpt_controls", "saved_prompts", "message_bookmarks", "message_feedback", "assistant_presets", "generation_segments", "generation_runs", "archive_jobs", "provider_model_grants", "provider_model_policies", "knowledge_chunks_fts", "knowledge_chunks", "knowledge_sources", "knowledge_collections", "share_groups", "share_users", "share_audiences", "user_group_members", "user_groups", "n8n_agent_sessions", "n8n_agent_runs", "n8n_agents", "permission_leases", "permission_rate_windows", "permission_audit", "user_model_instructions", "prompt_rules", "permission_policies", "permission_state", "notifications", "tag_filter_presets", "thread_tags", "comparison_panes", "comparison_groups"]) db.exec("DROP TABLE " + table);
      db.exec("DROP TABLE channel_messages_fts; DROP TABLE channel_search_keys; DROP TABLE channel_events; DROP TABLE channel_event_state; DROP TABLE channel_rate_windows; DROP TABLE channel_moderation_audit; DROP TABLE channel_create_keys; DROP TABLE channel_ai_runs; DROP TABLE channel_reactions; DROP TABLE channel_mentions; DROP TABLE channel_messages; DROP TABLE channel_exclusions; DROP TABLE channel_invites; DROP TABLE channel_members; DROP TABLE channel_groups; DROP TABLE channels");
      for (const table of ["notes_fts", "note_tags", "notes", "calendar_events_fts", "calendar_reminders", "calendar_events"]) db.exec("DROP TABLE " + table);
      db.exec("DROP INDEX IF EXISTS usage_channel_run");
      db.exec("ALTER TABLE usage DROP COLUMN channel_id");
      db.exec("ALTER TABLE usage DROP COLUMN channel_run_id");
      for (const index of ["shares_user_time", "shares_thread", "shares_expiry", "threads_compare"]) db.exec("DROP INDEX " + index);
      db.exec("ALTER TABLE threads DROP COLUMN compare_group_id");
      for (const column of ["custom_instructions", "instructions_revision", "assistant_json", "assistant_revision", "imported_assistant_json", "preferred_head"]) db.exec("ALTER TABLE threads DROP COLUMN " + column);
      db.exec("ALTER TABLE messages DROP COLUMN imported");
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
          integratedTables: ["provider_model_policies", "provider_model_grants", "email_accounts", "knowledge_collections", "knowledge_sources", "knowledge_chunks", "knowledge_chunks_fts", "email_drafts", "media", "image_threads", "saved_prompts", "message_bookmarks", "message_feedback", "shares", "thread_tags", "tag_filter_presets", "notifications", "comparison_groups", "comparison_panes", "message_search_keys", "evaluation_datasets", "evaluation_cases", "evaluation_runs", "evaluation_results", "evaluation_scores", "notes", "note_tags", "calendar_events", "calendar_reminders"].map(table => db.prepare("SELECT count(*) AS n FROM " + table).get().n),
          evaluationActiveIndex: db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='evaluation_runs_active'").get()?.sql ?? null,
          evaluationScoreForeignKeys: db.prepare("PRAGMA foreign_key_list(evaluation_scores)").all(),
          edits: db.prepare("SELECT edited_at, original_enc FROM messages WHERE id = 'm1'").get(),
          version: db.prepare("PRAGMA user_version").get().user_version,
          foreignKeys: db.prepare("PRAGMA foreign_key_check").all()
        })); db.exec("DELETE FROM uploads"); db.close();`));
      // The version only grows with appended migrations; the FTS addressing migration is version 36.
      assert.ok(result.version >= 45, `user_version ${result.version}`);
      const { version: _version, ...state } = result as Record<string, unknown>;
      assert.match(String((state as { evaluationActiveIndex: string }).evaluationActiveIndex), /UNIQUE INDEX evaluation_runs_active/);
      assert.deepEqual((state as { evaluationScoreForeignKeys: Array<{ table: string; from: string; to: string }> }).evaluationScoreForeignKeys.map((key) => [key.table, key.from, key.to]), [["evaluation_results", "run_id", "run_id"], ["evaluation_results", "case_id", "case_id"]]);
      delete (state as Record<string, unknown>).evaluationActiveIndex;
      delete (state as Record<string, unknown>).evaluationScoreForeignKeys;
      assert.deepEqual(state, { image: 42, skills: 0, sandbox: 0, users: 1, uploads: i === 0 ? 1 : 0, temporaryPrompt: "Keep this temporary chat out of history.", oldPromptCount: 0, original: "data:image/png;base64,bGVnYWN5LWZpbGU=", integratedTables: [...Array(19).fill(0), 1, ...Array(5).fill(0), ...Array(4).fill(0)], edits: { edited_at: null, original_enc: null }, foreignKeys: [] });
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("storage accounting counts every evaluation table and releases it with the dataset", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "okaychat-eval-quota-"));
  const environment = { ...process.env, OKAYCHAT_DATA_DIR: directory, OKAYCHAT_SECRET: "migration-tests-secret-not-for-production" };
  const dbUrl = new URL("./db.ts", import.meta.url).href;
  const quotaUrl = new URL("./quota.ts", import.meta.url).href;
  try {
    const result = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      const { db } = await import(${JSON.stringify(dbUrl)});
      const { storageUsed } = await import(${JSON.stringify(quotaUrl)});
      const { encrypt } = await import(${JSON.stringify(new URL("./crypto.ts", import.meta.url).href)});
      db.prepare("INSERT INTO users (id,email,name,password_hash,role,created_at) VALUES ('u','u@example.test','U','unused','user',1)").run();
      const before = storageUsed("u");
      db.prepare("INSERT INTO evaluation_datasets (id,user_id,name,description,revision,created_at,updated_at) VALUES ('d','u','Dataset','description',1,1,1)").run();
      db.prepare("INSERT INTO evaluation_cases (id,dataset_id,position,input,instructions,expected,notes,tags_json,created_at,updated_at) VALUES ('c','d',1,'input','instructions','expected','notes',?,1,1)").run('["tag"]');
      const target = JSON.stringify({modelRef:'m',modelName:'M',effort:null,sampling:{},assistantPresetId:null,assistantName:null,instructions:''});
      const judge = JSON.stringify({modelRef:'j',modelName:'J',effort:null,scale:'scale5',rubric:'rubric',rubricHash:'hash'});
      db.prepare("INSERT INTO evaluation_runs (id,user_id,dataset_id,dataset_revision,label,target_json,score_mode,concurrency,budget_tokens,budget_micros,state,error_message,total_cases,judge_json,created_at,updated_at) VALUES ('r','u','d',1,'label',?,'scale5',1,10000,10000,'done','message',1,?,1,1)").run(target, judge);
      const snapshot = JSON.stringify({caseId:'c',position:1,input:'input',instructions:'',expected:'',notes:'',tags:[]});
      db.prepare("INSERT INTO evaluation_results (run_id,case_id,position,state,case_json,output,output_bytes,error_message,created_at,updated_at) VALUES ('r','c',1,'done',?,'output',6,null,1,1)").run(snapshot);
      db.prepare("INSERT INTO evaluation_scores (run_id,case_id,source,scale,value,comment_enc,rationale,cost,revision,created_at,updated_at) VALUES ('r','c','manual','scale5',4,?,NULL,0,1,1,1)").run(encrypt("comment"));
      db.prepare("INSERT INTO evaluation_scores (run_id,case_id,source,scale,value,comment_enc,rationale,judge_model_ref,judge_rubric_hash,cost,revision,created_at,updated_at) VALUES ('r','c','judge','scale5',3,NULL,'judge rationale','j','hash',0,1,1,1)").run();
      const after = storageUsed("u");
      db.prepare("DELETE FROM evaluation_datasets WHERE id='d'").run();
      console.log(JSON.stringify({ before, after, restored: storageUsed("u"), runs: db.prepare("SELECT count(*) AS n FROM evaluation_runs").get().n, results: db.prepare("SELECT count(*) AS n FROM evaluation_results").get().n, scores: db.prepare("SELECT count(*) AS n FROM evaluation_scores").get().n }));
      db.close();`], { env: environment, encoding: "utf8" })) as { before: number; after: number; restored: number; runs: number; results: number; scores: number };
    assert.ok(result.after > result.before, `${result.after} > ${result.before}`);
    assert.equal(result.restored, result.before);
    assert.deepEqual([result.runs, result.results, result.scores], [0, 0, 0]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
    db.exec('DROP TABLE saved_prompts; DROP TABLE message_bookmarks; DROP TABLE message_feedback');
    db.exec('DROP TABLE evaluation_scores; DROP TABLE evaluation_results; DROP TABLE evaluation_runs; DROP TABLE evaluation_cases; DROP TABLE evaluation_datasets');
    for (const table of ['channel_messages_fts', 'channel_search_keys', 'channel_events', 'channel_event_state', 'channel_rate_windows', 'channel_moderation_audit', 'channel_create_keys', 'channel_ai_runs', 'channel_reactions', 'channel_mentions', 'channel_messages', 'channel_exclusions', 'channel_invites', 'channel_members', 'channel_groups', 'channels', 'notifications', 'tag_filter_presets', 'thread_tags', 'comparison_panes', 'comparison_groups', 'notes_fts', 'note_tags', 'notes', 'calendar_events_fts', 'calendar_reminders', 'calendar_events']) db.exec('DROP TABLE ' + table);
    db.exec('DROP INDEX IF EXISTS usage_channel_run; ALTER TABLE usage DROP COLUMN channel_id; ALTER TABLE usage DROP COLUMN channel_run_id');
    for (const index of ['shares_user_time', 'shares_thread', 'shares_expiry', 'threads_compare']) db.exec('DROP INDEX ' + index);
    db.exec('ALTER TABLE threads DROP COLUMN compare_group_id');
    db.exec('DROP TABLE assistant_presets; DROP TABLE generation_segments; DROP TABLE generation_runs; DROP TABLE archive_jobs');
    for (const column of ['assistant_json', 'assistant_revision', 'imported_assistant_json', 'preferred_head']) db.exec('ALTER TABLE threads DROP COLUMN ' + column);
    db.exec('ALTER TABLE messages DROP COLUMN imported');
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

test("channels migration rolls back cleanly, keeps notifications intact, and maintains its own FTS", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "okaychat-channels-migration-"));
  const base = { ...process.env, OKAYCHAT_DATA_DIR: directory, OKAYCHAT_SECRET: "migration-tests-secret-not-for-production" };
  const dbUrl = new URL("./db.ts", import.meta.url).href;
  const run = (code: string, env: Record<string, string | undefined> = {}) =>
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { env: { ...base, ...env }, encoding: "utf8" });
  try {
    // A failure after the channels DDL rolls the whole migration back with its version.
    assert.throws(() => run(`await import(${JSON.stringify(dbUrl)});`, { OKAYCHAT_TEST_FAIL_MIGRATION: "channels" }));
    const result = JSON.parse(run(`const { db } = await import(${JSON.stringify(dbUrl)});
      db.prepare("INSERT INTO users (id,email,name,password_hash,role,created_at) VALUES ('u','u@example.test','U','unused','user',1)").run();
      db.prepare("INSERT INTO channels (id,owner_id,name,visibility,created_at,updated_at) VALUES ('c','u','Room','public',1,1)").run();
      db.prepare("INSERT INTO channel_messages (id,channel_id,seq,author_id,kind,body,created_at) VALUES ('m','c',1,'u','human','alpha beta',1)").run();
      const inserted = db.prepare("SELECT rowid FROM channel_messages_fts WHERE channel_messages_fts MATCH 'alpha'").all();
      db.prepare("UPDATE channel_messages SET body = 'gamma' WHERE id = 'm'").run();
      const updated = db.prepare("SELECT rowid FROM channel_messages_fts WHERE channel_messages_fts MATCH 'alpha'").all();
      const found = db.prepare("SELECT rowid FROM channel_messages_fts WHERE channel_messages_fts MATCH 'gamma'").all();
      db.prepare("DELETE FROM channel_messages WHERE id = 'm'").run();
      const gone = db.prepare("SELECT rowid FROM channel_messages_fts WHERE channel_messages_fts MATCH 'gamma'").all();
      // The rebuilt notifications table accepts the new kind but still rejects an unknown one.
      db.prepare("INSERT INTO notifications (id,user_id,kind,level,title_key,params_json,created_at) VALUES ('n','u','channel','info','channel.message','{}',1)").run();
      let rejected = false;
      try { db.prepare("INSERT INTO notifications (id,user_id,kind,level,title_key,params_json,created_at) VALUES ('bad','u','other','info','channel.message','{}',1)").run(); } catch { rejected = true; }
      console.log(JSON.stringify({
        version: db.prepare("PRAGMA user_version").get().user_version,
        tables: ["channels","channel_members","channel_messages","channel_events","channel_search_keys","channel_event_state"].map((table) => db.prepare("SELECT count(*) AS n FROM " + table).get().n),
        epoch: db.prepare("SELECT epoch FROM channel_event_state WHERE singleton=1").get().epoch,
        inserted: inserted.length, updated: updated.length, found: found.length, gone: gone.length,
        rejected, fks: db.prepare("PRAGMA foreign_key_check").all(),
        usageColumns: db.prepare("PRAGMA table_info(usage)").all().filter((column) => String(column.name).startsWith("channel")).map((column) => column.name),
      })); db.close();`));
    assert.ok(result.version >= 45, `user_version ${result.version}`);
    assert.deepEqual(result.tables.slice(0, 4), [1, 0, 0, 0]);
    assert.match(String(result.epoch), /^chev_/);
    assert.deepEqual([result.inserted, result.updated, result.found, result.gone], [1, 0, 1, 0]);
    assert.equal(result.rejected, true);
    assert.deepEqual(result.fks, []);
    assert.deepEqual(result.usageColumns.sort(), ["channel_id", "channel_run_id"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("notes-calendar migration rolls back cleanly, preserves every notice, and owns its FTS", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "okaychat-notes-calendar-migration-"));
  const base = { ...process.env, OKAYCHAT_DATA_DIR: directory, OKAYCHAT_SECRET: "migration-tests-secret-not-for-production" };
  const dbUrl = new URL("./db.ts", import.meta.url).href;
  const run = (code: string, env: Record<string, string | undefined> = {}) =>
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { env: { ...base, ...env }, encoding: "utf8" });
  const inspect = (code: string) =>
    execFileSync(process.execPath, ["--input-type=module", "-e", `import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(${JSON.stringify(path.join(directory, "okaychat.db"))});
      ${code}
      db.close();`], { encoding: "utf8" });
  try {
    assert.throws(() => run(`await import(${JSON.stringify(dbUrl)});`, { OKAYCHAT_TEST_FAIL_MIGRATION: "notes-calendar" }));
    const failed = JSON.parse(inspect(`console.log(JSON.stringify({ version: db.prepare("PRAGMA user_version").get().user_version, notes: db.prepare("SELECT name FROM sqlite_master WHERE name='notes'").all() }));`));
    assert.equal(failed.version, 45);
    assert.deepEqual(failed.notes, []);

    // The failed run left schema 45. Seed one notice of every existing kind with ACL and read state.
    inspect(`
      db.exec("INSERT INTO users (id,email,name,password_hash,role,created_at) VALUES ('u','u@example.test','U','unused','user',1)");
      db.exec("INSERT INTO channels (id,owner_id,name,visibility,created_at,updated_at) VALUES ('c','u','Room','public',1,1)");
      db.prepare("INSERT INTO notifications (id,user_id,kind,level,title_key,body_key,params_json,thread_id,channel_id,channel_message_id,action_path,source_key,read_at,created_at) VALUES ('n1','u','schedule','success','schedule.ok',NULL,'{}',NULL,NULL,NULL,'/', 's:1', NULL, 1)").run();
      db.prepare("INSERT INTO notifications (id,user_id,kind,level,title_key,params_json,source_key,created_at) VALUES ('n2','u','import','info','import.done','{}','i:1',2)").run();
      db.prepare("INSERT INTO notifications (id,user_id,kind,level,title_key,params_json,read_at,created_at) VALUES ('n3','u','export','error','export.failed','{}',3,3)").run();
      db.prepare("INSERT INTO notifications (id,user_id,kind,level,title_key,body_key,params_json,channel_id,channel_message_id,action_path,source_key,created_at) VALUES ('n4','u','channel','info','channel.message','channel.openRoom','{}','c',NULL,'/channels/c','m:1',4)").run();
    `);

    const result = JSON.parse(run(`const { db } = await import(${JSON.stringify(dbUrl)});
      db.prepare("INSERT INTO notifications (id,user_id,kind,level,title_key,params_json,created_at) VALUES ('n5','u','calendar','info','calendar.reminder','{}',5)").run();
      let rejected = false;
      try { db.prepare("INSERT INTO notifications (id,user_id,kind,level,title_key,params_json,created_at) VALUES ('bad','u','other','info','calendar.reminder','{}',6)").run(); } catch { rejected = true; }
      db.prepare("INSERT INTO notes (id,user_id,title,body,create_key,create_hash,created_at,updated_at) VALUES ('note1','u','Title','Body','k','h',1,1)").run();
      db.prepare("INSERT INTO note_tags (note_id,tag) VALUES ('note1','tag')").run();
      const fts = db.prepare("SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'Title'").all().length;
      const calendarFts = db.prepare("SELECT name FROM sqlite_master WHERE name='calendar_events_fts'").get();
      const indexes = ["notes_user_order","note_tags_tag","calendar_user_range","calendar_reminders_due","notifications_calendar"].map((name) => db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name=?").get(name).n);
      const triggers = ["notes_fts_insert","notes_fts_update","notes_fts_delete","calendar_fts_insert","calendar_fts_update","calendar_fts_delete"].map((name) => db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name=?").get(name).n);
      console.log(JSON.stringify({
        version: db.prepare("PRAGMA user_version").get().user_version,
        notices: db.prepare("SELECT id,kind,title_key,channel_id,read_at,source_key FROM notifications ORDER BY id").all(),
        rejected, fts, calendarFts: !!calendarFts, indexes, triggers,
        fks: db.prepare("PRAGMA foreign_key_check").all(),
      })); db.close();`)) as { version: number; notices: Array<Record<string, unknown>>; rejected: boolean; fts: number; calendarFts: boolean; indexes: number[]; triggers: number[]; fks: unknown[] };
    assert.ok(result.version >= 46);
    assert.equal(result.rejected, true);
    assert.equal(result.fts, 1);
    assert.equal(result.calendarFts, true);
    assert.deepEqual(result.indexes, [1, 1, 1, 1, 1]);
    assert.deepEqual(result.triggers, [1, 1, 1, 1, 1, 1]);
    assert.deepEqual(result.fks, []);
    assert.deepEqual(result.notices.map((notice) => [notice.id, notice.kind, notice.title_key, notice.channel_id ?? null, notice.read_at ?? null, notice.source_key ?? null]), [
      ["n1", "schedule", "schedule.ok", null, null, "s:1"],
      ["n2", "import", "import.done", null, null, "i:1"],
      ["n3", "export", "export.failed", null, 3, null],
      ["n4", "channel", "channel.message", "c", null, "m:1"],
      ["n5", "calendar", "calendar.reminder", null, null, null],
    ]);

    // A second reopen is a no-op and a deleted account cascades through tags and FTS.
    const reopened = JSON.parse(run(`const { db } = await import(${JSON.stringify(dbUrl)});
      db.prepare("DELETE FROM users WHERE id='u'").run();
      console.log(JSON.stringify({ version: db.prepare("PRAGMA user_version").get().user_version, notes: db.prepare("SELECT count(*) AS n FROM notes").get().n, tags: db.prepare("SELECT count(*) AS n FROM note_tags").get().n, fts: db.prepare("SELECT count(*) AS n FROM notes_fts").get().n, notices: db.prepare("SELECT count(*) AS n FROM notifications").get().n })); db.close();`)) as { version: number; notes: number; tags: number; fts: number; notices: number };
    assert.equal(reopened.version, result.version);
    assert.deepEqual([reopened.notes, reopened.tags, reopened.fts, reopened.notices], [0, 0, 0, 0]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
