import { ArrowLeftIcon, AudioLinesIcon, BarChart3Icon, BlocksIcon, BrainIcon, CalendarClockIcon, FolderIcon, KeyboardIcon, KeyRoundIcon, MailIcon, ShieldIcon, PaletteIcon, SlidersHorizontalIcon, UserRoundIcon } from "lucide-react";
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
  { id: "mcp", labelKey: "settings.sectionMcp", icon: BlocksIcon },
  { id: "projects", labelKey: "settings.sectionProjects", icon: FolderIcon },
  { id: "schedules", labelKey: "settings.sectionScheduled", icon: CalendarClockIcon },
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
        <nav ref={navRef} aria-label={t("common.settings")} className="relative flex flex-col gap-1 p-2">
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
          <ArrowLeftIcon className="size-4" /> {t("settings.backToChat")}
        </Link>
      </div>
    </div>
  );
}
