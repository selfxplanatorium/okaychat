import assert from "node:assert/strict";
import { test } from "node:test";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
const directory = mkdtempSync(join(tmpdir(), "okaychat-permissions-"));
process.env.OKAYCHAT_DATA_DIR = directory;
process.env.OKAYCHAT_SECRET = "permission-test-secret-only-not-for-production";
after(() => rmSync(directory, { recursive: true, force: true }));
const { db } = await import("../db.js");
const { reserveOperation, setLimitClock } = await import("./limits.js");

test("rate reservations use fixed minute windows and failed admission does not consume capacity",()=>{
 const id="limit-test-"+Date.now(); let now=120_000; setLimitClock(()=>now);
 try {
  db.prepare("INSERT INTO users (id,email,name,password_hash,role,created_at) VALUES (?,?,?,'x','user',1)").run(id,id+"@test",id);
  db.prepare("INSERT INTO permission_policies (subject_kind,subject_id,model_ref,document,updated_at,updated_by) VALUES ('user',?,'',?,1,NULL)").run(id,JSON.stringify({version:1,limits:{operationsPerMinute:1,concurrentOperations:1}}));
  const lease=reserveOperation({userId:id,modelRef:"p/m"},"llm.call");
  assert.throws(()=>reserveOperation({userId:id,modelRef:"p/m"},"llm.call"));
  lease.release(); now=180_000;
  const next=reserveOperation({userId:id,modelRef:"p/m"},"llm.call"); next.release();
 } finally { setLimitClock(null); db.prepare("DELETE FROM users WHERE id=?").run(id); }
});
