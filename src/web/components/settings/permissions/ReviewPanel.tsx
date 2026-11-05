import { AlertTriangleIcon, Loader2Icon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";
import { usePermissions } from "@/state/permissions";
import { describeImpact, impactValueText } from "@/state/permissions-impact";
import { FEATURE_LABEL, LIMIT_LABEL } from "./labels";

// Preview → review → commit. Impact labels are built from the canonical path, so nothing here interprets
// prompt text; counts come from the whole draft even when the row list is long.

export function ReviewPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const preview = usePermissions((state) => state.preview);
  const previewStatus = usePermissions((state) => state.previewStatus);
  const previewError = usePermissions((state) => state.previewError);
  const commitStatus = usePermissions((state) => state.commitStatus);
  const commitError = usePermissions((state) => state.commitError);
  const conflict = usePermissions((state) => state.conflict);
  const [reason, setReason] = useState("");
  const [reloadBusy, setReloadBusy] = useState(false);
  const counts = preview?.counts;
  const users = usePermissions((state) => state.bootstrap?.subjects.users ?? []);
  const prompts = usePermissions((state) => state.subjects["everyone:"]?.serverPrompts ?? []);
  const canCommit = !!preview && reason.trim().length > 0 && reason.trim().length <= 500 && commitStatus !== "loading" && !conflict;

  const commit = async () => {
    const ok = await usePermissions.getState().commit(reason.trim());
    if (ok) {
      setReason("");
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && commitStatus !== "loading" && onOpenChange(false)}>
      <DialogContent className="flex max-h-[min(90dvh,48rem)] flex-col gap-4 overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-base">{t("permissions.reviewTitle")}</DialogTitle>
          <DialogDescription>{t("permissions.reviewDescription")}</DialogDescription>
        </DialogHeader>

        {previewStatus === "error" && <p role="alert" className="text-error text-sm">{previewError ?? t("permissions.statePreviewFailed")}</p>}
        {conflict && (
          <div role="alert" className="border-warning/40 bg-warning/5 flex flex-col gap-2 rounded-lg border p-3">
            <p className="text-warning flex items-center gap-2 text-sm font-medium">
              <AlertTriangleIcon className="size-4" aria-hidden /> {t("permissions.stateConflict")}
            </p>
            <p className="text-muted-foreground text-xs">{conflict}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={reloadBusy}
                onClick={async () => {
                  setReloadBusy(true);
                  await usePermissions.getState().reloadAfterConflict();
                  setReloadBusy(false);
                }}
              >
                {reloadBusy && <Loader2Icon className="animate-spin" />} {t("permissions.stateReload")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={reloadBusy}
                onClick={async () => {
                  setReloadBusy(true);
                  await usePermissions.getState().rebaseDrafts();
                  setReloadBusy(false);
                  await usePermissions.getState().review();
                }}
              >
                {reloadBusy && <Loader2Icon className="animate-spin" />} {t("permissions.stateRebase")}
              </Button>
            </div>
          </div>
        )}

        {counts && (
          <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <Count label={t("permissions.reviewAffectedUsers", { count: counts.usersAffected })} />
            <Count label={t("permissions.reviewAffectedModels", { count: counts.modelsAffected })} />
            <Count label={t("permissions.reviewGrantsAdded", { count: counts.grantsAdded })} />
            <Count label={t("permissions.reviewGrantsRemoved", { count: counts.grantsRemoved })} />
            <Count label={t("permissions.reviewFeaturesChanged", { count: counts.featuresChanged })} />
            <Count label={t("permissions.reviewLimitsTightened", { count: counts.limitsTightened })} />
            <Count label={t("permissions.reviewLimitsRelaxed", { count: counts.limitsRelaxed })} />
            <Count label={t("permissions.reviewPromptsChanged", { count: counts.promptsChanged })} />
          </div>
        )}

        {preview && preview.rows.length === 0 && <p className="text-muted-foreground text-sm">{t("permissions.reviewNoImpact")}</p>}
        {preview && preview.rows.length > 0 && (
          <ul className="bg-muted/40 min-h-0 flex-1 overflow-y-auto rounded-lg border p-1 text-xs" aria-label={t("permissions.reviewRows")}>
            {preview.rows.slice(0, 200).map((row, index) => {
              const impact = describeImpact(row);
              const user = users.find((item) => item.id === row.userId);
              const promptLabel = impact.kind === "prompt" ? (prompts.find((item) => item.key === impact.name)?.label ?? impact.name) : impact.name;
              const field =
                impact.kind === "feature" && impact.name
                  ? t(FEATURE_LABEL[impact.name as keyof typeof FEATURE_LABEL])
                  : impact.kind === "limit" || impact.kind === "bucket"
                    ? t(LIMIT_LABEL[impact.name as keyof typeof LIMIT_LABEL])
                    : impact.kind === "access"
                      ? t("permissions.modelAccess")
                      : impact.kind === "prompt"
                        ? promptLabel
                        : impact.name;
              return (
                <li key={`${row.userId}|${row.modelRef ?? ""}|${row.path}|${index}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-md px-2 py-1.5">
                  <span className="font-medium">{user?.name ?? row.userId}</span>
                  <span className="text-muted-foreground">{row.modelRef ?? t("permissions.scopeAllModels")}</span>
                  <span className="min-w-0 flex-1 truncate">{field}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {impactValueText(row.before)} → {impactValueText(row.after)}
                  </span>
                  <span className="bg-muted rounded px-1.5 py-0.5 text-[10px]">{t(directionKey(impact.direction))}</span>
                </li>
              );
            })}
            {preview.rows.length > 200 && <li className="text-muted-foreground px-2 py-1.5">{t("permissions.reviewRowsTruncated")}</li>}
          </ul>
        )}

        <p className="text-warning flex items-start gap-2 text-xs">
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {t("permissions.reviewActiveWork")}
        </p>

        <label className="flex flex-col gap-1 text-xs font-medium">
          {t("permissions.reviewReason")}
          <Input value={reason} maxLength={500} onChange={(event) => setReason(event.currentTarget.value)} placeholder={t("permissions.reviewReasonHint")} aria-describedby="permission-reason-help" />
          <span id="permission-reason-help" className="text-muted-foreground font-normal">
            {t("permissions.reviewReasonHelp", { count: reason.trim().length })}
          </span>
        </label>
        {commitError && <p role="alert" className="text-error text-xs">{commitError}</p>}

        <DialogFooter>
          <Button type="button" variant="outline" disabled={commitStatus === "loading"} onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="button" disabled={!canCommit} onClick={() => void commit()}>
            {commitStatus === "loading" && <Loader2Icon className="animate-spin" />} {t("permissions.reviewSave")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Count({ label }: { label: string }) {
  return <div className="bg-muted/50 rounded-lg px-2.5 py-2 tabular-nums">{label}</div>;
}

function directionKey(direction: ReturnType<typeof describeImpact>["direction"]) {
  switch (direction) {
    case "granted":
      return "permissions.reviewGranted" as const;
    case "revoked":
      return "permissions.reviewRevoked" as const;
    case "tightened":
      return "permissions.reviewTightened" as const;
    case "relaxed":
      return "permissions.reviewRelaxed" as const;
    case "changed":
      return "permissions.reviewChanged" as const;
  }
}
