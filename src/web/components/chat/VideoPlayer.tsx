import { useState } from "react";
import { DownloadIcon } from "lucide-react";
import type { VideoOutput } from "@shared/video";
import { t } from "@/i18n";
import { formatDuration, formatNumber } from "@/i18n/format";
import { buttonVariants } from "@/components/ui/button";

export function VideoPlayer({output}:{output:VideoOutput}) {
  const [failed,setFailed]=useState(false);
  const src=`/api/videos/${encodeURIComponent(output.id)}/file`;
  return <div className="min-w-0 space-y-2">
    {failed?<p className="text-muted-foreground py-6 text-sm" role="status">{t("video.previewUnavailable")}</p>:<video aria-label={t("video.player")} controls playsInline preload="metadata" className="bg-muted max-h-[70svh] w-full rounded-xl" style={{aspectRatio:`${output.width} / ${output.height}`}} src={src} onError={()=>setFailed(true)} />}
    <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <span>{formatDuration(output.durationMs/1000)}</span><span>{t("video.dimensions",{width:formatNumber(output.width),height:formatNumber(output.height)})}</span><span>{t(output.hasAudio?"video.audio":"video.silent")}</span>
    </div>
    <a className={buttonVariants({variant:'outline',className:'min-h-11'})} href={`${src}?download=1`}><DownloadIcon aria-hidden />{t("video.download")}</a>
  </div>;
}
