import { Loader2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { REASONING_EFFORTS } from "@shared/reasoning";
import { TRANSLATION_LANGUAGES } from "@shared/locale-tag";
import { isAgentTarget } from "@shared/n8n-agents";
import { DEFAULT_USER_SETTINGS, SIDEBAR_ITEMS, type ChatTargetInfo, type NotificationSettings } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { EffortIcon } from "../chat/EffortIcon";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { compareText, formatLanguageName, formatNativeLanguageName, formatPercent } from "@/i18n/format";
import { saveLocalePreference } from "@/i18n/account-locale";
import { shippedLocales } from "@/i18n/locales";
import { useServices } from "@/state/services";
import { ServiceAvailability } from "@/components/ServiceAvailability";
import { useData } from "@/state/data";
import { effortLabel, ModelSelect } from "../chat/ModelPicker";
import { ImageServicesSettings } from "./ImageServicesSettings";
import { SettingsPage, SettingsRow, SettingsSection, SettingsSlider } from "./SettingsUI";

// Utility and sub-agent models stay language models: an n8n agent is a chat target, not a model call.
const llmModels = (m: ChatTargetInfo) => !isAgentTarget(m);
const toolModels = (m: ChatTargetInfo) => !isAgentTarget(m) && m.toolCall;

const SIDEBAR_LABELS = {
  newChat: "general.sidebarNewChat",
  scheduled: "general.sidebarScheduled",
  notes: "general.sidebarNotes",
  calendar: "general.sidebarCalendar",
  library: "general.sidebarLibrary",
  knowledge: "general.sidebarKnowledge",
  plugins: "general.sidebarPlugins",
  projects: "general.sidebarProjects",
  channels: "settings.sidebarChannels",
  compare: "general.sidebarCompare",
  evaluations: "general.sidebarEvaluations",
} as const;

export function GeneralSettings() {
  const settings = useData((s) => s.settings);
  const update = useData((s) => s.updateSettings);
  const [prompt, setPrompt] = useState(settings?.systemPrompt ?? "");
  const [confirmEditReplies, setConfirmEditReplies] = useState(false);
  const [savingEditSetting, setSavingEditSetting] = useState(false);
  const [editSettingError, setEditSettingError] = useState<string | null>(null);
  const [language, setLanguage] = useState(settings?.locale ?? "");
  const [savingLanguage, setSavingLanguage] = useState(false);
  const [languageError, setLanguageError] = useState<string | null>(null);
  const [savingTranslation, setSavingTranslation] = useState(false);
  const [translationError, setTranslationError] = useState<string | null>(null);
  const [savingNotifications, setSavingNotifications] = useState(false);
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const [notificationBlocked, setNotificationBlocked] = useState(false);
  const [savingActivity, setSavingActivity] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  const sandboxStatus = useServices((s) => s.statuses?.find((status) => status.id === "sandbox"));
  const sandbox = sandboxStatus ? { configured: sandboxStatus.state !== "unconfigured", reachable: sandboxStatus.state === "up" || sandboxStatus.state === "degraded", refuses: sandboxStatus.reasonKey === "refuses" } : null;
  useEffect(() => setPrompt(settings?.systemPrompt ?? ""), [settings?.systemPrompt]);
  if (!settings) return null;
  // "Use browser language" first, then every shipped language by its autonym ("Deutsch", "Français"), so a
  // reader can find their language whatever the current UI language is; sorted for the current UI language.
  const shipped = shippedLocales();
  const languageChoices = [
    { value: "", label: t("general.languageBrowser") },
    ...shipped
      .map((tag) => ({ value: tag, label: formatNativeLanguageName(tag) }))
      .sort((a, b) => compareText(a.label, b.label)),
    // A valid stored tag this build does not ship (for example de-AT) still has a readable name.
    ...(language && !shipped.includes(language) ? [{ value: language, label: formatNativeLanguageName(language) }] : []),
  ];
  const translationChoices = [
    { value: "", label: t("general.translateIntoUi") },
    ...[...TRANSLATION_LANGUAGES]
      .map((tag) => ({ value: tag, label: formatLanguageName(tag) }))
      .sort((a, b) => compareText(a.label, b.label)),
  ];
  const closeEditConfirm = () => {
    setEditSettingError(null);
    setConfirmEditReplies(false);
  };
  const editRepliesOn = settings.editAssistantMessages === true;
  const notifications: NotificationSettings = settings.notifications ?? DEFAULT_USER_SETTINGS.notifications ?? { browser: false, scheduleSuccess: false };
  const channelActivity = settings.channelActivity ?? DEFAULT_USER_SETTINGS.channelActivity ?? { sharePresence: true, shareTyping: true };

  /** One whole object per save: the server rejects a partial pair instead of merging a stale half. */
  const saveChannelActivity = async (next: { sharePresence: boolean; shareTyping: boolean }) => {
    setActivityError(null);
    setSavingActivity(true);
    try {
      await update({ channelActivity: next });
    } catch {
      setActivityError(t("general.channelActivityFailed"));
    } finally {
      setSavingActivity(false);
    }
  };

  const saveNotifications = async (next: NotificationSettings) => {
    const previous = { ...notifications };
    setSavingNotifications(true);
    setNotificationError(null);
    try {
      await update({ notifications: next });
    } catch {
      // `updateSettings` patches optimistically; a rejected save must not look applied.
      useData.setState((s) => ({ settings: s.settings ? { ...s.settings, notifications: previous } : s.settings }));
      setNotificationError(t("general.notificationsFailed"));
    } finally {
      setSavingNotifications(false);
    }
  };

  const toggleBrowserNotifications = async (checked: boolean) => {
    setNotificationBlocked(false);
    if (!checked) return saveNotifications({ browser: false, scheduleSuccess: false });
    // The request runs in the switch's own handler, which browsers require for a permission prompt.
    const permission = typeof Notification === "undefined" ? "denied" : await Notification.requestPermission();
    if (permission !== "granted") {
      setNotificationBlocked(true);
      return saveNotifications({ browser: false, scheduleSuccess: false });
    }
    return saveNotifications({ ...notifications, browser: true });
  };

  const saveLanguage = async (next: string) => {
    if (savingLanguage) return;
    const previous = language;
    setLanguage(next);
    setSavingLanguage(true);
    setLanguageError(null);
    try {
      // Success reloads the page with the new chunk; only a failure returns here.
      await saveLocalePreference(next || null);
    } catch (error) {
      setLanguage(previous);
      setSavingLanguage(false);
      setLanguageError(t("general.languageFailed", { error: error instanceof Error ? error.message : t("common.somethingWentWrong") }));
    }
  };

  const saveTranslationTarget = async (value: string | null) => {
    const previous = settings.translationTarget ?? null;
    setTranslationError(null);
    try {
      await update({ translationTarget: value });
    } catch (error) {
      useData.setState((s) => ({ settings: s.settings ? { ...s.settings, translationTarget: previous } : s.settings }));
      setTranslationError(t("general.translateMessagesFailed", { error: error instanceof Error ? error.message : t("common.somethingWentWrong") }));
    }
  };

  const saveTranslationSetting = async (next: boolean) => {
    if (savingTranslation) return;
    const previous = settings.translateMessages !== false;
    setSavingTranslation(true);
    setTranslationError(null);
    try {
      await update({ translateMessages: next });
    } catch (error) {
      // `updateSettings` applies its patch before the request; a rejected save must not look like it worked.
      useData.setState((s) => ({ settings: s.settings ? { ...s.settings, translateMessages: previous } : s.settings }));
      setTranslationError(t("general.translateMessagesFailed", { error: error instanceof Error ? error.message : t("common.somethingWentWrong") }));
    } finally {
      setSavingTranslation(false);
    }
  };

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
      <SettingsSection title={t("general.languageTitle")} description={t("general.languageDescription")}>
        <SettingsRow
          id="setting-language"
          label={t("general.languageLabel")}
          description={
            <>
              <span className="block">{t("general.languageDescription")}</span>
              <span className="mt-1 block">{t("general.languageNote")}</span>
            </>
          }
          control={
            <Select
              aria-label={t("general.languageLabel")}
              className="w-full md:w-80"
              value={language}
              disabled={savingLanguage}
              onValueChange={(value) => void saveLanguage(value)}
              options={languageChoices}
            />
          }
        />
        {languageError && <p role="alert" className="text-destructive px-4 pb-3 text-xs">{languageError}</p>}
      </SettingsSection>

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
          label={t("general.defaultReasoningEffort")}
          description={t("general.defaultReasoningEffortDescription")}
          reset={settings.defaultReasoningEffort !== DEFAULT_USER_SETTINGS.defaultReasoningEffort ? () => update({ defaultReasoningEffort: DEFAULT_USER_SETTINGS.defaultReasoningEffort }) : null}
          control={
            <Select
              aria-label={t("general.defaultReasoningEffort")}
              className="w-full md:w-80"
              value={settings.defaultReasoningEffort ?? "medium"}
              onValueChange={(defaultReasoningEffort) => update({ defaultReasoningEffort })}
              options={REASONING_EFFORTS.map((effort) => ({
                value: effort,
                label: <span className="inline-flex items-center gap-2"><EffortIcon effort={effort} options={REASONING_EFFORTS} />{effortLabel(effort)}</span>,
              }))}
            />
          }
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
              filter={llmModels}
              allowAgents={false}
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

      <SettingsSection title={t("general.translationTitle")}>
        <SettingsRow
          id="setting-translate-messages"
          label={t("general.translateMessages")}
          description={t("general.translateMessagesDescription")}
          control={
            <Switch
              aria-label={t("general.translateMessages")}
              checked={settings.translateMessages !== false}
              disabled={savingTranslation}
              onCheckedChange={(checked) => void saveTranslationSetting(checked)}
            />
          }
        />
        <SettingsRow
          id="setting-translation-target"
          label={t("general.translateInto")}
          description={t("general.translateIntoDescription")}
          control={
            <Select
              aria-label={t("general.translateInto")}
              className="w-full md:w-80"
              value={settings.translationTarget ?? ""}
              disabled={settings.translateMessages === false}
              onValueChange={(value) => void saveTranslationTarget(value || null)}
              options={translationChoices}
            />
          }
        />
        {translationError && <p role="alert" className="text-destructive px-4 pb-3 text-xs">{translationError}</p>}
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

      <SettingsSection title={t("general.notificationsTitle")} description={t("general.notificationsDeviceNote")}>
        <SettingsRow
          id="setting-notifications"
          label={t("general.browserNotifications")}
          description={t("general.browserNotificationsDescription")}
          control={
            <Switch
              aria-label={t("general.browserNotifications")}
              checked={notifications.browser}
              disabled={savingNotifications}
              onCheckedChange={(checked) => void toggleBrowserNotifications(checked)}
            />
          }
        />
        <SettingsRow
          label={t("general.scheduleSuccessNotify")}
          description={t("general.scheduleSuccessNotifyDescription")}
          control={
            <Switch
              aria-label={t("general.scheduleSuccessNotify")}
              checked={notifications.scheduleSuccess}
              disabled={savingNotifications || !notifications.browser}
              onCheckedChange={(scheduleSuccess) => void saveNotifications({ ...notifications, scheduleSuccess })}
            />
          }
        />
        {notificationBlocked && <p role="alert" className="text-destructive px-4 pb-3 text-xs">{t("general.browserBlocked")}</p>}
        {notificationError && <p role="alert" className="text-destructive px-4 pb-3 text-xs">{notificationError}</p>}
      </SettingsSection>

      <SettingsSection title={t("general.channelActivityTitle")} description={t("general.channelActivityHelp")}>
        <SettingsRow
          id="setting-channel-activity"
          label={t("general.channelSharePresence")}
          control={
            <Switch
              aria-label={t("general.channelSharePresence")}
              checked={channelActivity.sharePresence}
              disabled={savingActivity}
              onCheckedChange={(sharePresence) => void saveChannelActivity({ ...channelActivity, sharePresence })}
            />
          }
        />
        <SettingsRow
          label={t("general.channelShareTyping")}
          control={
            <Switch
              aria-label={t("general.channelShareTyping")}
              checked={channelActivity.shareTyping}
              disabled={savingActivity}
              onCheckedChange={(shareTyping) => void saveChannelActivity({ ...channelActivity, shareTyping })}
            />
          }
        />
        {activityError && <p role="alert" className="text-destructive px-4 pb-3 text-xs">{activityError}</p>}
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
                  allowAgents={false}
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

      <Dialog open={confirmEditReplies} onOpenChange={(open) => !open && !savingEditSetting && closeEditConfirm()}>
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
            <Button type="button" variant="outline" className="min-h-10 pointer-coarse:min-h-11" disabled={savingEditSetting} onClick={closeEditConfirm}>
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
