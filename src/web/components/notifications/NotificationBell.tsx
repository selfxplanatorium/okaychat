import { BellIcon } from "lucide-react";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { useNotifications } from "@/state/notifications";

/**
 * Opens the notification center. Two mounts: the sidebar header and, when the drawer is closed on a
 * phone, the chat header, so the bell stays reachable.
 */
export function NotificationBell({ variant = "sidebar" }: { variant?: "sidebar" | "header" }) {
  const unread = useNotifications((s) => s.unread);
  const openCenter = useNotifications((s) => s.openCenter);
  const label = unread > 0 ? t("notifications.bellUnread", { count: unread }) : t("notifications.bell");
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-command="notifications.open"
      onClick={openCenter}
      onPointerDown={(event) => event.stopPropagation()}
      className={cn(
        "relative inline-flex items-center justify-center rounded-lg transition-colors duration-(--motion-fast) ease-out-quart",
        variant === "sidebar"
          ? "text-sidebar-muted-foreground hover:bg-sidebar-row-hover focus-visible:outline-ring p-1.5 pointer-coarse:p-2.5"
          : "surface-glass text-muted-foreground hover:text-foreground relative z-20 rounded-lg border p-1.5 pointer-coarse:p-2.5",
      )}
    >
      <BellIcon className="size-4" />
      {unread > 0 && (
        <span
          aria-hidden
          className="bg-primary text-primary-foreground absolute -end-0.5 -top-0.5 min-w-4 rounded-full px-1 text-[9px] leading-4 font-medium tabular-nums"
        >
          {unread > 9 ? "9+" : unread}
        </span>
      )}
    </button>
  );
}
