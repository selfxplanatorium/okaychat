import { useState } from "react";
import { ArchiveIcon, CheckIcon, CompassIcon, MailIcon, PlusIcon, SearchIcon, UsersIcon, XIcon } from "lucide-react";
import type { ChannelDirectoryEntry, ChannelInviteSummary, ChannelSummary } from "@shared/channels";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { dmTitle, dmsOf, roomsOf } from "@/state/channels-derive";
import { ChannelRow } from "./ChannelRow";

export type ChannelListMode = "joined" | "dm" | "discover" | "invitations";

export function ChannelList({
  joined,
  discover,
  invites,
  mode,
  onMode,
  selectedId,
  meId,
  onSelect,
  onDiscoverQuery,
  onJoin,
  onAccept,
  onDecline,
  onCreate,
  onNewDm,
  onLoadMore,
  hasMore,
}: {
  joined: ChannelSummary[];
  discover: ChannelDirectoryEntry[];
  invites: ChannelInviteSummary[];
  mode: ChannelListMode;
  onMode: (mode: ChannelListMode) => void;
  selectedId: string | null;
  meId: string | null;
  onSelect: (id: string) => void;
  onDiscoverQuery: (query: string) => void;
  onJoin: (id: string) => void;
  onAccept: (id: string) => void;
  onDecline: (id: string) => void;
  onCreate: () => void;
  onNewDm: () => void;
  onLoadMore: () => void;
  hasMore: boolean;
}) {
  const [query, setQuery] = useState("");
  const [archivedOnly, setArchivedOnly] = useState(false);
  // Archived is a view of the joined rooms, not a scope of its own, so it selects like the other tabs.
  const rooms = roomsOf(joined).filter((room) => (archivedOnly ? room.archivedAt !== null : room.archivedAt === null));
  const dms = dmsOf(joined).filter((room) => (archivedOnly ? room.archivedAt !== null : room.archivedAt === null));
  const select = (tab: ChannelListMode | "archived") => {
    if (tab === "archived") {
      onMode("joined");
      setArchivedOnly(true);
      return;
    }
    onMode(tab);
    setArchivedOnly(false);
  };
  const tabs = [
    ["joined", "channels.joined", CompassIcon],
    ["dm", "channels.directMessages", UsersIcon],
    ["discover", "channels.discover", SearchIcon],
    ["invitations", "channels.invites", MailIcon],
    ["archived", "channels.archived", ArchiveIcon],
  ] as const;
  const active = (tab: (typeof tabs)[number][0]) =>
    tab === "archived" ? mode === "joined" && archivedOnly : mode === tab && !(tab === "joined" && archivedOnly);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 px-2 pt-2">
        <Button type="button" size="sm" className="flex-1" onClick={onCreate}>
          <PlusIcon aria-hidden /> {t("channels.create")}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onNewDm} aria-label={t("channels.newDm")}>
          <UsersIcon aria-hidden /> {t("channels.newDm")}
        </Button>
      </div>
      <div role="tablist" aria-label={t("channels.title")} className="grid grid-cols-2 gap-0.5 px-2 pt-2">
        {tabs.map(([tab, label, Icon]) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={active(tab)}
            onClick={() => select(tab)}
            className={cn(
              "text-muted-foreground hover:bg-muted flex min-w-0 items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-xs transition-colors",
              active(tab) && "bg-muted text-foreground font-medium",
            )}
          >
            <Icon aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">{t(label)}</span>
            {tab === "invitations" && invites.length > 0 && <span className="bg-primary text-primary-foreground rounded-full px-1 text-[0.6rem]">{invites.length}</span>}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {mode === "joined" && (
          rooms.length ? rooms.map((room) => (
            <ChannelRow
              key={room.id}
              entry={room}
              selected={selectedId === room.id}
              onSelect={() => onSelect(room.id)}
              secondary={room.description || undefined}
            />
          )) : <p className="text-muted-foreground px-2 py-6 text-sm">{t(archivedOnly ? "channels.emptyArchived" : "channels.emptyRooms")}</p>
        )}
        {mode === "dm" && (
          dms.length ? dms.map((room) => (
            <ChannelRow
              key={room.id}
              entry={room}
              title={dmTitle(room, meId)}
              selected={selectedId === room.id}
              onSelect={() => onSelect(room.id)}
            />
          )) : <p className="text-muted-foreground px-2 py-6 text-sm">{t("channels.emptyDms")}</p>
        )}
        {mode === "discover" && (
          <>
            <div className="px-1 pb-2">
              <Input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  onDiscoverQuery(event.target.value);
                }}
                placeholder={t("channels.search")}
                aria-label={t("channels.search")}
              />
            </div>
            {discover.length ? discover.map((room) => (
              <ChannelRow
                key={room.id}
                entry={room}
                onSelect={() => onJoin(room.id)}
                secondary={room.description || undefined}
                action={
                  <Button type="button" size="xs" variant="outline" onClick={() => onJoin(room.id)} className="me-1">
                    {t("channels.join")}
                  </Button>
                }
              />
            )) : <p className="text-muted-foreground px-2 py-6 text-sm">{t("channels.emptyDiscover")}</p>}
            {hasMore && (
              <div className="flex justify-center py-2">
                <Button type="button" size="sm" variant="ghost" onClick={onLoadMore}>{t("channels.loadOlder")}</Button>
              </div>
            )}
          </>
        )}
        {mode === "invitations" && (
          invites.length ? invites.map((invite) => (
            <div key={invite.channelId} className="border-border bg-muted/20 mb-1 rounded-lg border p-2">
              <ChannelRow entry={invite} secondary={invite.description || undefined} />
              <div className="mt-1 flex justify-end gap-1">
                <Button type="button" size="xs" variant="ghost" onClick={() => onDecline(invite.channelId)}>
                  <XIcon aria-hidden /> {t("channels.decline")}
                </Button>
                <Button type="button" size="xs" onClick={() => onAccept(invite.channelId)}>
                  <CheckIcon aria-hidden /> {t("channels.accept")}
                </Button>
              </div>
            </div>
          )) : <p className="text-muted-foreground px-2 py-6 text-sm">{t("channels.emptyInvites")}</p>
        )}
      </div>
    </div>
  );
}
