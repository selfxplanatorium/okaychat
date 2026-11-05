import { Loader2Icon, ShieldAlertIcon } from "lucide-react";
import { FEATURE_KEYS, LIMIT_KEYS, type LimitKey } from "@shared/permissions";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { formatNumber } from "@/i18n/format";
import { useData } from "@/state/data";
import { usePermissions } from "@/state/permissions";
import { FEATURE_LABEL, LIMIT_LABEL, LIMIT_UNIT } from "./permissions/labels";
import { SettingsRow, SettingsSection } from "./SettingsUI";

// Ordinary-user view: only self endpoints are read (`/permissions`, `/instructions/models`). No source
// names, group membership, prompt text, or any other account's data can reach this component.

export function SelfPermissionsSettings() {
  const me = useData((state) => state.me);
  const models = useData((state) => state.models);
  const self = usePermissions((state) => state.self);
  const selfStatus = usePermissions((state) => state.selfStatus);
  const selfError = usePermissions((state) => state.selfError);
  const instruction = usePermissions((state) => state.instruction);
  const instructionStatus = usePermissions((state) => state.instructionStatus);
  const instructionError = usePermissions((state) => state.instructionError);
  const [modelRef, setModelRef] = useState("");
  const [mode, setMode] = useState<"inherit" | "append" | "replace">("inherit");
  const [text, setText] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!me) return;
    usePermissions.getState().begin(me.id);
    void usePermissions.getState().loadSelf();
    const first = useData.getState().settings?.defaultModel ?? useData.getState().models[0]?.ref ?? "";
    setModelRef((current) => current || first);
  }, [me?.id]);

  useEffect(() => {
    if (!modelRef) return;
    setSaved(false);
    void usePermissions.getState().loadInstruction(modelRef);
  }, [modelRef]);

  useEffect(() => {
    if (!instruction || instruction.modelRef !== modelRef) return;
    setMode(instruction.mode);
    setText(instruction.text);
  }, [instruction, modelRef]);

  const disabled = useMemo(() => FEATURE_KEYS.filter((key) => self && !self.features[key]), [self]);
  const limits = useMemo(() => LIMIT_KEYS.filter((key) => self && self.limits[key] !== null), [self]);
  const modelName = models.find((model) => model.ref === modelRef)?.name ?? modelRef;

  const save = async () => {
    setSaved(false);
    const ok = await usePermissions.getState().saveInstruction(modelRef, mode === "inherit" ? null : { mode, text });
    if (ok) setSaved(true);
  };

  return (
    <>
      <SettingsSection title={t("permissions.userTitle")} description={t("permissions.userDescription")}>
        {selfStatus === "loading" && (
          <p className="text-muted-foreground flex items-center gap-2 px-4 py-3 text-sm">
            <Loader2Icon className="animate-spin" /> {t("permissions.stateLoading")}
          </p>
        )}
        {selfStatus === "error" && <p role="alert" className="text-error px-4 py-3 text-sm">{selfError ?? t("permissions.stateLoadFailed")}</p>}
        {self && (
          <>
            <div className="flex flex-col gap-1 px-4 py-3">
              <p className="flex items-center gap-2 text-sm font-medium">
                <ShieldAlertIcon className="text-muted-foreground size-4" aria-hidden /> {t("permissions.userDisabledTitle")}
              </p>
              {disabled.length === 0 ? (
                <p className="text-muted-foreground text-xs">{t("permissions.userAllEnabled")}</p>
              ) : (
                <ul className="flex flex-wrap gap-1.5 pt-1">
                  {disabled.map((feature) => (
                    <li key={feature} className="bg-muted rounded px-1.5 py-0.5 text-[11px]">
                      {t(FEATURE_LABEL[feature])}
                      <span className="text-muted-foreground"> · {self.disabledReasons[feature] === "dependency" ? t("permissions.userDependency") : t("permissions.userByAdmin")}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <SettingsRow
              label={t("permissions.userLimits")}
              description={limits.length ? undefined : t("permissions.userNoExtraLimits")}
              control={
                <span className="text-muted-foreground text-right text-xs leading-relaxed">
                  {limits.length
                    ? limits.map((limit: LimitKey) => `${t(LIMIT_LABEL[limit])}: ${formatNumber(self.limits[limit]!)} ${t(LIMIT_UNIT[limit])}`).join(" · ")
                    : "—"}
                </span>
              }
            />
          </>
        )}
      </SettingsSection>

      <SettingsSection title={t("permissions.userInstructions")} description={t("permissions.userInstructionsHelp")}>
        <div className="grid gap-3 px-4 py-3">
          <label className="flex flex-col gap-1 text-xs font-medium">
            {t("permissions.inspectModel")}
            <Select
              aria-label={t("permissions.inspectModel")}
              value={modelRef}
              onValueChange={setModelRef}
              options={models.length ? models.map((model) => ({ value: model.ref, label: model.name })) : [{ value: "", label: t("permissions.userNoModels") }]}
            />
          </label>
          {instructionStatus === "loading" && <p className="text-muted-foreground flex items-center gap-2 text-xs"><Loader2Icon className="size-3.5 animate-spin" /> {t("permissions.stateLoading")}</p>}
          {instructionStatus === "error" && (
            <div role="alert" className="flex flex-col items-start gap-1">
              <p className="text-error text-xs">{instructionError ?? t("permissions.stateLoadFailed")}</p>
              <Button type="button" size="xs" variant="outline" onClick={() => void usePermissions.getState().loadInstruction(modelRef)}>
                {t("common.tryAgain")}
              </Button>
            </div>
          )}
          {instruction && instruction.modelRef === modelRef && (
            <>
              <p className="text-muted-foreground text-xs">
                {t("permissions.userAccountTextLabel")}: {instruction.accountText ? t("permissions.userAccountTextPresent") : t("permissions.userAccountTextEmpty")}
              </p>
              <div className="flex flex-col gap-1">
                <p className="text-xs font-medium">{t("permissions.userEffectiveText")}</p>
                <pre className="bg-muted/40 max-h-32 overflow-auto rounded-lg border p-2 font-mono text-xs whitespace-pre-wrap break-words">{instruction.effectivePersonalText || t("permissions.promptEmptyText")}</pre>
              </div>
              <label className="flex flex-col gap-1 text-xs font-medium">
                {t("permissions.userMode")}
                <Select
                  aria-label={t("permissions.userMode")}
                  value={mode}
                  onValueChange={(next) => setMode(next as "inherit" | "append" | "replace")}
                  options={[
                    { value: "inherit", label: t("permissions.valueInherit") },
                    { value: "append", label: t("permissions.promptAppend") },
                    { value: "replace", label: t("permissions.promptReplace") },
                  ]}
                />
              </label>
              {mode !== "inherit" && (
                <>
                  <Textarea
                    aria-label={t("permissions.promptPersonalModel")}
                    className="min-h-40 font-mono text-base md:text-sm"
                    maxLength={50_000}
                    value={text}
                    onChange={(event) => setText(event.currentTarget.value)}
                    placeholder={t("permissions.promptPersonalModel")}
                  />
                  <p className="text-muted-foreground text-xs tabular-nums">{t("permissions.promptTokens", { count: formatNumber(Math.ceil(text.length / 4)) })}</p>
                </>
              )}
              <p className="text-muted-foreground text-xs">{t("permissions.userAdminStillApplies", { model: modelName })}</p>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" size="sm" disabled={instructionStatus === "saving"} onClick={() => void save()}>
                  {instructionStatus === "saving" && <Loader2Icon className="animate-spin" />} {t("common.save")}
                </Button>
                {saved && <span role="status" aria-live="polite" className="text-success text-xs">{t("permissions.stateSaved")}</span>}
              </div>
            </>
          )}
        </div>
      </SettingsSection>
    </>
  );
}
