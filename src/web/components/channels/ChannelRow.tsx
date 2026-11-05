import { BookOpenIcon, CodeIcon, CoffeeIcon, HashIcon, LightbulbIcon, MegaphoneIcon, MessagesSquareIcon, UsersIcon } from "lucide-react";
import type { ChannelDirectoryEntry, ChannelInviteSummary, ChannelSummary } from "@shared/channels";
import { formatUnreadBadge } from "@/state/channels-derive";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

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

export type ChannelListEntry = ChannelSummary | ChannelDirectoryEntry | ChannelInviteSummary;

function titleOf(entry: ChannelListEntry): string {
  return "channelId" in entry ? entry.channelId : entry.name;
}

export function ChannelRow({
  entry,
  selected,
  onSelect,
  secondary,
  action,
}: {
  entry: ChannelListEntry;
  selected?: boolean;
  onSelect?: () => void;
  secondary?: string;
  action?: React.ReactNode;
}) {
  const Icon = ICONS[entry.icon as keyof typeof ICONS] ?? HashIcon;
  const summary = "membership" in entry ? (entry as ChannelSummary) : null;
  const unread = summary?.unread ?? 0;
  const mentions = summary?.mentionsUnread ?? 0;
  const archived = "archivedAt" in entry && entry.archivedAt !== null;
  return (
    <div className={cn("group/room flex items-center gap-0.5", selected && "depth-row-active rounded-lg")}>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "page" : undefined}
        className={cn(
          "hover:bg-sidebar-row-hover focus-visible:outline-ring flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-start text-sm transition-colors pointer-coarse:min-h-11",
          selected && "depth-row-active",
        )}
      >
        <Icon aria-hidden className="size-4 shrink-0 opacity-80" />
        <span className="min-w-0 flex-1">
          <span className={cn("flex items-center gap-1 truncate", (unread > 0 || mentions > 0) && "font-medium")}>
            <span className="truncate">{titleOf(entry)}</span>
            {archived && <span className="text-muted-foreground shrink-0 text-[0.65rem]">{t("channels.archived")}</span>}
            {entry.visibility !== "public" && (
              <span className="text-muted-foreground shrink-0 text-[0.65rem]">{t(entry.visibility === "private" ? "channels.private" : "channels.group")}</span>
            )}
          </span>
          {secondary && <span className="text-muted-foreground block truncate text-xs">{secondary}</span>}
        </span>
        {mentions > 0 ? (
          <span className="depth-primary text-primary-foreground rounded-full px-1.5 py-0.5 text-[0.65rem] font-medium" aria-label={t("channels.mentionsUnread", { count: mentions })}>
            {formatUnreadBadge(mentions)}
          </span>
        ) : unread > 0 ? (
          <span className="bg-muted text-foreground rounded-full px-1.5 py-0.5 text-[0.65rem] font-medium" aria-label={t("channels.unread", { count: unread })}>
            {formatUnreadBadge(unread)}
          </span>
        ) : null}
      </button>
      {action}
    </div>
  );
}
