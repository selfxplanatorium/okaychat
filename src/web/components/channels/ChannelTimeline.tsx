import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDownIcon, MessagesSquareIcon } from "lucide-react";
import type { ChannelMessage, ChannelSummary } from "@shared/channels";
import { t } from "@/i18n";
import { formatDate } from "@/i18n/format";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ChannelMessageRow, type MessageActions } from "./ChannelMessageRow";

const RENDER_LIMIT = 100;

export function ChannelTimeline({
  room,
  messages,
  nextBeforeSeq,
  meId,
  focusedId,
  activeThreadId = null,
  title,
  actions,
  onFocus,
  onLoadOlder,
  onSeen,
}: {
  room: ChannelSummary;
  messages: ChannelMessage[];
  nextBeforeSeq: number | null;
  meId: string | null;
  focusedId: string | null;
  activeThreadId?: string | null;
  title: string;
  actions: MessageActions;
  onFocus: (id: string) => void;
  onLoadOlder: () => void;
  onSeen: (seq: number) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const lastSeq = useRef(0);

  const focusIndex = focusedId ? messages.findIndex((message) => message.id === focusedId) : -1;
  const visible =
    focusIndex >= 0 && focusIndex < messages.length - RENDER_LIMIT
      ? messages.slice(Math.max(0, focusIndex - 20), focusIndex + RENDER_LIMIT - 20)
      : messages.length > RENDER_LIMIT
        ? messages.slice(-RENDER_LIMIT)
        : messages;

  useLayoutEffect(() => {
    if (!messages.length) return;
    const seq = messages.at(-1)!.seq;
    if (seq > lastSeq.current && lastSeq.current !== 0) {
      if (atBottom) bottomRef.current?.scrollIntoView({ block: "end" });
      else setNewCount((count) => count + messages.filter((message) => message.seq > lastSeq.current).length);
    }
    lastSeq.current = seq;
  }, [messages, atBottom]);

  useEffect(() => {
    if (!messages.length) return;
    lastSeq.current = messages.at(-1)!.seq;
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [room.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // The room cursor advances only to the newest sequence actually on screen at the bottom, never from
  // SSE delivery or merely opening an older anchor. The store also refuses a non-increasing cursor.
  useEffect(() => {
    const report = () => {
      if (document.visibilityState !== "visible" || !atBottom || !visible.length) return;
      onSeen(visible.at(-1)!.seq);
    };
    report();
    document.addEventListener("visibilitychange", report);
    return () => document.removeEventListener("visibilitychange", report);
  }, [atBottom, visible, onSeen]);

  const jumpToLatest = () => {
    bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
    setNewCount(0);
    setAtBottom(true);
  };

  return (
    <div
      ref={scroller}
      role="log"
      aria-live="polite"
      aria-label={title}
      className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
      onScroll={(event) => {
        const element = event.currentTarget;
        const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= 80;
        setAtBottom(nearBottom);
        if (nearBottom) setNewCount(0);
      }}
    >
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-0.5 px-1 py-3 sm:px-3">
        {(nextBeforeSeq !== null || messages.length > RENDER_LIMIT) && (
          <div className="flex justify-center py-1">
            <Button type="button" size="sm" variant="ghost" onClick={onLoadOlder}>
              {t("channels.loadOlder")}
            </Button>
          </div>
        )}
        {!messages.length ? (
          <div className="text-muted-foreground grid place-items-center gap-2 py-16 text-center text-sm">
            <MessagesSquareIcon aria-hidden className="size-7 opacity-50" />
            <p>{t("channels.emptyRoom")}</p>
          </div>
        ) : (
          visible.map((message, index) => {
            const previous = visible[index - 1];
            const day = new Date(message.createdAt).toDateString();
            const previousDay = previous ? new Date(previous.createdAt).toDateString() : null;
            return (
              <div key={message.id} className="contents">
                {day !== previousDay && (
                  <div role="separator" className="text-muted-foreground my-3 flex items-center gap-2 text-[0.7rem]">
                    <span className="bg-border h-px flex-1" />
                    <span>{formatDate(message.createdAt, { month: "short", day: "numeric", year: "numeric" })}</span>
                    <span className="bg-border h-px flex-1" />
                  </div>
                )}
                <ChannelMessageRow
                  message={message}
                  room={room}
                  meId={meId}
                  focused={focusedId === message.id}
                  actions={actions}
                  onFocus={() => onFocus(message.id)}
                  threadOpen={activeThreadId === message.id}
                />
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>
      {newCount > 0 && (
        <div className="pointer-events-none sticky inset-x-0 bottom-3 flex justify-center">
          <Button type="button" size="sm" className="pointer-events-auto" onClick={jumpToLatest}>
            <ArrowDownIcon aria-hidden /> {t("channels.newMessages", { count: newCount })}
          </Button>
        </div>
      )}
      {!atBottom && newCount === 0 && (
        <div className="pointer-events-none sticky inset-x-0 bottom-3 flex justify-center">
          <Button type="button" size="icon-sm" variant="outline" className="pointer-events-auto" aria-label={t("channels.markRead")} onClick={jumpToLatest}>
            <ArrowDownIcon aria-hidden />
          </Button>
        </div>
      )}
      <span className={cn("sr-only")}>{room.archivedAt ? t("channels.archivedReadOnly") : ""}</span>
    </div>
  );
}
