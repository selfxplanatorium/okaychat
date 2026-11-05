import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { db } from '../db.js';
import { encrypt } from '../crypto.js';
import { saveConnection } from '../catalog/providers.js';
import { admitVideo, claimVideo, finishVideo, jobRow, ownJob, patchJob, rememberCompletion, requestVideoCancel, videoJobView, type VideoJobRow } from './store.js';
import { VideoWorker, recoverVideoJobs, type VideoWorkerDependencies } from './worker.js';
import type { VideoProvider, VideoProviderStatus } from './providers/types.js';
import { downloadDescriptor } from './transport.js';
import { VideoError } from './errors.js';
import { videoFile, videoStaging } from './paths.js';
import { persistVideo, videoFileResponse } from './files.js';
import { storageUsed } from '../quota.js';
import { threadUsage } from '../usage.js';

let serial=0;
function context(){
  const user=`video_test_${++serial}`,thread=`thread_${serial}`;
  db.prepare("INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES (?,?,?,'unused','user',1)").run(user,`${user}@example.test`,user);
  db.prepare('INSERT INTO threads(id,user_id,created_at,updated_at) VALUES (?,?,1,1)').run(thread,user);
  saveConnection(user,'xai',{apiKey:'test-key',enabled:true});
  return {user,thread};
}
function admission(c:ReturnType<typeof context>,service:'xai'|'replicate'='xai'){
  if(service==='replicate')saveConnection(c.user,'image-replicate',{apiKey:'replicate-test-key',enabled:true});
  return {userId:c.user,threadId:c.thread,llmRunId:'run',assistantMessageId:'assistant',toolCallId:'call',service,model:service==='xai'?'grok-imagine-video-1.5-lite':'google/veo-3.1-fast',request:{prompt:'A boat',durationSeconds:4 as const,aspectRatio:'16:9' as const,size:'720p' as const,audio:true as const},authorize:()=>{}};
}
function fixture():Buffer {
  const n=(x:number)=>{const b=Buffer.alloc(4);b.writeUInt32BE(x);return b;};
  const box=(type:string,...parts:Buffer[])=>{const payload=Buffer.concat(parts);return Buffer.concat([n(payload.length+8),Buffer.from(type),payload]);};
  const full=(type:string,...parts:Buffer[])=>box(type,n(0),...parts);
  const ftyp=box('ftyp',Buffer.from('isom'),n(0),Buffer.from('avc1')),mdat=box('mdat',Buffer.alloc(100));
  const mv=Buffer.alloc(96);mv.writeUInt32BE(1000,12);mv.writeUInt32BE(4000,16);
  const tk=Buffer.alloc(84);tk.writeUInt32BE(1,0);tk.writeUInt32BE(4000,20);[65536,0,0,0,65536,0,0,0,1073741824].forEach((v,i)=>tk.writeUInt32BE(v,40+i*4));tk.writeUInt32BE(1280*65536,76);tk.writeUInt32BE(720*65536,80);
  const md=Buffer.alloc(24);md.writeUInt32BE(1000,12);md.writeUInt32BE(4000,16);
  const hd=Buffer.alloc(24);hd.write('vide',8);
  const sample=Buffer.alloc(78);sample.writeUInt16BE(1,6);sample.writeUInt16BE(1280,24);sample.writeUInt16BE(720,26);
  const stbl=box('stbl',full('stsd',n(1),box('avc1',sample,box('avcC',Buffer.from([1,66,0,30,255,225,0,1,103,1,0,1,104])))),full('stts',n(1),n(100),n(40)),full('stsc',n(1),n(1),n(100),n(1)),full('stsz',n(1),n(100)),full('stco',n(1),n(ftyp.length+8)));
  return Buffer.concat([ftyp,mdat,box('moov',box('mvhd',mv),box('trak',box('tkhd',tk),box('mdia',box('mdhd',md),box('hdlr',hd),box('minf',box('dinf',full('dref',n(1),box('url ',n(1)))),stbl))))]);
}
function harness(extra:Partial<VideoWorkerDependencies>={}){
  let now=1_000_000,submits=0,polls=0,cancels=0;
  let poll:()=>Promise<VideoProviderStatus>=async()=>({state:'succeeded',output:downloadDescriptor('xai','https://vidgen.x.ai/local-fixture'),billedSeconds:4});
  const provider:VideoProvider={service:'xai',async submit(){submits++;return{id:'provider_1'};},async poll(){polls++;return poll();},async cancel(){cancels++;return'confirmed';}};
  const worker=new VideoWorker({now:()=>now,jitter:()=>.5,provider:()=>provider,authorize:()=>{},reference:async()=>undefined,download:async(_descriptor,file)=>{const bytes=fixture();await writeFile(file,bytes,{mode:0o600});return{size:bytes.length,sha256:'unused'};},...extra});
  return {worker,provider,get now(){return now;},advance(ms=2000){now+=ms;},setPoll(fn:typeof poll){poll=fn;},counts:()=>({submits,polls,cancels})};
}
async function cancelRemaining(row:VideoJobRow){const fresh=jobRow(row.id)!;if(['queued','submitting','polling','downloading','validating','cancel_requested'].includes(fresh.state)){requestVideoCancel(row.user_id,row.id);recoverVideoJobs();await harness().worker.runOne();}}

