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
