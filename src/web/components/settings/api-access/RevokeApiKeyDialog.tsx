import { useState } from "react";
import type { ApiKeySummary } from "@shared/api-access";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { errorText } from "@/lib/error-text";

export function RevokeApiKeyDialog({
  keyToRevoke,
  onOpenChange,
  onRevoke,
}: {
  keyToRevoke: ApiKeySummary | null;
  onOpenChange: (open: boolean) => void;
  onRevoke: (key: ApiKeySummary) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!keyToRevoke) return null;

  const revoke = async () => {
    setBusy(true);
    setError(null);
    try {
      await onRevoke(keyToRevoke);
      onOpenChange(false);
    } catch (cause) {
      setError(errorText(cause, "apiAccess.revokeFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!busy) onOpenChange(open); }}>
      <DialogContent aria-describedby="api-key-revoke-description">
        <DialogHeader>
          <DialogTitle>{t("apiAccess.revokeTitle", { label: keyToRevoke.label })}</DialogTitle>
        </DialogHeader>
        <p id="api-key-revoke-description" className="text-muted-foreground text-sm">
          {t("apiAccess.revokeDescription", { prefix: keyToRevoke.prefix })}
        </p>
        <div aria-live="polite" aria-atomic="true" className="min-h-5">
          {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" className="pointer-coarse:h-11" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button type="button" variant="destructive" className="pointer-coarse:h-11" onClick={() => void revoke()} disabled={busy} data-command="apiAccess.revokeConfirm">
            {busy ? t("common.saving") : t("apiAccess.revoke")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
