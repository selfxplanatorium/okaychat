import { useAui, useAuiState } from "@assistant-ui/react";
import { useRef } from "react";
import { t } from "@/i18n";
import { useCommand, useKeyboardDialog, useShortcutProps } from "@/keyboard/registry";
import { SIDEBAR_ITEMS } from "@shared/types";
import { useChatPrivacyStore } from "@/state/chat-privacy";
import { ChatSearch } from "./ChatSearch";
import { CalendarClockIcon, BookOpenIcon, FolderIcon, LibraryIcon, LogOutIcon, PanelLeftIcon, PlusIcon, PuzzleIcon, SearchIcon, SettingsIcon, SquarePenIcon, UserRoundIcon } from "lucide-react";
import { Link, useLocation } from "wouter";
import { ThreadList, ThreadSelectionBar } from "@/components/assistant-ui/elements/thread-list.aui";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { AccountAvatar } from "@/components/ui/account-avatar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { settingsHref } from "@/lib/settings-link";
import { signOut } from "@/lib/sign-out";
import { cn } from "@/lib/utils";
import { showChat, useData } from "@/state/data";
import { prefetchLibrary } from "@/state/library-cache";

import { SettingsNav } from "@/components/settings/SettingsNav";
import { Brand } from "./Brand";
import { SidebarResizeHandle } from "./sidebar-width";
import { GlideHighlight } from "./GlideHighlight";

/**
 * One panel for the whole app. Chat and settings are two layers inside it, so moving
 * between them slides the contents while the surface itself stays still (shell.css).
 */
