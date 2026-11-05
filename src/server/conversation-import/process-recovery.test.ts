import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('a fresh process resumes a durable commit checkpoint without duplicating its first chat',()=> {
  const directory=mkdtempSync(path.join(tmpdir(),'conversation-restart-'));
  const modules={db:new URL('../db.ts',import.meta.url).href,jobs:new URL('./jobs.ts',import.meta.url).href,store:new URL('./store.ts',import.meta.url).href,commit:new URL('./commit.ts',import.meta.url).href};
  const prelude=`const {db}=await import(${JSON.stringify(modules.db)});const jobs=await import(${JSON.stringify(modules.jobs)});const store=await import(${JSON.stringify(modules.store)});const delay=ms=>new Promise(r=>setTimeout(r,ms));`;
  const run=(script:string)=>execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',prelude+script],{cwd:process.cwd(),env:{...process.env,OKAYCHAT_DATA_DIR:directory,OKAYCHAT_SECRET:'synthetic-process-restart-test-secret-32chars'},encoding:'utf8',timeout:20000});
  try {
    const first=JSON.parse(run(`
      db.exec("INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES ('restart','restart@example.test','Restart','unused','user',1)");
      const now=Date.now();const conversations=[0,1].map(i=>({source:{namespace:'portable-v1',id:'restart-'+i},title:'Checkpoint '+i,createdAt:1000,updatedAt:2000,status:'regular',messages:[{id:'m',createdAt:1500,role:'user',originalRole:null,parts:[{type:'text',text:'Checkpoint '+i}]}]}));
      const row=await jobs.receiveImport('restart',new Request('http://localhost/',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({format:'okaychat.conversations',version:1,exportedAt:now,conversations})}));
      for(let i=0;i<200 && store.getJob('restart',row.id).state!=='ready';i++) await delay(10);
      if(store.getJob('restart',row.id).state!=='ready') throw new Error('preview did not settle');
      const keys=store.allItems(row.id).map(i=>i.item_key).sort();
      db.prepare("UPDATE conversation_import_jobs SET state='importing',confirmation_sha256=?,selection_json=? WHERE id=?").run(store.hashBytes(JSON.stringify({itemKeys:keys,projectId:null})),JSON.stringify(keys),row.id);
      db.prepare("UPDATE conversation_import_items SET state='pending',selected=1 WHERE job_id=?").run(row.id);
      const {commitConversation}=await import(${JSON.stringify(modules.commit)});const first=commitConversation('restart',row.id,0,conversations[0]);
      console.log(JSON.stringify({jobId:row.id,threadId:first.threadId}));
      // Simulate process loss immediately after the durable conversation checkpoint.
      process.exit(0);
    `)) as {jobId:string;threadId:string};
    const second=JSON.parse(run(`
      jobs.recoverImports();jobs.startImports();
      for(let i=0;i<200 && store.getJob('restart',${JSON.stringify(first.jobId)}).state!=='done';i++) await delay(10);
      const row=store.getJob('restart',${JSON.stringify(first.jobId)});
      console.log(JSON.stringify({state:row.state,threads:db.prepare("SELECT count(*) AS n FROM threads WHERE user_id='restart'").get().n,first:store.allItems(row.id)[0].thread_id,processed:store.jobView(row).counts.processed}));
      await jobs.stopImports();db.close();
    `)) as {state:string;threads:number;first:string;processed:number};
    assert.deepEqual(second,{state:'done',threads:2,first:first.threadId,processed:2});
  } finally {rmSync(directory,{recursive:true,force:true});}
});
