import assert from 'node:assert/strict';
import test from 'node:test';
import type { VideoJobView } from '../../shared/video.js';
import { VideoJobClient, type VideoEventConnection } from './video-job-client.js';

const job=(id='vid_one',revision=1,state:VideoJobView['state']='polling'):VideoJobView=>({id,threadId:'thread',assistantMessageId:'assistant',toolCallId:'call',attempt:0,retryOf:null,service:'xai',model:'grok-imagine-video-1.5-lite',state,stage:state==='succeeded'?'complete':'generating',revision,createdAt:1,updatedAt:revision,finishedAt:state==='succeeded'?2:null,request:{durationSeconds:4,aspectRatio:'16:9',size:'720p'},cost:{currency:'USD',estimatedMicrousd:120000,settledMicrousd:null,state:'unknown'},error:null,remoteCancellation:'not_requested',output:null,outputUnavailable:state==='succeeded',canRetry:false});
function setup(){
  const sources:Array<VideoEventConnection&{closed:boolean}>=[];
  const requests:Array<{id:string;signal:AbortSignal;resolve:(j:VideoJobView)=>void;reject:(e:unknown)=>void}>=[];
  const timers:Array<()=>void>=[];
  const client=new VideoJobClient({get:(id,signal)=>new Promise((resolve,reject)=>requests.push({id,signal,resolve,reject})),connect:()=>{const source={closed:false,close(){this.closed=true;},onmessage:null,onerror:null} as VideoEventConnection&{closed:boolean};sources.push(source);return source;},later:work=>{timers.push(work);return()=>{const i=timers.indexOf(work);if(i>=0)timers.splice(i,1);};}});
  return {client,sources,requests,timers};
}

test('old revisions cannot replace current status; terminal snapshots close SSE and stale callbacks are ignored',async()=>{
  const {client,sources,requests}=setup();client.setAccount('alice');const stop=client.watch('vid_one');
  sources[0]!.onmessage?.(JSON.stringify(job('vid_one',3)));
  requests[0]!.resolve(job('vid_one',1));await Promise.resolve();await Promise.resolve();
  assert.equal(client.get('vid_one').job!.revision,3);
  sources[0]!.onmessage?.(JSON.stringify(job('vid_one',4,'succeeded')));
  assert.equal(sources[0]!.closed,true);assert.equal(client.get('vid_one').job!.state,'succeeded');
  sources[0]!.onmessage?.(JSON.stringify(job('vid_one',5)));assert.equal(client.get('vid_one').job!.revision,4);stop();
});

test('account switch aborts requests/closes streams and drops late private results even after switching back',async()=>{
  const {client,sources,requests}=setup();client.setAccount('alice');client.watch('vid_one');client.setAccount('bob');client.setAccount('alice');
  assert.equal(sources[0]!.closed,true);assert.equal(requests[0]!.signal.aborted,true);
  requests[0]!.resolve(job());await Promise.resolve();await Promise.resolve();
  sources[0]!.onmessage?.(JSON.stringify(job('vid_one',2)));
  assert.equal(client.get('vid_one').job,null);
});

test('visibility subscriptions share one stream, stop offscreen and cap simultaneous streams to five',()=>{
  const {client,sources}=setup();client.setAccount('alice');const first=client.watch('vid_one'),second=client.watch('vid_one');
  assert.equal(sources.length,1);first();assert.equal(sources[0]!.closed,false);second();assert.equal(sources[0]!.closed,true);
  const stops=Array.from({length:6},(_,i)=>client.watch(`vid_job${i}`));
  assert.equal(sources.filter(s=>!s.closed).length,5);stops[0]!();assert.equal(sources.filter(s=>!s.closed).length,5);
  for(const stop of stops)stop();assert.equal(sources.filter(s=>!s.closed).length,0);
});

test('offline is stale status, never a provider failure; reconnect GET reconciles missed revisions',async()=>{
  const {client,sources,requests,timers}=setup();client.setAccount('alice');client.watch('vid_one');requests[0]!.resolve(job());await Promise.resolve();await Promise.resolve();
  sources[0]!.onerror?.();assert.equal(client.get('vid_one').stale,true);assert.equal(client.get('vid_one').job!.state,'polling');
  assert.equal(timers.length,1);timers.shift()!();assert.equal(requests.length,2);requests[1]!.resolve(job('vid_one',2,'succeeded'));await Promise.resolve();await Promise.resolve();
  assert.equal(client.get('vid_one').job!.state,'succeeded');assert.equal(client.get('vid_one').stale,false);
  client.setAccount(null);
});

test('malformed snapshots cannot expose a remote player URL or turn a terminal job back into active work',()=>{
  const {client}=setup();client.setAccount('alice');client.apply(job('vid_one',1,'succeeded'));
  client.apply(job('vid_one',2,'polling'));assert.equal(client.get('vid_one').job!.state,'succeeded');
  const malformed={...job('vid_bad'),output:{id:'foreign',mime:'video/mp4',fileUrl:'https://untrusted.example/video.mp4'}};
  client.apply(malformed as VideoJobView);assert.equal(client.get('vid_bad').job,null);
});

test('fresh GET can reconcile output deletion without changing the generation state or receipt revision',async()=>{
  const {client,requests}=setup();client.setAccount('alice');
  const original=job('vid_one',1,'succeeded');client.apply({...original,outputUnavailable:false});
  const refreshing=client.refresh('vid_one');requests[0]!.resolve(original);await refreshing;
  assert.equal(client.get('vid_one').job!.outputUnavailable,true);assert.equal(client.get('vid_one').job!.state,'succeeded');
});