export function Sidebar({ open, onToggle, settings, section }: { open: boolean; onToggle: () => void; settings: boolean; section?: string }) {
  const aui = useAui();
  const searchOpen = useKeyboardDialog((s) => s.open === "search");
  const toggleDialog = useKeyboardDialog((s) => s.toggle);
  const setSearchOpen = (open: boolean) => open !== searchOpen && toggleDialog("search");
  const visibleItems = useData((s) => s.settings?.sidebarItems) ?? SIDEBAR_ITEMS;
  const empty = useAuiState((s) => s.thread.isEmpty);
  useCommand("app.search", () => toggleDialog("search"), !settings);
  const searchHint = useShortcutProps("app.search", t("sidebar.searchChats"));
  const closeHint = useShortcutProps("app.toggleSidebar", t("sidebar.closeSidebar"));
  const me = useData((s) => s.me);
  const panelRef = useRef<HTMLDivElement>(null);
  // Settings keeps the panel open on desktop; leaving returns it to the chat's own open state.
  const shown = open || settings;
  const [location, navigate] = useLocation();
  const rowClass = "relative hover:bg-sidebar-row-hover focus-visible:outline-ring flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm pointer-coarse:min-h-11 active:bg-sidebar-row-hover transition-colors duration-(--motion-fast) ease-out-quart";
  return (
    <>
      <ChatSearch open={searchOpen} onOpenChange={setSearchOpen} />
      <aside
        data-open={shown}
        className={cn(
          "shell-sidebar text-sidebar-foreground border-sidebar-border panel-transition relative flex h-full shrink-0 flex-col overflow-hidden transition-[width,margin]",
          shown ? "w-(--sidebar-width)" : "w-0",
          // On mobile the rail is an overlay: it keeps its width and slides off screen.
          // Visibility is transitioned too: the hidden drawer keeps its shadow until it has slid off, then disappears.
          // Tailwind translate-* sets `translate`, not `transform`, so that is the property to animate.
          "max-md:bg-sidebar max-md:safe-top max-md:safe-bottom max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:w-[min(18rem,85vw)] max-md:border-r max-md:shadow-xl max-md:transition-[translate,visibility]",
          open ? "max-md:translate-x-0" : "max-md:-translate-x-full max-md:invisible",
          // Phones have their own settings index, so the drawer stays out of the way there.
          settings && "max-md:hidden",
        )}
      >
        {/* Floating or docked comes from html[data-sidebar]; shell.css morphs between the two. */}
        <div className="shell-sidebar-inner sidebar-surface relative h-full shrink-0 overflow-hidden max-md:w-full">
          <div ref={panelRef} data-layer="chat" data-active={!settings} inert={settings} className="sidebar-layer absolute inset-0 flex flex-col">
            <div className="flex h-12 shrink-0 items-center justify-between px-3">
              <Link href="/" onClick={(event) => { event.preventDefault(); showChat(navigate); }}>
                <Brand />
              </Link>
              <div className="flex items-center gap-1">
              <button type="button" onClick={() => setSearchOpen(true)} aria-label={t("sidebar.searchChats")} {...searchHint} className="text-sidebar-muted-foreground hover:bg-sidebar-row-hover focus-visible:outline-ring rounded-lg p-1.5 pointer-coarse:p-2.5">
                <SearchIcon className="size-4" />
              </button>
              <button
                type="button"
                onClick={onToggle}
                aria-label={t("sidebar.closeSidebar")}
                {...closeHint}
                className="text-sidebar-muted-foreground hover:bg-sidebar-row-hover rounded-lg p-1.5 pointer-coarse:p-2.5 transition-colors duration-(--motion-fast) ease-out-quart"
              >
                <PanelLeftIcon className="size-4" />
              </button>
              </div>
            </div>
            <nav aria-label={t("sidebar.mainNavigation")} className="glide-host flex flex-col gap-0.5 px-2 pt-2 pb-4">
              <GlideHighlight />
              {visibleItems.includes("newChat") && <button type="button" data-glide aria-current={location === "/" && empty ? "page" : undefined} className={cn(rowClass, location === "/" && empty && "bg-sidebar-row-hover")} onClick={async () => {
                await aui.threads.switchToNewThread();
                useChatPrivacyStore.getState().set(aui.threadListItem.getState().id, { temporary: false, personalized: true });
                showChat(navigate);
              }}><SquarePenIcon className="size-4 shrink-0" /> {t("common.newChat")}</button>}
              {([
                { id: "scheduled", label: "sidebar.scheduled", href: "/scheduled", icon: CalendarClockIcon, create: { command: "nav.createSchedule", label: "ux.newScheduleQuick", href: "/scheduled?new=1" } },
                { id: "library", label: "sidebar.library", href: "/library", icon: LibraryIcon },
                { id: "knowledge", label: "sidebar.knowledge", href: "/knowledge", icon: BookOpenIcon },
                { id: "plugins", label: "sidebar.plugins", href: "/plugins", icon: PuzzleIcon },
                { id: "projects", label: "sidebar.projects", href: "/projects", icon: FolderIcon, create: { command: "nav.createProject", label: "ux.newProjectQuick", href: "/projects?new=1" } },
              ] as const).filter((item) => visibleItems.includes(item.id)).map((item) => (
                <div key={item.id} className="flex items-center gap-0.5">
                  <Link
                    data-glide
                    href={item.href}
                    aria-current={location === item.href ? "page" : undefined}
                    className={cn(rowClass, "min-w-0 flex-1", location === item.href && "bg-sidebar-row-hover")}
                    // Start the Library's first page while the pointer heads for the click, so it opens with data.
                    {...(item.id === "library" ? { onPointerEnter: prefetchLibrary, onFocus: prefetchLibrary, onPointerDown: prefetchLibrary } : {})}
                  >
                    <item.icon className="size-4 shrink-0" /> {t(item.label)}
                  </Link>
                  {"create" in item && (
                    // Sibling, never inside the Link: the row keeps opening its page while this opens the form.
                    <button
                      type="button"
                      data-command={item.create.command}
                      onClick={() => navigate(item.create.href)}
                      aria-label={t(item.create.label)}
                      title={t(item.create.label)}
                      className="text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-ring inline-flex size-8 pointer-coarse:size-11 shrink-0 items-center justify-center rounded-lg transition-colors duration-(--motion-fast) ease-out-quart"
                    >
                      <PlusIcon className="size-4" />
                    </button>
                  )}
                </div>
              ))}
            </nav>
            <ProjectSwitcher />
            <ScrollArea
              className="min-h-0 flex-1"
              viewportProps={{
                style: { maskImage: "linear-gradient(to bottom, transparent, black var(--chat-list-fade, 0px))" },
                onScroll: (event) => {
                  const list = event.currentTarget;
                  list.style.setProperty("--chat-list-fade", `${Math.min(24, Math.max(0, list.scrollTop))}px`);
                },
              }}
            >
              <div
                className="glide-host px-2"
                // Arrows move between chats, like a list. Rows are focusable one by one, so Tab still walks them too.
                onKeyDown={(event) => {
                  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
                  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-slot=aui_thread-list-item-trigger], [data-slot=aui_thread-list-item-select]")];
                  const index = rows.indexOf(event.target as HTMLElement);
                  if (index === -1) return;
                  const next =
                    event.key === "ArrowDown" ? rows[index + 1] :
                    event.key === "ArrowUp" ? rows[index - 1] :
                    event.key === "Home" ? rows[0] :
                    event.key === "End" ? rows.at(-1) : undefined;
                  if (!next) return;
                  event.preventDefault();
                  next.focus();
                }}
                // Only opening a chat leaves the current page. Row menus are portaled, but their clicks still bubble here.
                onClick={(event) => {
                  if ((event.target as Element).closest?.("[data-slot=aui_thread-list-item-trigger]")) showChat(navigate);
                }}
              >
                <GlideHighlight />
                <ThreadList />
              </div>
            </ScrollArea>
            <ThreadSelectionBar scope={panelRef} />
            <div className="border-sidebar-border flex items-center gap-1 border-t p-2">
              <Menu>
                <MenuTrigger className="hover:bg-sidebar-row-hover flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors duration-(--motion-fast) ease-out-quart">
                  <AccountAvatar user={me} className="size-7 [&_[data-slot=avatar-fallback]]:text-xs" />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{me?.name}</span>
                    <span className="text-sidebar-muted-foreground block truncate text-xs">{me?.email}</span>
                  </span>
                </MenuTrigger>
                <MenuContent side="top" className="w-60">
                  <MenuItem onClick={() => navigate(settingsHref("account"))}>
                    <UserRoundIcon /> {t("sidebar.account")}
                  </MenuItem>
                  <MenuItem onClick={() => navigate("/settings")}>
                    <SettingsIcon /> {t("common.settings")}
                  </MenuItem>
                  <MenuItem onClick={() => void signOut()}>
                    <LogOutIcon /> {t("sidebar.logOut")}
                  </MenuItem>
                </MenuContent>
              </Menu>
              <Link
                href="/settings"
                aria-label={t("common.settings")}
                className="text-sidebar-muted-foreground hover:bg-sidebar-row-hover rounded-lg p-2 pointer-coarse:p-3 transition-colors duration-(--motion-fast) ease-out-quart"
              >
                <SettingsIcon className="size-4" />
              </Link>
            </div>
          </div>
          <div data-layer="settings" data-active={settings} inert={!settings} className="sidebar-layer absolute inset-0 max-md:hidden">
            <SettingsNav section={section} />
          </div>
        </div>
        {shown && <SidebarResizeHandle />}
      </aside>
    </>
  );
}
