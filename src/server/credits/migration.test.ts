import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("credit migration backfills only the new period, rolls back atomically, and reopens twice", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "okaychat-credit-migration-"));
  const env = { ...process.env, OKAYCHAT_DATA_DIR: directory };
  const dbUrl = new URL("../db.ts", import.meta.url).href;
  const run = (code: string, extra: Record<string, string> = {}) => execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { env: { ...env, ...extra }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    const version = Number(run(`const {db} = await import(${JSON.stringify(dbUrl)});
      db.exec("INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES ('legacy','legacy@example.test','L','unused','admin',1)");
      db.exec("INSERT INTO usage(user_id,provider_id,model_id,kind,input_tokens,output_tokens,reasoning_tokens,cache_read_tokens,cache_write_tokens,cost,created_at) VALUES ('legacy','test','test','chat',100,20,0,0,0,0,1)");
      const version = db.prepare('PRAGMA user_version').get().user_version;
      db.exec('DROP TABLE token_credit_requests; DROP TABLE token_credit_roots; DROP TABLE token_credit_audit; DROP TABLE token_credit_accounts; DROP INDEX usage_credit_request; ALTER TABLE usage DROP COLUMN credit_request_id; DROP INDEX usage_channel_run; CREATE UNIQUE INDEX usage_channel_run ON usage(channel_run_id) WHERE channel_run_id IS NOT NULL');
      db.exec("DROP INDEX usage_arena; ALTER TABLE usage DROP COLUMN arena_side; ALTER TABLE usage DROP COLUMN arena_battle_id; DROP TABLE arena_votes; DROP TABLE arena_contents; DROP TABLE arena_panes; DROP TABLE arena_battles; DROP TABLE arena_models; DROP TABLE arena_rating_meta;");
      db.exec('PRAGMA user_version = ' + (version-2)); console.log(version); db.close();`).trim());
    assert.throws(() => run(`await import(${JSON.stringify(dbUrl)})`, { OKAYCHAT_TEST_FAIL_MIGRATION: "token-credits" }));
    const rolled = JSON.parse(run(`import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(${JSON.stringify(path.join(directory, "okaychat.db"))}); console.log(JSON.stringify({version:db.prepare('PRAGMA user_version').get().user_version,tables:db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'token_credit_%'").get().n,columns:db.prepare('PRAGMA table_info(usage)').all().filter(c=>c.name==='credit_request_id').length,index:db.prepare("SELECT sql FROM sqlite_master WHERE name='usage_channel_run'").get().sql})); db.close();`));
    assert.equal(rolled.version, version - 2); assert.equal(rolled.tables, 0); assert.equal(rolled.columns, 0); assert.match(rolled.index, /UNIQUE/);
    let start: number | undefined;
    for (let i = 0; i < 2; i++) {
      const result = JSON.parse(run(`const {db}=await import(${JSON.stringify(dbUrl)}); console.log(JSON.stringify({version:db.prepare('PRAGMA user_version').get().user_version,account:db.prepare("SELECT * FROM token_credit_accounts WHERE user_id='legacy'").get(),usage:db.prepare('SELECT input_tokens,credit_request_id FROM usage').get(),fk:db.prepare('PRAGMA foreign_key_check').all(),audit:db.prepare('SELECT COUNT(*) AS n FROM token_credit_audit').get().n})); db.close();`));
      assert.equal(result.version, version); assert.equal(result.account.credit_tokens, null); assert.equal(result.account.consumed_tokens, 0); assert.equal(result.account.unknown_requests, 0);
      assert.equal(result.usage.input_tokens, 100); assert.equal(result.usage.credit_request_id, null); assert.equal(result.audit, 0); assert.deepEqual(result.fk, []);
      if (start !== undefined) assert.equal(result.account.period_started_at, start);
      start = result.account.period_started_at;
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
