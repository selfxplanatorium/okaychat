import { LockIcon } from "lucide-react";
import type { ShareLink } from "@shared/share-links";
import { formatDate } from "@/i18n/format";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

/** Mode, password, expiry, and view count for one link. Shared by the chat panel and the manager. */
export function ShareBadges({ share, className }: { share: ShareLink; className?: string }) {
  return (
    <span className={cn("text-muted-foreground inline-flex flex-wrap items-center gap-1.5 text-[11px]", className)}>
      <span className="bg-muted text-foreground rounded px-1.5 py-0.5 font-medium">
        {share.mode === "live" ? t("share.liveMode") : t("share.frozenMode")}
      </span>
      {share.hasPassword && (
        <span className="inline-flex items-center gap-0.5" aria-label={t("share.unlockPassword")}>
          <LockIcon aria-hidden className="size-3" />
        </span>
      )}
      {share.expired ? (
        <span className="text-destructive">{t("share.linkExpired")}</span>
      ) : share.expiresAt !== null ? (
        <span>{t("share.linkExpires", { date: formatDate(share.expiresAt) })}</span>
      ) : null}
      {share.mode === "frozen" && share.frozenAt !== null && <span>{t("share.snapshotAt", { date: formatDate(share.frozenAt) })}</span>}
      {share.viewCount > 0 && <span>{t("share.linkViews", { count: share.viewCount })}</span>}
    </span>
  );
}
