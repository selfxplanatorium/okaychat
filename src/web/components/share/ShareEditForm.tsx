import { useState } from "react";
import { Loader2Icon, RefreshCwIcon } from "lucide-react";
import type { ShareLink, ShareMode, ShareUpdateInput } from "@shared/share-links";
import { MIN_SHARE_PASSWORD } from "@shared/share-links";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select } from "@/components/ui/select";
import { api } from "@/lib/api";
import { errorText } from "@/lib/error-text";
import { t } from "@/i18n";

export const shareUrl = (token: string) => `${location.origin}/share/${token}`;

const DAY = 24 * 60 * 60 * 1000;
const PRESETS = [1, 7, 30] as const;

/** The stored expiry as one of the presets, or "keep" when it came from another choice. */
function expiryValue(expiresAt: number | null): string {
  if (expiresAt === null) return "never";
  const days = (expiresAt - Date.now()) / DAY;
  const closest = PRESETS.reduce((best, value) => (Math.abs(value - days) < Math.abs(best - days) ? value : best), PRESETS[0]);
  return Math.abs(closest - days) < 0.5 ? String(closest) : "keep";
}

/** Inline editor for one link, used by the chat panel and the account-wide manager. */
export function ShareEditForm({
  share,
  onSaved,
  onCancel,
}: {
  share: ShareLink;
  onSaved: (share: ShareLink) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(share.label);
  const [mode, setMode] = useState<ShareMode>(share.mode);
  const [expiry, setExpiry] = useState(expiryValue(share.expiresAt));
  const [password, setPassword] = useState("");
  const [removePassword, setRemovePassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patch = async (body: ShareUpdateInput, failed: "share.updateFailed" | "share.refreshFailed" = "share.updateFailed") => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ share: ShareLink }>(`/shares/${share.token}`, { method: "PATCH", json: body });
      onSaved(result.share);
    } catch (cause) {
      setError(errorText(cause, failed));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (password && password.length < MIN_SHARE_PASSWORD) return setError(t("share.passwordTooShort"));
    const body: ShareUpdateInput = { label, mode };
    if (expiry !== "keep") body.expiresAt = expiry === "never" ? null : Date.now() + Number(expiry) * DAY;
    if (removePassword) body.password = null;
    else if (password) body.password = password;
    await patch(body);
  };

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label className="text-muted-foreground flex flex-col gap-1 text-xs">
        {t("share.linkLabel")}
        <Input value={label} maxLength={60} onChange={(event) => setLabel(event.target.value)} className="h-8" />
      </label>
      <SegmentedControl
        aria-label={t("share.linkLabel")}
        value={mode}
        onValueChange={(value) => setMode(value === "frozen" ? "frozen" : "live")}
        items={[
          { value: "live", label: t("share.liveMode") },
          { value: "frozen", label: t("share.frozenMode") },
        ]}
      />
      <p className="text-muted-foreground text-[11px]">{mode === "live" ? t("share.liveModeHint") : t("share.frozenModeHint")}</p>
      <label className="text-muted-foreground flex flex-col gap-1 text-xs">
        {t("share.expiresLabel")}
        <Select
          aria-label={t("share.expiresLabel")}
          value={expiry}
          onValueChange={setExpiry}
          options={[
            ...(share.expiresAt !== null ? [{ value: "keep", label: t("share.expiresKeep") }] : []),
            { value: "never", label: t("share.expiresNever") },
            { value: "1", label: t("share.expiresOneDay") },
            { value: "7", label: t("share.expiresSevenDays") },
            { value: "30", label: t("share.expiresThirtyDays") },
          ]}
        />
      </label>
      <label className="text-muted-foreground flex flex-col gap-1 text-xs">
        {t("share.passwordOptional")}
        <Input
          type="password"
          value={password}
          autoComplete="new-password"
          maxLength={200}
          disabled={removePassword}
          placeholder={share.hasPassword ? t("share.passwordKeep") : t("share.passwordOptional")}
          onChange={(event) => setPassword(event.target.value)}
          className="h-8"
        />
      </label>
      {share.hasPassword && (
        <label className="text-muted-foreground flex items-center gap-2 text-xs">
          <input type="checkbox" checked={removePassword} onChange={(event) => setRemovePassword(event.target.checked)} />
          {t("share.removePassword")}
        </label>
      )}
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {busy && <Loader2Icon className="animate-spin motion-reduce:animate-none" />} {t("share.saveLink")}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        {share.mode === "frozen" && (
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void patch({ refreshSnapshot: true }, "share.refreshFailed")}>
            <RefreshCwIcon /> {t("share.refreshSnapshot")}
          </Button>
        )}
      </div>
    </form>
  );
}
