import { constants, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { db, tx } from '../db.js';
import { env } from '../env.js';
import { newId } from '../crypto.js';
import { AppError } from '../errors.js';
import { ImportFailure } from './json.js';
import { assertStorage } from '../quota.js';
import { assertStagingCapacity } from '../archive-staging-budget.js';
import { IMPORT_LIMITS as L, type ImportCounts, type ImportItemState, type ImportJobState, type ImportWarning, type JobView, type PreviewItem, type SourceNamespace } from '../../shared/chat-import.js';

export const stagingRoot = path.join(env.dataDir,'conversation-import-staging');
export interface JobRow {
  id:string; user_id:string; kind:'import'|'export'; state:ImportJobState; adapter:SourceNamespace|null; adapter_version:number|null;
  project_id:string|null; model_ref:string|null; admission_at:number; updated_at:number; expires_at:number; terminal_at:number|null;
  input_sha256:string|null; manifest_sha256:string|null; confirmation_sha256:string|null; reservation_bytes:number; cancel_requested:number;
  error_code:string|null; selection_json:string|null; received_bytes:number; total_bytes:number|null; staging_present:number;
}
export interface ItemRow {
  job_id:string; ordinal:number; item_key:string; source_namespace:SourceNamespace|null; source_id:string|null;
  payload_sha256:string|null; title:string|null; created_at:number|null; updated_at:number|null; message_count:number;
  normalized_bytes:number; warnings_json:string; state:ImportItemState; selected:number; thread_id:string|null; error_code:string|null;
}
export interface Manifest {version:1;adapter:SourceNamespace;adapterVersion:1;items:Array<{ordinal:number;itemKey:string;fileSha256:string;fileBytes:number}>}
export const hashBytes = (bytes: Uint8Array|string) => createHash('sha256').update(bytes).digest('hex');
export const terminal = (state:ImportJobState) => ['done','cancelled','failed','expired'].includes(state);
export function problem(reason:string,status=409): never {
  throw new AppError({code:status===404 || status===410 ? 'not_found' : status===413 ? 'storage_quota' : status===429 ? 'rate_limited' : 'validation',status,message:'Conversation transfer could not be completed.',details:{reason}});
}
export function getJob(userId:string,id:string): JobRow|undefined { return db.prepare('SELECT * FROM conversation_import_jobs WHERE user_id=? AND id=?').get(userId,id) as JobRow|undefined; }
export function requireJob(userId:string,id:string): JobRow {
  const row = getJob(userId,id); if (!row) problem('not_found',404);
  if (row.state === 'expired') problem('expired',410);
  return row;
}
export function allItems(id:string): ItemRow[] { return db.prepare('SELECT * FROM conversation_import_items WHERE job_id=? ORDER BY ordinal').all(id) as unknown as ItemRow[]; }
function safeDir(dir:string): void { mkdirSync(dir,{recursive:true,mode:0o700}); const stat=lstatSync(dir); if (!stat.isDirectory() || stat.isSymbolicLink()) problem('staging_unavailable'); }
export function jobDir(row:Pick<JobRow,'user_id'|'id'>):string {
  if (![row.user_id,row.id].every((id)=>/^[A-Za-z0-9_-]{1,200}$/.test(id))) problem('staging_unavailable');
  return path.join(stagingRoot,row.user_id,row.id);
}
export function makeDir(row:JobRow):void { safeDir(stagingRoot); safeDir(path.dirname(jobDir(row))); safeDir(jobDir(row)); }
export function syncDir(dir:string):void { const fd=openSync(dir,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW); try {fsyncSync(fd);} finally {closeSync(fd);} }
export function atomicFile(row:JobRow,name:string,bytes:Uint8Array|string):void {
  const dir=jobDir(row); const target=path.join(dir,name); const temporary=`${target}.partial`;
  const fd=openSync(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  try { writeFileSync(fd,bytes); fsyncSync(fd); } finally {closeSync(fd);}
  renameSync(temporary,target); syncDir(dir);
}
export function readBounded(row:JobRow,name:string,limit:number):Buffer {
  let fd:number|undefined;
  try {
    const dir=jobDir(row);
    for(const p of [stagingRoot,path.dirname(dir),dir]) {const stat=lstatSync(p);if(!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('staging');}
    fd=openSync(path.join(dir,name),constants.O_RDONLY|constants.O_NOFOLLOW);
    const stat=lstatSync(path.join(dir,name));if(!stat.isFile() || stat.size>limit) throw new Error('staging');
    return readFileSync(fd);
  } catch {throw new ImportFailure('staging_unavailable');}
  finally {if(fd!==undefined) closeSync(fd);}
}
export function cleanupJob(row:JobRow):void {
  try {rmSync(jobDir(row),{recursive:true,force:true}); db.prepare('UPDATE conversation_import_jobs SET reservation_bytes=0,staging_present=0 WHERE id=? AND user_id=?').run(row.id,row.user_id);} catch { /* Keep reservation and retry maintenance. */ }
}
export function finishJob(row:JobRow,state:'done'|'failed'|'cancelled'|'expired',code:string|null=null):void {
  tx(()=> {
    db.prepare('UPDATE conversation_import_jobs SET state=?,error_code=?,terminal_at=?,updated_at=? WHERE id=? AND user_id=?').run(state,code,Date.now(),Date.now(),row.id,row.user_id);
    db.prepare("UPDATE conversation_import_items SET state=?,error_code=? WHERE job_id=? AND state='pending'").run(state==='cancelled' || state==='expired' ? 'cancelled' : 'failed',code,row.id);
  });
  cleanupJob(row);
}
export function admitJob(userId:string,kind:'import'|'export',totalBytes:number|null=null,now=Date.now()):JobRow {
  const row=tx(()=> {
    if (db.prepare("SELECT 1 FROM conversation_import_jobs WHERE user_id=? AND state IN ('receiving','validating','ready','queued','importing','paused','cancelling')").get(userId)) problem('account_busy');
    const n=(db.prepare("SELECT count(*) AS n FROM conversation_import_jobs WHERE state IN ('receiving','validating','queued','importing')").get() as {n:number}).n;
    if (n>=6) problem('worker_capacity',429);
    assertStagingCapacity(L.reservationBytes); assertStorage(userId,L.reservationBytes);
    const id=newId('cij');
    db.prepare("INSERT INTO conversation_import_jobs (id,user_id,kind,state,admission_at,updated_at,expires_at,reservation_bytes,staging_present,total_bytes,adapter_version) VALUES (?,?,?,?,?,?,?,?,1,?,1)").run(id,userId,kind,kind==='import' ? 'receiving' : 'queued',now,now,now+L.lifetimeMs,L.reservationBytes,totalBytes);
    return getJob(userId,id)!;
  });
  try {makeDir(row);} catch {finishJob(row,'failed','staging_unavailable');problem('staging_unavailable');}
  return row;
}
function itemMeta(row:ItemRow): {warnings:ImportWarning[];counts:ImportCounts} {
  const parsed=JSON.parse(row.warnings_json) as {warnings?:ImportWarning[];counts?:ImportCounts}|ImportWarning[];
  return Array.isArray(parsed) ? {warnings:parsed,counts:{sourceNodes:0,sourceMessages:0,discardedBranchNodes:0,discardedBranchMessages:0,quarantine:0,omittedAttachments:0}} : {warnings:parsed.warnings ?? [],counts:parsed.counts ?? {sourceNodes:0,sourceMessages:0,discardedBranchNodes:0,discardedBranchMessages:0,quarantine:0,omittedAttachments:0}};
}
export function previewItem(row:ItemRow):PreviewItem {
  const {warnings,counts}=itemMeta(row);
  if (row.error_code==='source_changed' && !warnings.some((w)=>w.code==='source_changed')) warnings.push({code:'source_changed',count:1});
  return {itemKey:row.item_key,ordinal:row.ordinal,title:row.title,state:row.state,selectable:row.state==='valid',messageCount:row.message_count,
    quarantineCount:counts.quarantine,omittedAttachmentCount:counts.omittedAttachments,discardedBranchMessages:counts.discardedBranchMessages,
    createdAt:row.created_at,updatedAt:row.updated_at,normalizedBytes:row.normalized_bytes,warnings,errorCode:row.error_code,
    duplicate:row.state==='duplicate' && row.thread_id ? {threadId:row.thread_id,changed:row.error_code==='source_changed'} : null,
    result:row.state==='imported' && row.thread_id ? {threadId:row.thread_id} : null};
}
export function jobView(row:JobRow):JobView {
  const items=allItems(row.id), selected=items.filter((i)=>i.selected);
  const count=(state:ImportItemState)=>items.filter((i)=>i.state===state).length;
  const processed=selected.filter((i)=>['imported','duplicate','failed','cancelled'].includes(i.state)).length;
  const warnings:ImportWarning[]=[];
  for (const i of items) for (const w of previewItem(i).warnings) {const old=warnings.find((x)=>x.code===w.code);if(old) old.count+=w.count;else warnings.push({...w});}
  if (!row.model_ref && row.kind==='import' && !warnings.some((w)=>w.code==='model_unset')) warnings.push({code:'model_unset',count:1});
  if (row.kind==='export') warnings.push({code:'export_loss',count:1});
  const times=items.filter((i)=>i.created_at!==null && i.updated_at!==null);
  return {id:row.id,kind:row.kind,state:row.state,admissionAt:row.admission_at,expiresAt:row.expires_at,terminalAt:row.terminal_at,
    counts:{total:items.length,valid:items.filter((i)=>i.state!=='invalid').length,invalid:count('invalid'),selected:selected.length,processed,
      imported:count('imported'),duplicates:count('duplicate'),failed:count('failed'),cancelled:count('cancelled'),pending:count('pending')},
    phase:row.state,errorCode:row.error_code,canCancel:!terminal(row.state),canConfirm:row.kind==='import' && row.state==='ready' && count('valid')>0,
    canResume:row.kind==='import' && row.state==='paused',canDownload:row.kind==='export' && row.state==='ready',adapter:row.adapter,adapterVersion:row.adapter_version,
    projectId:row.project_id,modelRef:row.model_ref,normalizedBytes:items.reduce((n,i)=>n+i.normalized_bytes,0),receivedBytes:row.received_bytes,totalBytes:row.total_bytes,
    dateRange:times.length ? {from:Math.min(...times.map((i)=>i.created_at!)),to:Math.max(...times.map((i)=>i.updated_at!))} : null,warnings};
}
