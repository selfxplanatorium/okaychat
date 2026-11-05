import { t } from "@/i18n";
import { AgentManagement } from "@/components/agents/AgentManagement";
import { SettingsPage } from "./SettingsUI";

/** Settings → Agents. Also embedded as the Agents tab under Plugins. */
export function N8nAgentsSettings({ embedded = false }: { embedded?: boolean }) {
  return (
    <SettingsPage title={embedded ? "" : t("agents.title")} description={t("agents.intro")}>
      <AgentManagement scope="own" />
    </SettingsPage>
  );
}
