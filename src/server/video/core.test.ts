import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import dns from 'node:dns/promises';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { gzipSync } from 'node:zlib';
import { readFile, stat } from 'node:fs/promises';
import type { pinnedRequest } from '../public-fetch.js';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { videoEstimateMicrousd, videoService, type VideoParameters } from '../../shared/video.js';
import { resolveVideoCredential } from './services.js';
import { downloadDescriptor, downloadVideo, providerId, videoJson, type VideoFetch } from './transport.js';
import { xaiVideo } from './providers/xai.js';
import { replicateVideo } from './providers/replicate.js';
import { VideoError } from './errors.js';
import { inspectMp4 } from './mp4.js';

const p:VideoParameters={durationSeconds:4,aspectRatio:'16:9',size:'720p',audio:true,hasReference:false};
const input={model:'grok-imagine-video-1.5-lite',prompt:'A boat',parameters:p};
function fake(responses:unknown[]) {
  const calls:Array<{url:string;init:RequestInit|undefined}>=[];
  const transport:VideoFetch=async(url,init)=>{calls.push({url:String(url),init});if(!responses.length) throw new Error('Unexpected provider request');return Response.json(responses.shift(),{status:String(url).endsWith('/models/google/veo-3.1-fast/predictions') ? 201:200});};
  return {transport,calls};
}

test('private credential pin rejects shared/disabled/replaced keys and noncanonical endpoints',()=>{
  const own={providerId:'xai',enabled:true,apiKey:'private'};
  const pinned=resolveVideoCredential('xai',own);
  assert.match(pinned.fingerprint,/^[a-f0-9]{64}$/);
  for(const c of [undefined,{...own,shared:true},{...own,enabled:false},{...own,apiKey:'changed'},{...own,baseURL:'https://api.x.ai/v1/'}]) assert.throws(()=>resolveVideoCredential('xai',c,pinned.fingerprint),VideoError);
  assert.equal(resolveVideoCredential('replicate',{providerId:'image-replicate',enabled:true,apiKey:'private'}).connectionId,'image-replicate');
  assert.equal(videoEstimateMicrousd(videoService('xai').models[0]!.price,p),120000);
  assert.equal(videoEstimateMicrousd(videoService('xai').models[0]!.price,{...p,hasReference:true,size:'1080p'}),570000);
});

test('xAI exact wire shape, status normalization and unsupported cancellation',async()=>{
  const f=fake([{request_id:'job_1'},{status:'pending'},{status:'done',video:{url:'https://vidgen.x.ai/a.mp4',duration:4,respect_moderation:true}}]);
  const adapter=xaiVideo(f.transport);
  assert.deepEqual(await adapter.submit('secret',input),{id:'job_1'});
  assert.equal(f.calls[0]!.url,'https://api.x.ai/v1/videos/generations');
  const init=f.calls[0]!.init!;
  assert.equal(init.redirect,'error');
  assert.deepEqual(JSON.parse(String(init.body)),{model:input.model,prompt:'A boat',duration:4,aspect_ratio:'16:9',resolution:'720p',generate_audio:true});
  assert.deepEqual(await adapter.poll('secret','job_1',input.model),{state:'running'});
  const done=await adapter.poll('secret','job_1',input.model);
  assert.equal(done.state,'succeeded');
  assert.equal(JSON.stringify(done).includes('vidgen'),false);
  assert.equal(await adapter.cancel('secret','job_1'),'unsupported');
  assert.equal(f.calls.length,3);
});

test('Replicate preserves receipt id for immediate success, one URI output and explicit cancel',async()=>{
  const f=fake([{id:'abc',status:'succeeded',output:'https://replicate.delivery/a.mp4'},...['starting','processing','failed','canceled','succeeded'].map(status=>({status,model:'google/veo-3.1-fast',output:'https://a.replicate.delivery/a.mp4'})),{status:'canceled'}]);
  const adapter=replicateVideo(f.transport);
  assert.deepEqual(await adapter.submit('key',{...input,model:'google/veo-3.1-fast'}),{id:'abc'});
  assert.equal(f.calls[0]!.url,'https://api.replicate.com/v1/models/google/veo-3.1-fast/predictions');
  assert.deepEqual(JSON.parse(String(f.calls[0]!.init!.body)),{input:{prompt:'A boat',duration:4,aspect_ratio:'16:9',resolution:'720p',generate_audio:true}});
  for(const expected of ['queued','running','failed','cancelled','succeeded']) assert.equal((await adapter.poll('key','abc','google/veo-3.1-fast')).state,expected);
  assert.equal(await adapter.cancel('key','abc'),'confirmed');
  assert.equal(f.calls.at(-1)!.url,'https://api.replicate.com/v1/predictions/abc/cancel');
});

