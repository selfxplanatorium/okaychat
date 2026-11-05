/// <reference types="node" />
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import type { JobView } from '@shared/chat-import';
const previousFetch=globalThis.fetch;
const pending:Array<(response:Response)=>void>=[];
globalThis.fetch=(()=>new Promise<Response>((resolve)=>pending.push(resolve))) as typeof fetch;
const {useConversationImports,startConversationImportAccount}=await import('./conversation-imports.js');
const answer=(body:unknown)=>pending.shift()!(new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}}));
const flush=()=>new Promise<void>((resolve)=>setImmediate(resolve));
beforeEach(()=>{assert.equal(pending.length,0);startConversationImportAccount('');startConversationImportAccount('alice');});
after(()=>{globalThis.fetch=previousFetch;});
const job={id:'owned-job',state:'ready',kind:'import',counts:{imported:0},canCancel:true} as JobView;
test('late job lists cannot cross an account boundary',async()=> {
  const request=useConversationImports.getState().refresh();
  startConversationImportAccount('bob');answer({jobs:[{...job,title:'private title'}]});await request;
  assert.deepEqual(useConversationImports.getState().jobs,[]);assert.equal(useConversationImports.getState().job,null);
});
test('an account change after job loading prevents dependent preview requests',async()=> {
  const request=useConversationImports.getState().select(job.id);
  startConversationImportAccount('bob');answer(job);await request;
  assert.equal(pending.length,0);assert.equal(useConversationImports.getState().job,null);
});
test('late private preview pages are discarded on sign out',async()=> {
  const request=useConversationImports.getState().select(job.id);answer(job);await flush();
  assert.equal(pending.length,1);startConversationImportAccount('');answer({items:[{title:'Private source title'}],nextCursor:null});await request;
  assert.deepEqual(useConversationImports.getState().items,[]);assert.equal(useConversationImports.getState().job,null);
});
test('a late confirmation cannot repopulate another account or trigger its refresh',async()=> {
  useConversationImports.setState({job});
  const request=useConversationImports.getState().confirm(['item'],null);
  startConversationImportAccount('bob');answer({...job,state:'queued'});await request;
  assert.equal(pending.length,0);assert.equal(useConversationImports.getState().job,null);assert.equal(useConversationImports.getState().busy,false);
});
test('a late upload response cannot load a former account job',async()=> {
  const request=useConversationImports.getState().start(new File(['{}'],'synthetic.json',{type:'application/json'}));
  startConversationImportAccount('bob');answer({jobId:'private-job'});await request;
  assert.equal(pending.length,0);assert.equal(useConversationImports.getState().job,null);assert.equal(useConversationImports.getState().busy,false);
});
