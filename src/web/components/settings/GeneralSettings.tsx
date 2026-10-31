import { Loader2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { DEFAULT_USER_SETTINGS, SIDEBAR_ITEMS, type ModelInfo } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { formatPercent } from "@/i18n/format";
import { useServices } from "@/state/services";
import { ServiceAvailability } from "@/components/ServiceAvailability";
import { useData } from "@/state/data";
import { ModelSelect } from "../chat/ModelPicker";
import { ImageServicesSettings } from "./ImageServicesSettings";
import { SettingsPage, SettingsRow, SettingsSection, SettingsSlider } from "./SettingsUI";

const toolModels = (m: ModelInfo) => m.toolCall;

const SIDEBAR_LABELS = {
  newChat: "general.sidebarNewChat",
  scheduled: "general.sidebarScheduled",
  library: "general.sidebarLibrary",
  knowledge: "general.sidebarKnowledge",
  plugins: "general.sidebarPlugins",
  projects: "general.sidebarProjects",
} as const;

export function GeneralSettings() {
  const settings = useData((s) => s.settings);
  const update = useData((s) => s.updateSettings);
  const [prompt, setPrompt] = useState(settings?.systemPrompt ?? "");
  const [confirmEditReplies, setConfirmEditReplies] = useState(false);
  const [savingEditSetting, setSavingEditSetting] = useState(false);
  const [editSettingError, setEditSettingError] = useState<string | null>(null);
  const sandboxStatus = useServices((s) => s.statuses?.find((status) => status.id === "sandbox"));
  const sandbox = sandboxStatus ? { configured: sandboxStatus.state !== "unconfigured", reachable: sandboxStatus.state === "up" || sandboxStatus.state === "degraded", refuses: sandboxStatus.reasonKey === "refuses" } : null;
  useEffect(() => setPrompt(settings?.systemPrompt ?? ""), [settings?.systemPrompt]);
  if (!settings) return null;
  const editRepliesOn = settings.editAssistantMessages === true;

  const saveEditSetting = async (next: boolean) => {
    if (savingEditSetting) return;
    const previous = editRepliesOn;
    setSavingEditSetting(true);
    setEditSettingError(null);
    try {
      await update({ editAssistantMessages: next });
      setConfirmEditReplies(false);
    } catch (error) {
      // `updateSettings` applies its patch before the request; a rejected save must not look like it worked.
      useData.setState((s) => ({ settings: s.settings ? { ...s.settings, editAssistantMessages: previous } : s.settings }));
      setEditSettingError(t("general.editAssistantMessagesFailed", { error: error instanceof Error ? error.message : t("common.somethingWentWrong") }));
    } finally {
      setSavingEditSetting(false);
    }
  };

  return (
    <SettingsPage title={t("general.title")}>
      <SettingsSection title={t("general.sidebarTitle")} description={t("general.sidebarDescription")}>
        {SIDEBAR_ITEMS.map((item) => (
          <SettingsRow
            key={item}
            label={t(SIDEBAR_LABELS[item])}
            control={<Switch aria-label={t("general.showInSidebar", { item: t(SIDEBAR_LABELS[item]) })} checked={(settings.sidebarItems ?? SIDEBAR_ITEMS).includes(item)} onCheckedChange={(checked) => {
              const visible = settings.sidebarItems ?? SIDEBAR_ITEMS;
              void update({ sidebarItems: SIDEBAR_ITEMS.filter((id) => id === item ? checked : visible.includes(id)) });
            }} />}
          />
        ))}
      </SettingsSection>

      <SettingsSection title={t("general.modelsTitle")}>
        <SettingsRow
          label={t("general.defaultModel")}
          description={t("general.defaultModelDescription")}
          control={<ModelSelect aria-label={t("general.defaultModel")} className="w-full md:w-80" value={settings.defaultModel ?? ""} onValueChange={(v) => update({ defaultModel: v || null })} choices={[{ value: "", label: t("general.firstAvailableModel") }]} />}
        />
        <SettingsRow
          label={t("general.utilityModel")}
          description={t("general.utilityModelDescription")}
          control={
            <ModelSelect
              className="w-full md:w-80"
              aria-label={t("general.utilityModel")}
              value={settings.utilityModel ?? ""}
              onValueChange={(v) => update({ utilityModel: v || null })}
              choices={[{ value: "", label: t("general.sameAsChatModel") }]}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title={t("general.contextTitle")}>
        <SettingsRow
          id="setting-compaction"
          label={t("general.autoCompact")}
          description={t("general.autoCompactDescription")}
          reset={settings.autoCompactAt !== DEFAULT_USER_SETTINGS.autoCompactAt ? () => update({ autoCompactAt: DEFAULT_USER_SETTINGS.autoCompactAt }) : null}
          control={
            <SettingsSlider
              label={t("general.autoCompactThreshold")}
              value={Math.round(settings.autoCompactAt * 100)}
              min={0}
              max={95}
              step={5}
              format={(v) => (v === 0 ? t("common.off") : formatPercent(v / 100))}
              onChange={(v) => update({ autoCompactAt: v / 100 })}
            />
          }
        />
        <SettingsRow
          label={t("general.trimBeforeSummarizing")}
          description={t("general.trimDescription")}
          control={<Switch checked={settings.trimBeforeCompact === true} onCheckedChange={(trimBeforeCompact) => update({ trimBeforeCompact })} aria-label={t("general.trimBeforeSummarizing")} />}
        />
        <SettingsRow
          label={t("general.maxAgentSteps")}
          description={t("general.maxAgentStepsDescription")}
          reset={settings.maxSteps !== DEFAULT_USER_SETTINGS.maxSteps ? () => update({ maxSteps: DEFAULT_USER_SETTINGS.maxSteps }) : null}
          control={<SettingsSlider label={t("general.maxAgentSteps")} value={settings.maxSteps} min={1} max={50} step={1} onChange={(v) => update({ maxSteps: v })} />}
        />
        <SettingsRow
          id="setting-web-search-limit"
          label={t("general.maxWebSearches")}
          description={t("general.maxWebSearchesDescription")}
          reset={settings.maxSearches !== DEFAULT_USER_SETTINGS.maxSearches ? () => update({ maxSearches: DEFAULT_USER_SETTINGS.maxSearches }) : null}
          control={<SettingsSlider label={t("general.maxWebSearches")} value={settings.maxSearches} min={0} max={50} step={1} onChange={(v) => update({ maxSearches: v })} />}
        />
      </SettingsSection>

      <SettingsSection title={t("general.editingTitle")}>
        <SettingsRow
          id="setting-edit-assistant-messages"
          label={t("general.editAssistantMessages")}
          description={t("general.editAssistantMessagesDescription")}
          control={
            <Switch
              aria-label={t("general.editAssistantMessages")}
              checked={editRepliesOn}
              disabled={savingEditSetting}
              onCheckedChange={(checked) => {
                setEditSettingError(null);
                if (checked) setConfirmEditReplies(true);
                else void saveEditSetting(false);
              }}
            />
          }
        />
        {editSettingError && !confirmEditReplies && (
          <p role="alert" className="text-destructive px-4 pb-3 text-xs">{editSettingError}</p>
        )}
      </SettingsSection>

      <SettingsSection title={t("general.toolsTitle")}>
        <SettingsRow
          id="setting-web-tools"
          label={t("general.webTools")}
          description={t("general.webToolsDescription")}
          control={<Switch checked={settings.webTools} onCheckedChange={(webTools) => update({ webTools })} aria-label={t("general.webToolsLabel")} />}
        />
        <SettingsRow
          label={t("general.artifacts")}
          description={t("general.artifactsDescription")}
          control={<Switch checked={settings.artifacts} onCheckedChange={(artifacts) => update({ artifacts })} aria-label={t("general.artifacts")} />}
        />
        <SettingsRow
          label={t("general.generativeUi")}
          description={t("general.generativeUiDescription")}
          control={<Switch checked={settings.generativeUI} onCheckedChange={(generativeUI) => update({ generativeUI })} aria-label={t("general.generativeUi")} />}
        />
        <SettingsRow
          label={t("general.subagents")}
          description={t("general.subagentsDescription")}
          control={<Switch checked={settings.subagents} onCheckedChange={(subagents) => update({ subagents })} aria-label={t("general.subagents")} />}
        />
        {settings.subagents && (
          <div className="settings-collapse">
            <SettingsRow
              label={t("general.subagentModel")}
              description={t("general.subagentModelDescription")}
              control={
                <ModelSelect
                  className="w-full md:w-80"
                  aria-label={t("general.subagentModel")}
                  value={settings.subagentModel ?? ""}
                  onValueChange={(v) => update({ subagentModel: v || null })}
                  choices={[{ value: "", label: t("general.sameAsUtilityModel") }, { value: "chat", label: t("general.sameAsChatModel") }]}
                  filter={toolModels}
                />
              }
            />
          </div>
        )}
        <SettingsRow
          label={t("general.codeExecution")}
          className={!sandbox?.configured ? "text-muted-foreground" : undefined}
          description={
            <span id="code-execution-description">{!sandbox
              ? t("general.sandboxChecking")
              : !sandbox.configured
              ? t("general.sandboxNotConfigured")
              : sandbox && !sandbox.reachable
                ? sandbox.refuses
                  ? t("general.sandboxIsolationFailed")
                  : t("general.sandboxUnreachable")
                : t("general.sandboxDescription")}</span>
          }
          control={<Switch checked={settings.codeExecution && !!sandbox?.configured} disabled={!sandbox?.configured} onCheckedChange={(codeExecution) => update({ codeExecution })} aria-label={t("general.codeExecution")} aria-describedby="code-execution-description" />}
        />
      </SettingsSection>

      <ServiceAvailability id="sandbox" />

      <ImageServicesSettings />

      <SettingsSection title={t("general.customInstructions")} description={t("general.customInstructionsDescription")}>
        <div className="p-3">
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onBlur={() => prompt !== settings.systemPrompt && update({ systemPrompt: prompt })}
            placeholder={t("general.customInstructionsPlaceholder")}
            className="min-h-32"
          />
        </div>
      </SettingsSection>

      <Dialog open={confirmEditReplies} onOpenChange={(open) => !open && !savingEditSetting && setConfirmEditReplies(false)}>
        <DialogContent showCloseButton={!savingEditSetting} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("general.editAssistantMessagesDialogTitle")}</DialogTitle>
            <DialogDescription>{t("general.editAssistantMessagesDialogIntro")}</DialogDescription>
          </DialogHeader>
          <ul className="text-muted-foreground flex list-disc flex-col gap-2 ps-5 text-sm">
            <li>{t("general.editAssistantMessagesConsequenceModel")}</li>
            <li>{t("general.editAssistantMessagesConsequenceOriginal")}</li>
            <li>{t("general.editAssistantMessagesConsequenceCache")}</li>
            <li>{t("general.editAssistantMessagesConsequenceShare")}</li>
            <li>{t("general.editAssistantMessagesConsequenceTools")}</li>
          </ul>
          {editSettingError && <p role="alert" className="text-destructive text-sm">{editSettingError}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" className="min-h-10 pointer-coarse:min-h-11" disabled={savingEditSetting} onClick={() => setConfirmEditReplies(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="button" className="min-h-10 pointer-coarse:min-h-11" disabled={savingEditSetting} onClick={() => void saveEditSetting(true)}>
              {savingEditSetting && <Loader2Icon className="size-3.5 animate-spin motion-reduce:animate-none" />}
              {t("general.editAssistantMessagesEnable")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsPage>
  );
}
