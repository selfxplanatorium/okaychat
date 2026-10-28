import { ArrowLeftIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type { ComponentType } from "react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { AdminSettings } from "./AdminSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { GeneralSettings } from "./GeneralSettings";
import { McpSettings } from "./McpSettings";
import { ProjectSettings } from "./ProjectSettings";
import { ProvidersSettings } from "./ProvidersSettings";
import { ScheduleSettings } from "./ScheduleSettings";
import { UsageSettings } from "./UsageSettings";
import { AccountSettings } from "./AccountSettings";
import { MemorySettings } from "./MemorySettings";
import { KeyboardSettings } from "./KeyboardSettings";
import { VoiceSettings } from "./VoiceSettings";
import { useSettingsSections } from "./SettingsNav";

const PAGES: Record<string, ComponentType> = {
  general: GeneralSettings,
  account: AccountSettings,
  memory: MemorySettings,
  providers: ProvidersSettings,
  mcp: McpSettings,
  projects: ProjectSettings,
  schedules: ScheduleSettings,
  usage: UsageSettings,
  voice: VoiceSettings,
  appearance: AppearanceSettings,
  keyboard: KeyboardSettings,
  admin: AdminSettings,
};

// Phones get a drill-in index at /settings. Desktop has no index: its rail shows General there.
function MobileIndex({ sections }: { sections: ReturnType<typeof useSettingsSections> }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:hidden">
      <div className="flex h-12 shrink-0 items-center px-3">
        <Link href="/" className="text-sidebar-muted-foreground hover:bg-sidebar-row-hover flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm">
          <ArrowLeftIcon className="size-4" /> Back to chat
        </Link>
      </div>
      <h1 className="px-4 pt-2 pb-3 text-xl font-semibold">Settings</h1>
      <div className="bg-card divide-border mx-4 mb-6 flex flex-col divide-y overflow-hidden rounded-xl shadow-[var(--depth-highlight),var(--shadow-raised)]">
        {sections.map((s) => (
          <Link
            key={s.id}
            href={`/settings/${s.id}`}
            className="flex min-h-11 items-center gap-3 px-4 py-2.5 text-sm transition-colors duration-(--motion-fast) active:bg-accent"
          >
            <s.icon className="text-muted-foreground size-4 shrink-0" />
            <span className="flex-1">{s.label}</span>
            <ChevronRightIcon className="text-muted-foreground size-4 shrink-0" />
          </Link>
        ))}
      </div>
    </div>
  );
}

export function SettingsLayout({ section }: { section?: string }) {
  const sections = useSettingsSections();
  // No section means /settings. Desktop shows General there; phones show the index instead.
  const current = sections.find((s) => s.id === section) ?? sections[0]!;
  const Page = PAGES[current.id]!;

  return (
    <div className="flex h-full min-h-0 flex-1 max-md:flex-col">
      {/* The desktop rail is SettingsNav inside the shell's sidebar panel, so the panel stays put while its contents change. */}
      {section === undefined && <MobileIndex sections={sections} />}
      <main className={cn("min-h-0 flex-1 overflow-y-auto", section === undefined && "max-md:hidden")}>
        {/* Sticky inside main, which is the scroll container, so the bar stays while the page scrolls.
            No title here: the page heading right below already names the section. */}
        {section !== undefined && (
          <header className="bg-background/80 border-border sticky top-0 z-10 flex h-12 items-center border-b px-2 backdrop-blur md:hidden">
            <Link href="/settings" className="text-muted-foreground hover:text-foreground flex min-h-11 items-center gap-1 rounded-lg pr-2 text-sm">
              <ChevronLeftIcon className="size-4" /> Settings
            </Link>
          </header>
        )}
        {/* Section changes remount the page, so the entrance replays; no exit animation. */}
        <div key={current.id} className="animate-rise-in">
          <Page />
        </div>
      </main>
    </div>
  );
}
