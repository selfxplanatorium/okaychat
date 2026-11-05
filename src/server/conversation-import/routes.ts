import { Hono } from 'hono';
import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import type { AppEnv } from '../auth.js';
import { db } from '../db.js';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { QuotaError } from '../quota.js';
import { conversationStagingReserved, personalStagingBytes, roomStagingReserved } from '../archive-staging-budget.js';
import { domainHmac } from '../crypto.js';
import { AppError, handleAppError, toWireError } from '../errors.js';
import { IMPORT_REASON_CODES, IMPORT_LIMITS as L, type ImportReason } from '../../shared/chat-import.js';
import { ImportFailure, parseJson } from './json.js';
import { cancelImport, confirmImport, createExport, maintainImports, receiveImport, resumeImport, verifyStaging } from './jobs.js';
import { allItems, jobView, previewItem, problem, readBounded, requireJob, type JobRow } from './store.js';

const confirm=z.object({itemKeys:z.array(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)).min(1).max(L.conversations),projectId:z.string().min(1).max(200).nullable()}).strict();
const exporting=z.object({threads:z.array(z.object({id:z.string().min(1).max(200),selectedLeaf:z.string().min(1).max(200).optional()}).strict()).min(1).max(100)}).strict();
async function controlBody(request:Request):Promise<unknown> {
  const reader=request.body?.getReader();if(!reader) problem('invalid_selection',422);
  const chunks:Uint8Array[]=[];let total=0;let timer:ReturnType<typeof setTimeout>|undefined;
  const timeout=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('timeout')),5000);});
  try {
    while(true) {const chunk=await Promise.race([reader.read(),timeout]);if(chunk.done) break;total+=chunk.value.length;if(total>128*1024) problem('too_large',413);chunks.push(chunk.value);}
    const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks) {bytes.set(chunk,offset);offset+=chunk.length;}
    return parseJson(bytes);
  } catch(error) {if(error instanceof AppError) throw error;problem('invalid_selection',422);} finally {clearTimeout(timer);void reader.cancel().catch(()=>{});reader.releaseLock();}
}
function current(userId:string,id:string):JobRow {maintainImports();const row=requireJob(userId,id);if(row.expires_at<=Date.now() && row.state!=='done' && row.state!=='failed' && row.state!=='cancelled') problem('expired',410);return row;}
const cursor=(userId:string,id:string,ordinal:number)=>`${ordinal.toString(36)}.${domainHmac('conversation-import-cursor',JSON.stringify([userId,id,ordinal]))}`;
function afterOrdinal(userId:string,id:string,value:string|undefined):number {
  if(!value) return -1;
  if(!/^[a-z0-9]{1,4}\.[a-f0-9]{64}$/.test(value)) problem('invalid_cursor',422);
  const ordinal=parseInt(value.split('.')[0]!,36);const expected=cursor(userId,id,ordinal);
  if(expected.length!==value.length || !timingSafeEqual(Buffer.from(expected),Buffer.from(value))) problem('invalid_cursor',422);
  return ordinal;
}
export const conversationImportRoutes=new Hono<AppEnv>().basePath('/conversation-imports')
  .use('*',async(c,next)=>{c.header('Cache-Control','private, no-store');await next();})
  .onError((error,c)=> {
    const appError=error instanceof ImportFailure ? new AppError({code:'validation',status:422,details:{reason:error.code}}) : error;
    if(!(appError instanceof AppError)) return handleAppError(appError,c);
    const details=appError.details as {reason?:unknown;jobId?:unknown}|undefined;
    const reason=IMPORT_REASON_CODES.includes(details?.reason as ImportReason) ? details!.reason as ImportReason : appError.code==='storage_quota' ? 'storage_quota' : 'internal_error';
    const wire=toWireError(appError);
    const quota=appError instanceof QuotaError ? {neededBytes:L.reservationBytes,availableBytes:Math.max(0,appError.limit-appError.used)} : reason==='staging_full' ? {neededBytes:L.reservationBytes,availableBytes:Math.max(0,512*1024*1024-conversationStagingReserved()-personalStagingBytes()-roomStagingReserved())} : {};
    return c.json({error:wire.message,...wire,details:{reason,...quota,...(typeof details?.jobId==='string' && /^[A-Za-z0-9_-]{1,100}$/.test(details.jobId) ? {jobId:details.jobId} : {})}},appError.status as ContentfulStatusCode);
  })
  .post('/',async(c)=>{const row=await receiveImport(c.get('user').id,c.req.raw);return c.json({jobId:row.id,expiresAt:row.expires_at},202);})
  .get('/',(c)=> {
    maintainImports();const rows=db.prepare('SELECT * FROM conversation_import_jobs WHERE user_id=? ORDER BY admission_at DESC,rowid DESC LIMIT 20').all(c.get('user').id) as unknown as JobRow[];
    return c.json({jobs:rows.map(jobView)});
  })
  .post('/exports',async(c)=> {
    const parsed=exporting.safeParse(await controlBody(c.req.raw));if(!parsed.success) problem('invalid_selection',422);
    const row=createExport(c.get('user').id,parsed.data.threads);return c.json({jobId:row.id,expiresAt:row.expires_at},202);
  })
  .get('/:id',(c)=>c.json(jobView(current(c.get('user').id,c.req.param('id')))))
  .get('/:id/items',(c)=> {
    const userId=c.get('user').id,id=c.req.param('id');current(userId,id);
    const after=afterOrdinal(userId,id,c.req.query('after'));
    const limit=Number(c.req.query('limit')??50);if(!Number.isInteger(limit)||limit<1||limit>100) problem('invalid_cursor',422);
    const rows=allItems(id).filter((row)=>row.ordinal>after).slice(0,limit+1);
    const page=rows.slice(0,limit);return c.json({items:page.map(previewItem),nextCursor:rows.length>limit ? cursor(userId,id,page.at(-1)!.ordinal) : null});
  })
  .post('/:id/confirm',async(c)=> {
    const userId=c.get('user').id,id=c.req.param('id');current(userId,id);
    const parsed=confirm.safeParse(await controlBody(c.req.raw));if(!parsed.success) problem('invalid_selection',422);
    const row=confirmImport(userId,id,parsed.data.itemKeys,parsed.data.projectId);return c.json(jobView(row),row.state==='done' ? 200 : 202);
  })
  .post('/:id/resume',async(c)=> {
    const userId=c.get('user').id,id=c.req.param('id');current(userId,id);
    if(!z.object({}).strict().safeParse(await controlBody(c.req.raw)).success) problem('invalid_selection',422);
    return c.json(jobView(resumeImport(userId,id)),202);
  })
  .delete('/:id',(c)=> {const userId=c.get('user').id,id=c.req.param('id');current(userId,id);const row=cancelImport(userId,id);return c.json(jobView(row),row.state==='cancelling' ? 202 : 200);})
  .get('/:id/download',(c)=> {
    const row=current(c.get('user').id,c.req.param('id'));if(row.kind!=='export'||row.state!=='ready') problem('wrong_state');
    try {verifyStaging(row);} catch {problem('staging_unavailable');}
    const bytes=readBounded(row,'output.json',L.inputBytes);
    return new Response(new Uint8Array(bytes),{headers:{'Content-Type':'application/json','Content-Disposition':'attachment; filename="okaychat-conversations.json"','Content-Length':String(bytes.length),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
  });
