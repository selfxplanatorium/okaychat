import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftIcon, LoaderCircleIcon, ShieldAlertIcon } from "lucide-react";
import { useLocation, useSearch } from "wouter";
import { generateId } from "ai";
import type { ChannelDirectoryEntry, ChannelInviteSummary, ChannelMessage, ChannelSummary } from "@shared/channels";
import { t } from "@/i18n";
import { useData } from "@/state/data";
import { useChannels } from "@/state/channels";
import { channelsApi } from "@/state/channels-api";
import { useCommand } from "@/keyboard/registry";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { channelError } from "@/lib/channel-error";
import { nextUnreadAfter } from "@/state/channels-derive";
import { Button } from "@/components/ui/button";
import { ChannelList, type ChannelListMode } from "./ChannelList";
import { ChannelHeader } from "./ChannelHeader";
import { ChannelTimeline } from "./ChannelTimeline";
import { ChannelComposer } from "./ChannelComposer";
import { ChannelSearch } from "./ChannelSearch";
import { ChannelMemberPanel } from "./ChannelMemberPanel";
import { ChannelSettingsDialog } from "./ChannelSettingsDialog";
import { CreateChannelDialog } from "./CreateChannelDialog";
import { ChannelJoinDialog } from "./ChannelJoinDialog";
import type { MessageActions } from "./ChannelMessageRow";

// A stable empty list: a fresh `[]` from a selector re-renders forever (React error 185).
const NO_MESSAGES: never[] = [];

