import { useEffect, useState } from "react";
import type { VideoJobView } from "@shared/video";
import { t } from "@/i18n";
import { formatCost, formatNumber } from "@/i18n/format";
import { api } from "@/lib/api";
import { useData } from "@/state/data";
import { Button } from "@/components/ui/button";

/** No provider URLs or separate LLM receipt: these links focus the originating application card. */
export function VideoMessageDetails({threadId,messageId,open,onNavigate}:{threadId:string|null;messageId:string;open:boolean;onNavigate:()=>void}) {
  const owner=useData(s=>s.me?.id);
  const [data,setData]=useState<{owner:string;threadId:string;messageId:string;jobs:VideoJobView[]}|null>(null);
  const [failed,setFailed]=useState(false);
  useEffect(()=>{
    if(!open||!threadId||!owner)return;
    const controller=new AbortController();
    void api<{jobs:VideoJobView[]}>(`/threads/${encodeURIComponent(threadId)}/video-jobs?assistantMessageId=${encodeURIComponent(messageId)}`,{signal:controller.signal}).then(result=>{if(!controller.signal.aborted&&useData.getState().me?.id===owner){setData({owner,threadId,messageId,jobs:result.jobs});setFailed(false);}}).catch(()=>{if(!controller.signal.aborted)setFailed(true);});
    return()=>controller.abort();
  },[open,threadId,messageId,owner]);
  const jobs=data?.owner===owner&&data?.threadId===threadId&&data?.messageId===messageId?data.jobs:[];
  if(!jobs?.length)return failed?<p className="mt-3 text-xs">{t("video.detailsUnavailable")}</p>:null;
  const focus=(toolCallId:string)=>{
    onNavigate();
    requestAnimationFrame(()=>{
      const root=[...document.querySelectorAll<HTMLElement>("[data-message-id]")].find(node=>node.dataset.messageId===messageId);
      const card=[...(root?.querySelectorAll<HTMLElement>("[data-video-tool-call]")??[])].find(node=>node.dataset.videoToolCall===toolCallId);
      card?.scrollIntoView({block:"center",behavior:matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth"});card?.focus({preventScroll:true});
    });
  };
  return <section className="mt-3 border-t pt-3" aria-label={t("video.details")}>
    <p className="text-muted-foreground mb-2 text-xs">{t("video.ledgerHelp")}</p>
    <ul className="space-y-2">{jobs.map(job=><li key={job.id} className="text-xs">
      <Button variant="link" className="min-h-11 max-w-full justify-start whitespace-normal px-0 text-start text-xs" onClick={()=>focus(job.toolCallId)}>{t("video.viewAttempt",{attempt:formatNumber(job.attempt+1)})} · {job.service} · {job.model}</Button>
      <p className="text-muted-foreground">{job.cost.state==="unknown"?t("video.chargeUnknown"):t(job.cost.state==="reported"?"video.reported":"video.estimated",{cost:formatCost((job.cost.settledMicrousd??job.cost.estimatedMicrousd)/1e6)})}</p>
    </li>)}</ul>
  </section>;
}
