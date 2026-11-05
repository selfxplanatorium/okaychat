import { ArrowLeftIcon, BookOpenIcon, CodeIcon, CoffeeIcon, HashIcon, LightbulbIcon, MegaphoneIcon, MessagesSquareIcon, SearchIcon, SettingsIcon, UserIcon, UsersIcon } from "lucide-react";
import type { ChannelSummary } from "@shared/channels";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import { dmTitle } from "@/state/channels-derive";
import { ChannelNotificationPreferences } from "./ChannelNotificationPreferences";
import { ChannelConnectionNotice } from "./ChannelConnectionNotice";
import type { TransportState } from "@/state/channels-events";

const ICONS = {
  hash: HashIcon,
  "messages-square": MessagesSquareIcon,
  users: UsersIcon,
  megaphone: MegaphoneIcon,
  "book-open": BookOpenIcon,
  code: CodeIcon,
  lightbulb: LightbulbIcon,
  coffee: CoffeeIcon,
} as const;

export function ChannelHeader({
  room,
  meId,
  connection,
  lastSync,
  onBack,
  onSearch,
  onMembers,
  onSettings,
  onRetry,
  onNotify,
}: {
  room: ChannelSummary;
  meId: string | null;
  connection: TransportState;
  lastSync: number | null;
  onBack: () => void;
  onSearch: () => void;
  onMembers: () => void;
  onSettings: () => void;
  onRetry: () => void;
  onNotify: (mode: NonNullable<ChannelSummary["membership"]>["notifyMode"]) => void;
}) {
  const dm = room.kind === "dm";
  const Icon = dm ? (room.memberCount > 2 ? UsersIcon : UserIcon) : ICONS[room.icon] ?? HashIcon;
  const title = dm ? dmTitle(room, meId) : room.name;
  return (
    <header className="bg-background/85 supports-backdrop-filter:bg-background/70 border-border flex shrink-0 items-center gap-2 border-b px-2 py-2 backdrop-blur-md sm:px-3">
      <Button type="button" size="icon-sm" variant="ghost" aria-label={t("channels.back")} onClick={onBack} className="md:hidden">
        <ArrowLeftIcon aria-hidden />
      </Button>
      <Icon aria-hidden className="text-muted-foreground hidden size-5 shrink-0 sm:block" />
      <div className="min-w-0 flex-1">
        <h1 className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
          <span className="truncate">{title}</span>
          <span className="text-muted-foreground shrink-0 text-[0.65rem] font-normal">
            {dm ? t("channels.directMessages") : t(room.visibility === "public" ? "channels.public" : room.visibility === "private" ? "channels.private" : "channels.group")}
          </span>
          {room.archivedAt && <span className="text-muted-foreground shrink-0 text-[0.65rem] font-normal">{t("channels.archived")}</span>}
        </h1>
        <div className="text-muted-foreground flex min-w-0 items-center gap-2 text-[0.7rem]">
          <ChannelConnectionNotice state={connection} lastSync={lastSync} onRetry={onRetry} />
          <span className="shrink-0">{dm ? t("channels.dmMemberCount", { count: room.memberCount }) : t("channels.memberCount", { count: room.memberCount })}</span>
        </div>
      </div>
      <div className="flex items-center gap-0.5">
        <Button type="button" size="icon-sm" variant="ghost" aria-label={t("channels.searchRooms")} onClick={onSearch}>
          <SearchIcon aria-hidden />
        </Button>
        {!dm && (
          <Button type="button" size="icon-sm" variant="ghost" aria-label={t("channels.members")} onClick={onMembers}>
            <UsersIcon aria-hidden />
          </Button>
        )}
        {room.membership && <ChannelNotificationPreferences mode={room.membership.notifyMode} onChange={onNotify} />}
        {(dm || room.capabilities.manage || room.capabilities.moderate) && (
          <Button type="button" size="icon-sm" variant="ghost" aria-label={t("channels.settings")} onClick={onSettings}>
            <SettingsIcon aria-hidden />
          </Button>
        )}
      </div>
    </header>
  );
}