test('reference requests use the starting-image field and enforce curated combinations',async()=>{
  const jpeg=Buffer.from([255,216,255]);
  for(const service of ['xai','replicate'] as const){
    const f=fake([service==='xai'?{request_id:'a'}:{id:'a'}]);
    const adapter=service==='xai'?xaiVideo(f.transport):replicateVideo(f.transport);
    await adapter.submit('key',{model:videoService(service).models[0]!.id,prompt:'Keep this prompt',parameters:{...p,durationSeconds:8,hasReference:true},referenceJpeg:jpeg});
    const body=JSON.parse(String(f.calls[0]!.init!.body));
    assert.deepEqual(service==='xai'?body.image:body.input.image,service==='xai'?{url:'data:image/jpeg;base64,/9j/'}:'data:image/jpeg;base64,/9j/');
    assert.equal(JSON.stringify(body).includes('reference_images'),false);
  }
  const f=fake([]);
  await assert.rejects(replicateVideo(f.transport).submit('key',{...input,model:'google/veo-3.1-fast',parameters:{...p,hasReference:true},referenceJpeg:jpeg}),VideoError);
  assert.equal(f.calls.length,0);
});

test('protocol errors never echo upstream content and ambiguous submission is not retried',async()=>{
  for(const response of [{},{request_id:'../bad'},{request_id:'https://internal/secret'}]){
    const f=fake([response]);
    await assert.rejects(xaiVideo(f.transport).submit('key',input),(e:unknown)=>e instanceof VideoError && e.dispatch==='unknown' && !e.message.includes('secret'));
    assert.equal(f.calls.length,1);
  }
  for(const response of [{status:'unknown'},{status:'done',video:{duration:NaN,url:'https://vidgen.x.ai/a'}},{status:'done',video:{duration:4,url:'https://vidgen.x.ai/a',respect_moderation:false}}]) await assert.rejects(xaiVideo(fake([response]).transport).poll('key','a',input.model),VideoError);
  await assert.rejects(replicateVideo(fake([{status:'succeeded',output:['https://replicate.delivery/a']}]).transport).poll('key','a','google/veo-3.1-fast'),VideoError);
  for(const id of ['../a','a?secret','a/b','', 'a'.repeat(201)]) assert.throws(()=>providerId(id),VideoError);
});

test('bounded JSON, HTTP rejection, and connection failures use safe errors',async()=>{
  const huge:VideoFetch=async()=>new Response(' '.repeat(1024*1024+1));
  await assert.rejects(videoJson('xai','/videos/generations','key','POST',{},undefined,huge),(e:unknown)=>e instanceof VideoError && e.dispatch==='unknown');
  const denied:VideoFetch=async()=>new Response('secret',{status:401});
  await assert.rejects(videoJson('xai','/videos/generations','key','POST',{},undefined,denied),(e:unknown)=>e instanceof VideoError && e.code==='provider_auth' && e.dispatch==='rejected');
  for(const status of [408,500,502,504]){
    const gateway:VideoFetch=async()=>new Response('upstream detail',{status});
    await assert.rejects(videoJson('xai','/videos/generations','key','POST',{},undefined,gateway),(e:unknown)=>e instanceof VideoError && e.dispatch==='unknown');
  }
  const broken:VideoFetch=async()=>{throw new Error('key and signed URL');};
  await assert.rejects(videoJson('xai','/videos/generations','key','POST',{},undefined,broken),(e:unknown)=>e instanceof VideoError && e.dispatch==='unknown' && e.message==='provider_unavailable');
});

test('CDN descriptors reject suffix confusion, credentials, redirects targets, and forged descriptors',async()=>{
  for(const url of ['http://vidgen.x.ai/a','https://vidgen.x.ai.evil/a','https://evil.x.ai/a','https://u:p@vidgen.x.ai/a','https://vidgen.x.ai:444/a','https://vidgen.x.ai/a#x']) assert.throws(()=>downloadDescriptor('xai',url),VideoError);
  for(const url of ['https://evilreplicate.delivery/a','https://replicate.delivery.evil/a','https://127.0.0.1/a']) assert.throws(()=>downloadDescriptor('replicate',url),VideoError);
  await assert.rejects(downloadVideo({} as ReturnType<typeof downloadDescriptor>,'/unused'),VideoError);
});

