import { ArrowLeftIcon, BarChart3Icon, BlocksIcon, KeyRoundIcon, PaletteIcon, SlidersHorizontalIcon } from "lucide-react";
import type { ComponentType } from "react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { AppearanceSettings } from "./AppearanceSettings";
import { GeneralSettings } from "./GeneralSettings";
import { McpSettings } from "./McpSettings";
import { ProvidersSettings } from "./ProvidersSettings";
import { UsageSettings } from "./UsageSettings";

const SECTIONS: Array<{ id: string; label: string; icon: ComponentType<{ className?: string }>; component: ComponentType }> = [
  { id: "general", label: "General", icon: SlidersHorizontalIcon, component: GeneralSettings },
  { id: "providers", label: "Providers", icon: KeyRoundIcon, component: ProvidersSettings },
  { id: "mcp", label: "MCP servers", icon: BlocksIcon, component: McpSettings },
  { id: "usage", label: "Usage", icon: BarChart3Icon, component: UsageSettings },
  { id: "appearance", label: "Appearance", icon: PaletteIcon, component: AppearanceSettings },
];

export function SettingsLayout({ section }: { section: string }) {
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]!;
  const Page = current.component;
  return (
    <div className="flex h-full min-h-0 flex-1 max-md:flex-col">
      <nav className="bg-sidebar border-sidebar-border flex shrink-0 gap-1 border-r p-2 md:w-56 md:flex-col max-md:overflow-x-auto max-md:border-r-0 max-md:border-b">
        <Link href="/" className="text-sidebar-muted-foreground hover:bg-sidebar-row-hover mb-2 flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm max-md:mb-0">
          <ArrowLeftIcon className="size-4" /> Back to chat
        </Link>
        {SECTIONS.map((s) => (
          <Link
            key={s.id}
            href={`/settings/${s.id}`}
            className={cn(
              "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm whitespace-nowrap",
              s.id === current.id ? "bg-sidebar-row-active text-sidebar-foreground font-medium" : "text-sidebar-muted-foreground hover:bg-sidebar-row-hover",
            )}
          >
            <s.icon className="size-4" /> {s.label}
          </Link>
        ))}
      </nav>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <Page />
      </main>
    </div>
  );
}
