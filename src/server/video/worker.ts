import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { db } from '../db.js';
import { decrypt, encrypt } from '../crypto.js';
import type { ResolvedRunConfig } from '../../shared/assistant-presets.js';
import { assertVideoTurn } from './eligibility.js';
import { getSettings } from '../settings.js';
import { VIDEO_LIMITS, type VideoServiceId } from '../../shared/video.js';
import { videoCredential, videoServiceStatuses } from './services.js';
import { xaiVideo } from './providers/xai.js';
import { replicateVideo } from './providers/replicate.js';
import type { VideoProvider } from './providers/types.js';
import { downloadVideo } from './transport.js';
import { VideoError } from './errors.js';
import { videoFile, videoStaging } from './paths.js';
import { cleanupVideoJob, persistVideo, prepareVideoReference } from './files.js';
import { claimVideo, jobRow, isVideoOpen, onVideoChange, patchJob, finishVideo, rememberCompletion, requestOf, parametersOf, OPEN_STATES, openSql, type VideoJobRow } from './store.js';

export interface VideoWorkerDependencies {
  now:()=>number;jitter:()=>number;provider:(service:VideoServiceId)=>VideoProvider;
  credential:(row:VideoJobRow)=>{apiKey:string};authorize:(row:VideoJobRow)=>void;
  reference:typeof prepareVideoReference;download:typeof downloadVideo;persist:typeof persistVideo;cleanup:typeof cleanupVideoJob;
}
function authorizeJob(row:VideoJobRow):void {
  const run=row.llm_run_id?db.prepare('SELECT config_json FROM generation_runs WHERE id=? AND thread_id=?').get(row.llm_run_id,row.thread_id):undefined;
  if(!run)throw new VideoError('credentials_changed',403);
  const config=JSON.parse(String(run.config_json)) as ResolvedRunConfig;
  if(!row.thread_id) throw new VideoError('cancelled',409);
  try {
    // Durable jobs can outlive their text turn: recheck the same live chat/family boundary.
    assertVideoTurn({userId:row.user_id,threadId:row.thread_id,assistantMessageId:row.assistant_message_id,
      getRunId:()=>row.llm_run_id,modelRef:config.modelRef,toolCallModel:true,toolPolicy:config.toolPolicy,
      interactive:config.turnOrigin==='interactive',unattended:false,turnOrigin:config.turnOrigin,
      temporary:false,restrictedChat:false,comparison:false},row.service);
  } catch {throw new VideoError('credentials_changed',403);}
  const status=videoServiceStatuses(row.user_id,getSettings(row.user_id).videoServices??{}).find(s=>s.id===row.service);
  if(!status?.enabled || status.model!==row.model_id) throw new VideoError('credentials_changed',403);
}
const defaults:VideoWorkerDependencies={now:Date.now,jitter:Math.random,provider:service=>service==='xai'?xaiVideo():replicateVideo(),credential:row=>videoCredential(row.user_id,row.service,row.connection_fingerprint),authorize:authorizeJob,reference:prepareVideoReference,download:downloadVideo,persist:persistVideo,cleanup:cleanupVideoJob};