const n=(v:number)=>{const b=Buffer.alloc(4);b.writeUInt32BE(v);return b;};
const box=(type:string,...parts:Buffer[])=>{const payload=Buffer.concat(parts);return Buffer.concat([n(payload.length+8),Buffer.from(type),payload]);};
const full=(type:string,...parts:Buffer[])=>box(type,n(0),...parts);
/** Hand-authored container fixture; sample bytes intentionally do not claim decoder validity. */
function fixture(overrides:{offset?:number;codec?:string;duration?:number;width?:number}={}) {
  const seconds=overrides.duration??4,width=overrides.width??1280;
  const ftyp=box('ftyp',Buffer.from('isom'),n(0),Buffer.from('avc1'));
  const mdat=box('mdat',Buffer.alloc(100,0x11));
  const mv=Buffer.alloc(96);mv.writeUInt32BE(1000,12);mv.writeUInt32BE(seconds*1000,16);
  const tk=Buffer.alloc(84);tk.writeUInt32BE(1,0);tk.writeUInt32BE(seconds*1000,20);[65536,0,0,0,65536,0,0,0,1073741824].forEach((v,i)=>tk.writeUInt32BE(v,40+i*4));tk.writeUInt32BE(width*65536,76);tk.writeUInt32BE(720*65536,80);
  const md=Buffer.alloc(24);md.writeUInt32BE(1000,12);md.writeUInt32BE(seconds*1000,16);
  const sample=Buffer.alloc(78);sample.writeUInt16BE(1,6);sample.writeUInt16BE(width,24);sample.writeUInt16BE(720,26);
  const avcc=box('avcC',Buffer.from([1,66,0,30,255,225,0,1,103,1,0,1,104]));
  const stbl=box('stbl',full('stsd',n(1),box(overrides.codec??'avc1',sample,avcc)),full('stts',n(1),n(100),n(seconds*10)),full('stsc',n(1),n(1),n(100),n(1)),full('stsz',n(1),n(100)),full('stco',n(1),n(overrides.offset??ftyp.length+8)));
  const hdlr=Buffer.alloc(24);hdlr.write('vide',8);
  const dinf=box('dinf',full('dref',n(1),box('url ',n(1))));
  return Buffer.concat([ftyp,mdat,box('moov',box('mvhd',mv),box('trak',box('tkhd',tk),box('mdia',box('mdhd',md),box('hdlr',hdlr),box('minf',dinf,stbl))))]);
}

test('MP4 validates bounded timing/sample ranges and fails closed on unsupported containers/codecs',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'video-mp4-'));
  async function inspect(bytes:Buffer){const file=path.join(dir,'fixture.mp4');await writeFile(file,bytes);const fd=await open(file,'r');try{return await inspectMp4(fd,bytes.length,p);}finally{await fd.close();}}
  try{
    assert.deepEqual(await inspect(fixture()),{durationMs:4000,width:1280,height:720,hasAudio:false});
    for(const bytes of [Buffer.from('<html>'),box('ftyp',Buffer.from('avif'),n(0)),fixture({offset:0}),fixture({offset:999999}),fixture({codec:'hvc1'}),fixture({duration:9}),fixture({width:1000}),fixture().subarray(0,-1),Buffer.concat([fixture(),box('moof')])]) await assert.rejects(inspect(bytes),VideoError);
  }finally{await rm(dir,{recursive:true,force:true});}
});


test('CDN download uses public DNS validation at connection time without vendor traffic',async()=>{
  const lookup=mock.method(dns,'lookup',async()=>[{address:'127.0.0.1',family:4}]);
  try{
    await assert.rejects(downloadVideo(downloadDescriptor('xai','https://vidgen.x.ai/a.mp4'),'/unused-output'),(e:unknown)=>e instanceof VideoError && e.code==='download_failed');
    assert.ok(lookup.mock.callCount()>0);
  }finally{lookup.mock.restore();}
});

function audioFixture() {
  const base=fixture();
  const ftypLength=base.readUInt32BE(0), mdatLength=base.readUInt32BE(ftypLength);
  const moov=base.subarray(ftypLength+mdatLength);
  const tk=Buffer.alloc(84);tk.writeUInt32BE(1,0);tk.writeUInt32BE(4000,20);[65536,0,0,0,65536,0,0,0,1073741824].forEach((v,i)=>tk.writeUInt32BE(v,40+i*4));
  const md=Buffer.alloc(24);md.writeUInt32BE(1000,12);md.writeUInt32BE(4000,16);
  const hdlr=Buffer.alloc(24);hdlr.write('soun',8);
  const sample=Buffer.alloc(28);sample.writeUInt16BE(1,6);sample.writeUInt16BE(2,16);sample.writeUInt16BE(16,18);sample.writeUInt32BE(48000*65536,24);
  const descriptor=(tag:number,bytes:Buffer)=>Buffer.concat([Buffer.from([tag,bytes.length]),bytes]);
  const esds=full('esds',descriptor(3,Buffer.concat([Buffer.from([0,1,0]),descriptor(4,Buffer.concat([Buffer.from([0x40,0x15]),Buffer.alloc(11),descriptor(5,Buffer.from([0x12,0x10]))]))])));
  const stbl=box('stbl',full('stsd',n(1),box('mp4a',sample,esds)),full('stts',n(1),n(4),n(1000)),full('stsc',n(1),n(1),n(4),n(1)),full('stsz',n(1),n(4)),full('stco',n(1),n(ftypLength+mdatLength)));
  const dinf=box('dinf',full('dref',n(1),box('url ',n(1))));
  const audio=box('trak',box('tkhd',tk),box('mdia',box('mdhd',md),box('hdlr',hdlr),box('minf',dinf,stbl)));
  return Buffer.concat([base.subarray(0,ftypLength),box('mdat',Buffer.alloc(104)),box('moov',moov.subarray(8),audio)]);
}

