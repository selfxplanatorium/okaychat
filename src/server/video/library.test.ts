import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,writeFile,stat } from 'node:fs/promises';
import path from 'node:path';
import { Hono } from 'hono';
import { db } from '../db.js';
import { requireUser,type AppEnv } from '../auth.js';
import { sha256 } from '../crypto.js';
import { saveConnection } from '../catalog/providers.js';
import { listLibrary,libraryRoutes } from '../library.js';
import { storageUsed } from '../quota.js';
import { admitVideo,patchJob,videoJobView,jobRow } from './store.js';
import { videoFile } from './paths.js';
import { videoFileResponse } from './files.js';

const app=new Hono<AppEnv>().use('*',requireUser).route('/',libraryRoutes);
for(const user of ['vl_owner','vl_foreign']){
  db.prepare("INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,'x','user',1)").run(user,`${user}@example.test`,user);
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(sha256(user),user,Date.now()+600000);
  saveConnection(user,'xai',{apiKey:'fake',enabled:true});
}
for(const id of ['vp_one','vp_two'])db.prepare("INSERT INTO projects(id,user_id,name,created_at) VALUES(?,'vl_owner',?,1)").run(id,id);
for(const [id,project] of [['vt_origin','vp_one'],['vt_fork','vp_two']] as const)db.prepare("INSERT INTO threads(id,user_id,project_id,title,created_at,updated_at) VALUES(?,'vl_owner',?,?,1,2)").run(id,project,id);
let serial=0;
async function video(label:string,time:number,size=40){
  const row=admitVideo({userId:'vl_owner',threadId:'vt_origin',llmRunId:'r',assistantMessageId:`a_${++serial}`,toolCallId:'c',service:'xai',model:'grok-imagine-video-1.5-lite',request:{prompt:label,durationSeconds:4,aspectRatio:'16:9',size:'720p',audio:true},authorize:()=>{}},time);
  patchJob(row.id,0,['queued'],{state:'succeeded',finished_at:time,reservation_bytes:32768},time);
  db.prepare("INSERT INTO videos(id,user_id,job_id,origin_thread_id,label,size,sha256,duration_ms,width,height,has_audio,created_at) VALUES(?,'vl_owner',?,'vt_origin',?,?,?,4000,1280,720,1,?)").run(row.id,row.id,label,size,sha256(label),time);
  for(const thread of ['vt_origin','vt_fork'])db.prepare('INSERT INTO video_threads(video_id,thread_id) VALUES(?,?)').run(row.id,thread);
  await mkdir(path.dirname(videoFile('vl_owner',row.id)),{recursive:true});await writeFile(videoFile('vl_owner',row.id),Buffer.alloc(size));
  return row.id;
}
test('Library videos are private, completed-only, deduplicated, and filter through every live chat/project reference',async()=>{
  const id=await video('Clip A',1000);
  db.prepare("INSERT INTO uploads(id,user_id,name,mime,data,created_at) VALUES('opaque','vl_owner','upload.mp4','video/mp4',x'01',1)").run();
  const videos=await listLibrary('vl_owner',{kind:'video'});assert.equal(videos.items.length,1);
  assert.equal(videos.items[0]!.id,`video:${id}`);assert.equal(videos.items[0]!.posterUrl,null);assert.equal(videos.items[0]!.durationMs,4000);assert.equal(videos.items[0]!.thumbUrl,undefined);assert.equal(videos.items[0]!.source,'generated');
  for(const project of ['vp_one','vp_two'])assert.equal((await listLibrary('vl_owner',{kind:'video',projectId:project})).items.length,1);
  assert.equal((await listLibrary('vl_owner',{kind:'video',threadId:'vt_fork'})).items.length,1);
  assert.equal((await listLibrary('vl_foreign',{kind:'video'})).items.length,0);
  assert.equal((await listLibrary('vl_owner',{kind:'other'})).items.some(item=>item.id==='upload:opaque'),true);
  db.prepare("DELETE FROM threads WHERE id='vt_origin'").run();
  assert.equal((await listLibrary('vl_owner',{kind:'video'})).items[0]!.threadId,'vt_fork');
  db.prepare("INSERT INTO threads(id,user_id,project_id,title,created_at,updated_at) VALUES('vt_origin','vl_owner','vp_one','origin',1,1)").run();
});

test('video filters keep all four keyset sorts stable across duplicate names, times and sizes',async()=>{
  await video('Clip B',2000);await video('Clip B',2000);await video('Clip C',3000,50);
  for(const sort of ['newest','oldest','name','size'] as const){
    const expected=(await listLibrary('vl_owner',{kind:'video',sort,limit:100})).items.map(item=>item.id);
    const seen:string[]=[];let cursor:string|undefined;
    do{const page=await listLibrary('vl_owner',{kind:'video',sort,limit:1,cursor});seen.push(...page.items.map(item=>item.id));cursor=page.nextCursor??undefined;}while(cursor);
    assert.deepEqual(seen,expected);assert.equal(new Set(seen).size,4);
  }
});

test('global Library delete authorizes first, removes bytes/all refs, frees bytes once and invalidates historical cards',async()=>{
  const item=(await listLibrary('vl_owner',{kind:'video'})).items[0]!,id=item.id.slice(6),before=storageUsed('vl_owner');
  assert.equal((await app.request(`/library/video/${id}`,{method:'DELETE',headers:{cookie:'okaychat_session=vl_foreign'}})).status,404);
  assert.equal((await app.request(`/library/video/${id}`,{method:'DELETE',headers:{cookie:'okaychat_session=vl_owner'}})).status,200);
  assert.equal(before-storageUsed('vl_owner'),item.size);await assert.rejects(stat(videoFile('vl_owner',id)));
  assert.equal(db.prepare('SELECT count(*) AS n FROM video_threads WHERE video_id=?').get(id)!.n,0);assert.equal(videoJobView(jobRow(id)!).outputUnavailable,true);
  assert.equal((await videoFileResponse('vl_owner',id,new Request('https://app.test/file',{method:'HEAD'}))).status,404);
});
