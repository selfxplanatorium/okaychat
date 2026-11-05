import type { VideoJobView } from '@shared/video';

export const videoActive=(job:VideoJobView)=>['queued','submitting','polling','downloading','validating','cancel_requested'].includes(job.state);
export interface VideoSnapshot {job:VideoJobView|null;stale:boolean;missing:boolean}
export const EMPTY_VIDEO:VideoSnapshot={job:null,stale:false,missing:false};
export function acceptVideoRevision(current:VideoJobView|null,next:VideoJobView):boolean {
  return !current || next.id===current.id&&next.revision>current.revision&&(videoActive(current)||!videoActive(next));
}
export interface VideoEventConnection {close:()=>void;onmessage:((data:unknown)=>void)|null;onerror:(()=>void)|null}
interface Dependencies {
  get:(id:string,signal:AbortSignal)=>Promise<VideoJobView>;
  connect:(id:string)=>VideoEventConnection;
  later:(work:()=>void)=>()=>void;
}
/** Account-bound status cache; visibility owns subscriptions, never message metadata. */
export class VideoJobClient {
  private account:string|null=null;
  private generation=0;
  private values=new Map<string,VideoSnapshot>();
  private listeners=new Set<()=>void>();
  private watches=new Map<string,{count:number;source?:VideoEventConnection;stopRetry?:()=>void;controller?:AbortController}>();
  constructor(private dependencies:Dependencies){}
  setAccount(account:string|null):void {
    if(this.account===account)return;
    this.account=account;this.generation++;
    for(const watch of this.watches.values()){watch.source?.close();watch.stopRetry?.();watch.controller?.abort();}
    this.watches.clear();this.values.clear();this.emit();
  }
  accountIs(account:string):boolean{return this.account===account;}
  get(id:string):VideoSnapshot{return this.values.get(id)??EMPTY_VIDEO;}
  subscribe=(listener:()=>void):(()=>void)=>{this.listeners.add(listener);return()=>this.listeners.delete(listener);};
  private emit():void {for(const listener of this.listeners)listener();}
  apply(job:VideoJobView,refreshed=false):void {
    if(!this.account||!videoSnapshotValid(job))return;
    const current=this.get(job.id);
    if(!acceptVideoRevision(current.job,job)&&!(refreshed&&current.job?.revision===job.revision&&current.job.state===job.state))return;
    this.values.set(job.id,{job,stale:false,missing:false});
    if(!videoActive(job)){
      const watch=this.watches.get(job.id);watch?.source?.close();if(watch)watch.source=undefined;
      watch?.stopRetry?.();if(watch)watch.stopRetry=undefined;
    }
    this.emit();this.pump();
  }
  async refresh(id:string):Promise<void> {
    const watch=this.watches.get(id),generation=this.generation;
    if(!this.account||watch?.controller)return;
    const controller=new AbortController();if(watch)watch.controller=controller;
    try{const job=await this.dependencies.get(id,controller.signal);if(generation===this.generation){this.apply(job,true);const current=this.get(id);if(current.stale){this.values.set(id,{...current,stale:false});this.emit();}}}
    catch(error){if(generation!==this.generation||controller.signal.aborted)return;this.values.set(id,{...this.get(id),stale:true,missing:typeof error==='object'&&error!==null&&'status' in error&&error.status===404});this.emit();}
    finally{if(generation===this.generation&&watch?.controller===controller)watch.controller=undefined;}
  }
  watch(id:string):()=>void {
    if(!this.account||!/^vid_[A-Za-z0-9_-]{1,100}$/.test(id))return()=>{};
    const existing=this.watches.get(id);if(existing)existing.count++;else this.watches.set(id,{count:1});
    void this.refresh(id);this.pump();
    const generation=this.generation;
    return()=>{if(generation!==this.generation)return;const watch=this.watches.get(id);if(!watch)return;if(--watch.count>0)return;watch.source?.close();watch.stopRetry?.();watch.controller?.abort();this.watches.delete(id);this.pump();};
  }
  private pump():void {
    if(!this.account)return;
    let slots=[...this.watches.values()].filter(w=>!!w.source).length;
    for(const [id,watch] of this.watches){
      if(slots>=5)break;
      const current=this.get(id);
      if(watch.source||watch.stopRetry||current.missing||current.job&&!videoActive(current.job))continue;
      const generation=this.generation,source=this.dependencies.connect(id);
      watch.source=source;slots++;
      source.onmessage=data=>{if(generation!==this.generation||watch.source!==source)return;try{const job=typeof data==='string'?JSON.parse(data) as VideoJobView:data as VideoJobView;if(job?.id===id)this.apply(job);}catch{/* Invalid status cannot change a known snapshot. */}};
      source.onerror=()=>{
        if(generation!==this.generation||watch.source!==source)return;
        source.close();watch.source=undefined;
        this.values.set(id,{...this.get(id),stale:true});this.emit();
        watch.stopRetry=this.dependencies.later(()=>{watch.stopRetry=undefined;if(generation===this.generation&&this.watches.has(id)){void this.refresh(id);this.pump();}});
        this.pump();
      };
    }
    // Bounded session cache: never evict a visible/subscribed job.
    if(this.values.size>200)for(const id of this.values.keys()){if(!this.watches.has(id))this.values.delete(id);if(this.values.size<=200)break;}
  }
}

/** DTO shape checks protect the player from malformed/replayed status events. All URLs are derived locally. */
export function videoSnapshotValid(value:unknown):value is VideoJobView {
  if(!value||typeof value!=='object')return false;
  const j=value as Partial<VideoJobView>;
  const finite=(n:unknown)=>typeof n==='number'&&Number.isFinite(n);
  if(typeof j.id!=='string'||!/^vid_[A-Za-z0-9_-]{1,100}$/.test(j.id)||!Number.isSafeInteger(j.revision)||!j.revision||j.revision<1||!finite(j.createdAt)||!finite(j.updatedAt))return false;
  if(!['xai','replicate'].includes(String(j.service))||typeof j.model!=='string'||j.model.length>200||!['queued','submitting','polling','downloading','validating','cancel_requested','succeeded','failed','cancelled','timed_out','submission_unknown'].includes(String(j.state)))return false;
  if(!['accepted','submitting','queued_at_provider','generating','downloading','checking','complete','stopping','stopped','error'].includes(String(j.stage)))return false;
  if(!j.request||![4,6,8].includes(j.request.durationSeconds)||!['16:9','9:16'].includes(j.request.aspectRatio)||!['720p','1080p'].includes(j.request.size))return false;
  if(!j.cost||j.cost.currency!=='USD'||!finite(j.cost.estimatedMicrousd)||!['unknown','estimated','reported'].includes(j.cost.state)||(j.cost.settledMicrousd!==null&&!finite(j.cost.settledMicrousd)))return false;
  if(j.output!==null){const o=j.output;if(!o||o.id!==j.id||o.mime!=='video/mp4'||!finite(o.size)||o.size<=0||o.size>67108864||!finite(o.durationMs)||o.durationMs<=0||o.durationMs>8500||!finite(o.width)||!finite(o.height)||o.width<=0||o.height<=0||o.width>1920||o.height>1920||typeof o.hasAudio!=='boolean')return false;}
  return typeof j.canRetry==='boolean'&&typeof j.outputUnavailable==='boolean';
}
