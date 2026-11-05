import { useEffect, useState } from "react";
import type { CreateApiKeyResult } from "@shared/api-access";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { t } from "@/i18n";

/**
 * The only place a complete token ever exists in the browser. It is held in this component's props
 * (from the create response) and discarded when the dialog closes; it is never stored, cached, or
 * inserted into the documentation snippets.
 */
export function ApiKeyCreatedDialog({ result, onClose }: { result: CreateApiKeyResult | null; onClose: () => void }) {
  const { copyToClipboard } = useCopyToClipboard();
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    setStatus("idle");
  }, [result]);

  if (!result) return null;

  const copy = async () => {
    if (!navigator.clipboard) {
      setStatus("failed");
      copyToClipboard(result.secret);
      return;
    }
    try {
      await navigator.clipboard.writeText(result.secret);
      setStatus("copied");
    } catch {
      // The selectable field stays visible for a manual copy.
      setStatus("failed");
      copyToClipboard(result.secret);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent aria-describedby="api-key-secret-note">
        <DialogHeader>
          <DialogTitle>{t("apiAccess.createdTitle")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <label htmlFor="api-key-secret" className="text-sm font-medium">{t("apiAccess.secretLabel")}</label>
          <input
            id="api-key-secret"
            data-no-drawer-swipe
            readOnly
            value={result.secret}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            className="bg-muted/60 depth-field w-full min-w-0 overflow-x-auto rounded-lg border border-transparent px-3 py-2 font-mono text-xs whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            onFocus={(event) => event.currentTarget.select()}
          />
          <p id="api-key-secret-note" className="text-destructive text-sm font-medium">{t("apiAccess.secretOnce")}</p>
          <p className="text-muted-foreground text-xs">{t("apiAccess.recovery")}</p>
          <div aria-live="polite" aria-atomic="true" className="min-h-5 text-sm">
            {status === "copied" && <p className="text-success">{t("apiAccess.copied")}</p>}
            {status === "failed" && <p className="text-destructive">{t("apiAccess.copyFailed")}</p>}
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" className="pointer-coarse:h-11" onClick={() => void copy()} data-command="apiAccess.copy">
            {t("apiAccess.copy")}
          </Button>
          <Button type="button" className="pointer-coarse:h-11" onClick={onClose} data-command="apiAccess.done">{t("apiAccess.done")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
