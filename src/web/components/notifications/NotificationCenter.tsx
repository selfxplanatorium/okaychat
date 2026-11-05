import { useEffect } from "react";
import { useLocation } from "wouter";
import { BellIcon, CalendarClockIcon, CalendarDaysIcon, DownloadIcon, InfoIcon, MessagesSquareIcon, UploadIcon } from "lucide-react";
import type { AppNotification } from "@shared/notifications";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { useCommand } from "@/keyboard/registry";
import { cn } from "@/lib/utils";
import { useData } from "@/state/data";
import {
  notificationBody,
  notificationTitle,
  setNotificationNavigator,
  useNotifications,
} from "@/state/notifications";

/** Relative time from the four catalog forms, so times never go through `toLocaleString`. */
export function notificationTime(createdAt: number, now = Date.now()): string {
  const minutes = Math.floor((now - createdAt) / 60_000);
  if (minutes < 1) return t("notifications.justNow");
  if (minutes < 60) return t("notifications.minutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("notifications.hoursAgo", { count: hours });
  return t("notifications.daysAgo", { count: Math.floor(hours / 24) });
}

const KIND_ICONS = {
  schedule: CalendarClockIcon,
  import: UploadIcon,
  export: DownloadIcon,
  channel: MessagesSquareIcon,
  calendar: CalendarDaysIcon,
} as const;

function NotificationRow({ item }: { item: AppNotification }) {
  const markRead = useNotifications((s) => s.markRead);
  const markUnread = useNotifications((s) => s.markUnread);
  const dismiss = useNotifications((s) => s.dismiss);
  const open = useNotifications((s) => s.open);
  const busy = useNotifications((s) => s.busyId === item.id);
  const Icon = KIND_ICONS[item.kind];
  const body = notificationBody(item);
  const unread = item.readAt === null;
  return (
    <li
      data-unread={unread || undefined}
      className={cn("flex flex-col gap-1 rounded-xl border p-3", unread ? "bg-muted/50" : "bg-transparent")}
    >
      <div className="flex items-start gap-2">
        <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", item.level === "error" ? "text-destructive" : "text-muted-foreground")} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            {unread && <span aria-hidden className="bg-primary size-1.5 shrink-0 rounded-full" />}
            <span className="min-w-0 break-words">{notificationTitle(item)}</span>
          </p>
          {body && <p className="text-muted-foreground mt-0.5 text-xs break-words">{body}</p>}
          <p className="text-muted-foreground mt-1 text-[11px]">{notificationTime(item.createdAt)}</p>
        </div>
      </div>
      <div className="flex flex-wrap justify-end gap-1">
        {item.actionPath && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => open(item)} className="pointer-coarse:min-h-11">
            {t("notifications.open")}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void (unread ? markRead(item.id) : markUnread(item.id))}
          className="pointer-coarse:min-h-11"
        >
          {unread ? t("notifications.markRead") : t("notifications.markUnread")}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void dismiss(item.id)} className="text-muted-foreground pointer-coarse:min-h-11">
          {t("notifications.dismiss")}
        </Button>
      </div>
    </li>
  );
}

/** The dialog itself. Mounted once in the shell; the bell only opens it. */
export function NotificationCenter() {
  const accountId = useData((s) => s.me?.id);
  const [, navigate] = useLocation();
  const open = useNotifications((s) => s.centerOpen);
  const openCenter = useNotifications((s) => s.openCenter);
  const closeCenter = useNotifications((s) => s.closeCenter);
  const start = useNotifications((s) => s.start);
  const stop = useNotifications((s) => s.stop);
  const refresh = useNotifications((s) => s.refresh);
  const loadMore = useNotifications((s) => s.loadMore);
  const markAllRead = useNotifications((s) => s.markAllRead);
  const clearRead = useNotifications((s) => s.clearRead);
  const { items, unread, loaded, error, cursor } = useNotifications();

  useEffect(() => {
    setNotificationNavigator((path) => navigate(path));
    return () => setNotificationNavigator(null);
  }, [navigate]);

  useCommand("notifications.open", openCenter);
  useCommand("notifications.markAllRead", () => void useNotifications.getState().markAllRead());

  useEffect(() => {
    if (accountId) start(accountId);
    else stop();
  }, [accountId, start, stop]);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? openCenter() : closeCenter())}>
      <DialogContent className="flex max-h-[min(42rem,85vh)] flex-col gap-4 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BellIcon aria-hidden className="size-4" /> {t("notifications.title")}
          </DialogTitle>
          <DialogDescription className="sr-only">{t("notifications.emptyBody")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={unread === 0} onClick={() => void markAllRead()}>
            {t("notifications.markAllRead")}
          </Button>
          <Button size="sm" variant="ghost" disabled={!items.some((item) => item.readAt !== null)} onClick={() => void clearRead()}>
            {t("notifications.clearRead")}
          </Button>
          <span aria-live="polite" className="text-muted-foreground ms-auto text-xs tabular-nums">
            {unread > 0 ? t("notifications.bellUnread", { count: unread }) : ""}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {!loaded && !error && (
            <div role="status" aria-label={t("common.loading")} className="flex flex-col gap-2">
              {[0, 1, 2].map((index) => (
                <div key={index} className="bg-muted/40 h-20 animate-pulse rounded-xl" />
              ))}
            </div>
          )}
          {error && !items.length && (
            <div role="alert" className="flex flex-col items-start gap-2 p-4">
              <p className="text-sm">{t("notifications.loadFailed")}</p>
              <Button size="sm" variant="outline" onClick={() => void refresh()}>
                {t("notifications.retry")}
              </Button>
            </div>
          )}
          {loaded && !error && items.length === 0 && (
            <div className="flex flex-col items-center gap-1 px-4 py-12 text-center">
              <InfoIcon aria-hidden className="text-muted-foreground mb-2 size-6" />
              <p className="text-sm font-medium">{t("notifications.empty")}</p>
              <p className="text-muted-foreground max-w-xs text-xs">{t("notifications.emptyBody")}</p>
            </div>
          )}
          {items.length > 0 && (
            <ul className="flex flex-col gap-2 p-0.5">
              {items.map((item) => (
                <NotificationRow key={item.id} item={item} />
              ))}
            </ul>
          )}
          {cursor && (
            <div className="flex justify-center py-3">
              <Button size="sm" variant="ghost" onClick={() => void loadMore()}>
                {t("notifications.loadMore")}
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
