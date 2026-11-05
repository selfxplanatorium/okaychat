import { CloudOffIcon, LoaderCircleIcon, RefreshCwIcon, WifiIcon } from "lucide-react";
import { t } from "@/i18n";
import { formatTime } from "@/i18n/format";
import { Button } from "@/components/ui/button";
import type { TransportState } from "@/state/channels-events";

export function ChannelConnectionNotice({
  state,
  lastSync,
  onRetry,
}: {
  state: TransportState;
  lastSync: number | null;
  onRetry: () => void;
}) {
  if (state === "streaming") {
    return (
      <p className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
        <WifiIcon aria-hidden className="size-3" />
        {lastSync ? t("channels.lastSync", { time: formatTime(lastSync) }) : null}
      </p>
    );
  }
  const offline = state === "offline";
  const label = offline ? t("channels.offline") : state === "polling" ? t("channels.polling") : lastSync ? t("channels.resyncing") : t("channels.reconnecting");
  return (
    <div role="status" className="border-border bg-muted/40 flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs">
      {offline ? <CloudOffIcon aria-hidden className="size-3.5" /> : <LoaderCircleIcon aria-hidden className="size-3.5 animate-spin" />}
      <span className="min-w-0 flex-1">{label}</span>
      {lastSync && <span className="text-muted-foreground hidden sm:inline">{t("channels.lastSync", { time: formatTime(lastSync) })}</span>}
      <Button type="button" size="xs" variant="ghost" onClick={onRetry} aria-label={t("channels.retry")}>
        <RefreshCwIcon aria-hidden />
      </Button>
    </div>
  );
}
