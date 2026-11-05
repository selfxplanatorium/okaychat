import { useEffect, useRef, useState } from "react";
import { DownloadIcon, Loader2Icon, UploadIcon } from "lucide-react";
import type { ImportJobState, ImportReason, ImportWarning, WarningCode } from "@shared/chat-import";
import { IMPORT_LIMITS } from "@shared/chat-import";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { t, type PlainMessageKey } from "@/i18n";
import { formatBytes, formatDate, formatDateTime, formatNumber } from "@/i18n/format";
import { useConversationImports } from "@/state/conversation-imports";
import { useData } from "@/state/data";

export const PHASE_KEYS:Record<ImportJobState,PlainMessageKey>={receiving:"conversationImport.phase_receiving",validating:"conversationImport.phase_validating",ready:"conversationImport.phase_ready",queued:"conversationImport.phase_queued",importing:"conversationImport.phase_importing",paused:"conversationImport.phase_paused",cancelling:"conversationImport.phase_cancelling",done:"conversationImport.phase_done",cancelled:"conversationImport.phase_cancelled",failed:"conversationImport.phase_failed",expired:"conversationImport.phase_expired"};
export const ERROR_KEYS:Record<ImportReason,PlainMessageKey>={
  invalid_json:"conversationImport.errorFile",unsafe_key:"conversationImport.errorFile",duplicate_key:"conversationImport.errorFile",too_deep:"conversationImport.errorLarge",too_large:"conversationImport.errorLarge",unsupported_format:"conversationImport.errorFormat",unsupported_version:"conversationImport.errorFormat",validation_timeout:"conversationImport.errorLarge",invalid_conversation:"conversationImport.errorFile",duplicate_source:"conversationImport.errorFile",invalid_tree:"conversationImport.errorFile",empty_conversation:"conversationImport.errorFile",upload_interrupted:"conversationImport.errorFailed",staging_unavailable:"conversationImport.errorFailed",target_missing:"conversationImport.errorSelection",storage_quota:"conversationImport.errorStorage",internal_error:"conversationImport.errorFailed",account_busy:"conversationImport.errorBusy",worker_capacity:"conversationImport.errorBusy",compression:"conversationImport.errorFormat",media_type:"conversationImport.errorFormat",invalid_selection:"conversationImport.errorSelection",wrong_state:"conversationImport.errorSelection",different_confirmation:"conversationImport.errorSelection",invalid_cursor:"conversationImport.errorSelection",expired:"conversationImport.errorExpired",not_found:"conversationImport.errorSelection",export_too_large:"conversationImport.errorLarge",export_unavailable:"conversationImport.errorUnavailable",cancelled:"conversationImport.phase_cancelled",staging_full:"conversationImport.errorStorage",
};
const WARNING_KEYS:Record<WarningCode,`conversationImport.${WarningCode}`>={branches_omitted:"conversationImport.branches_omitted",roles_quarantined:"conversationImport.roles_quarantined",attachments_missing:"conversationImport.attachments_missing",html_removed:"conversationImport.html_removed",links_removed:"conversationImport.links_removed",timestamps_inferred:"conversationImport.timestamps_inferred",title_shortened:"conversationImport.title_shortened",label_shortened:"conversationImport.label_shortened",controls_removed:"conversationImport.controls_removed",unknown_fields:"conversationImport.unknown_fields",unsupported_content:"conversationImport.unsupported_content",reasoning_omitted:"conversationImport.reasoning_omitted",source_changed:"conversationImport.source_changed",model_unavailable:"conversationImport.model_unavailable",model_unset:"conversationImport.model_unset",export_loss:"conversationImport.export_loss"};
export function TransferWarnings({warnings}:{warnings:ImportWarning[]}) {return warnings.length ? <details className="text-muted-foreground text-sm"><summary className="min-h-11 cursor-pointer py-3 font-medium">{t("conversationImport.warnings")}</summary><ul className="ms-5 list-disc space-y-1">{warnings.map((w)=><li key={w.code}>{t(WARNING_KEYS[w.code],{count:formatNumber(w.count)})}</li>)}</ul></details> : null;}
const errorKey=(reason:string)=>ERROR_KEYS[reason as ImportReason]??"conversationImport.errorFailed";

