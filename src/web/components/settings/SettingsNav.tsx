import { ArrowLeftIcon, AudioLinesIcon, BarChart3Icon, BlocksIcon, BrainIcon, CalendarClockIcon, FolderIcon, KeyboardIcon, KeyRoundIcon, MailIcon, ShieldIcon, PaletteIcon, SlidersHorizontalIcon, UserRoundIcon, WebhookIcon, WorkflowIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from "react";
import { Link } from "wouter";
import { ScrollArea } from "@/components/ui/scroll-area";
import { t, type PlainMessageKey } from "@/i18n";
import { cn } from "@/lib/utils";
import { useData } from "@/state/data";

// Light on purpose: the chat sidebar hosts this rail, while the pages themselves load lazily in SettingsLayout.
const SETTINGS_SECTIONS: Array<{ id: string; labelKey: PlainMessageKey; icon: ComponentType<{ className?: string }>; admin?: boolean }> = [
  { id: "general", labelKey: "settings.sectionGeneral", icon: SlidersHorizontalIcon },
  { id: "account", labelKey: "settings.sectionAccount", icon: UserRoundIcon },
  { id: "memory", labelKey: "settings.sectionMemory", icon: BrainIcon },
  { id: "email", labelKey: "settings.sectionEmail", icon: MailIcon },
  { id: "providers", labelKey: "settings.sectionProviders", icon: KeyRoundIcon },
  { id: "apiAccess", labelKey: "settings.sectionApiAccess", icon: KeyRoundIcon },
  { id: "mcp", labelKey: "settings.sectionMcp", icon: BlocksIcon },
  { id: "agents", labelKey: "settings.sectionAgents", icon: WorkflowIcon },
  { id: "projects", labelKey: "settings.sectionProjects", icon: FolderIcon },
  { id: "schedules", labelKey: "settings.sectionScheduled", icon: CalendarClockIcon },
  { id: "webhooks", labelKey: "settings.sectionWebhooks", icon: WebhookIcon },
  { id: "usage", labelKey: "settings.sectionUsage", icon: BarChart3Icon },
  { id: "voice", labelKey: "settings.sectionVoice", icon: AudioLinesIcon },
  { id: "appearance", labelKey: "settings.sectionAppearance", icon: PaletteIcon },
  { id: "keyboard", labelKey: "settings.sectionKeyboard", icon: KeyboardIcon },
  { id: "admin", labelKey: "settings.sectionAdmin", icon: ShieldIcon, admin: true },
];

export function useSettingsSections() {
  const isAdmin = useData((s) => s.me?.role === "admin");
  return SETTINGS_SECTIONS.filter((s) => !s.admin || isAdmin).map((s) => ({ ...s, label: t(s.labelKey) }));
}

/** Desktop settings rail, drawn inside the sidebar panel. Phones use SettingsLayout's index instead. */
export function SettingsNav({ section }: { section?: string }) {
  const sections = useSettingsSections();
  // No section means /settings, which shows General on desktop.
  const current = sections.find((s) => s.id === section) ?? sections[0]!;

  return (
    <div className="flex h-full flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <nav aria-label={t("common.settings")} className="flex flex-col gap-1 p-2">
          {sections.map((s) => (
            <Link
              key={s.id}
              href={`/settings/${s.id}`}
              aria-current={s.id === current.id ? "page" : undefined}
              className={cn(
                "relative flex shrink-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm whitespace-nowrap transition-colors duration-(--motion-fast)",
                s.id === current.id ? "depth-row-active text-sidebar-foreground font-medium" : "text-sidebar-muted-foreground hover:bg-sidebar-row-hover",
              )}
            >
              <s.icon className="size-4" /> {s.label}
            </Link>
          ))}
        </nav>
      </ScrollArea>
      {/* Anchored like the chat sidebar's account footer, outside the scrolling list. h-12 matches that footer's
          account row, so the divider holds still while the two layers slide past each other. */}
      <div className="border-sidebar-border border-t p-2">
        <Link
          href="/"
          className="text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground flex h-12 items-center gap-2 rounded-lg px-2.5 text-sm whitespace-nowrap transition-colors duration-(--motion-fast)"
        >
          <ArrowLeftIcon className="size-4" /> {t("settings.backToChat")}
        </Link>
      </div>
    </div>
  );
}
