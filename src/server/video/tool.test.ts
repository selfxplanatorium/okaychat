import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { db } from '../db.js';
import { beginRun } from '../generation-runs.js';
import { saveConnection } from '../catalog/providers.js';
import { getSettings, updateSettings } from '../settings.js';
import { writePolicy } from '../permissions/store.js';
import { videoTools } from '../tools/video.js';
import { videoServiceStatuses } from './services.js';
import { assertVideoTurn, videoModeEligible, type VideoTurnContext, type VideoEligibilityDependencies } from './eligibility.js';
import { jobRow, finishVideo, patchJob, type VideoJobRow } from './store.js';
import { retryVideo } from './retry.js';
import { riskOfTool } from '../prompt-injection.js';
import type { VideoAcceptedResult } from '../../shared/video.js';
import type { ResolvedRunConfig } from '../../shared/assistant-presets.js';

let serial=0;
function setup(){
  const user=`vt_${++serial}`,thread=`vtt_${serial}`;
  db.prepare("INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,'x','user',1)").run(user,`${user}@example.test`,user);
  db.prepare('INSERT INTO threads(id,user_id,created_at,updated_at) VALUES(?,?,1,1)').run(thread,user);
  saveConnection(user,'xai',{apiKey:'own-video-key',enabled:true});
  updateSettings(user,{videoServices:{xai:{enabled:true,durationSeconds:4}}});
  let runId:string|null=null,modelChecks=0;
  const context:VideoTurnContext={userId:user,threadId:thread,assistantMessageId:'assistant',getRunId:()=>runId,modelRef:'xai/test-model',toolCallModel:true,toolPolicy:{mode:'inherit',builtins:[],mcpTools:[]},interactive:true,unattended:false,turnOrigin:'interactive',temporary:false,restrictedChat:false,comparison:false};
  const deps:VideoEligibilityDependencies={model:async()=>{modelChecks++;return{toolCall:true};},voice:()=>false};
  const services=()=>videoServiceStatuses(user,getSettings(user).videoServices??{}).filter(s=>s.enabled);
  const tool=videoTools(context,services(),deps).generate_video!;
  const run=()=>{const config:ResolvedRunConfig={version:1,requestKind:'send',turnOrigin:'interactive',modelRef:context.modelRef,sampling:{},instructions:'',toolPolicy:context.toolPolicy,knowledgeIds:[],assistantName:null,assistantIcon:null,assistantRevision:null,webSearch:false,deepResearch:false};runId=beginRun({userId:user,threadId:thread,userMessageId:'u',assistantMessageId:'assistant',config}).id;};
  const execute=async(t=tool,input:unknown={prompt:'A boat'},id='call')=>await t.execute!(input,{toolCallId:id,messages:[]}) as VideoAcceptedResult;
  return {user,thread,context,deps,tool,run,services,execute,modelChecks:()=>modelChecks};
}
function finish(row:VideoJobRow){finishVideo(row.id,row.lease_epoch,'failed','provider_unavailable');}

test('tool allocated before LLM receipt uses the live getter and returns only an acceptance receipt',async()=>{
  const c=setup();c.run();const accepted=await c.execute();
  assert.deepEqual(Object.keys(accepted).sort(),['accepted','jobId','model','service','state','version']);assert.equal(accepted.accepted,true);assert.equal(accepted.state,'queued');
  const row=jobRow(accepted.jobId)!;assert.equal(row.llm_run_id,c.context.getRunId());assert.equal(c.modelChecks(),1);
  const model=await c.tool.toModelOutput!({toolCallId:'call',input:{prompt:'A boat'},output:accepted});
  assert.equal(model.type,'text');assert.match(JSON.stringify(model),/started/);assert.equal(JSON.stringify(model).includes('https:'),false);
  assert.equal(riskOfTool(c.tool),'outbound');
  updateSettings(c.user,{videoServices:{xai:{enabled:false}}});
  assert.equal((await c.execute()).jobId,accepted.jobId);assert.equal(c.modelChecks(),1);
  finish(row);
});

for(const [name,change] of [
  ['temporary',{temporary:true}],['temporary-id',{threadId:'tmp_forged'}],['schedule',{interactive:false,unattended:true,turnOrigin:'schedule'}],
  ['delegate',{interactive:false,turnOrigin:undefined}],['voice-mode',{interactive:false}],['comparison',{comparison:true,turnOrigin:'comparison'}],
  ['evaluation',{turnOrigin:undefined}],['channel',{interactive:false}],['API',{interactive:false,turnOrigin:undefined}],
  ['restricted',{restrictedChat:true}],['no-tools-model',{toolCallModel:false}],['disabled-family',{toolPolicy:{mode:'selected' as const,builtins:['images'],mcpTools:[]}}],
] as Array<[string,Partial<VideoTurnContext>]>) {
  test(`execution rejects ${name} with zero admissions`,async()=>{
    const c=setup();c.run();Object.assign(c.context,change);
    assert.equal(videoModeEligible(c.context),false);
    await assert.rejects(c.execute());
    assert.equal(db.prepare('SELECT count(*) AS n FROM video_jobs WHERE user_id=?').get(c.user)!.n,0);
  });
}

