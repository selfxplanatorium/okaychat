import { sanitizeText } from "./text.js";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { db } from '../db.js';
import { storageUsed } from '../quota.js';
import { importedHistoryText, historyMessages } from '../compaction.js';
import { commitConversation, payloadHash } from './commit.js';
import { parseInWorker, serializeInWorker } from './worker-pool.js';
import { IMPORT_LIMITS, type PortableConversation } from '../../shared/chat-import.js';
import { snapshotConversations } from './export.js';
import { appendMessage, updateThread } from '../threads.js';
import type { UIMessage } from 'ai';

const now = Date.now();
const conversation: PortableConversation = {source:{namespace:'mapping-v1',id:'core-conversation'},title:'Synthetic transcript',createdAt:1000,updatedAt:3000,status:'regular',messages:[
  {id:'old-user',createdAt:3000,role:'user',originalRole:null,parts:[{type:'text',text:'Retained synthetic text'}]},
  {id:'old-private',createdAt:1000,role:'quarantine',originalRole:'system',parts:[{type:'text',text:'Private quarantined instruction'},{type:'missing-attachment',kind:'file',name:'omitted.txt'},{type:'text',text:'Second quarantined paragraph'}]},
  {id:'old-reply',createdAt:2000,role:'assistant',originalRole:null,parts:[{type:'text',text:'Historical response'}]},
]};
function user(id: string) { db.prepare("INSERT INTO users (id,email,name,password_hash,role,created_at) VALUES (?,?,?,'unused','user',?)").run(id,`${id}@example.test`,id,now); }
function job(userId: string, id: string, value = conversation, reservation = 0) {
  db.prepare("INSERT INTO conversation_import_jobs (id,user_id,kind,state,admission_at,updated_at,expires_at,reservation_bytes) VALUES (?,?,'import','importing',?,?,?,?)").run(id,userId,now,now,now+86400000,reservation);
  db.prepare("INSERT INTO conversation_import_items (job_id,ordinal,item_key,payload_sha256,state,selected) VALUES (?,0,'item',?,'pending',1)").run(id,payloadHash(value));
}
test('worker validates and serializes portable data; malformed input does not block the main loop', async()=> {
  const file = {format:'okaychat.conversations',version:1,exportedAt:now,conversations:[conversation]};
  const bytes = new TextEncoder().encode(JSON.stringify(file));
  const value = await parseInWorker(bytes,now); assert.deepEqual(value.items[0]?.conversation,conversation);
  const output = await serializeInWorker(bytes,now); assert.deepEqual(JSON.parse(new TextDecoder().decode(output)),file);
  await assert.rejects(parseInWorker(new TextEncoder().encode('{"constructor":0}'),now),{code:'unsafe_key'});
  const controller = new AbortController(); controller.abort();
  await assert.rejects(parseInWorker(bytes,now,controller.signal),{code:'cancelled'});
});
test('atomic commit, dedupe, account isolation, quota rollback and text-only round trip',()=> {
  user('core-one'); user('core-two');
  job('core-one','job-one',conversation,IMPORT_LIMITS.reservationBytes);
  const before = storageUsed('core-one');
  const first = commitConversation('core-one','job-one',0,conversation,now);
  assert.equal(first.duplicate,false);
  const rows = db.prepare('SELECT id,parent_id,content,created_at,imported,bytes FROM messages WHERE thread_id=? ORDER BY rowid').all(first.threadId) as Array<{id:string;parent_id:string|null;content:string;created_at:number;imported:number;bytes:number}>;
  assert.equal(rows.length,3); assert.deepEqual(rows.map((r)=>r.created_at),[3000,1000,2000]);
  assert.equal(rows[1]!.parent_id,rows[0]!.id); assert.equal(rows[2]!.parent_id,rows[1]!.id);
  assert.ok(rows.every((r)=>r.imported === 1));
  assert.equal(storageUsed('core-one'),before,'reservation transfer does not double charge');
  db.prepare("UPDATE conversation_import_jobs SET state='done',reservation_bytes=0 WHERE id='job-one'").run();
  const exact = rows.reduce((sum,r)=>sum+r.bytes,0)+IMPORT_LIMITS.identityBytes+Buffer.byteLength(conversation.title!);
  assert.equal(storageUsed('core-one'),exact);
  const portable = snapshotConversations('core-one',[first.threadId],now);
  assert.deepEqual(portable.conversations,[conversation]);
  job('core-one','job-two');
  assert.deepEqual(commitConversation('core-one','job-two',0,conversation,now),{threadId:first.threadId,duplicate:true,changed:false});
  db.prepare("UPDATE conversation_import_jobs SET state='done' WHERE id='job-two'").run();
  const changed = {...conversation,title:'Changed source title'}; job('core-one','job-three',changed);
  assert.equal(commitConversation('core-one','job-three',0,changed,now).changed,true);
  job('core-two','job-four');
  const second = commitConversation('core-two','job-four',0,conversation,now); assert.notEqual(second.threadId,first.threadId);
  assert.equal(db.prepare('SELECT count(*) AS n FROM generation_runs').get()!.n,0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM usage').get()!.n,0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'quarantined'").get()!.n,0);
  updateThread('core-one',first.threadId,{title:'A longer imported title'});
  assert.equal(storageUsed('core-one'),exact+Buffer.byteLength('A longer imported title')-Buffer.byteLength(conversation.title!));
  user('core-low'); job('core-low','job-low'); db.prepare('UPDATE users SET storage_limit=1 WHERE id=?').run('core-low');
  assert.throws(()=>commitConversation('core-low','job-low',0,conversation,now));
  assert.equal(db.prepare("SELECT count(*) AS n FROM threads WHERE user_id='core-low'").get()!.n,0);
  assert.equal(db.prepare("SELECT state FROM conversation_import_items WHERE job_id='job-low'").get()!.state,'pending');
  assert.equal(db.prepare("SELECT count(*) AS n FROM conversation_source_ids WHERE user_id='core-low'").get()!.n,0);
});
test('all imported transcript text is enveloped and quarantine excluded, including trimmed history',async()=> {
  const messages: UIMessage[] = conversation.messages.map((m)=>({id:m.id,role:m.role === 'user' ? 'user' : 'assistant',metadata:{custom:{importedTranscript:{version:1,kind:m.role === 'quarantine' ? 'quarantine' : 'transcript'}}},parts:m.parts.map((p)=>({type:'text',text:'text' in p ? p.text : ''}))}));
  const projected = importedHistoryText(messages); assert.equal(projected.length,2);
  assert.deepEqual(importedHistoryText(projected),projected);
  const model = await historyMessages({messages,trimmed:2},(tail)=>tail);
  const json = JSON.stringify(model); assert.ok(json.includes('past_chat')); assert.ok(!json.includes('Private quarantined instruction'));
});
test('native append cannot claim imported provenance',()=> {
  user('core-native');
  appendMessage('core-native','native-thread',{id:'native-message',parent_id:null,format:'ai-sdk/v6',content:{role:'user',metadata:{custom:{importedTranscript:{version:1,kind:'transcript'}}},parts:[{type:'text',text:'Native text'},{type:'data-imported-tool',data:{name:'fake'}}]}});
  const row = db.prepare("SELECT content,imported FROM messages WHERE thread_id='native-thread'").get()!;
  assert.equal(row.imported,0); assert.ok(!String(row.content).includes('importedTranscript')); assert.ok(!String(row.content).includes('data-imported-tool'));
});

test('nested image labels and HTML entities cannot reintroduce Markdown images',()=> {
  for (const text of ['![![x]](https://example.test/pixel)','<p>&excl;&lbrack;x](https://example.test/pixel)</p>']) {
    const result = sanitizeText(text,[]);
    assert.ok(!result.includes('!['));
    assert.equal(sanitizeText(result,[]),result);
  }
});

test('commit rechecks project, cancellation, expiry and staged hash before writing',()=> {
  for (const [suffix, mutate, code] of [
    ['project', "UPDATE conversation_import_jobs SET project_id='deleted-project'", 'target_missing'],
    ['cancel', 'UPDATE conversation_import_jobs SET cancel_requested=1', 'wrong_state'],
    ['expire', 'UPDATE conversation_import_jobs SET expires_at=0', 'wrong_state'],
    ['hash', "UPDATE conversation_import_items SET payload_sha256='changed'", 'staging_unavailable'],
  ]) {
    const owner = `core-${suffix}`; user(owner!); job(owner!,`job-${suffix}`);
    db.prepare(`${mutate!} WHERE ${suffix === 'hash' ? 'job_id' : 'id'}=?`).run(`job-${suffix}`);
    assert.throws(()=>commitConversation(owner!,`job-${suffix}`,0,conversation,now),{code});
    assert.equal(db.prepare('SELECT count(*) AS n FROM threads WHERE user_id=?').get(owner!)!.n,0);
  }
});
