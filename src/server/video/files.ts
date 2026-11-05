import { mkdir, open, rename, rm, readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import { db, tx } from '../db.js';
import { readUpload } from '../media/store.js';
import { normalizeVideoReference } from '../media/variants.js';
import { encrypt } from '../crypto.js';
import { VideoError } from './errors.js';
import { videoFile, videoStaging } from './paths.js';
import { inspectMp4 } from './mp4.js';
import { jobRow, parametersOf, patchJob, requestOf, settleVideo, changed, type VideoJobRow } from './store.js';
import { VIDEO_LIMITS } from '../../shared/video.js';

export async function prepareVideoReference(row:VideoJobRow):Promise<Buffer|undefined> {
  const request=requestOf(row);
  if(!request.referenceUploadId) return undefined;
  const dir=videoStaging(row.user_id,row.id),file=path.join(dir,'reference.jpg');
  if(request.referenceSha256) {
    const bytes=await readFile(file);
    if(bytes.length>VIDEO_LIMITS.referenceBytes || createHash('sha256').update(bytes).digest('hex')!==request.referenceSha256) throw new VideoError('invalid_reference',400);
    return bytes;
  }
  const original=db.prepare('SELECT COALESCE(m.size,length(u.data)) AS size FROM uploads u LEFT JOIN media m ON m.id=u.media_id AND m.user_id=u.user_id WHERE u.id=? AND u.user_id=?').get(request.referenceUploadId,row.user_id) as {size:number}|undefined;
  if(!original || original.size>25*1024*1024)throw new VideoError('invalid_reference',400);
  const upload=readUpload(row.user_id,request.referenceUploadId);
  if(!upload || upload.data.length>25*1024*1024) throw new VideoError('invalid_reference',400);
  let bytes:Buffer;
  try {bytes=await normalizeVideoReference(Buffer.from(upload.data),request.aspectRatio);}
  catch(error){throw new VideoError(error instanceof Error && error.message==='reference_aspect_mismatch'?'reference_aspect_mismatch':'invalid_reference',400);}
  await mkdir(dir,{recursive:true,mode:0o700});
  const fd=await open(file,'w',0o600);
  try {await fd.writeFile(bytes);await fd.sync();}finally{await fd.close();}
  request.referenceSha256=createHash('sha256').update(bytes).digest('hex');
  if(!patchJob(row.id,row.lease_epoch,['queued'],{request_enc:encrypt(JSON.stringify(request))})) throw new VideoError('cancelled',409);
  return bytes;
}
export async function inspectVideoFile(row:VideoJobRow,file:string) {
  const fd=await open(file,'r');
  try {
    const size=(await fd.stat()).size;
    const info=await inspectMp4(fd,size,parametersOf(row));
    const hash=createHash('sha256');
    for await (const chunk of fd.createReadStream({autoClose:false,start:0})) hash.update(chunk);
    return {...info,size,sha256:hash.digest('hex')};
  }finally{await fd.close();}
}
export async function persistVideo(row:VideoJobRow,source:string,now=Date.now()):Promise<boolean> {
  const info=await inspectVideoFile(row,source);
  const target=videoFile(row.user_id,row.id);
  await mkdir(path.dirname(target),{recursive:true,mode:0o700});
  if(source!==target) await rename(source,target);
  const parent=await open(path.dirname(target),'r');
  try{await parent.sync();}finally{await parent.close();}
  return tx(()=>{
    const current=jobRow(row.id);
    if(!current || current.lease_epoch!==row.lease_epoch || current.state!=='validating' || current.deadline_at<=now || !current.thread_id || !db.prepare('SELECT 1 FROM threads WHERE id=? AND user_id=?').get(current.thread_id,current.user_id)) return false;
    const label=[...requestOf(current).prompt].slice(0,160).join('');
    db.prepare(`INSERT INTO videos (id,user_id,job_id,origin_thread_id,label,size,sha256,duration_ms,width,height,has_audio,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(current.id,current.user_id,current.id,current.thread_id,label,info.size,info.sha256,info.durationMs,info.width,info.height,Number(info.hasAudio),now);
    db.prepare('INSERT INTO video_threads (video_id,thread_id) VALUES (?,?)').run(current.id,current.thread_id);
    const done=patchJob(current.id,current.lease_epoch,['validating'],{state:'succeeded',stage:'complete',finished_at:now,lease_until:null,next_poll_at:null,reservation_bytes:VIDEO_LIMITS.receiptBytes+VIDEO_LIMITS.referenceBytes},now)!;
    settleVideo(done);return true;
  });
}
/** Release reservations only after the corresponding bytes are really gone. Retry from maintenance on failure. */
export async function cleanupVideoJob(row:VideoJobRow):Promise<void> {
  const current=jobRow(row.id);
  if(!current || current.lease_epoch!==row.lease_epoch) return;
  await rm(videoStaging(row.user_id,row.id),{recursive:true,force:true});
  if(!db.prepare('SELECT 1 FROM videos WHERE job_id=?').get(row.id)) await rm(videoFile(row.user_id,row.id),{force:true});
  patchJob(row.id,row.lease_epoch,[current.state],{reservation_bytes:VIDEO_LIMITS.receiptBytes});
}
export async function deleteVideoFile(userId:string,id:string):Promise<boolean> {
  if(!db.prepare('SELECT 1 FROM videos WHERE id=? AND user_id=?').get(id,userId)) return false;
  // Keeping the charged row until unlink succeeds also keeps a failed deletion recoverable.
  await rm(videoFile(userId,id),{force:true});
  tx(()=>{db.prepare('DELETE FROM videos WHERE id=? AND user_id=?').run(id,userId);changed(id);});
  return true;
}
export function byteRange(header:string|undefined,size:number):[number,number]|null {
  if(!header) return [0,size-1];
  const m=/^bytes=(\d*)-(\d*)$/.exec(header);
  if(!m || (!m[1]&&!m[2])) return null;
  let start:number,end:number;
  if(!m[1]) {const suffix=Number(m[2]);if(!Number.isSafeInteger(suffix)||suffix<=0)return null;start=Math.max(0,size-suffix);end=size-1;}
  else {start=Number(m[1]);end=m[2]?Math.min(size-1,Number(m[2])):size-1;}
  return !Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start?null:[start,end];
}
/** Caller has already authenticated. Ownership precedes stat, validators, HEAD and range responses. */
export async function videoFileResponse(userId:string,id:string,request:Request):Promise<Response> {
  const row=db.prepare('SELECT size,sha256 FROM videos WHERE id=? AND user_id=?').get(id,userId) as {size:number;sha256:string}|undefined;
  if(!row) return new Response(null,{status:404});
  const file=videoFile(userId,id);
  const actual=await stat(file).catch(()=>null);
  if(!actual || actual.size!==row.size) return new Response(null,{status:404});
  const tag=`"${row.sha256}"`;
  const headers=new Headers({'Content-Type':'video/mp4','X-Content-Type-Options':'nosniff','Cache-Control':'private,no-cache','Vary':'Cookie','ETag':tag,'Accept-Ranges':'bytes'});
  if(new URL(request.url).searchParams.get('download')==='1') headers.set('Content-Disposition',`attachment; filename="video-${id}.mp4"`);
  if(request.headers.get('if-none-match')===tag) return new Response(null,{status:304,headers});
  const range=request.headers.get('range');
  const useRange=!!range&&(!request.headers.has('if-range')||request.headers.get('if-range')===tag);
  const bounds=byteRange(useRange?range!:undefined,row.size);
  if(!bounds){headers.set('Content-Range',`bytes */${row.size}`);return new Response(null,{status:416,headers});}
  const [start,end]=bounds;
  headers.set('Content-Length',String(end-start+1));
  if(useRange) headers.set('Content-Range',`bytes ${start}-${end}/${row.size}`);
  if(request.method==='HEAD') return new Response(null,{status:useRange?206:200,headers});
  const stream=createReadStream(file,{start,end,signal:request.signal});
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>,{status:useRange?206:200,headers});
}
