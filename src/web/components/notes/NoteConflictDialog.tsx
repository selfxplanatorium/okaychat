import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";

/** Conflict recovery: compare plain text, then reload, save a copy, or copy locally. Never auto-merges. */
export function NoteConflictDialog({
  open,
  local,
  server,
  onClose,
  onReload,
  onSaveCopy,
  onCopy,
}: {
  open: boolean;
  local: string;
  server: string;
  onClose: () => void;
  onReload: () => void;
  onSaveCopy: () => void;
  onCopy: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex max-h-[min(90dvh,44rem)] flex-col gap-4 sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="text-base">{t("notes.conflict")}</DialogTitle>
          <DialogDescription>{t("notes.compare")}</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 flex-1 gap-3 overflow-hidden sm:grid-cols-2">
          <section className="flex min-h-0 flex-col gap-1">
            <h3 className="text-sm font-medium">{t("notes.localVersion")}</h3>
            <pre className="bg-muted/40 min-h-32 overflow-auto rounded-lg p-3 text-xs whitespace-pre-wrap">{local}</pre>
          </section>
          <section className="flex min-h-0 flex-col gap-1">
            <h3 className="text-sm font-medium">{t("notes.serverVersion")}</h3>
            <pre className="bg-muted/40 min-h-32 overflow-auto rounded-lg p-3 text-xs whitespace-pre-wrap">{server}</pre>
          </section>
        </div>
        <DialogFooter className="flex-wrap">
          <Button variant="outline" onClick={onCopy}>{t("notes.copyLocal")}</Button>
          <Button variant="outline" onClick={onSaveCopy}>{t("notes.saveCopy")}</Button>
          <Button onClick={onReload}>{t("notes.reloadServer")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
