import { MessagesSquareIcon } from "lucide-react";
import type { ChannelMessage } from "@shared/channels";
import { t } from "@/i18n";
import { formatRelativeTime } from "@/i18n/format";
import { threadLabel } from "@/state/channels-derive";
import { cn } from "@/lib/utils";

const PANEL_ID = "channel-thread-panel";

/** The reply chip under a root, and the small jump link under a reply. Both are real buttons. */
export function ChannelThreadChip({
  message,
  expanded,
  onOpen,
}: {
  message: ChannelMessage;
  expanded: boolean;
  onOpen: (rootId: string, focusId?: string) => void;
}) {
  if (message.threadRootId) {
    return (
      <button
        type="button"
        onClick={() => onOpen(message.threadRootId!, message.id)}
        className="text-muted-foreground hover:text-foreground mt-1 inline-flex items-center gap-1 rounded text-xs underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <MessagesSquareIcon aria-hidden className="size-3" />
        {t("channels.threadShowInRoom")}
      </button>
    );
  }
  const label = threadLabel(message.thread);
  if (label === "none") return null;
  const thread = message.thread!;
  return (
    <button
      type="button"
      onClick={() => onOpen(message.id)}
      aria-expanded={expanded}
      aria-controls={PANEL_ID}
      className={cn(
        "mt-1 inline-flex max-w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        label === "unread" ? "depth-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <MessagesSquareIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">
        {label === "unread"
          ? t("channels.threadUnread", { count: thread.unread })
          : t("channels.threadReplies", { count: thread.replyCount })}
      </span>
      <span className="shrink-0 opacity-80">· {t("channels.threadLastReply", { time: formatRelativeTime(thread.lastReplyAt) })}</span>
    </button>
  );
}
