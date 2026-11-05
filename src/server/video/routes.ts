import { VIDEO_SERVICES } from "../../shared/video.js";
import { getSettings } from "../settings.js";
import { saveConnection, deleteConnection } from "../catalog/providers.js";
import { videoServiceStatuses } from "./services.js";
import { z } from "zod";
import { retryVideo, canRetryVideo } from "./retry.js";
import { handleAppError } from "../errors.js";
import { VideoError, videoAppError } from "./errors.js";
import { Hono } from 'hono';
import { db } from '../db.js';
import { sessionAlive, type AppEnv } from '../auth.js';
import { assertFeature, featureAllowed } from '../permissions/guard.js';
import { AppError } from '../errors.js';
import { ownJob, videoJobView, isVideoOpen, requestVideoCancel } from './store.js';
import { videoWorker } from './worker.js';
import { videoFileResponse } from './files.js';

const subscriptions=new Map<string,number>();
export const videoRoutes=new Hono<AppEnv>()
  .get('/video-services',c=>{const user=c.get('user').id;assertFeature(user,'videos');return c.json({services:videoServiceStatuses(user,getSettings(user).videoServices??{})});})
  .get('/video-services/:id/models',c=>{
    assertFeature(c.get('user').id,'videos');
    const def=VIDEO_SERVICES.find(s=>s.id===c.req.param('id'));if(!def)throw new AppError({code:'not_found'});
    return c.json({models:def.models,live:false,source:'curated',verifiedAt:def.verifiedAt});
  })
  .put('/video-services/:id/key',async c=>{
    const user=c.get('user').id;assertFeature(user,'videos');
    if(c.req.param('id')!=='replicate')throw new AppError({code:'not_found'});
    const input=z.object({apiKey:z.string().trim().min(1).refine(v=>Buffer.byteLength(v)<=8192)}).strict().safeParse(await videoRouteJson(c.req.raw,50*1024));
    if(!input.success)throw new AppError({code:'validation'});
    saveConnection(user,'image-replicate',{apiKey:input.data.apiKey,enabled:true});
    return c.json({services:videoServiceStatuses(user,getSettings(user).videoServices??{})});
  })
  .delete('/video-services/:id/key',c=>{
    const user=c.get('user').id;assertFeature(user,'videos');
    if(c.req.param('id')!=='replicate')throw new AppError({code:'not_found'});
    deleteConnection(user,'image-replicate');
    return c.json({services:videoServiceStatuses(user,getSettings(user).videoServices??{})});
  })
  .get('/video-jobs/:id',c=>{assertFeature(c.get('user').id,'videos');const row=ownJob(c.get('user').id,c.req.param('id'));return c.json({...videoJobView(row),canRetry:canRetryVideo(row)});})
  .get('/threads/:threadId/video-jobs',c=>{
    const userId=c.get('user').id;assertFeature(userId,'videos');
    if(!db.prepare('SELECT 1 FROM threads WHERE id=? AND user_id=?').get(c.req.param('threadId'),userId)) throw new AppError({code:'not_found'});
    const assistant=c.req.query('assistantMessageId'),tool=c.req.query('toolCallId'),cursor=c.req.query('cursor');
    if([assistant,tool,cursor].some(v=>v!==undefined&&!/^[A-Za-z0-9_-]{1,200}$/.test(v)))throw new AppError({code:'validation'});
    const rows=db.prepare(`SELECT id FROM video_jobs WHERE user_id=? AND thread_id=? ${assistant?'AND assistant_message_id=?':''} ${tool?'AND tool_call_id=?':''} ${cursor?'AND (created_at,id) < (SELECT created_at,id FROM video_jobs WHERE id=? AND user_id=?)':''} ORDER BY created_at DESC,id DESC LIMIT ?`).all(userId,c.req.param('threadId'),...(assistant?[assistant]:[]),...(tool?[tool]:[]),...(cursor?[cursor,userId]:[]),assistant&&tool?8:101) as Array<{id:string}>;
    const jobs=rows.slice(0,assistant&&tool?8:100).map(r=>{const row=ownJob(userId,r.id);return {...videoJobView(row),canRetry:canRetryVideo(row)};});
    return c.json({jobs,cursor:rows.length>100?jobs.at(-1)!.id:null});
  })
  .post('/video-jobs/:id/retry',async c=>{
    const input=z.object({expectedRevision:z.number().int().positive()}).strict().safeParse(await videoRouteJson(c.req.raw));
    if(!input.success)throw new AppError({code:'validation'});
    const row=await retryVideo(c.get('user').id,c.req.param('id'),input.data.expectedRevision);
    return c.json({job:videoJobView(row)},202);
  })
  .post('/video-jobs/:id/cancel',async c=>{
    if(!z.object({}).strict().safeParse(await videoRouteJson(c.req.raw)).success)throw new AppError({code:'validation'});
    const row=requestVideoCancel(c.get('user').id,c.req.param('id'));videoWorker.tick();
    return c.json(videoJobView(row),isVideoOpen(row.state)?202:200);
  })
  .get('/video-jobs/:id/events',c=>{
    const userId=c.get('user').id,id=c.req.param('id'),session=c.get('session');
    assertFeature(userId,'videos');ownJob(userId,id);
    const last=c.req.header('last-event-id');
    if(last&&!/^\d{1,15}$/.test(last))throw new AppError({code:'validation'});
    if((subscriptions.get(userId)??0)>=5)throw new AppError({code:'rate_limited'});
    subscriptions.set(userId,(subscriptions.get(userId)??0)+1);
    let cleanup=()=>{};
    const body=new ReadableStream<Uint8Array>({
      start(controller){
        let closed=false,revision=-1,lastHeartbeat=Date.now();
        let interval:ReturnType<typeof setInterval>|undefined,lifetime:ReturnType<typeof setTimeout>|undefined;
        const close=()=>{if(closed)return;closed=true;if(interval)clearInterval(interval);if(lifetime)clearTimeout(lifetime);c.req.raw.signal.removeEventListener('abort',close);subscriptions.set(userId,Math.max(0,(subscriptions.get(userId)??1)-1));try{controller.close();}catch{/* Client cancelled. */}};
        cleanup=close;
        const send=()=>{
          if(closed)return;
          try{
            if(!sessionAlive(session)||!featureAllowed(userId,'videos'))return close();
            const row=ownJob(userId,id);
            const snapshot={...videoJobView(row),canRetry:canRetryVideo(row)};
            const frame=row.revision!==revision?`id: ${row.revision}\nevent: video-job\ndata: ${JSON.stringify(snapshot)}\n\n`:Date.now()-lastHeartbeat>=15000?': heartbeat\n\n':null;
            if(frame){const bytes=new TextEncoder().encode(frame);if(bytes.length>65536||(controller.desiredSize??0)<=0)return close();controller.enqueue(bytes);revision=row.revision;lastHeartbeat=Date.now();}
            if(!isVideoOpen(row.state))close();
          }catch{close();}
        };
        interval=setInterval(send,2000);lifetime=setTimeout(close,60000);c.req.raw.signal.addEventListener('abort',close,{once:true});send();
      },
      cancel(){cleanup();},
    });
    return new Response(body,{headers:{'Content-Type':'text/event-stream','Cache-Control':'private,no-store','X-Accel-Buffering':'no','Vary':'Cookie'}});
  })
  .on(['GET','HEAD'],'/videos/:id/file',c=>videoFileResponse(c.get('user').id,c.req.param('id'),c.req.raw))
  .onError((error,c)=>handleAppError(error instanceof VideoError?videoAppError(error):error,c));

/** Count actual bytes before parsing; the app-wide body cap is deliberately much larger. */
export async function videoRouteJson(request:Request,max=2048):Promise<unknown> {
  const reader=request.body?.getReader();let size=0;const chunks:Uint8Array[]=[];
  try {if(reader)for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();throw new AppError({code:'validation'});}chunks.push(value);}
    return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}') as unknown;
  }catch(error){throw error instanceof AppError?error:new AppError({code:'validation'});}
  finally{reader?.releaseLock();}
}
