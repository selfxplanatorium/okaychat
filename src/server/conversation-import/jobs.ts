import { constants, closeSync, fsyncSync, openSync, renameSync, rmSync, readdirSync, lstatSync, writeSync } from 'node:fs';
import path from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { z } from 'zod';
import { db, tx } from '../db.js';
import { newId } from '../crypto.js';
import { getSettings } from '../settings.js';
import { AppError } from '../errors.js';
import { messageBytes } from '../quota.js';
import { storedContent } from './stored-content.js';
import { IMPORT_LIMITS as L, type PortableConversation, type NormalizedItem } from '../../shared/chat-import.js';
import { parseInWorker, serializeInWorker, stopImportWorkers } from './worker-pool.js';
import { ImportFailure, parseJson } from './json.js';
import { commitConversation, payloadHash } from './commit.js';
import { snapshotConversations } from './export.js';
import { admitJob, allItems, atomicFile, cleanupJob, finishJob, getJob, hashBytes, jobDir, problem, readBounded, requireJob, stagingRoot, syncDir, terminal, type JobRow, type Manifest } from './store.js';

const active = new Map<string,AbortController>();
const uploads = new Map<string,()=>void>();
let stopped = false;
let maintenance:ReturnType<typeof setInterval>|undefined;
const manifestSchema = z.object({version:z.literal(1),adapter:z.enum(['mapping-v1','portable-v1']),adapterVersion:z.literal(1),items:z.array(z.object({ordinal:z.number().int().min(0).max(999),itemKey:z.string().max(100),fileSha256:z.string().regex(/^[a-f0-9]{64}$/),fileBytes:z.number().int().positive().max(L.conversationBytes+65536)}).strict()).max(L.conversations)}).strict();
const safeCode = (error:unknown):string => error instanceof ImportFailure ? error.code : error instanceof AppError && error.code==='storage_quota' ? 'storage_quota' : 'internal_error';
export function loadManifest(row:JobRow):Manifest {
  const bytes=readBounded(row,'manifest.json',1024*1024);
  if (hashBytes(bytes)!==row.manifest_sha256 || row.adapter_version!==1) throw new ImportFailure('staging_unavailable');
  const parsed=manifestSchema.safeParse(parseJson(bytes));
  if (!parsed.success || parsed.data.adapter!==row.adapter || new Set(parsed.data.items.map((i)=>i.ordinal)).size!==parsed.data.items.length) throw new ImportFailure('staging_unavailable');
  let total=bytes.length;
  for (const item of parsed.data.items) {total+=item.fileBytes;if(total>L.stagingBytes) throw new ImportFailure('staging_unavailable');}
  return parsed.data;
}
function stagedConversation(row:JobRow,entry:Manifest['items'][number]):PortableConversation {
  const bytes=readBounded(row,`${entry.ordinal}.json`,L.conversationBytes+65536);
  if (bytes.length!==entry.fileBytes || hashBytes(bytes)!==entry.fileSha256) throw new ImportFailure('staging_unavailable');
  const item=parseJson(bytes) as {version?:unknown;conversation?:PortableConversation};
  if (item.version!==1 || !item.conversation) throw new ImportFailure('staging_unavailable');
  return item.conversation;
}
export function verifyStaging(row:JobRow):void {
  if (row.adapter_version!==1) throw new ImportFailure('staging_unavailable');
  if (row.kind==='export' || row.state==='validating') {
    const bytes=readBounded(row,row.kind==='export' && row.state==='ready' ? 'output.json' : 'input.json',L.inputBytes);
    const expected=row.kind==='export' && row.state==='ready' ? row.manifest_sha256 : row.input_sha256;
    if (!expected || hashBytes(bytes)!==expected) throw new ImportFailure('staging_unavailable');
  } else {
    const manifest=loadManifest(row), items=allItems(row.id);
    if(['queued','importing','paused'].includes(row.state)) {
      const selection=row.selection_json ? z.array(z.string().min(1).max(100)).min(1).max(L.conversations).safeParse(parseJson(Buffer.from(row.selection_json))) : null;
      if(!selection?.success || new Set(selection.data).size!==selection.data.length || row.confirmation_sha256!==hashBytes(JSON.stringify({itemKeys:[...selection.data].sort(),projectId:row.project_id})) || items.filter((i)=>i.selected).length!==selection.data.length || selection.data.some((key)=>!items.some((i)=>i.selected && i.item_key===key))) throw new ImportFailure('staging_unavailable');
    }
    for (const entry of manifest.items) {
      const item=items.find((i)=>i.ordinal===entry.ordinal && i.item_key===entry.itemKey);
      if (!item || payloadHash(stagedConversation(row,entry))!==item.payload_sha256) throw new ImportFailure('staging_unavailable');
    }
    if (items.some((i)=>i.state==='pending' && !manifest.items.some((e)=>e.ordinal===i.ordinal))) throw new ImportFailure('staging_unavailable');
  }
}
function live(row:JobRow):JobRow {
  const current=getJob(row.user_id,row.id);
  if (!current || current.cancel_requested || current.state==='cancelling' || terminal(current.state)) throw new ImportFailure('cancelled');
  if (current.expires_at<=Date.now()) throw new ImportFailure('expired');
  return current;
}
async function validateImport(row:JobRow,signal:AbortSignal):Promise<void> {
  const bytes=readBounded(row,'input.json',L.inputBytes);if(hashBytes(bytes)!==row.input_sha256) throw new ImportFailure('staging_unavailable');
  const parsed=await parseInWorker(bytes,row.admission_at,signal); live(row);
  const manifest:Manifest={version:1,adapter:parsed.adapter,adapterVersion:1,items:[]};
  const prepared:Array<{item:NormalizedItem;key:string;size:number}>=[];
  let total=0;
  for (const item of parsed.items) {
    live(row); const key=newId('cii');let size=0;
    if (item.conversation) {
      const body=JSON.stringify({version:1,conversation:item.conversation,warnings:item.warnings,counts:item.counts});
      size=Buffer.byteLength(body);total+=size;
      if(total>L.stagingBytes-1024*1024) throw new ImportFailure('too_large');
      // Revalidation after restart overwrites only uncommitted preview staging.
      rmSync(path.join(jobDir(row),`${item.ordinal}.json.partial`),{force:true});
      atomicFile(row,`${item.ordinal}.json`,body);
      manifest.items.push({ordinal:item.ordinal,itemKey:key,fileSha256:hashBytes(body),fileBytes:size});
    }
    prepared.push({item,key,size});await yieldTurn();
  }
  live(row);
  rmSync(path.join(jobDir(row),'manifest.json.partial'),{force:true});
  const serialized=JSON.stringify(manifest);atomicFile(row,'manifest.json',serialized);
  tx(()=> {
    live(row);db.prepare('DELETE FROM conversation_import_items WHERE job_id=?').run(row.id);
    const insert=db.prepare(`INSERT INTO conversation_import_items (job_id,ordinal,item_key,source_namespace,source_id,payload_sha256,title,created_at,updated_at,message_count,normalized_bytes,warnings_json,state,thread_id,error_code) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const {item,key,size} of prepared) {
      const c=item.conversation;
      const existing=c ? db.prepare('SELECT thread_id,payload_sha256 FROM conversation_source_ids WHERE user_id=? AND namespace=? AND source_id=?').get(row.user_id,c.source.namespace,c.source.id) as {thread_id:string;payload_sha256:string}|undefined : undefined;
      const hash=c ? payloadHash(c) : null;
      insert.run(row.id,item.ordinal,key,c?.source.namespace??null,c?.source.id??null,hash,c?.title??null,c?.createdAt??null,c?.updatedAt??null,c?.messages.length??0,c ? c.messages.reduce((n,m)=>n+messageBytes(JSON.stringify(storedContent(m))),0)+L.identityBytes+Buffer.byteLength(c.title??'') : 0,JSON.stringify({warnings:item.warnings,counts:item.counts}),!c ? 'invalid' : existing ? 'duplicate' : 'valid',existing?.thread_id??null,existing && existing.payload_sha256!==hash ? 'source_changed' : item.errorCode);
    }
    db.prepare("UPDATE conversation_import_jobs SET state='ready',adapter=?,adapter_version=1,manifest_sha256=?,model_ref=?,updated_at=? WHERE id=?").run(parsed.adapter,hashBytes(serialized),getSettings(row.user_id).defaultModel??null,Date.now(),row.id);
  });
  rmSync(path.join(jobDir(row),'input.json'),{force:true});
  // All-duplicate previews still permit reviewing links; only entirely rejected exports fail.
  if (!prepared.some(({item})=>item.conversation)) finishJob(row,'failed','invalid_conversation');
}
async function importItems(row:JobRow):Promise<void> {
  const manifest=loadManifest(row);
  db.prepare("UPDATE conversation_import_jobs SET state='importing',updated_at=? WHERE id=? AND state='queued'").run(Date.now(),row.id);
  for (const entry of manifest.items) {
    live(row);
    const item=db.prepare('SELECT state FROM conversation_import_items WHERE job_id=? AND ordinal=?').get(row.id,entry.ordinal) as {state:string}|undefined;
    if (item?.state!=='pending') continue;
    try {commitConversation(row.user_id,row.id,entry.ordinal,stagedConversation(row,entry));}
    catch (error) {
      if (error instanceof AppError && error.code==='storage_quota') {
        db.prepare("UPDATE conversation_import_jobs SET state='paused',error_code='storage_quota',updated_at=? WHERE id=?").run(Date.now(),row.id);return;
      }
      throw error;
    }
    await yieldTurn();
    if (stopped) return;
  }
  live(row);finishJob(row,'done');
}
async function exportJob(row:JobRow,signal:AbortSignal):Promise<void> {
  db.prepare("UPDATE conversation_import_jobs SET state='validating' WHERE id=?").run(row.id);
  const bytes=readBounded(row,'input.json',L.inputBytes);if(hashBytes(bytes)!==row.input_sha256) throw new ImportFailure('staging_unavailable');
  const output=await serializeInWorker(bytes,row.admission_at,signal);live(row);
  rmSync(path.join(jobDir(row),'output.json.partial'),{force:true});atomicFile(row,'output.json',output);
  db.prepare("UPDATE conversation_import_jobs SET state='ready',adapter='portable-v1',adapter_version=1,manifest_sha256=?,updated_at=? WHERE id=?").run(hashBytes(output),Date.now(),row.id);
}
async function runJob(row:JobRow,controller:AbortController):Promise<void> {
  try {
    live(row);
    if (row.kind==='export') await exportJob(row,controller.signal);
    else if (row.state==='validating') await validateImport(row,controller.signal);
    else await importItems(row);
  } catch(error) {
    const current=getJob(row.user_id,row.id);
    if (!stopped && current && !terminal(current.state)) finishJob(current,current.cancel_requested ? 'cancelled' : current.expires_at<=Date.now() ? 'expired' : 'failed',safeCode(error));
  } finally {active.delete(row.id);if(!stopped) kickImports();}
}
export function kickImports():void {
  if (stopped) return;
  const rows=db.prepare("SELECT * FROM conversation_import_jobs WHERE state IN ('queued','validating') ORDER BY admission_at,id").all() as unknown as JobRow[];
  for(const row of rows) {
    if(active.size>=2) break;if(active.has(row.id)) continue;
    const controller=new AbortController();active.set(row.id,controller);
    // Defer the first filesystem read so HTTP admission can return immediately.
    setImmediate(()=> {if(stopped) {active.delete(row.id);return;}void runJob(row,controller);});
  }
}
export async function receiveImport(userId:string,request:Request):Promise<JobRow> {
  const encoding=request.headers.get('content-encoding');if(encoding && encoding.toLowerCase()!=='identity') problem('compression',415);
  const media=request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if(media!=='application/json' && media!=='application/octet-stream') problem('media_type',415);
  const declared=Number(request.headers.get('content-length'));if(declared>L.inputBytes) problem('too_large',413);
  const row=admitJob(userId,'import',declared>0 ? declared : null);
  const reader=request.body?.getReader();const temporary=path.join(jobDir(row),'input.partial');
  let fd:number|undefined, timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new ImportFailure('upload_interrupted')),120000);});
  let received=0,uploadCancelled=false;const hash=createUploadHash();let first=Buffer.alloc(0);
  const abort=()=>{uploadCancelled=true;void reader?.cancel().catch(()=>{});};uploads.set(row.id,abort);request.signal.addEventListener('abort',abort,{once:true});
  try {
    if(!reader) throw new ImportFailure('invalid_json');
    fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    while(true) {
      const chunk=await Promise.race([reader.read(),deadline]);if(chunk.done) break;
      if(request.signal.aborted || getJob(userId,row.id)?.state!=='receiving') throw new ImportFailure('upload_interrupted');
      received+=chunk.value.byteLength;if(received>L.inputBytes) throw new ImportFailure('too_large');
      if(first.length<4) first=Buffer.concat([first,Buffer.from(chunk.value.subarray(0,4-first.length))]);
      if(first.length>=2 && ((first[0]===0x50 && first[1]===0x4b)||(first[0]===0x1f && first[1]===0x8b))) throw new ImportFailure('compression');
      hash.update(chunk.value);let offset=0;while(offset<chunk.value.length) offset+=writeSync(fd,chunk.value,offset);
      db.prepare('UPDATE conversation_import_jobs SET received_bytes=? WHERE id=?').run(received,row.id);
    }
    if(!received || request.signal.aborted || uploadCancelled) throw new ImportFailure('upload_interrupted');
    fsyncSync(fd);closeSync(fd);fd=undefined;
    renameSync(temporary,path.join(jobDir(row),'input.json'));syncDir(jobDir(row));
    tx(()=> {if(getJob(userId,row.id)?.state!=='receiving') throw new ImportFailure('cancelled');
      db.prepare("UPDATE conversation_import_jobs SET state='validating',input_sha256=?,received_bytes=?,updated_at=? WHERE id=?").run(hash.digest('hex'),received,Date.now(),row.id);});
    kickImports();return getJob(userId,row.id)!;
  } catch(error) {
    abort();if(fd!==undefined) closeSync(fd);
    const current=getJob(userId,row.id);if(current && !terminal(current.state)) finishJob(current,current.cancel_requested ? 'cancelled' : 'failed',safeCode(error));
    const code=safeCode(error);throw new AppError({code:code==='too_large' ? 'storage_quota' : 'validation',status:code==='too_large' ? 413 : code==='compression' ? 415 : 422,details:{reason:code,jobId:row.id}});
  } finally {uploads.delete(row.id);clearTimeout(timer);request.signal.removeEventListener('abort',abort);reader?.releaseLock();}
}
import { createHash } from 'node:crypto';
const createUploadHash=()=>createHash('sha256');
export function confirmImport(userId:string,id:string,itemKeys:string[],projectId:string|null):JobRow {
  tx(()=> {
    const row=requireJob(userId,id);if(row.kind!=='import') problem('wrong_state');
    if(!itemKeys.length || itemKeys.length>L.conversations || new Set(itemKeys).size!==itemKeys.length) problem('invalid_selection',422);
    const hash=hashBytes(JSON.stringify({itemKeys:[...itemKeys].sort(),projectId}));
    if(row.confirmation_sha256) {if(row.confirmation_sha256!==hash) problem('different_confirmation');return;}
    if(row.state!=='ready' || row.expires_at<=Date.now()) problem('wrong_state');
    if(projectId && !db.prepare('SELECT id FROM projects WHERE id=? AND user_id=?').get(projectId,userId)) problem('not_found',404);
    const items=allItems(id);if(itemKeys.some((key)=>!items.some((item)=>item.item_key===key && item.state==='valid'))) problem('invalid_selection',422);
    verifyStaging(row);
    for(const item of items) db.prepare("UPDATE conversation_import_items SET state=?,selected=? WHERE job_id=? AND ordinal=? AND state='valid'").run(itemKeys.includes(item.item_key) ? 'pending' : 'unselected',Number(itemKeys.includes(item.item_key)),id,item.ordinal);
    db.prepare("UPDATE conversation_import_jobs SET state='queued',project_id=?,model_ref=?,confirmation_sha256=?,selection_json=?,updated_at=? WHERE id=?").run(projectId,getSettings(userId).defaultModel??null,hash,JSON.stringify([...itemKeys].sort()),Date.now(),id);
  });
  kickImports();return requireJob(userId,id);
}
export function cancelImport(userId:string,id:string):JobRow {
  const row=requireJob(userId,id);if(terminal(row.state)) return row;
  db.prepare("UPDATE conversation_import_jobs SET state='cancelling',cancel_requested=1,updated_at=? WHERE id=? AND user_id=?").run(Date.now(),id,userId);
  uploads.get(id)?.();
  active.get(id)?.abort();
  if(!active.has(id)) finishJob(row,'cancelled');
  return requireJob(userId,id);
}
export function resumeImport(userId:string,id:string):JobRow {
  const row=requireJob(userId,id);if(row.kind!=='import' || row.state!=='paused' || row.error_code!=='storage_quota' || !row.confirmation_sha256) problem('wrong_state');
  verifyStaging(row);db.prepare("UPDATE conversation_import_jobs SET state='queued',error_code=NULL WHERE id=? AND user_id=?").run(id,userId);kickImports();return requireJob(userId,id);
}
export function createExport(userId:string,threads:Array<{id:string;selectedLeaf?:string}>):JobRow {
  const row=admitJob(userId,'export');
  try {
    const snapshot=snapshotConversations(userId,threads,row.admission_at,row.id);
    const body=JSON.stringify(snapshot);if(Buffer.byteLength(body)>L.inputBytes) throw new ImportFailure('export_too_large');
    atomicFile(row,'input.json',body);
    for (const [ordinal,conversation] of snapshot.conversations.entries()) {
      db.prepare("INSERT INTO conversation_import_items (job_id,ordinal,item_key,title,created_at,updated_at,message_count,normalized_bytes,state,warnings_json) VALUES (?,?,?,?,?,?,?,?,'valid','[]')").run(row.id,ordinal,newId('cii'),conversation.title,conversation.createdAt,conversation.updatedAt,conversation.messages.length,Buffer.byteLength(JSON.stringify(conversation)));
    }
    db.prepare('UPDATE conversation_import_jobs SET input_sha256=?,received_bytes=? WHERE id=?').run(hashBytes(body),Buffer.byteLength(body),row.id);
    kickImports();return getJob(userId,row.id)!;
  } catch(error) {finishJob(row,'failed',safeCode(error));if(error instanceof AppError) throw error;problem(error instanceof ImportFailure ? error.code : 'internal_error',error instanceof ImportFailure && error.code==='not_found' ? 404 : error instanceof ImportFailure && error.code==='export_unavailable' ? 409 : 422);}
}
export function maintainImports(now=Date.now()):void {
  const rows=db.prepare('SELECT * FROM conversation_import_jobs').all() as unknown as JobRow[];
  for(const row of rows) {
    if(!terminal(row.state) && row.expires_at<=now) {active.get(row.id)?.abort();if(!active.has(row.id)) finishJob(row,'expired','expired');}
    else if(terminal(row.state) && row.staging_present && !active.has(row.id)) cleanupJob(row);
    if(row.terminal_at && row.terminal_at<now-7*86400000 && !row.staging_present) db.prepare('DELETE FROM conversation_import_jobs WHERE id=?').run(row.id);
  }
}
export function recoverImports():void {
  stopped=false;maintainImports();
  const rows=db.prepare('SELECT * FROM conversation_import_jobs').all() as unknown as JobRow[];
  for(const row of rows) {
    if(terminal(row.state)) continue;
    if(row.state==='receiving') {finishJob(row,'failed','upload_interrupted');continue;}
    if(row.state==='cancelling') {finishJob(row,'cancelled');continue;}
    try {
      verifyStaging(row);
      if(row.state==='importing') {if(!row.confirmation_sha256) throw new ImportFailure('staging_unavailable');db.prepare("UPDATE conversation_import_jobs SET state='queued' WHERE id=?").run(row.id);}
    } catch {finishJob(row,'failed','staging_unavailable');}
  }
  // Remove orphan account/job directories after account deletion or unpublished admission.
  try {for(const user of readdirSync(stagingRoot)) {
    const dir=path.join(stagingRoot,user);if(lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) {rmSync(dir,{recursive:true,force:true});continue;}
    for(const id of readdirSync(dir)) if(!getJob(user,id)) rmSync(path.join(dir,id),{recursive:true,force:true});
  }} catch { /* Next startup retries unavailable orphan cleanup. */ }
}
export function startImports():void {stopped=false;kickImports();if(!maintenance) {maintenance=setInterval(()=>{maintainImports();kickImports();},60000);maintenance.unref();}}
export async function stopImports():Promise<void> {stopped=true;clearInterval(maintenance);maintenance=undefined;for(const abort of uploads.values()) abort();for(const controller of active.values()) controller.abort();while(active.size) await yieldTurn();await stopImportWorkers();}
export function removeUserImports(userId:string):void {for(const row of db.prepare('SELECT * FROM conversation_import_jobs WHERE user_id=?').all(userId) as unknown as JobRow[]) {uploads.get(row.id)?.();active.get(row.id)?.abort();}try{rmSync(path.join(stagingRoot,userId),{recursive:true,force:true});}catch{/* Startup orphan sweep retries. */}}
