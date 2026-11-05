import { useEffect, useRef, useState } from "react";
import type { ChannelMemberSummary } from "@shared/channels";
import { EMPTY_CHANNEL_TYPING, useChannelActivity } from "@/state/channel-activity";
import { useData } from "@/state/data";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";
import { cn } from "@/lib/utils";

/**
 * One reserved line above a composer. It is outside message history so it never becomes a message,
 * unread dot, read cursor, toast, sound, focus target, or autoscroll trigger. The visible line is
 * truncated on small screens; the separate polite region keeps the full sentence.
 */

function typingText(userIds: readonly string[], names: ReadonlyMap<string, string>): string | null {
  if (!userIds.length) return null;
  if (userIds.length === 1) {
    const name = names.get(userIds[0]!);
    return name ? t("channels.typingOne", { name }) : t("channels.typingMany", { count: userIds.length });
  }
  if (userIds.length === 2) {
    const first = names.get(userIds[0]!);
    const second = names.get(userIds[1]!);
    if (first && second) return t("channels.typingTwo", { names: formatList([first, second]) });
  }
  return t("channels.typingMany", { count: userIds.length });
}

export function ChannelTypingIndicator({
  channelId,
  rootId,
  members,
  announce = true,
  className,
}: {
  channelId: string;
  rootId: string | null;
  members: ChannelMemberSummary[];
  /** False for the room pane hidden behind a mobile thread sheet. */
  announce?: boolean;
  className?: string;
}) {
  const meId = useData((state) => state.me?.id ?? null);
  const key = rootId ?? "";
  const typing = useChannelActivity((state) => state.typing[key] ?? EMPTY_CHANNEL_TYPING);
  const watchedChannel = useChannelActivity((state) => state.channelId);
  const watchedRoot = useChannelActivity((state) => state.rootId);
  // A line only describes the scope this connection watches. The room line is null-root typing.
  const scoped = watchedChannel === channelId && (watchedRoot ?? null) === rootId ? typing : EMPTY_CHANNEL_TYPING;
  const others = meId ? scoped.filter((id) => id !== meId) : scoped;
  const names = new Map(members.map((member) => [member.id, member.name]));
  const text = typingText(others, names);
  const signature = `${channelId}\u0000${key}\u0000${others.join(",")}`;

  const [announcement, setAnnouncement] = useState("");
  const lastAnnounced = useRef<string | null>(null);
  const lastAnnouncedAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (!announce || !text) return;
    if (lastAnnounced.current === signature) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    const wait = Math.max(500, lastAnnouncedAt.current + 5_000 - Date.now());
    timer.current = setTimeout(() => {
      timer.current = null;
      if (lastAnnounced.current === signature) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      lastAnnounced.current = signature;
      lastAnnouncedAt.current = Date.now();
      setAnnouncement(text);
    }, wait);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [announce, signature, text]);

  return (
    <div className={cn("flex h-5 items-center px-4", className)}>
      <p aria-hidden className="text-muted-foreground min-w-0 truncate text-[0.7rem] leading-5">
        {text ?? ""}
      </p>
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </span>
    </div>
  );
}