test('voice, feature, shared-only keys, endpoint changes and service disable are rechecked after assembly',async()=>{
  for(const condition of ['voice','feature','shared','endpoint','service','receipt'] as const){
    const c=setup();if(condition!=='receipt')c.run();
    if(condition==='voice')c.deps.voice=()=>true;
    if(condition==='feature')writePolicy({kind:'user',id:c.user},null,{version:1,features:{videos:false}},null);
    if(condition==='shared'){db.prepare('DELETE FROM provider_connections WHERE user_id=?').run(c.user);saveConnection(null,'xai',{apiKey:'shared-only',enabled:true});}
    if(condition==='endpoint')saveConnection(c.user,'xai',{apiKey:'own-video-key',baseURL:'https://custom.example.test/v1'});
    if(condition==='service')updateSettings(c.user,{videoServices:{xai:{enabled:false}}});
    const tool=videoTools(c.context,c.services().length?c.services():[{id:'xai',name:'xAI',connected:true,enabled:true,requiresOwnKey:false,unavailableReason:null,model:'grok-imagine-video-1.5-lite',models:[],defaults:{durationSeconds:4,aspectRatio:'16:9',size:'720p'}}],c.deps).generate_video!;
    await assert.rejects(c.execute(tool));
    assert.equal(db.prepare('SELECT count(*) AS n FROM video_jobs WHERE user_id=?').get(c.user)!.n,0);
  }
});

test('live model lookup and the synchronous admission guard close async permission races',async()=>{
  const c=setup();c.run();c.deps.model=async()=>{writePolicy({kind:'user',id:c.user},null,{version:1,features:{videos:false}},null);return{toolCall:true};};
  const tool=videoTools(c.context,c.services(),c.deps).generate_video!;await assert.rejects(c.execute(tool));
  assert.equal(db.prepare('SELECT count(*) AS n FROM video_jobs WHERE user_id=?').get(c.user)!.n,0);
});

test('strict schemas omit service with one backend and require a user-selected enum with several',()=>{
  const c=setup();
  const schema=c.tool.inputSchema as z.ZodType;
  assert.equal(schema.safeParse({prompt:'boat',service:'xai'}).success,false);
  assert.equal(schema.safeParse({prompt:'boat',url:'https://example.test'}).success,false);
  assert.equal(schema.safeParse({prompt:'boat',model:'unreviewed'}).success,false);
  assert.equal(schema.safeParse({prompt:' '.repeat(10)}).success,false);
  saveConnection(c.user,'image-replicate',{apiKey:'own',enabled:true});updateSettings(c.user,{videoServices:{xai:{enabled:true},replicate:{enabled:true}}});
  const both=videoTools(c.context,c.services(),c.deps).generate_video!,bs=both.inputSchema as z.ZodType;
  assert.equal(bs.safeParse({prompt:'boat'}).success,false);assert.equal(bs.safeParse({prompt:'boat',service:'replicate'}).success,true);
});

test('concurrent direct retries create one child, preserve original run, and recheck revision and live eligibility',async()=>{
  const c=setup();c.run();const result=await c.execute(),row=jobRow(result.jobId)!;
  patchJob(row.id,row.lease_epoch,['queued'],{state:'submitting',submitted_at:Date.now()});finishVideo(row.id,row.lease_epoch,'submission_unknown','submission_unknown');
  const parent=jobRow(row.id)!;
  await assert.rejects(retryVideo(c.user,row.id,parent.revision-1,c.deps));
  const [a,b]=await Promise.all([retryVideo(c.user,row.id,parent.revision,c.deps),retryVideo(c.user,row.id,parent.revision,c.deps)]);
  assert.equal(a.id,b.id);assert.equal(a.retry_of,parent.id);assert.equal(a.attempt,1);assert.equal(a.llm_run_id,parent.llm_run_id);
  assert.equal(db.prepare('SELECT count(*) AS n FROM video_jobs WHERE retry_of=?').get(row.id)!.n,1);finish(a);
  updateSettings(c.user,{videoServices:{xai:{enabled:false}}});assert.throws(()=>assertVideoTurn(c.context,'xai',c.deps));
});

test('the production worker rechecks model-scoped video revocation before the paid POST',async()=>{
  const {VideoWorker}=await import('./worker.js');
  const c=setup();c.run();const accepted=await c.execute();
  writePolicy({kind:'user',id:c.user},c.context.modelRef,{version:1,features:{videos:false}},null);
  let submits=0;
  const worker=new VideoWorker({provider:()=>({service:'xai',async submit(){submits++;return{id:'must_not_submit'};},async poll(){throw new Error('Unexpected poll');},async cancel(){return'unsupported';}})});
  await worker.runOne();
  assert.equal(submits,0);assert.equal(jobRow(accepted.jobId)!.error_code,'credentials_changed');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage WHERE video_job_id=?').get(accepted.jobId)!.n,0);
});
