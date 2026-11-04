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
      for (const table of ["message_feedback", "message_bookmarks", "saved_prompts", "provider_model_grants", "provider_model_policies", "knowledge_chunks_fts", "knowledge_chunks", "knowledge_sources", "knowledge_collections", "share_groups", "share_users", "share_audiences", "user_group_members", "user_groups"]) db.exec("DROP TABLE " + table);
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
          integratedTables: ["provider_model_policies", "provider_model_grants", "email_accounts", "knowledge_collections", "knowledge_sources", "knowledge_chunks", "knowledge_chunks_fts", "email_drafts", "media", "image_threads", "saved_prompts", "message_bookmarks", "message_feedback"].map(table => db.prepare("SELECT count(*) AS n FROM " + table).get().n),
          edits: db.prepare("SELECT edited_at, original_enc FROM messages WHERE id = 'm1'").get(),
          foreignKeys: db.prepare("PRAGMA foreign_key_check").all()
        })); db.exec("DELETE FROM uploads"); db.close();`));
      assert.deepEqual(result, { image: 42, skills: 0, sandbox: 0, users: 1, uploads: i === 0 ? 1 : 0, temporaryPrompt: "Keep this temporary chat out of history.", oldPromptCount: 0, original: "data:image/png;base64,bGVnYWN5LWZpbGU=", integratedTables: Array(13).fill(0), edits: { edited_at: null, original_enc: null }, foreignKeys: [] });
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
