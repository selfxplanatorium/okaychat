import { create } from "zustand";
import { IMPORT_REASON_CODES, type ImportItemsPage, type ImportReason, type JobView, type PreviewItem, type TransferErrorDetails } from "@shared/chat-import";
import type { ThreadSummary } from "@shared/types";
import { isSessionUnauthorized } from "@/lib/api";

interface State {
  jobs: JobView[]; job: JobView | null; items: PreviewItem[]; threads: ThreadSummary[]; busy: boolean;
  error: TransferErrorDetails | null;
  refresh: (signal?: AbortSignal) => Promise<void>;
  select: (id: string, signal?: AbortSignal) => Promise<void>;
  start: (file: File) => Promise<void>;
  export: (ids: string[]) => Promise<void>;
  confirm: (keys: string[], projectId: string | null) => Promise<void>;
  cancel: () => Promise<void>; resume: () => Promise<void>;
  loadThreads: (signal?: AbortSignal) => Promise<void>;
  download: () => Promise<void>;
  clearSelection: () => void;
}
let account="",epoch=0;
const controllers=new Set<AbortController>();
let uploadController:AbortController|null=null;
export function startConversationImportAccount(id:string):void {
  if(account===id) return;account=id;epoch++;
  for(const controller of controllers) controller.abort();controllers.clear();
  useConversationImports.setState({jobs:[],job:null,items:[],threads:[],busy:false,error:null});
}
class TransferFailure extends Error {constructor(readonly details:TransferErrorDetails) {super(details.reason);}}
async function request<T>(path:string,init:RequestInit={},signal?:AbortSignal):Promise<T> {
  const controller=new AbortController();const abort=()=>controller.abort();controllers.add(controller);signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted) abort();
  try {
    const response=await fetch(`/api${path}`,{credentials:"same-origin",...init,signal:controller.signal});
    const body:unknown=await response.json().catch(()=>null);
    if(!response.ok) {
      if(isSessionUnauthorized(response.status,path,body)) window.dispatchEvent(new Event("okaychat:unauthorized"));
      const detail=body && typeof body==="object" ? (body as {details?:TransferErrorDetails}).details : undefined;
      const reason=detail && IMPORT_REASON_CODES.includes(detail.reason) ? detail.reason : response.status===413 ? "storage_quota" : response.status===410 ? "expired" : response.status===404 ? "not_found" : "internal_error";
      throw new TransferFailure({reason,...(Number.isFinite(detail?.neededBytes) && Number.isFinite(detail?.availableBytes) ? {neededBytes:detail!.neededBytes,availableBytes:detail!.availableBytes} : {})});
    }
    return body as T;
  } finally {controllers.delete(controller);signal?.removeEventListener("abort",abort);}
}
async function pages(id:string,signal?:AbortSignal):Promise<PreviewItem[]> {
  const version=epoch;const items:PreviewItem[]=[];let cursor:string|null=null;
  do {const page:ImportItemsPage=await request(`/conversation-imports/${encodeURIComponent(id)}/items?limit=100${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`,{},signal);if(epoch!==version) throw new DOMException("Account changed","AbortError");items.push(...page.items);cursor=page.nextCursor;if(items.length>1000) throw new TransferFailure({reason:"too_large"});} while(cursor);
  return items;
}
function report(error:unknown,version:number):void {
  if(epoch!==version || (error instanceof Error && error.name==="AbortError")) return;
  useConversationImports.setState({error:error instanceof TransferFailure ? error.details : {reason:"internal_error"}});
}
async function action(work:()=>Promise<void>):Promise<void> {
  if(useConversationImports.getState().busy) return;
  const version=epoch;useConversationImports.setState({busy:true,error:null});
  try {await work();} catch(error) {report(error,version);} finally {if(epoch===version) useConversationImports.setState({busy:false});}
}
const json=(body:unknown):RequestInit=>({method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
export const useConversationImports=create<State>((set,get)=>({
  jobs:[],job:null,items:[],threads:[],busy:false,error:null,
  refresh:async(signal)=> {
    const version=epoch,selected=get().job?.id;
    try {
      const {jobs}=await request<{jobs:JobView[]}>("/conversation-imports",{},signal);
      if(epoch!==version) return;set({jobs});
      if(selected && get().job?.id===selected) await get().select(selected,signal);
    } catch(error) {report(error,version);}
  },
  select:async(id,signal)=> {
    const version=epoch;
    // Publish the requested id only after both owner-scoped requests return; drop superseded selections.
    const selection=++selectionEpoch;
    try {
      const job=await request<JobView>(`/conversation-imports/${encodeURIComponent(id)}`,{},signal);
      if(epoch!==version || selection!==selectionEpoch) return;
      const items=await pages(id,signal);
      if(epoch!==version || selection!==selectionEpoch) return;
      const previous=get().job;set({job,items,...(previous?.id!==job.id ? {error:null} : {})});
      if(previous?.counts.imported!==job.counts.imported || previous?.state!==job.state) window.dispatchEvent(new Event("okaychat:storage-changed"));
    } catch(error) {if(selection===selectionEpoch) report(error,version);}
  },
  start:async(file)=>action(async()=> {
    const version=epoch;
    const controller=new AbortController();uploadController=controller;
    let result:{jobId:string};
    try {result=await request<{jobId:string}>("/conversation-imports",{method:"POST",headers:{"Content-Type":"application/json"},body:file},controller.signal);} finally {if(uploadController===controller) uploadController=null;}
    if(epoch!==version) return;await get().select(result.jobId);await get().refresh();
  }),
  export:async(ids)=>action(async()=> {
    const version=epoch;const result=await request<{jobId:string}>("/conversation-imports/exports",json({threads:ids.map((id)=>({id}))}));
    if(epoch!==version) return;await get().select(result.jobId);await get().refresh();
  }),
  confirm:async(keys,projectId)=>action(async()=> {
    const version=epoch,id=get().job?.id;if(!id) return;
    await request(`/conversation-imports/${encodeURIComponent(id)}/confirm`,json({itemKeys:keys,projectId}));if(epoch===version) await get().refresh();
  }),
  cancel:async()=> {
    const version=epoch;
    try {
      let id=get().job?.id;
      if(!id) {
        const response=await request<{jobs:JobView[]}>("/conversation-imports");
        if(epoch!==version) return;
        id=response.jobs.find((job)=>job.canCancel)?.id;
      }
      if(id) await request(`/conversation-imports/${encodeURIComponent(id)}`,{method:"DELETE"});
      if(epoch!==version) return;
      uploadController?.abort();
      if(id) await get().select(id);
      await get().refresh();
    } catch(error) {report(error,version);}
  },
  resume:async()=>action(async()=> {
    const version=epoch,id=get().job?.id;if(!id) return;
    await request(`/conversation-imports/${encodeURIComponent(id)}/resume`,json({}));if(epoch===version) await get().refresh();
  }),
  loadThreads:async(signal)=> {
    const version=epoch;try {const threads=await request<ThreadSummary[]>("/threads",{},signal);if(epoch===version) set({threads});}catch(error){report(error,version);}
  },
  download:async()=>action(async()=> {
    const version=epoch,id=get().job?.id;if(!id) return;
    const controller=new AbortController();controllers.add(controller);
    try {
      const response=await fetch(`/api/conversation-imports/${encodeURIComponent(id)}/download`,{credentials:"same-origin",signal:controller.signal});
      if(!response.ok) throw new TransferFailure({reason:"staging_unavailable"});
      const blob=await response.blob();if(epoch!==version) return;
      const url=URL.createObjectURL(blob);const anchor=document.createElement("a");anchor.href=url;anchor.download="okaychat-conversations.json";anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    } finally {controllers.delete(controller);}
  }),
  clearSelection:()=>{selectionEpoch++;set({job:null,items:[],error:null});},
}));
let selectionEpoch=0;
