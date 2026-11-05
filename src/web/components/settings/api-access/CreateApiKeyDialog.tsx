import { useEffect, useRef, useState } from "react";
import type { ApiScope, CreateApiKeyInput, CreateApiKeyResult } from "@shared/api-access";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { t } from "@/i18n";
import { formatDateTime } from "@/i18n/format";
import { errorText } from "@/lib/error-text";
import { cn } from "@/lib/utils";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Local time in a `datetime-local` value, without seconds. */
function localInputValue(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function CreateApiKeyDialog({
  open,
  serverTime,
  onOpenChange,
  onCreate,
  onCreated,
}: {
  open: boolean;
  serverTime: number;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: CreateApiKeyInput) => Promise<CreateApiKeyResult>;
  onCreated: (result: CreateApiKeyResult) => void;
}) {
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<ApiScope[]>(["models:read", "chat:write"]);
  const [expiry, setExpiry] = useState("90");
  const [custom, setCustom] = useState(() => localInputValue(Date.now() + 90 * DAY_MS));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openedAt = useRef(Date.now());
  const expiryOptions = [
    { value: "7", label: t("apiAccess.expiryDays", { count: 7 }) },
    { value: "30", label: t("apiAccess.expiryDays", { count: 30 }) },
    { value: "90", label: t("apiAccess.expiryDays", { count: 90 }) },
    { value: "366", label: t("apiAccess.expiryDays", { count: 366 }) },
    { value: "custom", label: t("apiAccess.customExpiry") },
    { value: "none", label: t("apiAccess.noExpiry") },
  ];

  useEffect(() => {
    if (!open) return;
    openedAt.current = Date.now();
    setLabel("");
    setScopes(["models:read", "chat:write"]);
    setExpiry("90");
    setCustom(localInputValue(Date.now() + 90 * DAY_MS));
    setBusy(false);
    setError(null);
  }, [open]);

  // Server time plus elapsed local time; the server still validates the submitted value.
  const estimatedNow = serverTime + (Date.now() - openedAt.current);

  const expiresAt = (): number | null | undefined => {
    if (expiry === "none") return null;
    if (expiry === "custom") {
      const value = new Date(custom).getTime();
      return Number.isSafeInteger(value) ? value : undefined;
    }
    const days = Number(expiry);
    return Number.isSafeInteger(days) ? estimatedNow + days * DAY_MS : undefined;
  };

  const trimmed = label.trim();
  const labelValid = trimmed.length > 0 && [...trimmed].length <= 80 && !/[\u0000-\u001f\u007f-\u009f]/.test(trimmed);
  const expiryValue = expiresAt();
  const expiryValid = expiryValue !== undefined && (expiryValue === null || (expiryValue > estimatedNow && expiryValue <= estimatedNow + 366 * DAY_MS));
  const valid = labelValid && scopes.length > 0 && expiryValid;

  const toggle = (scope: ApiScope) => {
    setScopes((current) => (current.includes(scope) ? current.filter((value) => value !== scope) : [...current, scope]));
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await onCreate({ label: trimmed, scopes, expiresAt: expiryValue ?? null });
      onCreated(result);
    } catch (cause) {
      // The safe taxonomy text only; the form keeps its values.
      setError(errorText(cause, "apiAccess.createUnknown"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{t("apiAccess.create")}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="api-key-label" className="text-sm font-medium">{t("apiAccess.label")}</label>
            <Input
              id="api-key-label"
              autoFocus
              value={label}
              maxLength={80}
              placeholder={t("apiAccess.labelPlaceholder")}
              aria-invalid={label.length > 0 && !labelValid}
              aria-describedby={label.length > 0 && !labelValid ? "api-key-label-error" : undefined}
              onChange={(event) => setLabel(event.currentTarget.value)}
              autoComplete="off"
            />
            {label.length === 0 && <p id="api-key-label-error" className="text-muted-foreground text-xs">{t("apiAccess.labelRequired")}</p>}
            {label.length > 0 && !labelValid && (
              <p id="api-key-label-error" role="alert" className="text-destructive text-xs">{t("apiAccess.invalidLabel")}</p>
            )}
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">{t("apiAccess.scopes")}</legend>
            <label className="flex min-h-11 items-center gap-2.5 text-sm">
              <input
                type="checkbox"
                className="accent-primary size-4"
                checked={scopes.includes("models:read")}
                onChange={() => toggle("models:read")}
              />
              {t("apiAccess.scopeModels")}
            </label>
            <label className="flex min-h-11 items-center gap-2.5 text-sm">
              <input
                type="checkbox"
                className="accent-primary size-4"
                checked={scopes.includes("chat:write")}
                onChange={() => toggle("chat:write")}
              />
              {t("apiAccess.scopeChat")}
            </label>
            {scopes.length === 0 && <p role="alert" className="text-destructive text-xs">{t("apiAccess.scopeRequired")}</p>}
          </fieldset>

          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">{t("apiAccess.expiry")}</span>
            <Select value={expiry} onValueChange={setExpiry} aria-label={t("apiAccess.expiry")} options={expiryOptions} />
            {expiry === "custom" && (
              <Input
                type="datetime-local"
                value={custom}
                aria-label={t("apiAccess.customExpiry")}
                onChange={(event) => setCustom(event.currentTarget.value)}
              />
            )}
            <p className={cn("text-xs", expiryValid ? "text-muted-foreground" : "text-destructive")} aria-live="polite">
              {expiryValid
                ? expiryValue === null
                  ? t("apiAccess.noExpiry")
                  : t("apiAccess.expiresAt", { date: formatDateTime(expiryValue) })
                : t("apiAccess.expiryInvalid")}
            </p>
            <p className="text-muted-foreground text-xs">{t("apiAccess.localTime")}</p>
          </div>

          <div aria-live="polite" aria-atomic="true" className="min-h-5">
            {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" className="pointer-coarse:h-11" onClick={() => onOpenChange(false)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" className="pointer-coarse:h-11" disabled={!valid || busy}>
              {busy ? t("common.saving") : t("apiAccess.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
