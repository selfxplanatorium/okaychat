import { VideoPlayer } from "./VideoPlayer";
import { runCommand } from "@/keyboard/registry";
import { useAuiState, type ToolCallMessagePartProps } from '@assistant-ui/react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { VideoIcon } from 'lucide-react';
import type { VideoJobView } from '@shared/video';
import type { ErrorCode } from '@shared/errors';
import { ERROR_CODES } from '@shared/errors';
import { t, type PlainMessageKey } from '@/i18n';
import { formatCost, formatDuration, formatNumber } from '@/i18n/format';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { presentError } from '@/lib/error-presentation';
import { useData } from '@/state/data';
import { videoJobs } from '@/state/video-jobs';
import { videoActive } from '@/state/video-job-client';
import { ToolShell } from './tool-ui';

const stages:Record<VideoJobView['stage'],PlainMessageKey>={accepted:"video.accepted",submitting:"video.submitting",queued_at_provider:"video.queuedAtProvider",generating:"video.generating",downloading:"video.downloading",checking:"video.checking",complete:"video.complete",stopping:"video.stopping",stopped:"video.stopped",error:"video.error"};
const safeId=(value:unknown):value is string=>typeof value==='string'&&/^vid_[A-Za-z0-9_-]{1,100}$/.test(value);
const costLabel=(job:VideoJobView)=>job.cost.state==='unknown'&&!videoActive(job)?t("video.chargeUnknown"):t(job.cost.state==='reported'?"video.reported":"video.estimated",{cost:formatCost((job.cost.settledMicrousd??job.cost.estimatedMicrousd)/1e6)});


