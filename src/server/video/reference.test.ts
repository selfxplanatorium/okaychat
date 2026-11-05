import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile,stat,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import { db } from '../db.js';
import { saveConnection } from '../catalog/providers.js';
import { updateSettings } from '../settings.js';
import { putMedia } from '../media/store.js';
import { normalizeVideoReference } from '../media/variants.js';
import { admitVideo,finishVideo,jobRow,requestOf,requestVideoCancel,parametersOf } from './store.js';
import { retryVideo } from './retry.js';
import { prepareVideoReference } from './files.js';
import { VideoWorker,recoverVideoJobs } from './worker.js';
import { videoStaging } from './paths.js';
import { VideoError } from './errors.js';
import type { VideoProvider } from './providers/types.js';

let serial=0;
function setup(){
  const user=`vref_${++serial}`,thread=`vref_thread_${serial}`;
  db.prepare("INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,'x','user',1)").run(user,`${user}@example.test`,user);
  db.prepare('INSERT INTO threads(id,user_id,created_at,updated_at) VALUES(?,?,1,1)').run(thread,user);
  saveConnection(user,'xai',{apiKey:'reference-test-key',enabled:true});
  updateSettings(user,{videoServices:{xai:{enabled:true,durationSeconds:4}}});
  let now=Date.now(),submits=0,received:Buffer|undefined;
  const provider:VideoProvider={service:'xai',async submit(_key,input){submits++;received=input.referenceJpeg;return{id:'fake_reference_job'};},async poll(){return{state:'running'};},async cancel(){return'unsupported';}};
  const worker=new VideoWorker({now:()=>now,provider:()=>provider,authorize:()=>{}});
  const admit=(referenceUploadId:string)=>admitVideo({userId:user,threadId:thread,llmRunId:'run',assistantMessageId:'assistant',toolCallId:'call',service:'xai',model:'grok-imagine-video-1.5-lite',request:{prompt:'Preserve the starting image',referenceUploadId,durationSeconds:4,aspectRatio:'16:9',size:'720p',audio:true},authorize:()=>{}} ,now);
  const upload=(bytes:Buffer,backed=false)=>{
    const id=`upl_ref_${serial}`;
    const mediaId=backed?putMedia(user,bytes).media.id:null;
    db.prepare("INSERT INTO uploads(id,user_id,name,mime,data,created_at,media_id) VALUES(?,?,'reference.png','image/png',?,1,?)").run(id,user,backed?Buffer.alloc(0):bytes,mediaId);
    return id;
  };
  return {user,thread,worker,admit,upload,get now(){return now;},advance(){now+=2000;},submits:()=>submits,received:()=>received};
}
const solid=(width=160,height=90,alpha=1)=>sharp({create:{width,height,channels:4,background:{r:20,g:70,b:120,alpha}}}).png().toBuffer();

for(const backed of [false,true])test(`owned ${backed?'file-backed':'legacy BLOB'} raster is normalized once and retained privately after upload deletion`,async()=>{
  const c=setup(),original=await solid(3200,1800,.5),upload=c.upload(original,backed),row=c.admit(upload);
  await c.worker.runOne();assert.equal(c.submits(),1);assert.equal(jobRow(row.id)!.state,'polling');
  const normalized=c.received()!;assert.ok(normalized.length<=256*1024);
  const metadata=await sharp(normalized).metadata();assert.equal(metadata.format,'jpeg');assert.equal(metadata.hasAlpha,false);assert.equal(metadata.exif,undefined);assert.deepEqual([metadata.width,metadata.height],[1280,720]);
  const dir=videoStaging(c.user,row.id),file=path.join(dir,'reference.jpg');
  assert.equal((await stat(dir)).mode&0o777,0o700);assert.equal((await stat(file)).mode&0o777,0o600);
  assert.deepEqual(await readFile(file),normalized);
  const retained=requestOf(jobRow(row.id)!);assert.match(retained.referenceSha256!,/^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(retained).includes('base64'),false);assert.equal(JSON.stringify(parametersOf(jobRow(row.id)!)).includes(upload),false);
  db.prepare('DELETE FROM uploads WHERE id=? AND user_id=?').run(upload,c.user);
  recoverVideoJobs(c.now);assert.deepEqual(await prepareVideoReference(jobRow(row.id)!),normalized);
  c.advance();await c.worker.runOne();assert.equal(c.submits(),1);
  requestVideoCancel(c.user,row.id);await c.worker.runOne();assert.equal(jobRow(row.id)!.state,'cancelled');await assert.rejects(stat(dir));
});

