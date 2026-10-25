import { useAui, useAuiState } from "@assistant-ui/react";
import { useRef } from "react";
import { useCommand, useKeyboardDialog, useShortcutProps } from "@/keyboard/registry";
import { SIDEBAR_ITEMS } from "@shared/types";
import { useChatPrivacyStore } from "@/state/chat-privacy";
import { ChatSearch } from "./ChatSearch";
import { CalendarClockIcon, FolderIcon, LibraryIcon, LogOutIcon, PanelLeftIcon, PuzzleIcon, SearchIcon, SettingsIcon, SquarePenIcon, UserRoundIcon } from "lucide-react";
import { Link, useLocation } from "wouter";
import { ThreadList, ThreadSelectionBar } from "@/components/assistant-ui/elements/thread-list.aui";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { AccountAvatar } from "@/components/ui/account-avatar";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useData } from "@/state/data";

import { Brand } from "./Brand";
import { GlideHighlight } from "./GlideHighlight";

export function Sidebar({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const aui = useAui();
  const searchOpen = useKeyboardDialog((s) => s.open === "search");
  const toggleDialog = useKeyboardDialog((s) => s.toggle);
  const setSearchOpen = (open: boolean) => open !== searchOpen && toggleDialog("search");
  const visibleItems = useData((s) => s.settings?.sidebarItems) ?? SIDEBAR_ITEMS;
  const empty = useAuiState((s) => s.thread.isEmpty);
  useCommand("app.search", () => toggleDialog("search"));
  const searchHint = useShortcutProps("app.search", "Search chats");
  const closeHint = useShortcutProps("app.toggleSidebar", "Close sidebar");
  const me = useData((s) => s.me);
  const panelRef = useRef<HTMLDivElement>(null);
  const [location, navigate] = useLocation();
  const rowClass = "relative hover:bg-sidebar-row-hover focus-visible:outline-ring flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm pointer-coarse:min-h-11 active:bg-sidebar-row-hover transition-colors duration-(--motion-fast) ease-out-quart";
  return (
    <>
      <ChatSearch open={searchOpen} onOpenChange={setSearchOpen} />
      <aside
        data-open={open}
        className={cn(
          "shell-sidebar text-sidebar-foreground border-sidebar-border panel-transition flex h-full shrink-0 flex-col overflow-hidden transition-[width,margin]",
          open ? "w-72" : "w-0",
          // On mobile the rail is an overlay: it keeps its width and slides off screen.
          // Visibility is transitioned too: the hidden drawer keeps its shadow until it has slid off, then disappears.
          // Tailwind translate-* sets `translate`, not `transform`, so that is the property to animate.
          "max-md:bg-sidebar max-md:safe-top max-md:safe-bottom max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:w-[min(18rem,85vw)] max-md:border-r max-md:shadow-xl max-md:transition-[translate,visibility]",
          open ? "max-md:translate-x-0" : "max-md:-translate-x-full max-md:invisible",
        )}
      >
        {/* On desktop the panel floats inside the rail, inset from the window edge. */}
        <div ref={panelRef} className="shell-sidebar-inner md:depth-sidebar flex h-full w-72 shrink-0 max-md:w-full flex-col md:m-2 md:h-[calc(100%-1rem)] md:w-[calc(18rem-1rem)] md:rounded-2xl">
          <div className="flex h-12 shrink-0 items-center justify-between px-3">
            <Link href="/" onClick={() => location !== "/" && navigate("/")}>
              <Brand />
            </Link>
            <div className="flex items-center gap-1">
            <button type="button" onClick={() => setSearchOpen(true)} aria-label="Search chats" {...searchHint} className="text-sidebar-muted-foreground hover:bg-sidebar-row-hover focus-visible:outline-ring rounded-lg p-1.5 pointer-coarse:p-2.5">
              <SearchIcon className="size-4" />
            </button>
            <button
              type="button"
              onClick={onToggle}
              aria-label="Close sidebar"
              {...closeHint}
              className="text-sidebar-muted-foreground hover:bg-sidebar-row-hover rounded-lg p-1.5 pointer-coarse:p-2.5 transition-colors duration-(--motion-fast) ease-out-quart"
            >
              <PanelLeftIcon className="size-4" />
            </button>
            </div>
          </div>
          <nav aria-label="Main navigation" className="glide-host flex flex-col gap-0.5 px-2 pt-2 pb-4">
            <GlideHighlight />
            {visibleItems.includes("newChat") && <button type="button" data-glide aria-current={location === "/" && empty ? "page" : undefined} className={cn(rowClass, location === "/" && empty && "bg-sidebar-row-hover")} onClick={async () => {
              await aui.threads.switchToNewThread();
              useChatPrivacyStore.getState().set(aui.threadListItem.getState().id, { temporary: false, personalized: true });
              navigate("/");
            }}><SquarePenIcon className="size-4 shrink-0" /> New chat</button>}
            {([
              { id: "scheduled", label: "Scheduled", href: "/scheduled", icon: CalendarClockIcon },
              { id: "library", label: "Library", href: "/library", icon: LibraryIcon },
              { id: "plugins", label: "Plugins", href: "/plugins", icon: PuzzleIcon },
              { id: "projects", label: "Projects", href: "/projects", icon: FolderIcon },
            ] as const).filter((item) => visibleItems.includes(item.id)).map((item) => (
              <Link
                key={item.id}
                data-glide
                href={item.href}
                aria-current={location === item.href ? "page" : undefined}
                className={cn(rowClass, location === item.href && "bg-sidebar-row-hover")}
              >
                <item.icon className="size-4 shrink-0" /> {item.label}
              </Link>
            ))}
          </nav>
          <ProjectSwitcher />
          <div
            className="glide-host min-h-0 flex-1 overflow-y-auto overscroll-contain px-2"
            style={{ maskImage: "linear-gradient(to bottom, transparent, black var(--chat-list-fade, 0px))" }}
            onScroll={(event) => {
              const list = event.currentTarget;
              list.style.setProperty("--chat-list-fade", `${Math.min(24, Math.max(0, list.scrollTop))}px`);
            }}
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
              if (location !== "/" && (event.target as Element).closest?.("[data-slot=aui_thread-list-item-trigger]")) navigate("/");
            }}
          >
            <GlideHighlight />
            <ThreadList />
          </div>
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
                <MenuItem onClick={() => navigate("/settings/account")}>
                  <UserRoundIcon /> Account
                </MenuItem>
                <MenuItem onClick={() => navigate("/settings")}>
                  <SettingsIcon /> Settings
                </MenuItem>
                <MenuItem
                  onClick={async () => {
                    await api("/auth/logout", { method: "POST" });
                    window.location.href = "/";
                  }}
                >
                  <LogOutIcon /> Log out
                </MenuItem>
              </MenuContent>
            </Menu>
            <Link
              href="/settings"
              aria-label="Settings"
              className="text-sidebar-muted-foreground hover:bg-sidebar-row-hover rounded-lg p-2 pointer-coarse:p-3 transition-colors duration-(--motion-fast) ease-out-quart"
            >
              <SettingsIcon className="size-4" />
            </Link>
          </div>
        </div>
      </aside>
    </>
  );
}