// Every test finishes its open rows, so durable global admission slots are exercised rather than bypassed.
test('admission replay survives policy changes; quota is reserved before submit; success settles once with zero tokens',async()=>{
  const c=context(),h=harness(),a=admission(c),before=storageUsed(c.user);
  const row=admitVideo(a,h.now);
  assert.equal(storageUsed(c.user)-before,64*1024*1024+256*1024+32768);
  assert.equal(admitVideo({...a,authorize:()=>{throw new Error('revoked');}},h.now).id,row.id);
  await h.worker.runOne();assert.equal(jobRow(row.id)!.state,'polling');h.advance();await h.worker.runOne();
  const done=jobRow(row.id)!;assert.equal(done.state,'succeeded');assert.equal(done.cost_state,'estimated');
  assert.deepEqual(h.counts(),{submits:1,polls:1,cancels:0});
  const usage=db.prepare('SELECT * FROM usage WHERE video_job_id=?').get(row.id)!;
  for(const key of ['input_tokens','output_tokens','reasoning_tokens','cache_read_tokens','cache_write_tokens'])assert.equal(usage[key],0);
  assert.equal(usage.cost,.12);assert.equal(threadUsage(c.user,c.thread).cost,.12);
  recoverVideoJobs(h.now);await h.worker.runOne();assert.equal(h.counts().submits,1);
  assert.equal(storageUsed(c.user)-before,32768+fixture().length);
});

test('crash before POST safely resumes once; crash after POST before durable ID becomes unknown without resubmit',async()=>{
  for(const dispatched of [false,true]){
    const c=context(),h=harness(),row=admitVideo(admission(c),h.now),claimed=claimVideo(h.now)!;
    if(dispatched)patchJob(row.id,claimed.lease_epoch,['queued'],{state:'submitting',stage:'submitting',submitted_at:h.now});
    recoverVideoJobs(h.now);await h.worker.runOne();
    if(dispatched){assert.equal(jobRow(row.id)!.state,'submission_unknown');assert.equal(h.counts().submits,0);assert.equal(videoJobView(jobRow(row.id)!).error!.mayHaveCharged,true);const u=db.prepare('SELECT cost,cost_state FROM usage WHERE video_job_id=?').get(row.id)!;assert.equal(u.cost,0);assert.equal(u.cost_state,'unknown');assert.equal(threadUsage(c.user,c.thread).unknownCostRequests,1);}
    else {assert.equal(h.counts().submits,1);await cancelRemaining(row);}
  }
});

test('restart after ID or during download resumes same provider; orphan renamed output is adopted without network',async()=>{
  for(const stage of ['polling','downloading','validating'] as const){
    const c=context(),h=harness(),row=admitVideo(admission(c),h.now);
    await h.worker.runOne();h.advance();
    db.prepare('UPDATE video_jobs SET state=?,next_poll_at=0 WHERE id=?').run(stage,row.id);
    if(stage==='downloading'){await mkdir(videoStaging(c.user,row.id),{recursive:true});await writeFile(path.join(videoStaging(c.user,row.id),'output.part'),'truncated');}
    if(stage==='validating'){
      const claim=claimVideo(h.now)!;rememberCompletion(claim,4,h.now);
      await mkdir(path.dirname(videoFile(c.user,row.id)),{recursive:true});await writeFile(videoFile(c.user,row.id),fixture());
    }
    recoverVideoJobs(h.now);await h.worker.runOne();assert.equal(jobRow(row.id)!.state,'succeeded');assert.equal(h.counts().submits,1);assert.equal(h.counts().polls,stage==='validating'?0:1);
  }
});

test('ambiguous submit never retries, definitive rejection fails, and all dispatched failures settle unknown',async()=>{
  for(const dispatch of ['unknown','rejected'] as const){
    const c=context(),h=harness(),row=admitVideo(admission(c),h.now);
    h.provider.submit=async()=>{throw new VideoError('provider_unavailable',503,dispatch);};
    await h.worker.runOne();assert.equal(jobRow(row.id)!.state,dispatch==='unknown'?'submission_unknown':'failed');
    recoverVideoJobs(h.now);await h.worker.runOne();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage WHERE video_job_id=?').get(row.id)!.n,1);
  }
});

