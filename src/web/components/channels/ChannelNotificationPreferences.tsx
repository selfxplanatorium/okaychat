import { BellIcon, BellOffIcon, BellRingIcon } from "lucide-react";
import type { ChannelNotifyMode } from "@shared/channels";
import { t } from "@/i18n";
import { Link } from "wouter";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { settingsHref } from "@/lib/settings-link";
import { cn } from "@/lib/utils";

const OPTIONS: Array<{ mode: ChannelNotifyMode; label: "channels.notifyAll" | "channels.notifyMentions" | "channels.notifyNone"; icon: typeof BellIcon }> = [
  { mode: "all", label: "channels.notifyAll", icon: BellRingIcon },
  { mode: "mentions", label: "channels.notifyMentions", icon: BellIcon },
  { mode: "none", label: "channels.notifyNone", icon: BellOffIcon },
];

export function ChannelNotificationPreferences({ mode, onChange }: { mode: ChannelNotifyMode; onChange: (mode: ChannelNotifyMode) => void }) {
  return (
    <Menu>
      <MenuTrigger aria-label={t("channels.notificationMode")} title={t("channels.notificationMode")} className="text-muted-foreground hover:bg-muted hover:text-foreground rounded-lg p-2 pointer-coarse:p-3">
        <BellIcon aria-hidden className="size-4" />
      </MenuTrigger>
      <MenuContent side="bottom" align="end" className="w-56">
        <p className="text-muted-foreground px-2 py-1 text-xs">{t("channels.notificationMode")}</p>
        {OPTIONS.map(({ mode: value, label, icon: Icon }) => (
          <MenuItem key={value} onClick={() => onChange(value)} className={cn(mode === value && "font-medium")}>
            <Icon aria-hidden /> {t(label)}
          </MenuItem>
        ))}
        <p className="text-muted-foreground border-border mt-1 border-t px-2 py-1.5 text-[0.7rem]">{t("channels.notificationsHelp")}</p>
        <Link href={settingsHref("notifications")} className="text-primary px-2 py-1 text-[0.7rem] underline underline-offset-2">
          {t("channels.desktopSettings")}
        </Link>
      </MenuContent>
    </Menu>
  );
}
