import { useEffect, useState } from "react";
import { MoreHorizontalIcon, UserPlusIcon } from "lucide-react";
import type { ChannelMemberSummary, ChannelSummary } from "@shared/channels";
import { t } from "@/i18n";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { channelsApi } from "@/state/channels-api";

export function ChannelMemberPanel({
  open,
  room,
  members,
  meId,
  onOpenChange,
  onInvite,
  onRemove,
  onRole,
  onTransfer,
}: {
  open: boolean;
  room: ChannelSummary;
  members: ChannelMemberSummary[];
  meId: string | null;
  onOpenChange: (open: boolean) => void;
  onInvite: (userIds: string[]) => Promise<Array<{ id: string; name: string }>>;
  onRemove: (userId: string) => Promise<void>;
  onRole: (userId: string, role: "moderator" | "member") => Promise<void>;
  onTransfer: (userId: string) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [candidate, setCandidate] = useState<{ id: string; name: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Array<{ id: string; name: string }>>([]);
  const [excluded, setExcluded] = useState<Array<{ id: string; name: string }>>([]);
  const canModerate = room.capabilities.moderate;
  const canManage = room.capabilities.manage;

  const refreshLists = () => {
    if (!canModerate) return;
    void channelsApi.pendingInvites(room.id).then((result) => setPending(result.items)).catch(() => setPending([]));
    void channelsApi.exclusions(room.id).then((result) => setExcluded(result.items)).catch(() => setExcluded([]));
  };
  useEffect(() => {
    if (open) refreshLists();
  }, [open, room.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const lookup = async () => {
    setCandidate(null);
    setMessage(null);
    try {
      const result = await channelsApi.candidates(room.id, email.trim());
      if (!result.items.length) setMessage(t("channels.inviteNoMatch"));
      else setCandidate(result.items[0]!);
    } catch {
      setMessage(t("channels.inviteNoMatch"));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-0 right-0 left-auto h-full max-h-none w-[min(24rem,92vw)] translate-x-0 translate-y-0 grid-rows-[auto_1fr] rounded-none sm:rounded-s-xl">
        <DialogHeader>
          <DialogTitle>{t("channels.members")}</DialogTitle>
          <DialogDescription>{t("channels.memberCount", { count: room.memberCount })}</DialogDescription>
        </DialogHeader>
        {canModerate && (
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium" htmlFor="channel-invite-email">{t("channels.inviteEmail")}</label>
            <div className="flex gap-1">
              <Input id="channel-invite-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void lookup(); }} />
              <Button type="button" size="icon-sm" variant="outline" aria-label={t("channels.invite")} onClick={() => void lookup()}>
                <UserPlusIcon aria-hidden />
              </Button>
            </div>
            {message && <p className="text-muted-foreground text-xs">{message}</p>}
            {candidate && (
              <div className="flex items-center justify-between gap-2 rounded-lg border px-2 py-1.5 text-sm">
                <span className="truncate">{candidate.name}</span>
                <Button
                  type="button"
                  size="xs"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    await onInvite([candidate.id]);
                    setBusy(false);
                    setCandidate(null);
                    setEmail("");
                    setMessage(t("channels.invitePending"));
                    refreshLists();
                  }}
                >
                  {t("channels.invite")}
                </Button>
              </div>
            )}
            {pending.length > 0 && (
              <div className="flex flex-col gap-1">
                <p className="text-muted-foreground text-xs">{t("channels.invitePending")}</p>
                {pending.map((invite) => (
                  <div key={invite.id} className="flex items-center justify-between gap-2 rounded-lg border px-2 py-1 text-xs">
                    <span className="truncate">{invite.name}</span>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      onClick={async () => {
                        await channelsApi.revokeInvite(room.id, invite.id);
                        refreshLists();
                      }}
                    >
                      {t("channels.revokeInvite")}
                    </Button>
                  </div>
                ))}
              </div>
            )}
            {excluded.length > 0 && (
              <div className="flex flex-col gap-1">
                {excluded.map((entry) => (
                  <div key={entry.id} className="flex items-center justify-between gap-2 rounded-lg border px-2 py-1 text-xs">
                    <span className="truncate">{entry.name}</span>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      onClick={async () => {
                        await channelsApi.unblock(room.id, entry.id);
                        refreshLists();
                      }}
                    >
                      {t("channels.unblock")}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="min-h-0 overflow-y-auto">
          <ul className="flex flex-col gap-0.5">
            {members.map((member) => (
              <li key={member.id} className="hover:bg-muted/40 flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{member.name}</span>
                  <span className="text-muted-foreground block text-xs">{t(member.role === "owner" ? "channels.owner" : member.role === "moderator" ? "channels.moderator" : "channels.member")}</span>
                </span>
                {canModerate && member.role !== "owner" && member.id !== meId && (
                  <Menu>
                    <MenuTrigger aria-label={t("channels.member")} className="text-muted-foreground hover:bg-muted rounded-lg p-1.5">
                      <MoreHorizontalIcon aria-hidden className="size-4" />
                    </MenuTrigger>
                    <MenuContent side="bottom" align="end" className="w-52">
                      {canManage && (
                        <MenuItem onClick={() => void onRole(member.id, member.role === "moderator" ? "member" : "moderator")}>
                          {member.role === "moderator" ? t("channels.demote") : t("channels.promote")}
                        </MenuItem>
                      )}
                      {canManage && (
                        <MenuItem onClick={() => { if (window.confirm(t("channels.transfer"))) void onTransfer(member.id); }}>
                          {t("channels.transfer")}
                        </MenuItem>
                      )}
                      <MenuItem
                        className="text-destructive data-highlighted:bg-destructive/10"
                        onClick={() => { if (window.confirm(t("channels.removeMemberConfirm"))) void onRemove(member.id); }}
                      >
                        {t("channels.removeMember")}
                      </MenuItem>
                    </MenuContent>
                  </Menu>
                )}
              </li>
            ))}
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  );
}
