import { ArrowLeftIcon, BarChart3Icon, BlocksIcon, BrainIcon, CalendarClockIcon, ChevronLeftIcon, ChevronRightIcon, FolderIcon, KeyRoundIcon, ShieldIcon, PaletteIcon, SlidersHorizontalIcon, UserRoundIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from "react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { useData } from "@/state/data";
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

const SECTIONS: Array<{ id: string; label: string; icon: ComponentType<{ className?: string }>; component: ComponentType; admin?: boolean }> = [
  { id: "general", label: "General", icon: SlidersHorizontalIcon, component: GeneralSettings },
  { id: "account", label: "Account", icon: UserRoundIcon, component: AccountSettings },
  { id: "memory", label: "Memory", icon: BrainIcon, component: MemorySettings },
  { id: "providers", label: "Providers", icon: KeyRoundIcon, component: ProvidersSettings },
  { id: "mcp", label: "MCP servers", icon: BlocksIcon, component: McpSettings },
  { id: "projects", label: "Projects", icon: FolderIcon, component: ProjectSettings },
  { id: "schedules", label: "Scheduled", icon: CalendarClockIcon, component: ScheduleSettings },
  { id: "usage", label: "Usage", icon: BarChart3Icon, component: UsageSettings },
  { id: "appearance", label: "Appearance", icon: PaletteIcon, component: AppearanceSettings },
  { id: "admin", label: "Admin", icon: ShieldIcon, component: AdminSettings, admin: true },
];

type Pill = { x: number; y: number; width: number; height: number };

// Phones get a drill-in index at /settings. Desktop has no index: its rail shows General there.
function MobileIndex({ sections }: { sections: typeof SECTIONS }) {
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
  const isAdmin = useData((s) => s.me?.role === "admin");
  const sections = SECTIONS.filter((s) => !s.admin || isAdmin);
  // No section means /settings. Desktop shows General there; phones show the index instead.
  const current = sections.find((s) => s.id === section) ?? sections[0]!;
  const Page = current.component;

  const navRef = useRef<HTMLElement>(null);
  const itemRefs = useRef(new Map<string, HTMLAnchorElement>());
  const [pill, setPill] = useState<Pill | null>(null);
  // The first measurement must land without a transition, or the pill slides in
  // from the nav's top-left corner on mount.
  const [slide, setSlide] = useState(false);

  useLayoutEffect(() => {
    const nav = navRef.current;
    const item = itemRefs.current.get(current.id);
    if (!nav || !item) return;
    const measure = () =>
      setPill({ x: item.offsetLeft, y: item.offsetTop, width: item.offsetWidth, height: item.offsetHeight });
    measure();
    // Fonts, scrollbars, and the admin section appearing all change geometry.
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    observer.observe(item);
    return () => observer.disconnect();
  }, [current.id, isAdmin]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setSlide(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-1 max-md:flex-col">
      {/* Desktop rail. Same inset panel as the chat sidebar, so the two line up at the same width. Phones use MobileIndex and the top bar. */}
      <nav
        ref={navRef}
        className="md:depth-sidebar relative flex shrink-0 gap-1 p-2 max-md:hidden md:m-2 md:h-[calc(100%-1rem)] md:w-[calc(18rem-1rem)] md:flex-col md:rounded-2xl"
      >
        {/* A single pill moves between sections; items paint above it. */}
        {pill && (
          <span
            aria-hidden
            className={cn(
              "depth-row-active pointer-events-none absolute top-0 left-0 rounded-lg will-change-transform",
              slide && "transition-transform duration-(--motion-base) ease-out-expo",
            )}
            style={{ width: pill.width, height: pill.height, transform: `translate3d(${pill.x}px, ${pill.y}px, 0)` }}
          />
        )}
        {/* Same h-12 row and inset as the chat sidebar header. */}
        <Link
          href="/"
          className="text-sidebar-muted-foreground hover:bg-sidebar-row-hover relative mb-1 flex h-12 shrink-0 items-center gap-2 rounded-lg px-3 text-sm whitespace-nowrap transition-colors duration-(--motion-fast)"
        >
          <ArrowLeftIcon className="size-4" /> Back to chat
        </Link>
        {sections.map((s) => (
          <Link
            key={s.id}
            ref={(node) => {
              if (node) itemRefs.current.set(s.id, node);
              else itemRefs.current.delete(s.id);
            }}
            href={`/settings/${s.id}`}
            className={cn(
              "relative flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm whitespace-nowrap transition-colors duration-(--motion-fast)",
              s.id === current.id ? "text-sidebar-foreground font-medium" : "text-sidebar-muted-foreground hover:bg-sidebar-row-hover",
            )}
          >
            <s.icon className="size-4" /> {s.label}
          </Link>
        ))}
      </nav>
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
