import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { db } from '../db.js';
import { env } from '../env.js';
import { cleanupVideoJob, deleteVideoFile } from './files.js';
import { jobRow, isVideoOpen, cancelRunVideos, type VideoJobRow } from './store.js';

let timer:ReturnType<typeof setInterval>|null=null;
let running=false;
export async function maintainVideos(now=Date.now()):Promise<void> {
  if(running)return;running=true;
  try{
    const terminal=db.prepare("SELECT * FROM video_jobs WHERE state NOT IN ('queued','submitting','polling','downloading','validating','cancel_requested') AND reservation_bytes>32768 LIMIT 100").all() as unknown as VideoJobRow[];
    for(const row of terminal)await cleanupVideoJob(row).catch(()=>{});
    const unreferenced=db.prepare('SELECT id,user_id FROM videos v WHERE NOT EXISTS(SELECT 1 FROM video_threads r WHERE r.video_id=v.id) LIMIT 100').all() as Array<{id:string;user_id:string}>;
    for(const row of unreferenced)await deleteVideoFile(row.user_id,row.id).catch(()=>{});
    // Same revision/timestamp discipline as live mutations; open work is never pruned.
    db.prepare("UPDATE video_jobs SET request_enc=NULL,revision=revision+1,updated_at=? WHERE request_enc IS NOT NULL AND finished_at IS NOT NULL AND created_at<?").run(now,now-86400000);
    db.prepare("DELETE FROM video_jobs WHERE finished_at<? AND reservation_bytes<=32768 AND NOT EXISTS(SELECT 1 FROM videos WHERE job_id=video_jobs.id)").run(now-30*86400000);
    for(const root of ['videos','video-staging']){
      const directory=path.join(env.dataDir,root);
      for(const user of await readdir(directory,{withFileTypes:true}).catch(()=>[])){
        if(!user.isDirectory())continue;
        const ownerExists=!!db.prepare('SELECT 1 FROM users WHERE id=?').get(user.name);
        const userDir=path.join(directory,user.name);
        for(const entry of await readdir(userDir,{withFileTypes:true}).catch(()=>[])){
          const file=path.join(userDir,entry.name),id=root==='videos'?entry.name.replace(/\.mp4$/,''):entry.name;
          const info=await stat(file).catch(()=>null);if(!info||info.mtimeMs>now-3600000)continue;
          const job=jobRow(id);
          if(ownerExists&&job?.user_id===user.name&&(isVideoOpen(job.state)||root==='videos'&&db.prepare('SELECT 1 FROM videos WHERE id=? AND user_id=?').get(id,user.name)))continue;
          await rm(file,{recursive:true,force:true}).catch(()=>{});
        }
        if(!ownerExists)await rm(userDir,{recursive:true,force:true}).catch(()=>{});
      }
    }
  }finally{running=false;}
}
export function startVideoMaintenance():void {if(timer)return;void maintainVideos().catch(()=>{});timer=setInterval(()=>void maintainVideos().catch(()=>{}),3600000);timer.unref();}
export function stopVideoMaintenance():void {if(timer)clearInterval(timer);timer=null;}
export function deletingThreadVideos(userId:string,threadId:string):void {
  cancelRunVideos(userId,threadId);
  db.prepare('UPDATE video_jobs SET request_enc=NULL,revision=revision+1,updated_at=? WHERE user_id=? AND thread_id=?').run(Date.now(),userId,threadId);
}
/** User deletion must remove videos before the parent jobs cascade (videos.job_id intentionally is not CASCADE). */
export function deletingUserVideos(userId:string):void {
  const threads=db.prepare('SELECT id FROM threads WHERE user_id=?').all(userId) as Array<{id:string}>;
  for(const thread of threads)cancelRunVideos(userId,thread.id);
  db.prepare('DELETE FROM videos WHERE user_id=?').run(userId);
}
export async function removeUserVideoFiles(userId:string):Promise<void> {
  for(const root of ['videos','video-staging'])await rm(path.join(env.dataDir,root,userId),{recursive:true,force:true}).catch(()=>{});
}
