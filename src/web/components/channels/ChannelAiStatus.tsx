import { BotIcon, CircleStopIcon, LoaderCircleIcon, TriangleAlertIcon } from "lucide-react";
import type { ChannelMessage, ChannelRunProjection } from "@shared/channels";
import { t, type MessageKey, type PlainMessageKey } from "@/i18n";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const STATE_KEY: Record<ChannelRunProjection["state"], MessageKey> = {
  queued: "channels.aiQueued",
  running: "channels.aiRunning",
  finished: "channels.aiFinished",
  cancelled: "channels.aiCancelled",
  failed: "channels.aiFailed",
  interrupted: "channels.aiInterrupted",
};

export function ChannelAiStatus({
  message,
  canStop,
  onStop,
  onRetry,
}: {
  message: ChannelMessage;
  canStop: boolean;
  onStop: () => void;
  onRetry: () => void;
}) {
  const run = message.aiRun;
  if (!run) return null;
  const pending = run.state === "queued" || run.state === "running";
  const failed = run.state === "failed" || run.state === "interrupted";
  const unavailable = failed && (run.errorCode === "binding_unavailable" || run.errorCode === "forbidden" || run.errorCode === "not_found");
  return (
    <div className="text-muted-foreground mt-1 flex flex-col gap-1 text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={cn("inline-flex items-center gap-1", failed && "text-destructive")}>
          {pending ? <LoaderCircleIcon aria-hidden className="size-3 animate-spin" /> : failed ? <TriangleAlertIcon aria-hidden className="size-3" /> : <BotIcon aria-hidden className="size-3" />}
          {t(STATE_KEY[run.state] as PlainMessageKey)}
        </span>
        {unavailable && <span>{t("channels.aiUnavailable")}</span>}
        {run.finishReason === "output_limit" && <span>{t("channels.aiOutputLimit")}</span>}
        {run.state === "finished" && !run.usageReported && <span>{t("channels.usageUnknown")}</span>}
        {pending && canStop && (
          <Button type="button" size="xs" variant="outline" onClick={onStop}>
            <CircleStopIcon aria-hidden /> {t("channels.aiStop")}
          </Button>
        )}
        {failed && (
          <Button type="button" size="xs" variant="ghost" onClick={onRetry}>
            {t("channels.aiRetry")}
          </Button>
        )}
      </div>
      <span>{t("channels.aiContextSnapshot")}</span>
      {message.injectionFlagged && <span className="text-amber-600 dark:text-amber-400">{t("channels.injectionWarning")}</span>}
    </div>
  );
}