test('five transient polls terminate; deadline is unchanged across restart and times out with unknown billing',async()=>{
  const c=context(),h=harness(),row=admitVideo(admission(c),h.now);await h.worker.runOne();
  h.setPoll(async()=>{throw new VideoError('provider_unavailable',503);});
  for(let i=0;i<5;i++){h.advance(15000);await h.worker.runOne();}
  assert.equal(jobRow(row.id)!.state,'failed');assert.equal(h.counts().polls,5);assert.equal(h.counts().submits,1);
  const c2=context(),h2=harness(),r2=admitVideo(admission(c2),h2.now);await h2.worker.runOne();const deadline=jobRow(r2.id)!.deadline_at;
  h2.advance(480001);recoverVideoJobs(h2.now);await h2.worker.runOne();assert.equal(jobRow(r2.id)!.deadline_at,deadline);assert.equal(jobRow(r2.id)!.state,'timed_out');assert.equal(jobRow(r2.id)!.remote_cancellation,'unsupported');
});

test('cancellation queued/polling and late successful download cannot persist; remote stop is not a refund',async()=>{
  for(const when of ['queued','polling','downloading'] as const){
    const c=context();let row:VideoJobRow;
    const h=harness(when==='downloading'?{download:async()=>{requestVideoCancel(c.user,row.id);return{size:1,sha256:'unused'};}}:{});
    row=admitVideo(admission(c,'replicate'),h.now);
    if(when!=='queued'){await h.worker.runOne();h.advance();}
    if(when!=='downloading')requestVideoCancel(c.user,row.id);
    await h.worker.runOne();assert.equal(jobRow(row.id)!.state,'cancelled');assert.equal(db.prepare('SELECT COUNT(*) AS n FROM videos WHERE job_id=?').get(row.id)!.n,0);
    assert.equal(h.counts().cancels,when==='queued'?0:1);
    assert.equal(jobRow(row.id)!.cost_state,when==='downloading'?'estimated':'unknown');
    assert.equal(jobRow(row.id)!.settled_cost_microusd,when==='downloading'?600000:null);
  }
});

test('local validation failure still bills completed generation; credential replacement before submit makes no usage',async()=>{
  const c=context(),h=harness({download:async(_d,file)=>{await writeFile(file,'not MP4');return{size:7,sha256:'unused'};}}),row=admitVideo(admission(c),h.now);
  await h.worker.runOne();h.advance();await h.worker.runOne();assert.equal(jobRow(row.id)!.state,'failed');assert.equal(jobRow(row.id)!.error_code,'output_invalid');assert.equal(threadUsage(c.user,c.thread).cost,.12);
  const c2=context(),h2=harness(),r2=admitVideo(admission(c2),h2.now);saveConnection(c2.user,'xai',{apiKey:'replacement'});await h2.worker.runOne();assert.equal(jobRow(r2.id)!.error_code,'credentials_changed');assert.equal(h2.counts().submits,0);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage WHERE video_job_id=?').get(r2.id)!.n,0);
});

test('expired epoch cannot settle or persist after cancellation; cancelled requests remain owner scoped',async()=>{
  const c=context(),h=harness(),row=admitVideo(admission(c),h.now),old=claimVideo(h.now)!;
  h.advance(46000);const replacement=claimVideo(h.now)!;
  assert.equal(patchJob(row.id,old.lease_epoch,['queued'],{state:'succeeded'}),null);
  assert.equal(finishVideo(row.id,old.lease_epoch,'failed','provider_failed'),null);
  assert.throws(()=>ownJob('another-account',row.id));
  requestVideoCancel(c.user,row.id);recoverVideoJobs(h.now);await h.worker.runOne();assert.ok(replacement.lease_epoch>old.lease_epoch);assert.equal(jobRow(row.id)!.state,'cancelled');
});

test('owned serving authorizes before HEAD, validators and ranges; local output ranges never proxy vendors',async()=>{
  const c=context(),h=harness(),row=admitVideo(admission(c),h.now);await h.worker.runOne();h.advance();await h.worker.runOne();
  const url=`https://app.test/api/videos/${row.id}/file`;
  assert.equal((await videoFileResponse('foreign',row.id,new Request(url,{method:'HEAD',headers:{range:'bytes=999999-'}}))).status,404);
  for(const [range,status] of [['bytes=0-7',206],['bytes=-8',206],['bytes=8-',206],['bytes=0-1,3-4',416],['bytes=999999-',416]] as const){const response=await videoFileResponse(c.user,row.id,new Request(url,{headers:{range}}));assert.equal(response.status,status);await response.body?.cancel();}
  const response=await videoFileResponse(c.user,row.id,new Request(url,{headers:{range:'bytes=0-7','if-range':'wrong'}}));assert.equal(response.status,200);await response.body?.cancel();
  assert.equal((await readFile(videoFile(c.user,row.id))).length,(await stat(videoFile(c.user,row.id))).size);
});