/** Only call on process startup: one app writer per DB is the deployment contract. No resubmission here. */
export function recoverVideoJobs(now=Date.now()):void {
  db.prepare(`UPDATE video_jobs SET lease_until=NULL,revision=revision+1,updated_at=? WHERE state IN ${openSql}`).run(now);
}
export class VideoWorker {
  private deps:VideoWorkerDependencies;
  private active=new Map<string,{controller:AbortController;done:Promise<void>}>();
  private timer:ReturnType<typeof setInterval>|null=null;
  private detach:(()=>void)|null=null;
  private stopping=false;
  constructor(deps:Partial<VideoWorkerDependencies>={}) {this.deps={...defaults,...deps};}
  start():void {
    if(this.timer) return;
    this.stopping=false;
    this.detach=onVideoChange(id=>{if(jobRow(id)?.state==='cancel_requested')this.active.get(id)?.controller.abort();});
    this.timer=setInterval(()=>this.tick(),1000);this.timer.unref();this.tick();
  }
  async stop():Promise<void> {
    this.stopping=true;if(this.timer)clearInterval(this.timer);this.timer=null;this.detach?.();this.detach=null;
    for(const attempt of this.active.values())attempt.controller.abort();
    await Promise.all([...this.active.values()].map(a=>a.done));
  }
  tick():void {
    if(this.stopping) return;
    while(this.active.size<2) {
      const row=claimVideo(this.deps.now());if(!row)break;
      const controller=new AbortController();
      const done=this.process(row,controller).catch(()=>{}).finally(()=>this.active.delete(row.id));
      this.active.set(row.id,{controller,done});
    }
  }
  /** Deterministic one-claim seam: no timers, vendor traffic or implicit retries in tests. */
  async runOne():Promise<boolean> {
    const row=claimVideo(this.deps.now());if(!row)return false;
    await this.process(row,new AbortController());return true;
  }
  private async cancellation(row:VideoJobRow):Promise<void> {
    const d=this.deps;
    let remote:VideoJobRow['remote_cancellation']=row.submitted_at===null?'not_requested':row.service==='xai'?'unsupported':'unconfirmed';
    patchJob(row.id,row.lease_epoch,OPEN_STATES,{remote_cancellation:remote},d.now());
    if(row.provider_id_enc && row.service==='replicate') {
      try {const credential=d.credential(row);remote=await d.provider(row.service).cancel(credential.apiKey,decrypt(row.provider_id_enc));}catch{remote='unconfirmed';}
    }
    patchJob(row.id,row.lease_epoch,OPEN_STATES,{remote_cancellation:remote},d.now());
    const done=finishVideo(row.id,row.lease_epoch,row.error_code==='job_timeout'?'timed_out':'cancelled',row.error_code==='job_timeout'?'job_timeout':'cancelled',d.now());
    if(done)await d.cleanup(done).catch(()=>{});
  }
  private async process(initial:VideoJobRow,controller:AbortController):Promise<void> {
    const d=this.deps,epoch=initial.lease_epoch;
    const renew=setInterval(()=>{
      const current=jobRow(initial.id);
      if(!current || current.lease_epoch!==epoch || !isVideoOpen(current.state)) {controller.abort();return;}
      if(current.state==='cancel_requested' || current.deadline_at<=d.now()){controller.abort();return;}
      patchJob(current.id,epoch,OPEN_STATES,{lease_until:d.now()+VIDEO_LIMITS.leaseMs},d.now());
    },10_000);renew.unref();
    let row=initial;
    const update=(states:readonly VideoJobRow['state'][],patch:Parameters<typeof patchJob>[3])=>{
      const next=patchJob(row.id,epoch,states,patch,d.now());
      if(!next) throw new VideoError('cancelled',409);
      row=next;return row;
    };
    const credentials=()=>{d.authorize(row);return d.credential(row).apiKey;};
    try {
      if(row.state==='cancel_requested') {await this.cancellation(row);return;}
      if(row.deadline_at<=d.now()) {update(OPEN_STATES,{state:'cancel_requested',stage:'stopping',error_code:'job_timeout'});await this.cancellation(row);return;}
      if(row.state==='submitting' && !row.provider_id_enc) {
        const done=finishVideo(row.id,epoch,'submission_unknown','submission_unknown',d.now());if(done)await d.cleanup(done).catch(()=>{});return;
      }
      const provider=d.provider(row.service);
      if(row.state==='queued') {
        credentials();
        const referenceJpeg=await d.reference(row);
        const request=requestOf(jobRow(row.id)!);
        const key=credentials();
        update(['queued'],{state:'submitting',stage:'submitting',submitted_at:d.now(),deadline_at:d.now()+VIDEO_LIMITS.deadlineMs,may_have_charged:1});
        const receipt=await provider.submit(key,{model:row.model_id,prompt:request.prompt,parameters:parametersOf(row),referenceJpeg},controller.signal);
        // The provider id and polling state become durable in one write before any further request.
        if(jobRow(row.id)?.state==='cancel_requested') {
          update(['cancel_requested'],{provider_id_enc:encrypt(receipt.id)});await this.cancellation(row);return;
        }
        update(['submitting'],{provider_id_enc:encrypt(receipt.id),state:'polling',stage:'generating',next_poll_at:d.now()+2000,lease_until:null});
        return;
      }
      if(!row.provider_id_enc) throw new VideoError('provider_protocol');
      // Recover a durable renamed file first. Partial files never become success without inspection.
      if((row.state==='downloading'||row.state==='validating')&&existsSync(videoFile(row.user_id,row.id))) {
        credentials();update(['downloading','validating'],{state:'validating',stage:'checking'});
        if(await d.persist(row,videoFile(row.user_id,row.id),d.now())) {await d.cleanup(jobRow(row.id)!).catch(()=>{});return;}
        throw new VideoError('cancelled',409);
      }
      if(row.state!=='polling') update(['submitting','downloading','validating'],{state:'polling',stage:'generating'});
      let result:Awaited<ReturnType<VideoProvider['poll']>>;
      try {result=await provider.poll(credentials(),decrypt(row.provider_id_enc!),row.model_id,controller.signal);}
      catch(error) {
        const e=error instanceof VideoError?error:new VideoError('provider_unavailable',503);
        if(e.completion) rememberCompletion(row,e.completion.billedSeconds,d.now());
        if(['provider_unavailable','provider_rate_limit'].includes(e.code) && row.poll_failures<4) {
          update(['polling'],{poll_failures:row.poll_failures+1,next_poll_at:Math.min(row.deadline_at,d.now()+(e.retryAfterMs??15000)),lease_until:null});return;
        }
        throw e;
      }
      if(result.state==='queued'||result.state==='running') {
        const elapsed=d.now()-(row.submitted_at??d.now());
        const delay=elapsed<4000?4000:elapsed<11000?8000:15000;
        const jitter=0.8+Math.max(0,Math.min(1,d.jitter()))*.4;
        update(['polling'],{stage:result.state==='queued'?'queued_at_provider':'generating',poll_failures:0,next_poll_at:Math.min(row.deadline_at,d.now()+Math.round(delay*jitter)),lease_until:null});return;
      }
      if(result.state==='cancelled') {await this.cancellation(row);return;}
      if(result.state==='failed') throw new VideoError('provider_failed');
      if(result.state!=='succeeded')throw new VideoError('provider_protocol');
      const completed=rememberCompletion(row,result.billedSeconds,d.now());if(!completed)throw new VideoError('cancelled',409);row=completed;
      update(['polling'],{state:'downloading',stage:'downloading',poll_failures:0});
      const dir=videoStaging(row.user_id,row.id);await mkdir(dir,{recursive:true,mode:0o700});
      const part=path.join(dir,'output.part');await rm(part,{force:true});
      await d.download(result.output,part,controller.signal);
      update(['downloading'],{state:'validating',stage:'checking'});
      if(!await d.persist(row,part,d.now())) throw new VideoError('cancelled',409);
      await d.cleanup(jobRow(row.id)!).catch(()=>{});
    } catch(error) {
      if(this.stopping) return; // Leave durable state for restart, including ambiguous POSTs.
      const current=jobRow(initial.id);
      if(!current || current.lease_epoch!==epoch || !isVideoOpen(current.state)) return;
      if(current.state==='cancel_requested' || current.deadline_at<=d.now() || error instanceof VideoError && error.code==='cancelled') {
        if(current.deadline_at<=d.now()) patchJob(current.id,epoch,OPEN_STATES,{state:'cancel_requested',stage:'stopping',error_code:'job_timeout'},d.now());
        await this.cancellation(jobRow(current.id)!);return;
      }
      const e=error instanceof VideoError?error:new VideoError(current.state==='downloading'?'download_failed':current.state==='validating'?'storage_failed':'provider_unavailable');
      if(e.completion) rememberCompletion(current,e.completion.billedSeconds,d.now());
      const ambiguous=current.state==='submitting' && e.dispatch!=='rejected';
      const done=finishVideo(current.id,epoch,ambiguous?'submission_unknown':'failed',ambiguous?'submission_unknown':e.code,d.now());
      if(done)await d.cleanup(done).catch(()=>{});
    } finally {clearInterval(renew);}
  }
}
export const videoWorker=new VideoWorker();