/** Current status is separate from immutable tool results. Visibility, not reply age, owns network work. */
export function VideoToolCard(props:ToolCallMessagePartProps) {
  const threadId=useAuiState(s=>s.threadListItem.remoteId??undefined),messageId=useAuiState(s=>s.message.id);
  const userId=useData(s=>s.me?.id);
  const root=useRef<HTMLDivElement>(null);
  const [visible,setVisible]=useState(false),[version,setVersion]=useState(0);
  const [choice,setChoice]=useState<{owner:string;id:string}|null>(null);
  const [attempts,setAttempts]=useState<{owner:string;jobs:VideoJobView[]}|null>(null);
  const [busy,setBusy]=useState(false),[failed,setFailed]=useState(false),[confirm,setConfirm]=useState(false);
  const receipt=props.result as {jobId?:unknown;accepted?:unknown;version?:unknown}|undefined;
  const receiptId=receipt?.version===1&&receipt.accepted===true&&safeId(receipt.jobId)?receipt.jobId:null;
  const id=choice&&choice.owner===userId?choice.id:receiptId;
  const snapshot=useSyncExternalStore(videoJobs.subscribe,()=>id?videoJobs.get(id):videoJobs.get(''));
  const job=snapshot.job;
  useEffect(()=>{
    const node=root.current;if(!node)return;
    let intersecting=false;
    const update=()=>setVisible(intersecting&&document.visibilityState!=='hidden');
    if(typeof IntersectionObserver==='undefined'){intersecting=true;update();}
    const observer=typeof IntersectionObserver==='undefined'?null:new IntersectionObserver(entries=>{intersecting=entries[0]?.isIntersecting===true;update();});
    observer?.observe(node);document.addEventListener('visibilitychange',update);
    return()=>{observer?.disconnect();document.removeEventListener('visibilitychange',update);};
  },[]);
  useEffect(()=>{
    if(!visible||!userId||!threadId)return;
    const controller=new AbortController();
    // This lookup also recovers a job whose accepted tool result was lost during a disconnect.
    const query=new URLSearchParams({assistantMessageId:messageId,toolCallId:props.toolCallId});
    void api<{jobs:VideoJobView[]}>(`/threads/${encodeURIComponent(threadId)}/video-jobs?${query}`,{signal:controller.signal}).then(result=>{
      if(controller.signal.aborted||!videoJobs.accountIs(userId))return;
      const jobs=result.jobs.filter(j=>safeId(j.id)).sort((a,b)=>a.attempt-b.attempt);
      for(const item of jobs)videoJobs.apply(item,true);
      setAttempts({owner:userId,jobs});const latest=jobs.at(-1);if(latest)setChoice({owner:userId,id:latest.id});
    }).catch(()=>{});
    return()=>controller.abort();
  },[visible,userId,threadId,messageId,props.toolCallId,version]);
  useEffect(()=>{if(!visible||!id||!userId)return;return videoJobs.watch(id);},[visible,id,userId]);
  const [elapsed,setElapsed]=useState(0);
  useEffect(()=>{
    if(!visible||!job||!videoActive(job))return;
    const update=()=>setElapsed(Math.max(0,(Date.now()-job.createdAt)/1000));update();const timer=setInterval(update,1000);return()=>clearInterval(timer);
  },[visible,job?.id,job?.createdAt,job?.state]);
  const act=async(retry:boolean)=>{
    if(!job||!userId)return;
    const owner=userId;setBusy(true);setFailed(false);
    try{
      if(retry){const result=await api<{job:VideoJobView}>(`/video-jobs/${encodeURIComponent(job.id)}/retry`,{method:'POST',json:{expectedRevision:job.revision}});if(!videoJobs.accountIs(owner))return;videoJobs.apply(result.job);setChoice({owner,id:result.job.id});setConfirm(false);}
      else{const result=await api<VideoJobView>(`/video-jobs/${encodeURIComponent(job.id)}/cancel`,{method:'POST',json:{}});if(!videoJobs.accountIs(owner))return;videoJobs.apply(result);}
      setVersion(v=>v+1);
    }catch{if(videoJobs.accountIs(owner))setFailed(true);}
    finally{if(videoJobs.accountIs(owner))setBusy(false);}
  };
  const errorCode=job?.error?`video_${job.error.code}`:null;
  const error=errorCode&&(ERROR_CODES as readonly string[]).includes(errorCode)?presentError({code:errorCode as ErrorCode,message:'',retryable:job?.error?.retryable??false},'tool'):null;
  const active=!!job&&videoActive(job);
  const history=job ? [...(attempts&&attempts.owner===userId?attempts.jobs:[]).filter(item=>item.id!==job.id),job].sort((a,b)=>a.attempt-b.attempt) : [];
  const label=job?t(stages[job.stage]??"video.error"):snapshot.missing?t("video.unavailable"):props.status?.type==='incomplete'?t("video.error"):t("video.preparing");
  return <div ref={root} data-video-tool-call={props.toolCallId} tabIndex={-1} className="scroll-mt-8 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring" role="group" aria-label={t("video.title")}>
    <ToolShell icon={<VideoIcon className="size-4" />} label={label} running={active||!job&&props.status?.type==='running'} defaultOpen failure={props.status?.type==='incomplete'&&!job?t("video.error"):undefined}>
      <div className="max-w-xl min-w-0 space-y-3 rounded-xl bg-muted/30 p-3 sm:p-4">
        <p className="sr-only" aria-live="polite">{label}</p>
        {job&&<p className="text-muted-foreground break-words text-xs">{job.service} · {job.model} · {formatDuration(job.request.durationSeconds)} · {job.request.size}</p>}
        {active&&<div className="bg-muted/50 flex min-h-28 items-center justify-center gap-3 rounded-xl"><VideoIcon aria-hidden className="text-muted-foreground size-6" /><span className="text-muted-foreground text-xs tabular-nums">{t("video.elapsed",{duration:formatDuration(elapsed)})}</span></div>}
        {job?.output?<VideoPlayer key={job.output.id} output={job.output} />:job?.outputUnavailable||snapshot.missing?<p>{t("video.unavailable")}</p>:null}
        {error&&<p className="text-sm" role="status">{t(error.messageKey)}</p>}
        {job?.state==='submission_unknown'&&<p className="text-warning text-sm">{t("video.unknownBilling")}</p>}
        {job?.state==='cancelled'&&job.error?.mayHaveCharged&&<p className="text-muted-foreground text-xs">{t("video.cancelBilling")}</p>}
        {job&&<p className="text-muted-foreground text-xs">{costLabel(job)}</p>}
        {snapshot.stale&&<p className="text-muted-foreground text-xs">{t("video.stale")}</p>}
        {failed&&<p className="text-destructive text-xs" role="alert">{t("video.actionFailed")}</p>}
        <div className="flex flex-wrap gap-2">
          {active&&<Button variant="outline" className="min-h-11" disabled={busy||job?.state==='cancel_requested'} onClick={()=>void act(false)}>{t("video.cancel")}</Button>}
          {job?.canRetry&&<Button variant="outline" className="min-h-11" disabled={busy} onClick={()=>setConfirm(true)}>{t("video.retry")}</Button>}
          {snapshot.stale&&id&&<Button variant="ghost" className="min-h-11" onClick={()=>void videoJobs.refresh(id)}>{t("video.refresh")}</Button>}
        </div>
        {job&&<details className="text-muted-foreground text-xs"><summary className="min-h-11 cursor-pointer py-3">{t("video.details")}</summary><ol className="space-y-2">{history.map(item=><li key={item.id}>{t("video.attempt",{attempt:formatNumber(item.attempt+1)})} · {t(stages[item.stage]??"video.error")} · {costLabel(item)}</li>)}</ol><Button variant="ghost" className="mt-2 min-h-11" onClick={()=>runCommand("message.details")}>{t("video.messageDetails")}</Button></details>}
      </div>
    </ToolShell>
    <Dialog open={confirm} onOpenChange={open=>{if(!busy)setConfirm(open);}}><DialogContent><DialogHeader><DialogTitle>{t("video.retryTitle")}</DialogTitle><DialogDescription>{t("video.retryDescription",{cost:formatCost((job?.cost.estimatedMicrousd??0)/1e6)})}</DialogDescription></DialogHeader><DialogFooter><Button variant="ghost" className="min-h-11" disabled={busy} onClick={()=>setConfirm(false)}>{t("common.cancel")}</Button><Button className="min-h-11" disabled={busy||!job?.canRetry} onClick={()=>void act(true)}>{t("video.retryConfirm")}</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}
