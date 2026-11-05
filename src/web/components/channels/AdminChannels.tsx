import { useEffect, useState } from "react";
import { ArchiveIcon, EyeIcon, Trash2Icon } from "lucide-react";
import type { ChannelMessage } from "@shared/channels";
import { t } from "@/i18n";
import { formatDate } from "@/i18n/format";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { channelsApi } from "@/state/channels-api";

interface AdminRoom {
  id: string;
  name: string;
  visibility: string;
  archivedAt: number | null;
  ownerId: string;
  ownerName: string;
  memberCount: number;
  messageCount: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export function AdminChannels() {
  const [rooms, setRooms] = useState<AdminRoom[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inspect, setInspect] = useState<{ room: AdminRoom; reason: string; messages: ChannelMessage[]; nextBeforeSeq: number | null } | null>(null);
  const [reason, setReason] = useState("");
  const load = async (before?: string | null) => {
    try {
      const page = await channelsApi.adminList(before);
      setRooms((current) => (before && current ? [...current, ...page.items] : page.items));
      setCursor(page.nextCursor);
    } catch {
      setError(t("channels.notFound"));
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const openInspect = async (room: AdminRoom, why: string) => {
    if (!why.trim()) return;
    try {
      const page = await channelsApi.adminMessages(room.id, why);
      setInspect({ room, reason: why, messages: page.items, nextBeforeSeq: page.nextBeforeSeq });
      setReason("");
    } catch {
      setError(t("channels.notFound"));
    }
  };
  const moderate = async (room: AdminRoom, action: "archive" | "delete", why: string) => {
    if (!why.trim()) return;
    try {
      if (action === "archive") {
        const archived = room.archivedAt === null;
        await channelsApi.adminModerate(room.id, { action: "archive", archived, revision: room.revision, reason: why });
      } else {
        await channelsApi.adminRemove(room.id, room.revision, why);
      }
      await load();
      setInspect(null);
    } catch {
      setError(t("channels.revisionConflict"));
    }
  };
  return (
    <section className="border-border bg-card flex flex-col gap-3 rounded-xl border p-4 shadow-[var(--depth-highlight),var(--shadow-raised)]">
      <div>
        <h2 className="text-sm font-medium">{t("channels.adminTitle")}</h2>
        <p className="text-muted-foreground text-xs">{t("channels.adminDescription")}</p>

      </div>
      {error && <p role="alert" className="text-destructive text-xs">{error}</p>}
      {rooms === null ? (
        <p className="text-muted-foreground text-sm">{t("common.loading")}</p>
      ) : rooms.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("channels.adminNoRooms")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-start text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="px-2 py-1 text-start">{t("channels.name")}</th>
                <th className="px-2 py-1 text-start">{t("channels.owner")}</th>
                <th className="px-2 py-1 text-start">{t("channels.visibility")}</th>
                <th className="px-2 py-1 text-start">{t("channels.members")}</th>
                <th className="px-2 py-1 text-start">{t("channels.messages")}</th>
                <th className="px-2 py-1 text-start">{t("channels.updated")}</th>
                <th className="px-2 py-1" />
              </tr>
            </thead>
            <tbody>
              {rooms.map((room) => (
                <tr key={room.id} className="border-border border-t">
                  <td className="max-w-48 truncate px-2 py-1.5">{room.name}</td>
                  <td className="max-w-32 truncate px-2 py-1.5">{room.ownerName}</td>
                  <td className="px-2 py-1.5">{t(room.visibility === "private" ? "channels.private" : room.visibility === "group" ? "channels.group" : "channels.public")}</td>
                  <td className="px-2 py-1.5">{room.memberCount}</td>
                  <td className="px-2 py-1.5">{room.messageCount}</td>
                  <td className="px-2 py-1.5">{formatDate(room.updatedAt)}</td>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center justify-end gap-1">
                      <Button type="button" size="xs" variant="ghost" onClick={() => void openInspect(room, reason || t("channels.adminInspect"))}>
                        <EyeIcon aria-hidden /> {t("channels.adminInspect")}
                      </Button>
                      <Button type="button" size="xs" variant="ghost" onClick={() => void moderate(room, "archive", reason || t("channels.adminArchive"))}>
                        <ArchiveIcon aria-hidden />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-2 flex items-center gap-2">
            <Input value={reason} onChange={(event) => setReason(event.target.value)} placeholder={t("channels.adminReason")} aria-label={t("channels.adminReason")} className="max-w-sm" />
            {cursor && <Button type="button" size="sm" variant="ghost" onClick={() => void load(cursor)}>{t("channels.loadOlder")}</Button>}
          </div>
        </div>
      )}
      <Dialog open={!!inspect} onOpenChange={(open) => { if (!open) setInspect(null); }}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{inspect?.room.name}</DialogTitle>
            <DialogDescription>{t("channels.adminInspectHint")}</DialogDescription>
          </DialogHeader>
          {inspect && (
            <>
              <p className="text-muted-foreground text-xs">{t("channels.adminReason")}: {inspect.reason}</p>
              <ul className="flex flex-col gap-1">
                {inspect.messages.map((message) => (
                  <li key={message.id} className="border-border rounded-lg border p-2 text-sm">
                    <p className="text-muted-foreground text-xs">
                      #{message.seq} · {message.kind === "ai" ? message.aiLabel ?? t("channels.aiAsk") : message.author?.name ?? t("channels.deletedAccount")}
                    </p>
                    <p className="whitespace-pre-wrap break-words">{message.deletedAt ? t("channels.deletedMessage") : message.body}</p>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap justify-end gap-1">
                {inspect.nextBeforeSeq !== null && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={async () => {
                      const page = await channelsApi.adminMessages(inspect.room.id, inspect.reason, inspect.nextBeforeSeq ?? undefined);
                      setInspect({ ...inspect, messages: [...page.items, ...inspect.messages], nextBeforeSeq: page.nextBeforeSeq });
                    }}
                  >
                    {t("channels.loadOlder")}
                  </Button>
                )}
                <Button type="button" variant="outline" onClick={() => void moderate(inspect.room, "archive", inspect.reason)}>
                  {inspect.room.archivedAt === null ? t("channels.adminArchive") : t("channels.adminUnarchive")}
                </Button>
                <Button type="button" variant="destructive" onClick={() => { if (window.confirm(t("channels.deleteRoomConfirm"))) void moderate(inspect.room, "delete", inspect.reason); }}>
                  <Trash2Icon aria-hidden /> {t("channels.adminDelete")}
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
