import type { StorageInfo } from "@shared/types";
import { formatBytes } from "@/lib/api";
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
          of {formatBytes(storage.limit)} ({pct}%)
        </span>
      </div>
      <div className="bg-border/50 h-2 overflow-hidden rounded-full">
        <div
          className={cn("h-full rounded-full transition-[width] duration-(--motion-base)", full ? "bg-destructive" : pct >= 90 ? "bg-warning" : "bg-primary/80")}
          style={{ width: `${pct}%` }}
        />
      </div>
      {full ? (
        <p className="text-destructive text-xs">Your storage is full. New uploads, artifacts, and generated files are rejected until you delete old chats, attachments, or fonts.</p>
      ) : (
        pct >= 90 && <p className="text-muted-foreground text-xs">You are close to your storage limit.</p>
      )}
    </div>
  );
}
