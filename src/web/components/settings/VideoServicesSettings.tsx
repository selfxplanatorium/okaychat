import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { t, type PlainMessageKey } from "@/i18n";
import { formatCost, formatDuration } from "@/i18n/format";
import { api } from "@/lib/api";
import { settingsHref } from "@/lib/settings-link";
import { useData } from "@/state/data";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { videoEstimateMicrousd, type VideoServiceStatus, type VideoSettings } from "@shared/video";
import { SettingsRow, SettingsSection } from "./SettingsUI";

const reasons:Record<NonNullable<VideoServiceStatus["unavailableReason"]>,PlainMessageKey>={own_key_required:"video.ownKeyRequired",connection_disabled:"video.connectionDisabled",unsupported_endpoint:"video.unsupportedEndpoint",unsupported_parameters:"video.unsupportedModel"};

/** Explicit opt-in for paid jobs; status only ever describes private credentials. */
export function VideoServicesSettings() {
  const owner=useData(s=>s.me?.id),settings=useData(s=>s.settings);
  const [data,setData]=useState<{owner:string;services:VideoServiceStatus[]}|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(false);
  const writing=useRef(false),readSeq=useRef(0),epoch=useRef(0);
  useEffect(()=>{epoch.current++;setBusy(false);writing.current=false;return()=>{epoch.current++;readSeq.current++;};},[owner]);
  const refresh=useCallback(async(signal?:AbortSignal)=>{
    if(!owner)return;
    const seq=++readSeq.current,generation=epoch.current;
    try{const result=await api<{services:VideoServiceStatus[]}>("/video-services",{signal});if(!signal?.aborted&&generation===epoch.current&&seq===readSeq.current&&useData.getState().me?.id===owner){setData({owner,services:result.services});setError(false);}}
    catch{if(!signal?.aborted&&generation===epoch.current&&seq===readSeq.current&&useData.getState().me?.id===owner)setError(true);}
  },[owner]);
  useEffect(()=>{const controller=new AbortController();void refresh(controller.signal);return()=>controller.abort();},[refresh]);
  const perform=async(work:()=>Promise<void>)=>{
    if(!owner||writing.current)return false;
    const generation=epoch.current;readSeq.current++;
    writing.current=true;setBusy(true);setError(false);
    try{await work();if(generation!==epoch.current)return false;await refresh();return true;}catch{if(generation===epoch.current&&useData.getState().me?.id===owner)setError(true);return false;}
    finally{if(generation===epoch.current){writing.current=false;if(useData.getState().me?.id===owner)setBusy(false);}}
  };
  const choose=(id:VideoServiceStatus["id"],patch:NonNullable<VideoSettings["xai"]>)=>perform(async()=>{
    const generation=epoch.current,previous=useData.getState().settings?.videoServices??{};
    try{await useData.getState().updateSettings({videoServices:{...previous,[id]:{...previous[id],...patch}}});}
    catch(error){if(generation===epoch.current&&useData.getState().me?.id===owner)useData.setState(s=>({settings:s.settings?{...s.settings,videoServices:previous}:s.settings}));throw error;}
  });
  if(!settings||!owner)return null;
  const services=data?.owner===owner?data.services:null;
  return <SettingsSection title={t("video.title")} description={t("video.settingsDescription")}>
    <SettingsRow id="setting-video-generation" label={t("video.paidOptIn")} description={t("video.settingsPrivacy")} control={<Button variant="ghost" className="min-h-11" disabled={busy} onClick={()=>void refresh()}>{t("video.refreshServices")}</Button>} />
    <p className="text-muted-foreground px-4 py-3 text-xs">{t("video.billingNote")}</p>
    {error&&<p className="text-destructive px-4 py-3 text-xs" role="alert">{t("video.settingsFailed")}</p>}
    {!services&&!error&&<p className="text-muted-foreground px-4 py-3 text-sm" role="status">{t("common.loading")}</p>}
    {services?.map(service=><ServiceFields key={`${owner}:${service.id}`} service={service} enabled={settings.videoServices?.[service.id]?.enabled===true} busy={busy} choose={patch=>void choose(service.id,patch)} saveKey={key=>perform(async()=>{await api(`/video-services/${service.id}/key`,{method:"PUT",json:{apiKey:key}});})} removeKey={()=>perform(async()=>{await api(`/video-services/${service.id}/key`,{method:"DELETE"});})} />)}
  </SettingsSection>;
}
function ServiceFields({service:s,enabled,busy,choose,saveKey,removeKey}:{service:VideoServiceStatus;enabled:boolean;busy:boolean;choose:(patch:NonNullable<VideoSettings["xai"]>)=>void;saveKey:(key:string)=>Promise<boolean>;removeKey:()=>Promise<boolean>}) {
  const [key,setKey]=useState("");
  const model=s.models.find(m=>m.id===s.model);
  const unavailable=s.unavailableReason!==null;
  return <div>
    <SettingsRow label={s.name} description={s.unavailableReason?t(reasons[s.unavailableReason]):t("video.privateKeyReady")} control={<Switch aria-label={t("video.enableService",{name:s.name})} disabled={busy||unavailable&&!enabled} checked={enabled} onCheckedChange={checked=>choose({enabled:checked})} />} />
    <div className="space-y-3 px-4 pb-4">
      {s.id==="xai"?<Link href={settingsHref("providers")} className="text-primary inline-flex min-h-11 items-center text-sm underline underline-offset-4">{t("video.manageProviderKey")}</Link>:<>
        <p className="text-muted-foreground text-xs">{t("video.sharedImageKey")}</p>
        <form className="flex flex-wrap items-center gap-2" onSubmit={event=>{event.preventDefault();if(key.trim())void saveKey(key.trim()).then(saved=>{if(saved)setKey("");});}}>
          <Input type="password" autoComplete="off" maxLength={8192} className="min-h-11 w-full sm:w-72" aria-label={t("video.replicateKey")} value={key} onChange={event=>setKey(event.target.value)} disabled={busy} />
          <Button type="submit" className="min-h-11" disabled={busy||!key.trim()}>{t("common.save")}</Button>
          {s.connected&&<Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={()=>void removeKey()}>{t("video.removeKey")}</Button>}
        </form>
      </>}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs"><span>{t("video.model")}</span><Select className="min-h-11 w-full" aria-label={t("video.model")} value={s.model} disabled={busy} options={[...(!model?[{value:s.model,label:s.model}]:[]),...s.models.map(m=>({value:m.id,label:m.id}))]} onValueChange={value=>choose({model:value})} /></label>
        <label className="space-y-1 text-xs"><span>{t("video.duration")}</span><Select className="min-h-11 w-full" aria-label={t("video.duration")} value={String(s.defaults.durationSeconds)} disabled={busy} options={[4,6,8].map(value=>({value:String(value),label:formatDuration(value)}))} onValueChange={value=>{if(value==="4"||value==="6"||value==="8")choose({durationSeconds:Number(value) as 4|6|8});}} /></label>
        <label className="space-y-1 text-xs"><span>{t("video.aspect")}</span><Select className="min-h-11 w-full" aria-label={t("video.aspect")} value={s.defaults.aspectRatio} disabled={busy} options={[{value:"16:9",label:"16:9"},{value:"9:16",label:"9:16"}]} onValueChange={value=>{if(value==="16:9"||value==="9:16")choose({aspectRatio:value});}} /></label>
        <label className="space-y-1 text-xs"><span>{t("video.resolution")}</span><Select className="min-h-11 w-full" aria-label={t("video.resolution")} value={s.defaults.size} disabled={busy} options={[{value:"720p",label:"720p"},{value:"1080p",label:"1080p"}]} onValueChange={value=>{if(value==="720p"||value==="1080p")choose({size:value});}} /></label>
      </div>
      {model&&<p className="text-muted-foreground text-xs">{t("video.priceEstimate",{second:formatCost(model.price.ratesByResolution[s.defaults.size]),clip:formatCost(videoEstimateMicrousd(model.price,{...s.defaults,audio:true,hasReference:false})/1e6)})} {model.price.referenceImageUsd>0?t("video.referenceCharge",{cost:formatCost(model.price.referenceImageUsd)}):t("video.referenceIncluded")}</p>}
      {model?.upscaled1080p&&<p className="text-muted-foreground text-xs">{t("video.upscaleNote")}</p>}
      <p className="text-muted-foreground text-xs">{t("video.audioNote")} {s.id==="replicate"?t("video.referenceEightSeconds"):t("video.localCancelNote")}</p>
    </div>
  </div>;
}