export function ChannelsPage({ channelId }: { channelId?: string }) {
  const me = useData((state) => state.me);
  const [, navigate] = useLocation();
  const search = useSearch();
  const invitedId = new URLSearchParams(search).get("invite");
  const messageId = new URLSearchParams(search).get("message");
  const joined = useChannels((state) => state.joined);
  const discover = useChannels((state) => state.discover);
  const invites = useChannels((state) => state.invites);
  const discoverCursor = useChannels((state) => state.discoverCursor);
  const connection = useChannels((state) => state.connection);
  const lastSync = useChannels((state) => state.lastSync);
  const disabled = useChannels((state) => state.disabled);
  const error = useChannels((state) => state.error);
  const sending = useChannels((state) => state.sending);
  const roomStatus = useChannels((state) => state.roomStatus);
  const roomView = useChannels((state) => state.room);
  const activeRoomId = useChannels((state) => state.activeRoomId);
  const messages = useChannels((state) => (state.activeRoomId ? state.messages[state.activeRoomId] ?? NO_MESSAGES : NO_MESSAGES));
  const pages = useChannels((state) => (state.activeRoomId ? state.pages[state.activeRoomId] : undefined));
  const members = useChannels((state) => state.members);
  const drafts = useChannels((state) => state.drafts);
  const replyTo = useChannels((state) => state.replyTo);
  const aiArmed = useChannels((state) => state.aiArmed);
  const [mode, setMode] = useState<ChannelListMode>("joined");
  const [createOpen, setCreateOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [joinTarget, setJoinTarget] = useState<ChannelDirectoryEntry | ChannelInviteSummary | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const { copyToClipboard } = useCopyToClipboard();

  const room = roomView && "membership" in roomView ? (roomView as ChannelSummary) : null;
  const directory = roomView && !("membership" in roomView) ? (roomView as ChannelDirectoryEntry) : null;
  const meId = me?.id ?? null;

  useEffect(() => {
    if (me) void useChannels.getState().start(me.id);
  }, [me]);

  useEffect(() => {
    if (channelId) void useChannels.getState().selectRoom(channelId);
  }, [channelId]);

  useEffect(() => {
    if (mode === "discover" && !discover.length) void useChannels.getState().loadDiscover("");
  }, [mode, discover.length]);

  useEffect(() => {
    if (!messageId || !room) return;
    void jump(messageId);
    // The query is an entry hint, not a permanent selection.
    navigate(`/channels/${room.id}`, { replace: true });
  }, [messageId, room?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (directory && !joinTarget) setJoinTarget(directory);
  }, [directory, joinTarget]);

  useEffect(() => {
    if (invitedId) setMode("invitations");
  }, [invitedId]);

  const navigateRoom = useCallback((id: string) => navigate(`/channels/${id}`), [navigate]);
  const back = useCallback(() => navigate("/channels"), [navigate]);

  const loadSync = useCallback(() => void useChannels.getState().loadSync(), []);
  const markRead = useCallback(() => void useChannels.getState().markRead(), []);

  useCommand("nav.channels", () => navigate("/channels"), true);
  useCommand("channels.create", () => setCreateOpen(true));
  useCommand("channels.search", () => { if (room) setSearchOpen(true); });
  useCommand("channels.members", () => { if (room) setMembersOpen(true); });
  useCommand("channels.settings", () => { if (room && (room.capabilities.manage || room.capabilities.moderate)) setSettingsOpen(true); });
  useCommand("channels.markRead", markRead);
  useCommand("channels.nextUnread", () => {
    const next = nextUnreadAfter(joined, activeRoomId);
    if (next) navigateRoom(next.id);
  });
  useCommand("channels.focusComposer", () => document.getElementById("channel-composer")?.focus());
  useCommand("channels.reply", () => {
    const message = messages.find((item) => item.id === focusedId);
    if (message) useChannels.getState().setReply(message);
  });
  useCommand("channels.react", () => {
    if (focusedId) void useChannels.getState().react(focusedId, "👍", true);
  });
  useCommand("channels.askAi", () => {
    const message = messages.find((item) => item.id === focusedId);
    if (message && room) void askAi(message);
  });
  useCommand("channels.stopAi", () => {
    const running = messages.find((message) => message.aiRun && (message.aiRun.state === "queued" || message.aiRun.state === "running"));
    if (running?.aiRun && room) void useChannels.getState().cancelAi(running.aiRun.id);
  });

  const askAi = async (message: ChannelMessage) => {
    if (!room) return;
    try {
      await channelsApi.aiRun(room.id, generateId(), message.id);
      await useChannels.getState().loadHistory();
    } catch (cause) {
      useChannels.setState({ error: channelError(cause, "channels.aiFailed", { owner: room.ownerId === meId }) });
    }
  };

  const jump = async (messageId: string) => {
    if (!room) return;
    await useChannels.getState().jumpToMessage(messageId);
    setFocusedId(messageId);
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`)?.focus({ preventScroll: false });
    });
  };

  const focusSibling = (direction: 1 | -1) => {
    const rows = [...(grid.current?.querySelectorAll<HTMLElement>("[data-message-id]") ?? [])];
    if (!rows.length) return;
    const index = rows.findIndex((row) => row.dataset.messageId === focusedId);
    const next = rows[Math.min(rows.length - 1, Math.max(0, (index < 0 ? rows.length - 1 : index) + direction))];
    next?.focus();
  };

  const actions: MessageActions = {
    onReply: (message) => {
      if (!room?.capabilities.post) return;
      useChannels.getState().setReply(message);
      document.getElementById("channel-composer")?.focus();
    },
    onJumpToQuote: (messageId) => void jump(messageId),
    onEdit: (messageId, body, mentions) => useChannels.getState().edit(messageId, body, mentions),
    onDelete: (message) => void useChannels.getState().removeMessage(message.id),
    onReact: (messageId, emoji, add) => void useChannels.getState().react(messageId, emoji, add),
    onAskAi: (message) => void askAi(message),
    onStopAi: (message) => { if (message.aiRun) void useChannels.getState().cancelAi(message.aiRun.id); },
  };

  if (disabled) {
    return (
      <main className="grid min-h-0 flex-1 place-items-center p-6">
        <div role="status" className="text-muted-foreground flex max-w-md flex-col items-center gap-2 text-center text-sm">
          <ShieldAlertIcon aria-hidden className="size-8 opacity-60" />
          <p>{t("channels.disabled")}</p>
        </div>
      </main>
    );
  }

  const list = (
    <ChannelList
      joined={joined}
      discover={discover}
      invites={invites}
      mode={mode}
      onMode={setMode}
      selectedId={activeRoomId}
      onSelect={navigateRoom}
      onDiscoverQuery={(query) => void useChannels.getState().loadDiscover(query)}
      onJoin={(id) => {
        const entry = discover.find((item) => item.id === id);
        if (entry) setJoinTarget(entry);
        else void useChannels.getState().loadDiscover("").then(() => setJoinTarget(useChannels.getState().discover.find((item) => item.id === id) ?? null));
      }}
      onAccept={(id) => void useChannels.getState().accept(id).then(() => useChannels.getState().selectRoom(id))}
      onDecline={(id) => void useChannels.getState().decline(id)}
      onCreate={() => setCreateOpen(true)}
      onLoadMore={() => void useChannels.getState().loadDiscover(undefined, true)}
      hasMore={!!discoverCursor}
    />
  );

  const empty = (
    <div className="text-muted-foreground grid min-h-0 flex-1 place-items-center p-8 text-center text-sm">
      <p>{t("channels.selectRoom")}</p>
    </div>
  );

  const roomPane = room ? (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" ref={grid}
      onKeyDown={(event) => {
        if (event.defaultPrevented) return;
        const target = event.target as HTMLElement;
        if (target.closest("input, textarea, select, [contenteditable=true], [role=menu], [role=dialog]")) return;
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
          event.preventDefault();
          setSearchOpen(true);
        } else if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key === "j") {
          event.preventDefault();
          focusSibling(1);
        } else if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key === "k") {
          event.preventDefault();
          focusSibling(-1);
        } else if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key === "r") {
          const message = messages.find((item) => item.id === focusedId);
          if (message) {
            event.preventDefault();
            actions.onReply(message);
          }
        }
      }}
    >
      <ChannelHeader
        room={room}
        connection={connection}
        lastSync={lastSync}
        onBack={back}
        onSearch={() => setSearchOpen(true)}
        onMembers={() => setMembersOpen(true)}
        onSettings={() => setSettingsOpen(true)}
        onRetry={loadSync}
        onNotify={(modeValue) => void useChannels.getState().setNotify(modeValue)}
      />
      {room.archivedAt !== null && (
        <p role="status" className="border-border bg-muted/40 text-muted-foreground border-b px-3 py-1.5 text-xs">{t("channels.archivedReadOnly")}</p>
      )}
      {error && (
        <div role="alert" className="border-border bg-destructive/5 flex flex-wrap items-center gap-2 border-b px-3 py-1.5 text-xs">
          <span className="text-destructive min-w-0 flex-1 break-words">{error}</span>
          <Button type="button" size="xs" variant="outline" onClick={loadSync}>{t("channels.reload")}</Button>
          <Button type="button" size="xs" variant="ghost" onClick={() => copyToClipboard(drafts[room.id] ?? "")}>{t("channels.copyLocal")}</Button>
        </div>
      )}
      <ChannelTimeline
        room={room}
        messages={messages}
        nextBeforeSeq={pages?.nextBeforeSeq ?? null}
        meId={meId}
        focusedId={focusedId}
        actions={actions}
        onFocus={setFocusedId}
        onLoadOlder={() => void useChannels.getState().loadHistory(pages?.nextBeforeSeq ?? undefined)}
        onSeen={(seq) => void useChannels.getState().markRead(seq)}
      />
      <ChannelComposer
        room={room}
        members={members}
        draft={drafts[room.id] ?? ""}
        reply={replyTo[room.id] ?? null}
        aiArmed={aiArmed[room.id] === true}
        sending={sending}
        onDraftChange={(text) => useChannels.getState().setDraft(text)}
        onSend={(body, mentions) => void useChannels.getState().send({ body, mentions, requestAi: aiArmed[room.id] === true })}
        onCancelReply={() => useChannels.getState().setReply(null)}
        onAiToggle={() => useChannels.getState().setAiArmed(aiArmed[room.id] !== true)}
      />
      <ChannelSearch open={searchOpen} channelId={room.id} onOpenChange={setSearchOpen} onJump={(id) => void jump(id)} />
      <ChannelMemberPanel
        open={membersOpen}
        room={room}
        members={members}
        meId={meId}
        onOpenChange={setMembersOpen}
        onInvite={(userIds) => useChannels.getState().invite(userIds)}
        onRemove={(userId) => useChannels.getState().removeMember(userId)}
        onRole={(userId, role) => useChannels.getState().setRole(userId, role)}
        onTransfer={(userId) => useChannels.getState().transfer(userId)}
      />
      <ChannelSettingsDialog
        open={settingsOpen}
        room={room}
        onOpenChange={setSettingsOpen}
        onSave={(input) => useChannels.getState().update(input)}
        onArchive={(archived) => useChannels.getState().archive(archived)}
        onDelete={(revision) => useChannels.getState().removeRoom(revision)}
        onLeave={() => useChannels.getState().leave()}
      />
    </div>
  ) : roomStatus === "loading" ? (
    <div role="status" className="text-muted-foreground grid min-h-0 flex-1 place-items-center gap-2 text-sm">
      <LoaderCircleIcon aria-hidden className="size-5 animate-spin" />
      {t("common.loading")}
    </div>
  ) : roomStatus === "notFound" ? (
    <div className="grid min-h-0 flex-1 place-items-center p-8 text-center">
      <div className="flex flex-col items-center gap-3 text-sm">
        <p>{t("channels.notFound")}</p>
        <Button type="button" variant="outline" onClick={back}><ArrowLeftIcon aria-hidden /> {t("channels.back")}</Button>
      </div>
    </div>
  ) : empty;

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <aside className="border-border hidden w-60 min-w-[200px] max-w-[320px] shrink-0 flex-col border-e md:flex">
        <div className="flex h-12 shrink-0 items-center px-3 text-sm font-semibold">{t("channels.title")}</div>
        {list}
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        {!channelId ? (
          <>
            <div className="flex min-h-0 flex-1 flex-col md:hidden"><div className="flex h-12 shrink-0 items-center px-3 text-sm font-semibold">{t("channels.title")}</div>{list}</div>
            <div className="hidden min-h-0 flex-1 md:flex">{empty}</div>
          </>
        ) : roomPane}
      </section>
      <CreateChannelDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={async (input) => {
          const id = await useChannels.getState().create(input);
          if (id) navigateRoom(id);
          return id;
        }}
      />
      <ChannelJoinDialog
        entry={joinTarget}
        onOpenChange={(open) => { if (!open) { setJoinTarget(null); if (directory) back(); } }}
        onJoin={async (id) => {
          await useChannels.getState().join(id);
          setJoinTarget(null);
          navigateRoom(id);
        }}
        onAccept={async (id) => {
          await useChannels.getState().accept(id);
          setJoinTarget(null);
          navigateRoom(id);
        }}
      />
    </div>
  );
}
