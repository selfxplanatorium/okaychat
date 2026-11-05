import { existsSync } from 'node:fs';
import { db, tx, afterCommit } from '../db.js';
import { encrypt, decrypt, newId } from '../crypto.js';
import { assertStorage } from '../quota.js';
import { recordUsage, ZERO_USAGE } from '../usage.js';
import { AppError } from '../errors.js';
import { VIDEO_LIMITS as L, videoService, videoEstimateMicrousd, type VideoJobState, type VideoStage, type VideoParameters, type VideoPrice, type VideoServiceId, type VideoErrorCode, type VideoJobView } from '../../shared/video.js';
import { VideoError } from './errors.js';
import { assertVideoParameters, videoCredential } from './services.js';
import { videoFile } from './paths.js';

export const OPEN_STATES = ['queued','submitting','polling','downloading','validating','cancel_requested'] as const;
export const openSql = "('queued','submitting','polling','downloading','validating','cancel_requested')";
export const isVideoOpen = (state:VideoJobState):boolean => (OPEN_STATES as readonly string[]).includes(state);
export interface VideoRequest {prompt:string;referenceUploadId?:string;referenceSha256?:string;durationSeconds:4|6|8;aspectRatio:'16:9'|'9:16';size:'720p'|'1080p';audio:true}
export interface VideoJobRow {
  id:string;user_id:string;thread_id:string|null;llm_run_id:string|null;assistant_message_id:string;tool_call_id:string;
  attempt:number;retry_of:string|null;service:VideoServiceId;model_id:string;connection_id:string;connection_fingerprint:string;
  request_enc:string|null;parameters_json:string;price_json:string;provider_id_enc:string|null;state:VideoJobState;stage:VideoStage;
  revision:number;submitted_at:number|null;deadline_at:number;next_poll_at:number|null;poll_failures:number;
  lease_until:number|null;lease_epoch:number;cancel_requested_at:number|null;remote_cancellation:VideoJobView['remoteCancellation'];
  error_code:VideoErrorCode|null;may_have_charged:number;reservation_bytes:number;estimated_cost_microusd:number;
  settled_cost_microusd:number|null;cost_state:'unknown'|'estimated'|'reported';billed_seconds:number|null;created_at:number;updated_at:number;finished_at:number|null;
}
export function jobRow(id:string):VideoJobRow|undefined {return db.prepare('SELECT * FROM video_jobs WHERE id = ?').get(id) as unknown as VideoJobRow|undefined;}
export function ownJob(userId:string,id:string):VideoJobRow {
  const row=db.prepare('SELECT * FROM video_jobs WHERE id = ? AND user_id = ?').get(id,userId) as unknown as VideoJobRow|undefined;
  if(!row) throw new AppError({code:'not_found'});
  return row;
}
export const parametersOf = (row:VideoJobRow):VideoParameters => JSON.parse(row.parameters_json) as VideoParameters;
export const requestOf = (row:VideoJobRow):VideoRequest => {
  if(!row.request_enc) throw new AppError({code:'conflict',status:410,message:'The retained video request has expired.'});
  return JSON.parse(decrypt(row.request_enc)) as VideoRequest;
};
const listeners=new Set<(id:string)=>void>();
export function onVideoChange(listener:(id:string)=>void):()=>void {listeners.add(listener);return ()=>listeners.delete(listener);}
export function changed(id:string):void {afterCommit(()=>{for(const listener of listeners) listener(id);});}
type Patch=Partial<Pick<VideoJobRow,'state'|'stage'|'submitted_at'|'deadline_at'|'next_poll_at'|'poll_failures'|'provider_id_enc'|'lease_until'|'error_code'|'remote_cancellation'|'may_have_charged'|'reservation_bytes'|'settled_cost_microusd'|'cost_state'|'billed_seconds'|'finished_at'|'request_enc'>>;
/** Every worker mutation requires the current epoch and an allowed state. A cancelled or replaced lease cannot win. */
export function patchJob(id:string,epoch:number,states:readonly VideoJobState[],patch:Patch,now=Date.now()):VideoJobRow|null {
  return tx(()=>{
    const row=jobRow(id);
    if(!row || row.lease_epoch!==epoch || !states.includes(row.state)) return null;
    const keys=Object.keys(patch) as Array<keyof Patch>;
    const result=db.prepare(`UPDATE video_jobs SET ${keys.map(k=>`${k} = ?`).join(',')}, revision=revision+1,updated_at=? WHERE id=? AND revision=? AND lease_epoch=?`).run(...keys.map(k=>patch[k]??null),now,id,row.revision,epoch);
    if(!result.changes) return null;
    changed(id);return jobRow(id)!;
  });
}
export interface Admission {
  userId:string;threadId:string;llmRunId:string;assistantMessageId:string;toolCallId:string;
  service:VideoServiceId;model:string;request:VideoRequest;
  /** Synchronous live eligibility recheck, supplied by the server tool/retry boundary. */
  authorize:()=>void;
}
export function admitVideo(input:Admission,now=Date.now(),retryOf?:VideoJobRow):VideoJobRow {
  return tx(()=>{
    const existing=retryOf ? db.prepare('SELECT * FROM video_jobs WHERE retry_of = ?').get(retryOf.id) : db.prepare('SELECT * FROM video_jobs WHERE thread_id=? AND assistant_message_id=? AND tool_call_id=? AND attempt=0').get(input.threadId,input.assistantMessageId,input.toolCallId);
    if(existing) {
      const row=existing as unknown as VideoJobRow;
      if(row.user_id!==input.userId) throw new AppError({code:'not_found'});
      return row;
    }
    input.authorize();
    if(!db.prepare('SELECT 1 FROM threads WHERE id=? AND user_id=? AND compare_group_id IS NULL').get(input.threadId,input.userId)) throw new AppError({code:'not_found'});
    const r=input.request;
    if(!r.prompt.trim() || [...r.prompt].length>4000 || Buffer.byteLength(r.prompt)>16384 || r.referenceUploadId && !/^[A-Za-z0-9_-]{1,200}$/.test(r.referenceUploadId)) throw new VideoError('unsupported_parameters',400);
    const parameters:VideoParameters={durationSeconds:r.durationSeconds,aspectRatio:r.aspectRatio,size:r.size,audio:true,hasReference:!!r.referenceUploadId};
    assertVideoParameters(input.service,input.model,parameters);
    const credential=videoCredential(input.userId,input.service);
    const active=db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(user_id=?),0) AS owned FROM video_jobs WHERE state IN ${openSql}`).get(input.userId) as {total:number;owned:number};
    if(active.total>=2 || active.owned) throw new VideoError('video_busy',503);
    const today=Math.floor(now/86_400_000)*86_400_000;
    const count=db.prepare('SELECT COUNT(*) AS n FROM video_jobs WHERE user_id=? AND created_at>=?').get(input.userId,today) as {n:number};
    if(count.n>=20) throw new VideoError('video_rate_limit',429);
    if(retryOf && (isVideoOpen(retryOf.state) || retryOf.attempt>=7 || !retryOf.request_enc || retryOf.created_at<now-86400000)) throw new AppError({code:'conflict',status:410,message:'The video cannot be retried.'});
    const price=videoService(input.service).models.find(m=>m.id===input.model)!.price;
    const requestJson=JSON.stringify(r),priceJson=JSON.stringify(price);
    if(Buffer.byteLength(requestJson)>24576 || Buffer.byteLength(priceJson)>4096) throw new VideoError('unsupported_parameters',400);
    const reservation=L.outputBytes+L.referenceBytes+L.receiptBytes;
    assertStorage(input.userId,reservation);
    const id=newId('vid');
    db.prepare(`INSERT INTO video_jobs (id,user_id,thread_id,llm_run_id,assistant_message_id,tool_call_id,attempt,retry_of,service,model_id,connection_id,connection_fingerprint,request_enc,parameters_json,price_json,state,stage,deadline_at,next_poll_at,reservation_bytes,estimated_cost_microusd,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'queued','accepted',?,?,?,?,?,?)`).run(id,input.userId,input.threadId,input.llmRunId,input.assistantMessageId,input.toolCallId,retryOf ? retryOf.attempt+1:0,retryOf?.id??null,input.service,input.model,credential.connectionId,credential.fingerprint,encrypt(requestJson),JSON.stringify(parameters),priceJson,now+L.deadlineMs,now,reservation,videoEstimateMicrousd(price,parameters),now,now);
    changed(id);return jobRow(id)!;
  });
}
export function claimVideo(now=Date.now()):VideoJobRow|null {
  return tx(()=>{
    const row=db.prepare(`SELECT * FROM video_jobs WHERE state IN ${openSql} AND (lease_until IS NULL OR lease_until<=?) AND (next_poll_at IS NULL OR next_poll_at<=? OR deadline_at<=? OR state='cancel_requested') ORDER BY created_at,id LIMIT 1`).get(now,now,now) as unknown as VideoJobRow|undefined;
    if(!row) return null;
    db.prepare('UPDATE video_jobs SET lease_epoch=lease_epoch+1,lease_until=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').run(now+L.leaseMs,now,row.id,row.revision);
    changed(row.id);return jobRow(row.id)!;
  });
}
export function requestVideoCancel(userId:string,id:string,now=Date.now()):VideoJobRow {
  return tx(()=>{
    const row=ownJob(userId,id);
    if(row.state==='succeeded') throw new AppError({code:'conflict',message:'The video has already finished.',details:{reason:'already_finished'}});
    if(!isVideoOpen(row.state) || row.state==='cancel_requested') return row;
    db.prepare("UPDATE video_jobs SET state='cancel_requested',stage='stopping',cancel_requested_at=?,revision=revision+1,updated_at=? WHERE id=?").run(now,now,id);
    changed(id);return jobRow(id)!;
  });
}
export function cancelRunVideos(userId:string,threadId:string,runId?:string):void {
  const rows=db.prepare(`SELECT id FROM video_jobs WHERE user_id=? AND thread_id=? ${runId ? 'AND llm_run_id=?':''} AND state IN ${openSql}`).all(userId,threadId,...(runId ? [runId]:[])) as Array<{id:string}>;
  for(const row of rows) requestVideoCancel(userId,row.id);
}
export function settleVideo(row:VideoJobRow):void {
  if(row.submitted_at===null) return;
  recordUsage({userId:row.user_id,threadId:row.thread_id??undefined,providerId:row.service,modelId:row.model_id,kind:'video',videoJobId:row.id,usage:ZERO_USAGE,cost:(row.settled_cost_microusd??0)/1e6,costState:row.cost_state});
}
export function finishVideo(id:string,epoch:number,state:'failed'|'cancelled'|'timed_out'|'submission_unknown',code:VideoErrorCode,now=Date.now()):VideoJobRow|null {
  return tx(()=>{
    const row=patchJob(id,epoch,OPEN_STATES,{state,stage:state==='cancelled'?'stopped':'error',error_code:code,finished_at:now,lease_until:null,next_poll_at:null,may_have_charged:jobRow(id)?.submitted_at===null?0:1},now);
    if(row) settleVideo(row);
    return row;
  });
}
export function rememberCompletion(row:VideoJobRow,billedSeconds:number|null,now:number):VideoJobRow|null {
  const price=JSON.parse(row.price_json) as VideoPrice;
  return patchJob(row.id,row.lease_epoch,['polling','downloading','validating'],{billed_seconds:billedSeconds,settled_cost_microusd:videoEstimateMicrousd(price,parametersOf(row),billedSeconds??parametersOf(row).durationSeconds),cost_state:'estimated',may_have_charged:1},now);
}
export const retryableVideoCode=(code:VideoErrorCode)=>['video_busy','video_rate_limit','provider_rate_limit','provider_unavailable','download_failed','storage_failed','job_timeout','submission_unknown'].includes(code);
export function videoJobView(row:VideoJobRow):VideoJobView {
  const output=db.prepare('SELECT * FROM videos WHERE job_id=? AND user_id=?').get(row.id,row.user_id);
  const available=!!output && existsSync(videoFile(row.user_id,row.id));
  const p=parametersOf(row);
  return {id:row.id,threadId:row.thread_id,assistantMessageId:row.assistant_message_id,toolCallId:row.tool_call_id,attempt:row.attempt,retryOf:row.retry_of,service:row.service,model:row.model_id,state:row.state,stage:row.stage,revision:row.revision,createdAt:row.created_at,updatedAt:row.updated_at,finishedAt:row.finished_at,request:{durationSeconds:p.durationSeconds,aspectRatio:p.aspectRatio,size:p.size},cost:{currency:'USD',estimatedMicrousd:row.estimated_cost_microusd,settledMicrousd:row.settled_cost_microusd,state:row.cost_state},error:row.error_code?{code:row.error_code,retryable:retryableVideoCode(row.error_code),mayHaveCharged:!!row.may_have_charged}:null,remoteCancellation:row.remote_cancellation,output:available?{id:row.id,mime:'video/mp4',size:Number(output!.size),durationMs:Number(output!.duration_ms),width:Number(output!.width),height:Number(output!.height),hasAudio:!!output!.has_audio,fileUrl:`/api/videos/${row.id}/file`,downloadUrl:`/api/videos/${row.id}/file?download=1`,posterUrl:null}:null,outputUnavailable:row.state==='succeeded'&&!available,canRetry:false};
}
