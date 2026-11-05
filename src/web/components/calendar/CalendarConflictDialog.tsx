import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";

export function CalendarConflictDialog({
  open,
  onClose,
  onReload,
  onSaveCopy,
  onCopy,
}: {
  open: boolean;
  onClose: () => void;
  onReload: () => void;
  onSaveCopy: () => void;
  onCopy: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="text-base">{t("calendar.conflict")}</DialogTitle>
          <DialogDescription>{t("calendar.conflict")}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-wrap">
          <Button variant="outline" onClick={onCopy}>{t("calendar.copyLocal")}</Button>
          <Button variant="outline" onClick={onSaveCopy}>{t("calendar.saveCopy")}</Button>
          <Button onClick={onReload}>{t("calendar.reloadServer")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
