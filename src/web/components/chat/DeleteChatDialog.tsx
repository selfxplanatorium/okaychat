import { Loader2Icon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

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
      setError(cause instanceof Error ? cause.message : count > 1 ? "Could not delete the chats." : "Could not delete the chat.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && (setError(null), onOpenChange(next))}>
      <DialogContent showCloseButton={false} className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base">{count > 1 ? `Delete ${count} chats permanently?` : "Delete this chat permanently?"}</DialogTitle>
          <DialogDescription>
            {count > 1 ? "These chats and their messages" : `“${title || "New chat"}” and its messages`} are removed for good. Uploaded files stay in the Library.
          </DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
        <DialogFooter>
          <DialogClose disabled={busy} render={<Button variant="outline" />}>
            Cancel
          </DialogClose>
          <Button variant="destructive" disabled={busy} onClick={() => void confirm()}>
            {busy && <Loader2Icon className="animate-spin" />} {count > 1 ? `Delete ${count}` : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
