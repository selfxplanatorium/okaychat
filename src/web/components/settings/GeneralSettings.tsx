import { useEffect, useState } from "react";
import { DEFAULT_USER_SETTINGS, SIDEBAR_ITEMS, type ModelInfo } from "@shared/types";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { formatPercent } from "@/i18n/format";
import { api } from "@/lib/api";
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
  const [sandbox, setSandbox] = useState<{ configured: boolean; reachable: boolean; refuses?: boolean } | null>(null);
  useEffect(() => setPrompt(settings?.systemPrompt ?? ""), [settings?.systemPrompt]);
  useEffect(() => {
    api<{ configured: boolean; reachable: boolean; refuses?: boolean }>("/sandbox").then(setSandbox, () => setSandbox({ configured: false, reachable: false }));
  }, []);
  if (!settings) return null;

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
    </SettingsPage>
  );
}