test('normalization respects orientation, composites on white, strips metadata and does not upscale',async()=>{
  const rotated=await sharp({create:{width:90,height:160,channels:3,background:'#336699'}}).jpeg().withMetadata({orientation:6}).toBuffer();
  const output=await normalizeVideoReference(rotated,'16:9'),meta=await sharp(output).metadata();
  assert.deepEqual([meta.width,meta.height],[160,90]);assert.equal(meta.orientation,undefined);assert.equal(meta.exif,undefined);
  const transparent=await normalizeVideoReference(await solid(160,90,0),'16:9');
  const decoded=await sharp(transparent).raw().toBuffer({resolveWithObject:true});
  assert.equal(decoded.info.channels,3);assert.ok([...decoded.data.subarray(0,3)].every(n=>n>=250));
  const portrait=await normalizeVideoReference(await solid(90,160),'9:16');assert.deepEqual([(await sharp(portrait).metadata()).width,(await sharp(portrait).metadata()).height],[90,160]);
});

test('aspect validation allows one-percent tolerance and rejects mismatches before any provider call',async()=>{
  const near=await normalizeVideoReference(await solid(161,90),'16:9');assert.equal((await sharp(near).metadata()).width,161);
  const c=setup(),row=c.admit(c.upload(await solid(162,90)));await c.worker.runOne();
  assert.equal(c.submits(),0);assert.equal(jobRow(row.id)!.error_code,'reference_aspect_mismatch');assert.equal(jobRow(row.id)!.submitted_at,null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage WHERE video_job_id=?').get(row.id)!.n,0);
});

test('foreign and missing upload IDs have the same safe outcome; owned pointers cannot read foreign media',async()=>{
  const foreign=setup(),foreignId=foreign.upload(await solid(),true);
  for(const id of [foreignId,'upl_missing']){
    const c=setup(),row=c.admit(id);await c.worker.runOne();assert.equal(c.submits(),0);assert.equal(jobRow(row.id)!.error_code,'invalid_reference');assert.equal(jobRow(row.id)!.submitted_at,null);
  }
  const c=setup();const media=(db.prepare('SELECT media_id FROM uploads WHERE id=?').get(foreignId) as {media_id:string}).media_id;
  db.prepare("INSERT INTO uploads(id,user_id,name,mime,data,created_at,media_id) VALUES('upl_forged_ref',?,'forged.png','image/png',x'',1,?)").run(c.user,media);
  const row=c.admit('upl_forged_ref');await c.worker.runOne();assert.equal(c.submits(),0);assert.equal(jobRow(row.id)!.error_code,'invalid_reference');
});

test('URLs and paths cannot become reference IDs or create jobs',()=>{
  const c=setup();
  for(const id of ['https://example.test/frame.png','../frame.png','/tmp/frame.png','file:///secret'])assert.throws(()=>c.admit(id),VideoError);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM video_jobs WHERE user_id=?').get(c.user)!.n,0);
});

test('SVG, HTML, corrupt/truncated rasters and animated input fail before a paid POST',async()=>{
  const raw=Buffer.alloc(160*180*4);
  for(let y=0;y<180;y++)for(let x=0;x<160;x++)raw.set([y<90?255:0,0,y<90?0:255,255],(y*160+x)*4);
  const animation=await sharp(raw,{raw:{width:160,height:180,channels:4,pageHeight:90}}).gif().toBuffer();
  assert.equal((await sharp(animation,{animated:true}).metadata()).pages,2);
  const png=await solid();
  for(const bytes of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="160" height="90"/></svg>'),Buffer.from('<html>not a raster</html>'),png.subarray(0,40),Buffer.concat([png.subarray(0,33),Buffer.from('corrupt')]),animation]){
    const c=setup(),row=c.admit(c.upload(bytes));await c.worker.runOne();assert.equal(c.submits(),0);assert.equal(jobRow(row.id)!.error_code,'invalid_reference');
  }
});

test('original byte and decoded pixel limits reject oversized references without submission or usage',async()=>{
  const c=setup();db.prepare("INSERT INTO uploads(id,user_id,name,mime,data,created_at) VALUES('upl_huge_reference',?,'huge.png','image/png',zeroblob(26214401),1)").run(c.user);
  const huge=c.admit('upl_huge_reference');await c.worker.runOne();assert.equal(c.submits(),0);assert.equal(jobRow(huge.id)!.error_code,'invalid_reference');
  const pixels=Buffer.from(await solid());pixels.writeUInt32BE(60000,16);pixels.writeUInt32BE(60000,20);pixels.writeUInt32BE(crc32(pixels.subarray(12,29)),29);
  const d=setup(),bomb=d.admit(d.upload(pixels));await d.worker.runOne();assert.equal(d.submits(),0);assert.equal(jobRow(bomb.id)!.error_code,'invalid_reference');
  for(const row of [huge,bomb])assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage WHERE video_job_id=?').get(row.id)!.n,0);
});

test('the JPEG quality ladder fails closed if normalized bytes still exceed 256 KiB',async()=>{
  const data=Buffer.alloc(1280*720*3);let value=123456789;
  for(let i=0;i<data.length;i++){value^=value<<13;value^=value>>>17;value^=value<<5;data[i]=value&255;}
  const image=sharp(data,{raw:{width:1280,height:720,channels:3}});
  assert.ok((await image.clone().jpeg({quality:65}).toBuffer()).length>256*1024);
  const c=setup(),row=c.admit(c.upload(await image.png().toBuffer()));await c.worker.runOne();assert.equal(c.submits(),0);assert.equal(jobRow(row.id)!.error_code,'invalid_reference');
});

test('tampered staging is rejected on recovery instead of rereading the original or replacing it',async()=>{
  const c=setup(),row=c.admit(c.upload(await solid()));await c.worker.runOne();assert.equal(c.submits(),1);
  await writeFile(path.join(videoStaging(c.user,row.id),'reference.jpg'),'tampered');
  await assert.rejects(prepareVideoReference(jobRow(row.id)!),(error:unknown)=>error instanceof VideoError&&error.code==='invalid_reference');
  requestVideoCancel(c.user,row.id);await c.worker.runOne();
});

test('retrying an image job keeps the normalized frame after the upload is deleted',async()=>{
  const c=setup();
  db.prepare("INSERT INTO generation_runs(id,thread_id,user_message_id,assistant_message_id,config_json,state,created_at,updated_at) VALUES('run',?,'u','assistant',?,'finished',1,1)")
    .run(c.thread,JSON.stringify({version:1,requestKind:'send',turnOrigin:'interactive',modelRef:'xai/test',sampling:{},instructions:'',toolPolicy:{mode:'inherit',builtins:[],mcpTools:[]},knowledgeIds:[],assistantName:null,assistantIcon:null,assistantRevision:null,webSearch:false,deepResearch:false}));
  const upload=c.upload(await solid(320,180),true);const row=c.admit(upload);
  await c.worker.runOne();assert.equal(c.submits(),1);
  const failed=jobRow(row.id)!;finishVideo(failed.id,failed.lease_epoch,'failed','provider_unavailable');
  db.prepare('DELETE FROM uploads WHERE id=? AND user_id=?').run(upload,c.user);
  const deps={model:async()=>({toolCall:true}),voice:()=>false};
  const parent=jobRow(row.id)!;const child=await retryVideo(c.user,row.id,parent.revision,deps);
  assert.equal(child.retry_of,row.id);
  c.advance();await c.worker.runOne();assert.equal(c.submits(),2);
  assert.equal(jobRow(child.id)!.state,'polling');
});
