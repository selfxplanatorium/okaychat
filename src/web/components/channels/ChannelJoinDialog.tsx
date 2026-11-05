import type { ChannelDirectoryEntry, ChannelInviteSummary } from "@shared/channels";
import { t } from "@/i18n";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export function ChannelJoinDialog({
  entry,
  onOpenChange,
  onJoin,
  onAccept,
}: {
  entry: ChannelDirectoryEntry | ChannelInviteSummary | null;
  onOpenChange: (open: boolean) => void;
  onJoin: (id: string) => Promise<void>;
  onAccept: (id: string) => Promise<void>;
}) {
  const id = entry ? ("id" in entry ? entry.id : entry.channelId) : null;
  const invited = entry ? ("invited" in entry ? entry.invited : true) : false;
  return (
    <Dialog open={!!entry} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{entry?.name ?? t("channels.title")}</DialogTitle>
          <DialogDescription>
            {entry?.description || t("channels.joinDescription")}
          </DialogDescription>
        </DialogHeader>
        {entry && <p className="text-muted-foreground text-xs">{t(entry.visibility === "public" ? "channels.publicHelp" : entry.visibility === "private" ? "channels.privateHelp" : "channels.groupHelp")}</p>}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{t("channels.cancel")}</Button>
          {id && (
            <Button
              type="button"
              onClick={async () => {
                if (invited) await onAccept(id);
                else await onJoin(id);
              }}
            >
              {t(invited ? "channels.accept" : "channels.join")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
