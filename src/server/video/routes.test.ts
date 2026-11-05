import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { csrf } from 'hono/csrf';
import { db } from '../db.js';
import { handleAppError } from '../errors.js';
import { sha256 } from '../crypto.js';
import { requireUser, type AppEnv } from '../auth.js';
import { saveConnection } from '../catalog/providers.js';
import { videoRoutes } from './routes.js';
import { admitVideo, claimVideo, finishVideo } from './store.js';

const app=new Hono<AppEnv>();app.onError(handleAppError);app.use('*',csrf());app.use('*',requireUser);app.route('/',videoRoutes);
const cookie='test-video-session';
db.prepare("INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES('vroute','vroute@example.test','Video','x','user',1)").run();
db.prepare("INSERT INTO threads(id,user_id,created_at,updated_at) VALUES('vthread','vroute',1,1)").run();
db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(sha256(cookie),'vroute',Date.now()+3600000);
saveConnection('vroute','xai',{apiKey:'test',enabled:true});
const row=admitVideo({userId:'vroute',threadId:'vthread',llmRunId:'r',assistantMessageId:'a',toolCallId:'t',service:'xai',model:'grok-imagine-video-1.5-lite',request:{prompt:'boat',durationSeconds:4,aspectRatio:'16:9',size:'720p',audio:true},authorize:()=>{}});
const headers={Cookie:`okaychat_session=${cookie}`};
test('job/status endpoints authenticate, foreign/missing ids match, and SSE emits an authored snapshot',async()=>{
  assert.equal((await app.request(`/video-jobs/${row.id}`)).status,401);
  assert.equal((await app.request('/video-jobs/missing',{headers})).status,404);
  const response=await app.request(`/video-jobs/${row.id}/events`,{headers});
  assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'text/event-stream');
  const reader=response.body!.getReader();
  const first=await reader.read(),text=new TextDecoder().decode(first.value);
  assert.match(text,/event: video-job/);assert.match(text,/"state":"queued"/);assert.equal(text.includes('prompt'),false);assert.equal(text.includes('test-key'),false);
  await reader.cancel();
  assert.equal((await app.request('/threads/foreign/video-jobs',{headers})).status,404);
});
test('video writes are CSRF guarded; SSE terminal snapshot closes immediately',async()=>{
  assert.equal((await app.request(`/video-jobs/${row.id}/cancel`,{method:'POST',headers:{...headers,'Content-Type':'text/plain',Origin:'https://foreign.test'},body:'{}'})).status,403);
  const claimed=claimVideo()!;finishVideo(row.id,claimed.lease_epoch,'failed','provider_failed');
  const response=await app.request(`/video-jobs/${row.id}/events`,{headers});const text=await response.text();assert.match(text,/"state":"failed"/);
});

test('retry/cancel reject malformed or extra JSON fields with a safe validation response',async()=>{
  for(const [action,body] of [['retry','{}'],['retry','{"expectedRevision":"not a revision"}'],['cancel','{"url":"https://untrusted.example"}']] as const){
    const response=await app.request(`/video-jobs/${row.id}/${action}`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body});
    assert.equal(response.status,400);const wire=await response.json() as {code:string};assert.equal(wire.code,'validation');
  }
});

test('service management is curated, private, bounded, and reuses the image credential without leaking keys',async()=>{
  const {getOwnConnection}=await import('../catalog/providers.js');
  const {updateSettings,getSettings}=await import('../settings.js');
  updateSettings('vroute',{videoServices:{xai:{enabled:true}}});
  const get=async(path:string)=>app.request(path,{headers});
  const list=await get('/video-services');assert.equal(list.status,200);
  const payload=await list.json() as {services:Array<{id:string;enabled:boolean;requiresOwnKey:boolean;unavailableReason:string|null}>};
  assert.equal(payload.services.find(s=>s.id==='xai')!.enabled,true);
  const models=await (await get('/video-services/replicate/models')).json() as {live:boolean;source:string;models:Array<{id:string}>};
  assert.equal(models.live,false);assert.equal(models.source,'curated');assert.deepEqual(models.models.map(m=>m.id),['google/veo-3.1-fast']);
  const key='private-key-not-for-response';
  const saved=await app.request('/video-services/replicate/key',{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({apiKey:key})});
  assert.equal(saved.status,200);assert.equal((await saved.text()).includes(key),false);assert.equal(getOwnConnection('vroute','image-replicate')!.apiKey,key);
  assert.equal(getSettings('vroute').imageServices,undefined);
  assert.equal((await app.request('/video-services/xai/key',{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:'{"apiKey":"forbidden"}'})).status,404);
  assert.equal((await app.request('/video-services/replicate/key',{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({apiKey:'x'.repeat(8193)})})).status,400);
  await app.request('/video-services/replicate/key',{method:'DELETE',headers:{...headers,'Sec-Fetch-Site':'same-origin'}});assert.equal(getOwnConnection('vroute','image-replicate'),undefined);
  saveConnection(null,'image-replicate',{apiKey:'shared-only',enabled:true});
  const shared=await (await get('/video-services')).json() as typeof payload;assert.equal(shared.services.find(s=>s.id==='replicate')!.requiresOwnKey,true);
  saveConnection('vroute','xai',{apiKey:'test',baseURL:'https://custom.example.test/v1',enabled:true});
  const unsupported=await (await get('/video-services')).json() as typeof payload;
  assert.equal(unsupported.services.find(s=>s.id==='xai')!.unavailableReason,'unsupported_endpoint');assert.equal(unsupported.services.find(s=>s.id==='xai')!.enabled,false);
});

test('stored retired model remains visible as unavailable and strict settings writes reject it',async()=>{
  const {getSettings,updateSettings}=await import('../settings.js');
  db.prepare("UPDATE user_settings SET json=? WHERE user_id='vroute'").run(JSON.stringify({videoServices:{xai:{enabled:true,model:'retired-model'}}}));
  assert.equal(getSettings('vroute').videoServices!.xai!.model,'retired-model');
  // Restore the canonical key to isolate model unavailability from endpoint status.
  db.prepare("UPDATE provider_connections SET base_url=NULL WHERE user_id='vroute' AND provider_id='xai'").run();
  const body=await (await app.request('/video-services',{headers})).json() as {services:Array<{id:string;model:string;enabled:boolean;unavailableReason:string|null}>};
  assert.equal(body.services[0]!.model,'retired-model');assert.equal(body.services[0]!.enabled,false);assert.equal(body.services[0]!.unavailableReason,'unsupported_parameters');
  assert.throws(()=>updateSettings('vroute',{videoServices:{xai:{model:'retired-model'}}}));
});
