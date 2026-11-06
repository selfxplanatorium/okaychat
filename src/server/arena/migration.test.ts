import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("Arena append-only migration rewinds, fails atomically and reopens twice without changing legacy rows", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "okaychat-arena-migration-"));
  const url = new URL("../db.ts", import.meta.url).href;
  const run = (code: string, extra: Record<string, string> = {}) => execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    env: { ...process.env, OKAYCHAT_DATA_DIR: dir, OKAYCHAT_SECRET: "arena-migration-test-secret-not-for-production", ...extra }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  const direct = `import {DatabaseSync} from 'node:sqlite';import path from 'node:path';const db=new DatabaseSync(path.join(process.env.OKAYCHAT_DATA_DIR,'okaychat.db'));`;
  const legacy = `['users','comparison_groups','evaluation_datasets','usage','token_credit_accounts','token_credit_roots','token_credit_requests'].map(t=>[t,db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()])`;
  try {
    const prior = JSON.parse(run(`const {db}=await import(${JSON.stringify(url)});
      db.exec("INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES ('u','u@example.test','U','x','user',1)");
      db.exec("INSERT INTO comparison_groups(id,user_id,title,prompt,created_at,updated_at) VALUES ('c','u','old','old prompt',1,1)");
      db.exec("INSERT INTO evaluation_datasets(id,user_id,name,created_at,updated_at) VALUES ('e','u','old',1,1)");
      db.exec("INSERT INTO usage(user_id,provider_id,model_id,kind,input_tokens,output_tokens,cost,created_at) VALUES ('u','fixture','old','chat',4,6,1,1)");
      db.exec("INSERT INTO token_credit_accounts(user_id,credit_tokens,period_started_at,consumed_tokens) VALUES ('u',1000,1,10)");
      db.exec("INSERT INTO token_credit_roots(id,user_id,period,origin,exclusive,state,started_at) VALUES ('r','u',1,'chat',1,'finished',1)");
      db.exec("INSERT INTO token_credit_requests(id,root_id,user_id,period,provider_id,model_id,kind,state,context_json,created_at) VALUES ('q','r','u',1,'fixture','old','chat','not_dispatched','{}',1)");
      const version=db.prepare('PRAGMA user_version').get().user_version;
      db.exec('DROP INDEX usage_arena; ALTER TABLE usage DROP COLUMN arena_side; ALTER TABLE usage DROP COLUMN arena_battle_id; DROP TABLE arena_votes; DROP TABLE arena_contents; DROP TABLE arena_panes; DROP TABLE arena_battles; DROP TABLE arena_models; DROP TABLE arena_rating_meta; PRAGMA user_version='+(version-1));
      console.log(JSON.stringify({version:version-1,legacy:${legacy},schema:db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all()}));db.close();`));
    assert.throws(() => run(`await import(${JSON.stringify(url)})`, { OKAYCHAT_TEST_FAIL_MIGRATION: "arena" }));
    const failed = JSON.parse(run(direct + `console.log(JSON.stringify({version:db.prepare('PRAGMA user_version').get().user_version,legacy:${legacy},schema:db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all()}));db.close();`));
    assert.deepEqual(failed, prior);
    for (let i = 0; i < 2; i++) {
      const state = JSON.parse(run(`const {db}=await import(${JSON.stringify(url)});
        const old=${legacy};old.find(([t])=>t==='usage')[1].forEach(r=>{delete r.arena_battle_id;delete r.arena_side});
        console.log(JSON.stringify({version:db.prepare('PRAGMA user_version').get().user_version,legacy:old,fks:db.prepare('PRAGMA foreign_key_check').all(),tables:db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE 'arena_%'").get().n,index:db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='usage_arena'").get().n}));db.close();`));
      assert.equal(state.version, prior.version + 1); assert.deepEqual(state.legacy, prior.legacy);
      assert.deepEqual(state.fks, []); assert.equal(state.tables, 6); assert.equal(state.index, 1);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