test('fork keeps only completed owned output alive; deleting the source cannot delete shared bytes or usage',async()=>{
  const {branchThread,deleteThread}=await import('../threads.js');
  const {maintainVideos}=await import('./maintenance.js');
  const c=context(),h=harness(),row=admitVideo(admission(c),h.now);await h.worker.runOne();h.advance();await h.worker.runOne();
  const user={id:'user',role:'user',parts:[{type:'text',text:'A boat'}]};
  const assistant={id:'assistant',role:'assistant',parts:[{type:'tool-generate_video',state:'output-available',toolCallId:'call',input:{prompt:'A boat'},output:{version:1,accepted:true,state:'queued',jobId:row.id,service:'xai',model:row.model_id}}]};
  db.prepare("INSERT INTO messages(id,thread_id,parent_id,format,content,created_at,bytes) VALUES('user',?,NULL,'ai-sdk/v6',?,1,1)").run(c.thread,JSON.stringify(user));
  db.prepare("INSERT INTO messages(id,thread_id,parent_id,format,content,created_at,bytes) VALUES('assistant',?,'user','ai-sdk/v6',?,2,1)").run(c.thread,JSON.stringify(assistant));
  const fork=branchThread(c.user,c.thread,'assistant',`${c.thread}_fork`);
  assert.equal(db.prepare('SELECT count(*) AS n FROM video_threads WHERE video_id=?').get(row.id)!.n,2);
  deleteThread(c.user,c.thread);await maintainVideos(h.now);
  assert.ok(await stat(videoFile(c.user,row.id)));assert.equal(db.prepare('SELECT count(*) AS n FROM video_threads WHERE thread_id=?').get(fork.id)!.n,1);
  assert.equal(db.prepare('SELECT cost FROM usage WHERE video_job_id=?').get(row.id)!.cost,.12);
  const second=branchThread(c.user,fork.id,'assistant',`${fork.id}_again`);
  assert.equal(db.prepare('SELECT count(*) AS n FROM video_threads WHERE video_id=?').get(row.id)!.n,2);
  deleteThread(c.user,fork.id);await maintainVideos(h.now);assert.ok(await stat(videoFile(c.user,row.id)));
  deleteThread(c.user,second.id);await maintainVideos(h.now);
  assert.equal(db.prepare('SELECT count(*) AS n FROM videos WHERE id=?').get(row.id)!.n,0);
  await assert.rejects(stat(videoFile(c.user,row.id)));
});

test('thread deletion during download cancels locally and cannot resurrect output',async()=>{
  const {deleteThread}=await import('../threads.js');
  const c=context(),h=harness({download:async()=>{deleteThread(c.user,c.thread);return{size:1,sha256:'unused'};}}),row=admitVideo(admission(c),h.now);
  await h.worker.runOne();h.advance();await h.worker.runOne();
  assert.equal(jobRow(row.id)!.state,'cancelled');assert.equal(jobRow(row.id)!.thread_id,null);assert.equal(jobRow(row.id)!.request_enc,null);
  assert.equal(db.prepare('SELECT count(*) AS n FROM videos WHERE job_id=?').get(row.id)!.n,0);
});

test('shutdown aborts an in-flight submit and restart marks it unknown without a second POST',async()=>{
  const c=context(),h=harness(),row=admitVideo(admission(c),h.now);
  let started!:()=>void;
  const ready=new Promise<void>(resolve=>{started=resolve;});
  let submits=0;
  h.provider.submit=async(_key,_input,signal)=>{
    submits++;started();
    return new Promise((_resolve,reject)=>signal!.addEventListener('abort',()=>reject(new VideoError('provider_unavailable',503,'unknown')),{once:true}));
  };
  h.worker.start();await ready;await h.worker.stop();
  assert.equal(jobRow(row.id)!.state,'submitting');recoverVideoJobs(h.now);
  await harness().worker.runOne();assert.equal(jobRow(row.id)!.state,'submission_unknown');assert.equal(submits,1);
});

test('a late receipt after cancellation is saved for remote stop, and cleanup failure keeps bytes reserved',async()=>{
  const c=context(),h=harness({cleanup:async()=>{throw new Error('disk unavailable');}}),row=admitVideo(admission(c,'replicate'),h.now);
  h.provider.submit=async()=>{requestVideoCancel(c.user,row.id);return{id:'late_provider_receipt'};};
  await h.worker.runOne();const done=jobRow(row.id)!;
  assert.equal(done.state,'cancelled');assert.ok(done.provider_id_enc);assert.equal(h.counts().cancels,1);assert.equal(done.cost_state,'unknown');
  assert.equal(done.reservation_bytes,64*1024*1024+256*1024+32768);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage WHERE video_job_id=?').get(row.id)!.n,1);
});