export function ConversationImportDialog({open,onOpenChange,mode}:{open:boolean;onOpenChange:(open:boolean)=>void;mode:"import"|"export"}) {
  const {jobs,job,items,threads,busy,error}=useConversationImports();
  const projects=useData((s)=>s.projects);
  const [selected,setSelected]=useState<Set<string>>(new Set());
  const [exportIds,setExportIds]=useState<Set<string>>(new Set());
  const [project,setProject]=useState("");const [search,setSearch]=useState("");const [page,setPage]=useState(0);const [acknowledged,setAcknowledged]=useState(false);
  const seeded=useRef("");const alert=useRef<HTMLParagraphElement>(null);const picker=useRef<HTMLInputElement>(null);
  useEffect(()=> {
    if(!open) return;
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;let inFlight=false;
    const refresh=async()=> {
      if(inFlight || controller.signal.aborted) return;
      clearTimeout(timer);
      if(document.visibilityState==="hidden") return;
      inFlight=true;
      try {await useConversationImports.getState().refresh(controller.signal);} finally {
        inFlight=false;if(!controller.signal.aborted) {const store=useConversationImports.getState();const state=store.job?.canCancel ? store.job.state : store.jobs.find((row)=>row.canCancel)?.state;if(state || store.busy) timer=setTimeout(()=>void refresh(),state==="ready"||state==="paused" ? 5000 : 1000);}
      }
    };
    if(mode==="export") void useConversationImports.getState().loadThreads(controller.signal);
    void refresh();const focus=()=>void refresh();window.addEventListener("focus",focus);document.addEventListener("visibilitychange",focus);
    return ()=>{controller.abort();clearTimeout(timer);window.removeEventListener("focus",focus);document.removeEventListener("visibilitychange",focus);};
  },[open,mode,job?.id,job?.state,busy]);
  useEffect(()=> {
    if(job?.state==="ready" && job.kind==="import" && seeded.current!==job.id) {
      seeded.current=job.id;setSelected(new Set(items.filter((i)=>i.selectable).map((i)=>i.itemKey)));setProject("");setPage(0);
    }
  },[job?.id,job?.state,job?.kind,items]);
  useEffect(()=>{if(error || job?.errorCode) alert.current?.focus();},[error,job?.errorCode]);
  useEffect(()=> {
    if(!job) return;
    void useData.getState().refreshStorage().catch(()=>{});
    void useData.getState().refreshProjects().catch(()=>{});
    window.dispatchEvent(new Event("okaychat:conversation-imported"));
  },[job?.counts.imported,job?.state]);
  const visibleThreads=threads.filter((row)=>!row.sharedKnowledgeRestricted && (row.title??"").toLowerCase().includes(search.toLowerCase()));
  const rows=job ? items : visibleThreads;
  const pages=Math.max(1,Math.ceil(rows.length/25));const currentPage=Math.min(page,pages-1);
  const toggle=(key:string,exporting=false)=> {
    const update=(old:Set<string>)=>{const next=new Set(old);if(next.has(key)) next.delete(key);else next.add(key);return next;};
    if(exporting) setExportIds(update);else setSelected(update);
  };
  const newTransfer=()=>{useConversationImports.getState().clearSelection();seeded.current="";setSelected(new Set());setPage(0);};
  const pick=(file:File|undefined)=> {
    if(!file) return;
    if(!file.size || file.size>IMPORT_LIMITS.inputBytes) {useConversationImports.setState({error:{reason:"too_large"}});return;}
    void useConversationImports.getState().start(file);
  };
  const messages=items.reduce((n,i)=>n+i.messageCount,0);
  const reason=error?.reason??job?.errorCode;
  const quota=error?.neededBytes!==undefined && error.availableBytes!==undefined ? {neededBytes:error.neededBytes,availableBytes:error.availableBytes} : job?.quota;
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent showCloseButton={false} className="flex max-h-[90dvh] min-w-0 flex-col gap-4 p-4 sm:max-w-2xl sm:p-6">
      <DialogHeader><DialogTitle>{t("conversationImport.title")}</DialogTitle><DialogDescription>{t("conversationImport.cancelNotice")}</DialogDescription></DialogHeader>
      <div className="min-h-0 space-y-4 overflow-y-auto pe-1">
        {reason && <p ref={alert} role="alert" tabIndex={-1} className="text-destructive rounded-md text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">{t(errorKey(reason))}{quota ? <span className="mt-1 block">{t("conversationImport.quota",{needed:formatBytes(quota.neededBytes),available:formatBytes(quota.availableBytes)})}</span> : null}</p>}
        {!job && <>
          <p className="text-muted-foreground text-sm">{t(mode==="import" ? "conversationImport.notice" : "conversationImport.exportNotice")}</p>
          {mode==="import" ? <div className="space-y-2"><label htmlFor="conversation-import-file" className="block text-sm font-medium">{t("conversationImport.chooseFile")}</label><Input ref={picker} id="conversation-import-file" type="file" accept=".json,application/json" disabled={busy} className="min-h-11 w-full max-w-full" onChange={(event)=>{pick(event.currentTarget.files?.[0]);event.currentTarget.value="";}} /></div> : <>
            <label className="block space-y-2"><span className="text-sm font-medium">{t("conversationImport.chooseChats")}</span><Input value={search} onChange={(e)=>{setSearch(e.currentTarget.value);setPage(0);}} placeholder={t("conversationImport.search")} aria-label={t("conversationImport.search")} className="min-h-11 h-auto max-w-full whitespace-normal" /></label>
            <div className="flex flex-wrap gap-2"><Button variant="outline" className="min-h-11 h-auto max-w-full whitespace-normal" onClick={()=>setExportIds(new Set(visibleThreads.slice(0,100).map((r)=>r.id)))}>{t("conversationImport.selectAll")}</Button><Button variant="outline" className="min-h-11 h-auto max-w-full whitespace-normal" onClick={()=>setExportIds(new Set())}>{t("conversationImport.selectNone")}</Button></div>
            {visibleThreads.slice(currentPage*25,(currentPage+1)*25).map((row)=><label key={row.id} className="hover:bg-accent/60 flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 py-3"><input type="checkbox" checked={exportIds.has(row.id)} disabled={!exportIds.has(row.id)&&exportIds.size>=100} onChange={()=>toggle(row.id,true)} /><span className="min-w-0 break-words">{row.title??t("conversationImport.untitled")}</span></label>)}
            <label className="flex min-h-11 cursor-pointer items-start gap-3 py-3"><input type="checkbox" className="mt-1" checked={acknowledged} onChange={(e)=>setAcknowledged(e.currentTarget.checked)} /><span>{t("conversationImport.acknowledge")}</span></label>
          </>}
          <div><h3 className="mb-2 text-sm font-medium">{t("conversationImport.jobs")}</h3>{!jobs.length && <p className="text-muted-foreground text-sm">{t("conversationImport.noJobs")}</p>}{jobs.map((row)=><Button key={row.id} variant="ghost" className="mb-1 flex min-h-11 h-auto w-full min-w-0 flex-wrap justify-between gap-3 whitespace-normal text-start" disabled={busy} onClick={()=>{setPage(0);void useConversationImports.getState().select(row.id);}}><span>{t(PHASE_KEYS[row.state])}</span><span className="text-muted-foreground text-xs">{formatDateTime(row.admissionAt)}</span></Button>)}</div>
        </>}
        {job && <>
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-base font-medium" role="status" aria-live="polite">{t(PHASE_KEYS[job.state])}</h3><Button variant="ghost" className="min-h-11 h-auto max-w-full whitespace-normal" onClick={newTransfer}>{t("conversationImport.back")}</Button></div>
          <p className="text-sm">{t("conversationImport.totals",{conversations:formatNumber(job.counts.total),messages:formatNumber(messages),bytes:formatBytes(job.normalizedBytes)})}</p>
          {job.dateRange && <p className="text-muted-foreground text-xs">{t("conversationImport.dates",{from:formatDate(job.dateRange.from),to:formatDate(job.dateRange.to)})}</p>}
          <p className="text-muted-foreground text-xs">{t("conversationImport.expires",{date:formatDateTime(job.expiresAt)})}</p>
          {job.kind==="import" && <p className="text-muted-foreground text-sm">{job.modelRef ? t("conversationImport.model",{model:job.modelRef}) : t("conversationImport.noModel")}</p>}
          {job.kind==="export" && <p className="text-muted-foreground text-sm">{t("conversationImport.exportNotice")}</p>}
          <p aria-live="polite" role="status" className="text-sm tabular-nums">{t("conversationImport.progress",{processed:formatNumber(job.counts.processed),selected:formatNumber(job.counts.selected)})}</p>
          <p className="text-muted-foreground text-sm">{t("conversationImport.summary",{imported:formatNumber(job.counts.imported),duplicates:formatNumber(job.counts.duplicates),failed:formatNumber(job.counts.failed),cancelled:formatNumber(job.counts.cancelled),invalid:formatNumber(job.counts.invalid),pending:formatNumber(job.counts.pending)})}</p>
          <TransferWarnings warnings={job.warnings} />
          {job.canConfirm && <>
            <label className="block space-y-2"><span className="text-sm font-medium">{t("conversationImport.project")}</span><Select itemClassName="min-h-11" value={project} onValueChange={setProject} options={[{value:"",label:t("conversationImport.noProject")},...projects.map((p)=>({value:p.id,label:p.name}))]} aria-label={t("conversationImport.project")} className="min-h-11 w-full" disabled={busy} /></label>
            <div className="flex flex-wrap gap-2"><Button variant="outline" className="min-h-11 h-auto max-w-full whitespace-normal" onClick={()=>setSelected(new Set(items.filter((i)=>i.selectable).map((i)=>i.itemKey)))}>{t("conversationImport.selectAll")}</Button><Button variant="outline" className="min-h-11 h-auto max-w-full whitespace-normal" onClick={()=>setSelected(new Set())}>{t("conversationImport.selectNone")}</Button></div>
          </>}
          <h4 className="text-sm font-medium">{t(job.canConfirm ? "conversationImport.review" : "conversationImport.results")}</h4>
          <ul className="divide-border divide-y">{items.slice(currentPage*25,(currentPage+1)*25).map((item)=><li key={item.itemKey} className="min-w-0 space-y-1 py-3">
            <label className="flex min-h-11 items-start gap-3"><input type="checkbox" className="mt-1" disabled={!job.canConfirm||!item.selectable||busy} checked={selected.has(item.itemKey)} onChange={()=>toggle(item.itemKey)} /><span className="min-w-0 break-words font-medium">{item.title??t("conversationImport.untitled")}</span></label>
            <p className="text-muted-foreground text-xs">{t("conversationImport.item",{messages:formatNumber(item.messageCount),quarantine:formatNumber(item.quarantineCount),attachments:formatNumber(item.omittedAttachmentCount),branches:formatNumber(item.discardedBranchMessages)})}</p>
            {item.errorCode && item.errorCode!=="source_changed" && <p className="text-destructive text-xs">{t(errorKey(item.errorCode))}</p>}
            <TransferWarnings warnings={item.warnings} />
            {item.result||item.duplicate ? <a className="text-primary inline-flex min-h-11 items-center underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring" href={`/c/${encodeURIComponent((item.result??item.duplicate)!.threadId)}`}>{t("conversationImport.openChat")}</a> : item.state==="imported"||item.state==="duplicate" ? <p className="text-muted-foreground text-xs">{t("conversationImport.unavailable")}</p> : null}
          </li>)}</ul>
        </>}
        {pages>1 && <div className="flex flex-wrap items-center justify-between gap-2"><Button variant="outline" className="min-h-11 h-auto max-w-full whitespace-normal" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>{t("conversationImport.previous")}</Button><span className="text-xs">{t("conversationImport.page",{page:formatNumber(currentPage+1),pages:formatNumber(pages)})}</span><Button variant="outline" className="min-h-11 h-auto max-w-full whitespace-normal" disabled={currentPage>=pages-1} onClick={()=>setPage(currentPage+1)}>{t("conversationImport.next")}</Button></div>}
      </div>
      <div className="border-border flex shrink-0 flex-wrap items-center justify-end gap-2 border-t pt-3">
        {((job?.canConfirm)||(!job&&mode==="export")) && <p className="me-auto text-xs">{t("conversationImport.selected",{count:job ? selected.size : exportIds.size})}</p>}
        <Button variant="ghost" className="min-h-11 h-auto max-w-full whitespace-normal" disabled={busy} onClick={()=>void useConversationImports.getState().refresh()}>{t("conversationImport.refresh")}</Button>
        {busy&&!job && <p role="status" className="text-muted-foreground text-xs">{t(mode==="import" ? "conversationImport.phase_receiving" : "conversationImport.phase_validating")}</p>}
        {busy && <Loader2Icon aria-label={t("conversationImport.loading")} className="size-4 animate-spin" />}
        <Button variant="outline" className="min-h-11 h-auto max-w-full whitespace-normal" onClick={()=>onOpenChange(false)}>{t("conversationImport.close")}</Button>
        {(job?.canCancel || (busy&&!job)) && <Button variant="outline" className="min-h-11 h-auto max-w-full whitespace-normal" onClick={()=>void useConversationImports.getState().cancel()}>{t("conversationImport.cancel")}</Button>}
        {job?.canResume && <Button className="min-h-11 h-auto max-w-full whitespace-normal" disabled={busy} onClick={()=>void useConversationImports.getState().resume()}>{t("conversationImport.resume")}</Button>}
        {job?.canConfirm && <Button className="min-h-11 h-auto max-w-full whitespace-normal" disabled={busy||!selected.size} onClick={()=>void useConversationImports.getState().confirm([...selected],project||null)}><UploadIcon />{t("conversationImport.confirm",{count:selected.size})}</Button>}
        {job?.canDownload && <Button className="min-h-11 h-auto max-w-full whitespace-normal" disabled={busy} onClick={()=>void useConversationImports.getState().download()}><DownloadIcon />{t("conversationImport.download")}</Button>}
        {!job&&mode==="export" && <Button className="min-h-11 h-auto max-w-full whitespace-normal" disabled={busy||!acknowledged||!exportIds.size} onClick={()=>void useConversationImports.getState().export([...exportIds])}><DownloadIcon />{t("conversationImport.startExport")}</Button>}
      </div>
    </DialogContent>
  </Dialog>;
}
