import { ArrowLeftIcon, AudioLinesIcon, BarChart3Icon, BlocksIcon, BrainIcon, CalendarClockIcon, FolderIcon, KeyboardIcon, KeyRoundIcon, ShieldIcon, PaletteIcon, SlidersHorizontalIcon, UserRoundIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from "react";
import { Link } from "wouter";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useData } from "@/state/data";

// Light on purpose: the chat sidebar hosts this rail, while the pages themselves load lazily in SettingsLayout.
const SETTINGS_SECTIONS: Array<{ id: string; label: string; icon: ComponentType<{ className?: string }>; admin?: boolean }> = [
  { id: "general", label: "General", icon: SlidersHorizontalIcon },
  { id: "account", label: "Account", icon: UserRoundIcon },
  { id: "memory", label: "Memory", icon: BrainIcon },
  { id: "providers", label: "Providers", icon: KeyRoundIcon },
  { id: "mcp", label: "MCP servers", icon: BlocksIcon },
  { id: "projects", label: "Projects", icon: FolderIcon },
  { id: "schedules", label: "Scheduled", icon: CalendarClockIcon },
  { id: "usage", label: "Usage", icon: BarChart3Icon },
  { id: "voice", label: "Voice", icon: AudioLinesIcon },
  { id: "appearance", label: "Appearance", icon: PaletteIcon },
  { id: "keyboard", label: "Keyboard", icon: KeyboardIcon },
  { id: "admin", label: "Admin", icon: ShieldIcon, admin: true },
];

export function useSettingsSections() {
  const isAdmin = useData((s) => s.me?.role === "admin");
  return SETTINGS_SECTIONS.filter((s) => !s.admin || isAdmin);
}

type Pill = { x: number; y: number; width: number; height: number };

/** Desktop settings rail, drawn inside the sidebar panel. Phones use SettingsLayout's index instead. */
export function SettingsNav({ section }: { section?: string }) {
  const sections = useSettingsSections();
  // No section means /settings, which shows General on desktop.
  const current = sections.find((s) => s.id === section) ?? sections[0]!;

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
    // Fonts, scrollbars, the sidebar width, and the admin section appearing all change geometry.
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    observer.observe(item);
    return () => observer.disconnect();
  }, [current.id, sections.length]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setSlide(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <nav ref={navRef} aria-label="Settings" className="relative flex flex-col gap-1 p-2">
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
          {sections.map((s) => (
            <Link
              key={s.id}
              ref={(node) => {
                if (node) itemRefs.current.set(s.id, node);
                else itemRefs.current.delete(s.id);
              }}
              href={`/settings/${s.id}`}
              className={cn(
                "relative flex shrink-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm whitespace-nowrap transition-colors duration-(--motion-fast)",
                s.id === current.id ? "text-sidebar-foreground font-medium" : "text-sidebar-muted-foreground hover:bg-sidebar-row-hover",
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
          <ArrowLeftIcon className="size-4" /> Back to chat
        </Link>
      </div>
    </div>
  );
}
