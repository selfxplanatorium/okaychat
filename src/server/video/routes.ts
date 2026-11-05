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
  .get('/video-jobs/:id',c=>{assertFeature(c.get('user').id,'videos');return c.json(videoJobView(ownJob(c.get('user').id,c.req.param('id'))));})
  .get('/threads/:threadId/video-jobs',c=>{
    const userId=c.get('user').id;assertFeature(userId,'videos');
    if(!db.prepare('SELECT 1 FROM threads WHERE id=? AND user_id=?').get(c.req.param('threadId'),userId)) throw new AppError({code:'not_found'});
    const assistant=c.req.query('assistantMessageId'),tool=c.req.query('toolCallId'),cursor=c.req.query('cursor');
    if([assistant,tool,cursor].some(v=>v!==undefined&&!/^[A-Za-z0-9_-]{1,200}$/.test(v)))throw new AppError({code:'validation'});
    const rows=db.prepare(`SELECT id FROM video_jobs WHERE user_id=? AND thread_id=? ${assistant?'AND assistant_message_id=?':''} ${tool?'AND tool_call_id=?':''} ${cursor?'AND (created_at,id) < (SELECT created_at,id FROM video_jobs WHERE id=? AND user_id=?)':''} ORDER BY created_at DESC,id DESC LIMIT ?`).all(userId,c.req.param('threadId'),...(assistant?[assistant]:[]),...(tool?[tool]:[]),...(cursor?[cursor,userId]:[]),assistant&&tool?8:101) as Array<{id:string}>;
    const jobs=rows.slice(0,assistant&&tool?8:100).map(r=>videoJobView(ownJob(userId,r.id)));
    return c.json({jobs,cursor:rows.length>100?jobs.at(-1)!.id:null});
  })
  .post('/video-jobs/:id/cancel',async c=>{
    await videoRouteJson(c.req.raw);
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
            const snapshot=videoJobView(row);
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
  .on(['GET','HEAD'],'/videos/:id/file',c=>videoFileResponse(c.get('user').id,c.req.param('id'),c.req.raw));

/** Count actual bytes before parsing; the app-wide body cap is deliberately much larger. */
export async function videoRouteJson(request:Request,max=2048):Promise<unknown> {
  const reader=request.body?.getReader();let size=0;const chunks:Uint8Array[]=[];
  try {if(reader)for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();throw new AppError({code:'validation'});}chunks.push(value);}
    return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}') as unknown;
  }catch(error){throw error instanceof AppError?error:new AppError({code:'validation'});}
  finally{reader?.releaseLock();}
}
