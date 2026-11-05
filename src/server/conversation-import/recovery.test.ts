import { assertStagingCapacity, conversationStagingReserved } from "../archive-staging-budget.js";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { db } from '../db.js';
import { storageUsed } from '../quota.js';
import { IMPORT_LIMITS as L } from '../../shared/chat-import.js';
import { receiveImport,confirmImport,cancelImport,createExport,recoverImports,kickImports,resumeImport,maintainImports } from './jobs.js';
import { admitJob,allItems,hashBytes,getJob,finishJob,readBounded,jobDir,jobView,type JobRow } from './store.js';
import { commitConversation } from './commit.js';

const now=Date.now();
function owner(id:string) {db.prepare("INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES (?,?,?,'unused','user',?)").run(id,`${id}@example.test`,id,now);}
function conversation(id:string) {return {source:{namespace:'portable-v1' as const,id},title:'Synthetic transfer',createdAt:1000,updatedAt:3000,status:'regular' as const,messages:[{id:'message',createdAt:2000,role:'user' as const,originalRole:null,parts:[{type:'text' as const,text:`Transcript ${id}`}]}]};}
async function upload(userId:string,count=1) {
  const conversations=Array.from({length:count},(_,i)=>conversation(`${userId}-${i}`));
  const row=await receiveImport(userId,new Request('http://localhost/conversation-imports',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({format:'okaychat.conversations',version:1,exportedAt:now,conversations})}));
  return {row:await until(userId,row.id,'ready'),conversations};
}
async function until(userId:string,id:string,state:string):Promise<JobRow> {
  const deadline=Date.now()+10000;
  while(Date.now()<deadline) {const row=getJob(userId,id)!;if(row.state===state) return row;if(row.state==='failed') assert.fail(`job failed: ${row.error_code}`);await tick();}
  return assert.fail(`job did not reach ${state}`);
}
test('restart fails interrupted uploads and preserves ready previews without extending TTL',async()=> {
  owner('restart-ready');const interrupted=admitJob('restart-ready','import');
  recoverImports();assert.equal(getJob('restart-ready',interrupted.id)!.error_code,'upload_interrupted');assert.ok(!existsSync(jobDir(interrupted)));
  const {row}=await upload('restart-ready');const keys=allItems(row.id).map((i)=>i.item_key);
  recoverImports();const restored=getJob(row.user_id,row.id)!;
  assert.equal(restored.state,'ready');assert.equal(restored.expires_at,row.expires_at);assert.deepEqual(allItems(row.id).map((i)=>i.item_key),keys);
  cancelImport(row.user_id,row.id);
});
test('restart resumes only pending items and keeps already committed chats exactly once',async()=> {
  owner('restart-pending');const {row,conversations}=await upload('restart-pending',2);const items=allItems(row.id);
  // Durable checkpoint equivalent to a crash between two bounded transactions.
  db.prepare("UPDATE conversation_import_jobs SET state='importing',confirmation_sha256=?,selection_json=? WHERE id=?").run(hashBytes(JSON.stringify({itemKeys:items.map((i)=>i.item_key).sort(),projectId:null})),JSON.stringify(items.map((i)=>i.item_key).sort()),row.id);
  db.prepare("UPDATE conversation_import_items SET state='pending',selected=1 WHERE job_id=?").run(row.id);
  const first=commitConversation(row.user_id,row.id,0,conversations[0]!);
  recoverImports();assert.equal(getJob(row.user_id,row.id)!.state,'queued');kickImports();
  await until(row.user_id,row.id,'done');const outcome=allItems(row.id);
  assert.equal(outcome[0]!.thread_id,first.threadId);assert.ok(outcome.every((i)=>i.state==='imported'));
  assert.equal(db.prepare('SELECT count(*) AS n FROM threads WHERE user_id=?').get(row.user_id)!.n,2);
});
test('cancel between conversation commits retains the completed chat and prevents the next claim',async()=> {
  owner('cancel-checkpoint');const {row}=await upload('cancel-checkpoint',3);
  confirmImport(row.user_id,row.id,allItems(row.id).map((i)=>i.item_key),null);
  await tick();assert.equal(allItems(row.id).filter((i)=>i.state==='imported').length,1);
  cancelImport(row.user_id,row.id);await until(row.user_id,row.id,'cancelled');
  const result=jobView(getJob(row.user_id,row.id)!);
  assert.equal(result.counts.imported,1);assert.equal(result.counts.cancelled,2);assert.equal(result.counts.processed,3);
  assert.equal(db.prepare('SELECT count(*) AS n FROM threads WHERE user_id=?').get(row.user_id)!.n,1);
  assert.equal(storageUsed(row.user_id),allItems(row.id)[0]!.normalized_bytes);
});
test('quota pauses atomically, remains paused on recovery, and explicit resume transfers reservation once',async()=> {
  owner('quota-checkpoint');const {row}=await upload('quota-checkpoint');
  db.prepare('UPDATE users SET storage_limit=1 WHERE id=?').run(row.user_id);
  confirmImport(row.user_id,row.id,allItems(row.id).map((i)=>i.item_key),null);await until(row.user_id,row.id,'paused');
  assert.equal(db.prepare('SELECT count(*) AS n FROM threads WHERE user_id=?').get(row.user_id)!.n,0);
  assert.equal(getJob(row.user_id,row.id)!.reservation_bytes,L.reservationBytes);
  recoverImports();assert.equal(getJob(row.user_id,row.id)!.state,'paused');
  db.prepare('UPDATE users SET storage_limit=? WHERE id=?').run(1024*1024*1024,row.user_id);
  resumeImport(row.user_id,row.id);await until(row.user_id,row.id,'done');
  assert.equal(storageUsed(row.user_id),allItems(row.id)[0]!.normalized_bytes);
});
test('tampered staged files fail closed at restart and expired previews release bytes',async()=> {
  owner('tamper-checkpoint');const {row}=await upload('tamper-checkpoint');
  writeFileSync(path.join(jobDir(row),'0.json'),'{}');recoverImports();
  assert.equal(getJob(row.user_id,row.id)!.error_code,'staging_unavailable');assert.equal(storageUsed(row.user_id),0);
  const next=await upload('tamper-checkpoint');maintainImports(next.row.expires_at+1);
  assert.equal(getJob(row.user_id,next.row.id)!.state,'expired');assert.equal(storageUsed(row.user_id),0);assert.ok(!existsSync(jobDir(next.row)));
});

