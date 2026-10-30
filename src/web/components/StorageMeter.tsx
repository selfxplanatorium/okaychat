import type { StorageInfo } from "@shared/types";
import { t } from "@/i18n";
import { formatBytes } from "@/i18n/format";
import { cn } from "@/lib/utils";

export const storagePercent = (s: StorageInfo) => Math.min(100, Math.floor((s.used / Math.max(1, s.limit)) * 100));

/** Usage bar with the used and limit numbers. Colors come from semantic tokens, never hardcoded. */
export function StorageMeter({ storage, className }: { storage: StorageInfo; className?: string }) {
  const pct = storagePercent(storage);
  const full = storage.used >= storage.limit;
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex justify-between text-sm tabular-nums">
        <span className="font-medium">{formatBytes(storage.used)}</span>
        <span className="text-muted-foreground">
          {t("shell.storageOf", { limit: formatBytes(storage.limit), percent: pct })}
        </span>
      </div>
      <div className="bg-border/50 h-2 overflow-hidden rounded-full">
        <div
          className={cn("h-full rounded-full transition-[width] duration-(--motion-base)", full ? "bg-destructive" : pct >= 90 ? "bg-warning" : "bg-primary/80")}
          style={{ width: `${pct}%` }}
        />
      </div>
      {full ? (
        <p className="text-destructive text-xs">{t("shell.storageFullMeter")}</p>
      ) : (
        pct >= 90 && <p className="text-muted-foreground text-xs">{t("shell.storageNear")}</p>
      )}
    </div>
  );
}
