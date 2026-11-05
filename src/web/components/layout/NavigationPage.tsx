import { useState } from "react";
import { LibraryIcon } from "lucide-react";
import { KnowledgePage } from "@/components/knowledge/KnowledgePage";
import { LibraryPage } from "@/components/library/LibraryPage";
import { McpSettings } from "@/components/settings/McpSettings";
import { N8nAgentsSettings } from "@/components/settings/N8nAgentsSettings";
import { ProjectSettings } from "@/components/settings/ProjectSettings";
import { ScheduleSettings } from "@/components/settings/ScheduleSettings";
import { SkillsSettings } from "@/components/settings/SkillsSettings";
import { SettingsPage } from "@/components/settings/SettingsUI";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";

function PluginsPage() {
  const [tab, setTab] = useState("mcp");
  const tabs = [
    { id: "mcp", label: "shell.mcpServers" },
    { id: "skills", label: "shell.skills" },
    { id: "agents", label: "shell.agents" },
  ] as const;
  return (
    <div>
      <div className="mx-auto w-full max-w-3xl px-6 pt-8">
        <h1 className="text-xl font-semibold tracking-tight">{t("shell.pluginsTitle")}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t("shell.pluginsIntro")}</p>
        <div role="tablist" aria-label={t("shell.pluginType")} className="border-border mt-6 flex gap-5 border-b">
          {tabs.map(({ id, label }) => (
            <button key={id} id={`plugin-tab-${id}`} role="tab" type="button" aria-selected={tab === id} aria-controls={`plugin-panel-${id}`} tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)} onKeyDown={(e) => {
              if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
                e.preventDefault();
                const index = tabs.findIndex((item) => item.id === tab);
                const nextIndex = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (index + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
                const next = tabs[nextIndex]!.id;
                setTab(next);
                document.getElementById(`plugin-tab-${next}`)?.focus();
              }
            }} className={cn("focus-visible:outline-ring border-b-2 px-1 pb-3 text-sm", tab === id ? "border-foreground text-foreground font-medium" : "text-muted-foreground border-transparent hover:text-foreground")}>
              {t(label)}
            </button>
          ))}
        </div>
      </div>
      <div role="tabpanel" id={`plugin-panel-${tab}`} aria-labelledby={`plugin-tab-${tab}`} tabIndex={0}>
        {tab === "mcp" ? <McpSettings embedded /> : tab === "skills" ? <SkillsSettings embedded /> : <N8nAgentsSettings embedded />}
      </div>
    </div>
  );
}

export function NavigationPage({ page }: { page: string }) {
  if (page === "scheduled") return <ScheduleSettings />;
  if (page === "projects") return <ProjectSettings />;
  if (page === "plugins") return <PluginsPage />;
  if (page === "library") return <LibraryPage />;
  if (page === "knowledge") return <KnowledgePage />;
  return (
    <SettingsPage title={t("shell.navigation")}>
      <div className="flex flex-col items-center py-16 text-center">
        <LibraryIcon aria-hidden className="text-muted-foreground mb-5 size-8" />
        <h2 className="text-base font-medium">{t("shell.nothingHere")}</h2>
        <p className="text-muted-foreground mt-2 max-w-xs text-sm">{t("shell.pageMissing")}</p>
      </div>
    </SettingsPage>
  );
}
