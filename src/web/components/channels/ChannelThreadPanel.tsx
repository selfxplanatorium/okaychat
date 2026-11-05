import { useEffect, useRef, useState } from "react";
import { ArrowLeftIcon, LoaderCircleIcon, XIcon } from "lucide-react";
import type { ChannelMemberSummary, ChannelMessage, ChannelSummary } from "@shared/channels";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import { useChannels } from "@/state/channels";
import { newestSeq } from "@/state/channels-derive";
import { ChannelComposer } from "./ChannelComposer";
import { ChannelMessageRow, type MessageActions } from "./ChannelMessageRow";

const NO_ITEMS: ChannelMessage[] = [];

/**
 * One message's replies. A non-modal sheet on desktop and a full-width route-like panel on mobile; it
 * traps nothing, Escape closes it, and focus returns to the chip that opened it.
 */
export function ChannelThreadPanel({
  room,
  rootId,
  members,
  actions,
  onClose,
}: {
  room: ChannelSummary;
  rootId: string;
  members: ChannelMemberSummary[];
  actions: MessageActions;
  onClose: () => void;
}) {
  const thread = useChannels((state) => state.threads[rootId]);
  const status = useChannels((state) => state.threadStatus);
  const focusId = useChannels((state) => state.threadFocusId);
  const draft = useChannels((state) => state.drafts[`thread:${rootId}`] ?? "");
  const sending = useChannels((state) => state.sending);
  const items = thread?.items ?? NO_ITEMS;
  const scroller = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [reply, setReply] = useState<ChannelMessage | null>(null);

  useEffect(() => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    heading.current?.focus();
    return () => returnFocus.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!focusId) return;
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(focusId)}"]`)?.focus({ preventScroll: false });
    });
  }, [focusId, items.length]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [rootId]);

  // Only a visible panel parked at the newest reply advances the thread cursor.
  useEffect(() => {
    const report = () => {
      if (document.visibilityState !== "visible" || !atBottom || !items.length) return;
      void useChannels.getState().markThreadRead(rootId, newestSeq(items));
    };
    report();
    document.addEventListener("visibilitychange", report);
    return () => document.removeEventListener("visibilitychange", report);
  }, [atBottom, items, rootId]);

  const threadRoom = { ...room, capabilities: { ...room.capabilities, requestAi: false } };
  const panelActions: MessageActions = {
    ...actions,
    onReply: (message) => setReply(message),
    onReplyInThread: undefined,
    onOpenThread: undefined,
    onAskAi: () => {},
    onStopAi: () => {},
  };

  return (
    <aside
      id="channel-thread-panel"
      role="region"
      aria-label={t("channels.thread")}
      className="bg-background absolute inset-0 z-20 flex min-h-0 w-full flex-col border-s md:static md:z-auto md:w-[28rem] md:max-w-[28rem] md:shrink-0"
    >
      <header className="border-border flex shrink-0 items-center gap-2 border-b px-2 py-2">
        <Button type="button" size="icon-sm" variant="ghost" aria-label={t("channels.threadBackToRoom")} onClick={onClose} className="md:hidden">
          <ArrowLeftIcon aria-hidden />
        </Button>
        <h2 ref={heading} tabIndex={-1} className="min-w-0 flex-1 truncate text-sm font-semibold outline-none">
          {t("channels.thread")}
        </h2>
        <Button type="button" size="icon-sm" variant="ghost" aria-label={t("channels.threadClose")} onClick={onClose}>
          <XIcon aria-hidden />
        </Button>
      </header>
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        onScroll={(event) => {
          const element = event.currentTarget;
          setAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight <= 80);
        }}
      >
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-0.5 px-1 py-2 sm:px-3">
          {status === "loading" && !thread && (
            <div role="status" className="text-muted-foreground flex items-center justify-center gap-2 py-6 text-sm">
              <LoaderCircleIcon aria-hidden className="size-4 animate-spin" />
              {t("common.loading")}
            </div>
          )}
          {status === "error" && (
            <p role="alert" className="text-destructive py-4 text-center text-sm">{t("channels.notFound")}</p>
          )}
          {thread?.root && (
            <ChannelMessageRow
              message={thread.root}
              room={threadRoom}
              meId={useChannels.getState().accountId}
              focused={false}
              actions={panelActions}
              onFocus={() => {}}
              showThreadChip={false}
            />
          )}
          {thread?.root?.deletedAt && <p className="text-muted-foreground px-2 py-1 text-xs italic">{t("channels.threadRootDeleted")}</p>}
          {thread && (thread.hasMore || thread.nextBeforeSeq !== null) && (
            <div className="flex justify-center py-1">
              <Button type="button" size="sm" variant="ghost" onClick={() => thread && void useChannels.getState().loadThread(rootId, thread.nextBeforeSeq ?? undefined)}>
                {t("channels.loadOlder")}
              </Button>
            </div>
          )}
          {!items.length && status === "ready" && <p className="text-muted-foreground px-2 py-6 text-center text-sm">{t("channels.threadEmpty")}</p>}
          {items.map((message) => (
            <ChannelMessageRow
              key={message.id}
              message={message}
              room={threadRoom}
              meId={useChannels.getState().accountId}
              focused={focusId === message.id}
              actions={panelActions}
              onFocus={() => useChannels.getState().setThreadFocus(message.id)}
              showThreadChip
            />
          ))}
          <div ref={bottomRef} />
        </div>
      </div>
      <ChannelComposer
        room={threadRoom}
        members={members}
        composerKey={`thread:${rootId}`}
        draft={draft}
        reply={reply}
        aiArmed={false}
        sending={sending}
        showAi={false}
        threadMode
        onDraftChange={(text) => useChannels.setState((state) => ({ drafts: { ...state.drafts, [`thread:${rootId}`]: text } }))}
        onSend={(body, mentions) => {
          void useChannels.getState().sendToThread(rootId, { body, mentions, ...(reply ? { replyTo: reply.id } : {}) });
          setReply(null);
        }}
        onCancelReply={() => setReply(null)}
        onAiToggle={() => {}}
      />
    </aside>
  );
}
