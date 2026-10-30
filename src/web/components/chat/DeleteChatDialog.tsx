import { Loader2Icon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";

/** Confirms permanent deletion of one chat, or `count` chats. Stays open with the error when the delete fails. */
export function DeleteChatDialog({
  open,
  title,
  count = 1,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  title: string | null | undefined;
  count?: number;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t(count > 1 ? "composer.deleteChatsFailed" : "composer.deleteChatFailed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && (setError(null), onOpenChange(next))}>
      <DialogContent showCloseButton={false} className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base">{count > 1 ? t("composer.deleteChatsTitle", { count }) : t("composer.deleteChatTitle")}</DialogTitle>
          <DialogDescription>
            {count > 1 ? t("composer.deleteChatsBody") : t("composer.deleteChatBody", { title: title || t("common.newChat") })}
          </DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
        <DialogFooter>
          <DialogClose disabled={busy} render={<Button variant="outline" />}>
            {t("common.cancel")}
          </DialogClose>
          <Button variant="destructive" disabled={busy} onClick={() => void confirm()}>
            {busy && <Loader2Icon className="animate-spin" />} {count > 1 ? t("composer.deleteChats", { count }) : t("common.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
