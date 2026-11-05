import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { db } from '../db.js';
import { AppError } from '../errors.js';
import { getSettings } from '../settings.js';
import type { ResolvedRunConfig } from '../../shared/assistant-presets.js';
import { assertVideoTurn, checkVideoTurn, type VideoTurnContext, type VideoEligibilityDependencies } from './eligibility.js';
import { admitVideo, ownJob, requestOf, retryableVideoCode, isVideoOpen, patchJob, type VideoJobRow } from './store.js';
import { videoStaging } from './paths.js';
import { encrypt } from '../crypto.js';
import { videoServiceStatuses } from './services.js';

export function retryContext(row:VideoJobRow):VideoTurnContext|null {
  if(!row.thread_id||!row.llm_run_id)return null;
  const run=db.prepare('SELECT config_json FROM generation_runs WHERE id=? AND thread_id=? AND assistant_message_id=?').get(row.llm_run_id,row.thread_id,row.assistant_message_id);
  if(!run)return null;
  const config=JSON.parse(String(run.config_json)) as ResolvedRunConfig;
  return {userId:row.user_id,threadId:row.thread_id,assistantMessageId:row.assistant_message_id,getRunId:()=>row.llm_run_id,modelRef:config.modelRef,toolCallModel:true,toolPolicy:config.toolPolicy,interactive:config.turnOrigin==='interactive',unattended:false,turnOrigin:config.turnOrigin,temporary:false,restrictedChat:false,comparison:false};
}
export function canRetryVideo(row:VideoJobRow,now=Date.now()):boolean {
  const context=retryContext(row);
  if(!context)return false;
  try {assertVideoTurn(context,row.service);}catch{return false;}
  return !isVideoOpen(row.state)&&row.state!=='succeeded'&&!!row.error_code&&retryableVideoCode(row.error_code)&&!!row.request_enc&&row.created_at>now-86400000&&row.attempt<7&&!!row.thread_id&&!!retryContext(row)&&!db.prepare('SELECT 1 FROM video_jobs WHERE retry_of=?').get(row.id);
}
export async function retryVideo(userId:string,id:string,expectedRevision:number,dependencies?:VideoEligibilityDependencies):Promise<VideoJobRow> {
  const parent=ownJob(userId,id);
  const existing=db.prepare('SELECT id FROM video_jobs WHERE retry_of=? AND user_id=?').get(id,userId) as {id:string}|undefined;
  if(existing)return ownJob(userId,existing.id);
  if(!parent.request_enc||parent.created_at<Date.now()-86400000)throw new AppError({code:'conflict',status:410,message:'The retained video request has expired.',details:{reason:'retry_expired'}});
  if(parent.revision!==expectedRevision||!canRetryVideo(parent))throw new AppError({code:'conflict'});
  const context=retryContext(parent)!;
  const authorize=await checkVideoTurn(context,parent.service,dependencies);
  const service=videoServiceStatuses(userId,getSettings(userId).videoServices??{}).find(s=>s.id===parent.service);
  if(service?.model!==parent.model_id)throw new AppError({code:'conflict',message:'Video settings changed. Start a new request in chat.'});
  const request=requestOf(parent);
  const child=admitVideo({userId,threadId:parent.thread_id!,llmRunId:parent.llm_run_id!,assistantMessageId:parent.assistant_message_id,toolCallId:parent.tool_call_id,service:parent.service,model:parent.model_id,request,authorize:()=>{authorize();if(ownJob(userId,id).revision!==expectedRevision)throw new AppError({code:'conflict'});}},Date.now(),parent);
  // The parent's normalized JPEG lives in the parent's staging directory. Carry it to the child so a retry
  // still works after the original upload was deleted; the retained hash refers to that exact file. If the
  // parent's file is already gone, drop the hash and let preparation re-normalize from the upload.
  if(request.referenceUploadId&&request.referenceSha256){
    const from=path.join(videoStaging(parent.user_id,parent.id),'reference.jpg');
    const to=path.join(videoStaging(child.user_id,child.id),'reference.jpg');
    try{await mkdir(path.dirname(to),{recursive:true,mode:0o700});await copyFile(from,to);}
    catch{delete request.referenceSha256;patchJob(child.id,child.lease_epoch,['queued'],{request_enc:encrypt(JSON.stringify(request))});}
  }
  return child;
}