test('MP4 accepts self-contained AAC and rejects altered codec configuration and overlapping samples',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'video-audio-'));
  async function check(bytes:Buffer){const file=path.join(dir,'audio.mp4');await writeFile(file,bytes);const fd=await open(file,'r');try{return await inspectMp4(fd,bytes.length,p);}finally{await fd.close();}}
  try{
    assert.equal((await check(audioFixture())).hasAudio,true);
    const wrongCodec=audioFixture();const esds=wrongCodec.indexOf(Buffer.from('esds'));wrongCodec[esds+16]=0x20;
    await assert.rejects(check(wrongCodec),VideoError);
    const overlap=audioFixture();const stco=overlap.lastIndexOf(Buffer.from('stco'));overlap.writeUInt32BE(28,stco+12);
    await assert.rejects(check(overlap),VideoError);
  }finally{await rm(dir,{recursive:true,force:true});}
});


test('download caps decoded bytes, rejects redirects/content types, hashes and cleans partial files',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'video-download-'));
  const descriptor=downloadDescriptor('xai','https://vidgen.x.ai/a.mp4');
  const file=path.join(dir,'output.part');
  function response(status:number,headers:Record<string,string>,chunks:Buffer[]):typeof pinnedRequest {
    return async(_url,opts)=>{
      assert.equal(opts.headers,undefined);
      const message=new IncomingMessage(new Socket());message.statusCode=status;message.headers=headers;
      message._read=()=>{const next=chunks.shift();message.push(next??null);};
      return message;
    };
  }
  try{
    await assert.rejects(downloadVideo(descriptor,file,undefined,response(302,{location:'http://127.0.0.1/'},[])),VideoError);
    await assert.rejects(downloadVideo(descriptor,file,undefined,response(200,{'content-type':'text/html'},[])),VideoError);
    await assert.rejects(downloadVideo(descriptor,file,undefined,response(200,{'content-length':'67108865'},[])),VideoError);
    const huge=gzipSync(Buffer.alloc(65*1024*1024));
    await assert.rejects(downloadVideo(descriptor,file,undefined,response(200,{'content-encoding':'gzip'},[huge])),(e:unknown)=>e instanceof VideoError && e.code==='output_too_large');
    await assert.rejects(stat(file));
    const result=await downloadVideo(descriptor,file,undefined,response(200,{'content-encoding':'gzip'},[gzipSync(Buffer.from('local fixture'))]));
    assert.equal(result.size,13);assert.match(result.sha256,/^[a-f0-9]{64}$/);
    assert.equal((await readFile(file)).toString(),'local fixture');
    assert.equal((await stat(file)).mode & 0o777,0o600);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('MP4 rejects malformed extended boxes, deep metadata, external references, rotation and bad timing',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'video-boxes-'));
  async function check(bytes:Buffer){const file=path.join(dir,'bad.mp4');await writeFile(file,bytes);const fd=await open(file,'r');try{return await inspectMp4(fd,bytes.length,p);}finally{await fd.close();}}
  try{
    const overflow=Buffer.alloc(16);overflow.writeUInt32BE(1);overflow.write('moov',4);overflow.writeBigUInt64BE(2n**63n,8);
    const external=fixture();const url=external.indexOf(Buffer.from('url '));external.writeUInt32BE(0,url+4);
    const rotation=fixture();const tk=rotation.indexOf(Buffer.from('tkhd'));rotation.writeUInt32BE(0,tk+4+40);
    const zeroScale=fixture();const mv=zeroScale.indexOf(Buffer.from('mvhd'));zeroScale.writeUInt32BE(0,mv+4+12);
    let deep=box('free');for(let i=0;i<10;i++) deep=box('udta',deep);
    const base=fixture(), moovStart=base.readUInt32BE(0)+base.readUInt32BE(base.readUInt32BE(0));
    const withMetadata=Buffer.concat([base.subarray(0,moovStart),box('moov',base.subarray(moovStart+8),deep)]);
    const tooMany=Buffer.concat([base.subarray(0,moovStart),box('moov',base.subarray(moovStart+8),...Array.from({length:10001},()=>box('free')))]);
    for(const bytes of [overflow,external,rotation,zeroScale,withMetadata,tooMany]) await assert.rejects(check(bytes),VideoError);
  }finally{await rm(dir,{recursive:true,force:true});}
});