test('admission caps work before receiving bytes and shares physical reservations with both archive families',()=> {
  const rows:JobRow[]=[];
  for(let i=0;i<6;i++) {const id=`capacity-${i}`;owner(id);rows.push(admitJob(id,'import'));}
  assert.equal(conversationStagingReserved(),6*L.reservationBytes);
  owner('capacity-overflow');
  assert.throws(()=>admitJob('capacity-overflow','import'),{status:429});
  assert.throws(()=>admitJob('capacity-0','import'),{status:409});
  assert.throws(()=>assertStagingCapacity(256*1024*1024),{status:413});
  for(const row of rows) finishJob(row,'cancelled');
  assert.equal(conversationStagingReserved(),0);
});

test('native export dedupe hashes the worker-normalized transcript and never restores remote images',async()=> {
  const id='normalized-export';owner(id);
  db.prepare("INSERT INTO threads(id,user_id,title,status,created_at,updated_at) VALUES (?,?,?,'regular',1000,2000)").run('normalized-thread',id,'<b>Native title</b>');
  db.prepare("INSERT INTO messages(id,thread_id,parent_id,format,content,created_at) VALUES ('native-m','normalized-thread',NULL,'ai-sdk/v6',?,1500)").run(JSON.stringify({role:'user',parts:[{type:'text',text:'<b>Historical text</b> ![pixel](https://example.test/never)'}]}));
  const exported=createExport(id,[{id:'normalized-thread'}]);await until(id,exported.id,'ready');
  const bytes=readBounded(getJob(id,exported.id)!,'output.json',L.inputBytes);
  const file=JSON.parse(bytes.toString()) as {conversations:Array<ReturnType<typeof conversation>>};
  assert.equal(file.conversations[0]!.title,'Native title');assert.ok(!bytes.toString().includes('!['));
  cancelImport(id,exported.id);
  const uploaded=await receiveImport(id,new Request('http://localhost/',{method:'POST',headers:{'content-type':'application/json'},body:bytes}));
  await until(id,uploaded.id,'ready');const item=allItems(uploaded.id)[0]!;
  assert.equal(item.state,'duplicate');assert.equal(item.error_code,null);assert.equal(item.thread_id,'normalized-thread');
  cancelImport(id,uploaded.id);
});
