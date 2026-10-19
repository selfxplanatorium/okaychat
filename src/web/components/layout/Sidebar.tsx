import { LogOutIcon, PanelLeftIcon, SettingsIcon } from "lucide-react";
import { Link, useLocation } from "wouter";
import { ThreadList } from "@/components/assistant-ui/elements/thread-list.aui";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useData } from "@/state/data";

import { Brand } from "./Brand";

export function Sidebar({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const me = useData((s) => s.me);
  const [location, navigate] = useLocation();
  return (
    <aside
      data-open={open}
      className={cn(
        "shell-sidebar bg-sidebar text-sidebar-foreground border-sidebar-border panel-transition flex h-full shrink-0 flex-col overflow-hidden border-r transition-[width,margin]",
        open ? "w-72" : "w-0 border-r-0",
        // On mobile the rail is an overlay: it keeps its width and slides off screen.
        "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:w-72 max-md:shadow-xl max-md:transition-transform",
        open ? "max-md:translate-x-0" : "max-md:-translate-x-full",
      )}
    >
      <div className="shell-sidebar-inner flex h-full w-72 shrink-0 flex-col">
        <div className="flex h-12 shrink-0 items-center justify-between px-3">
          <Link href="/" onClick={() => location !== "/" && navigate("/")}>
            <Brand />
          </Link>
          <button
            type="button"
            onClick={onToggle}
            aria-label="Close sidebar"
            className="text-sidebar-muted-foreground hover:bg-sidebar-row-hover rounded-lg p-1.5 transition-colors duration-(--motion-fast) ease-out-quart"
          >
            <PanelLeftIcon className="size-4" />
          </button>
        </div>
        <ProjectSwitcher />
        <div className="min-h-0 flex-1 overflow-y-auto px-2" onClick={() => location !== "/" && navigate("/")}>
          <ThreadList />
        </div>
        <div className="border-sidebar-border flex items-center gap-1 border-t p-2">
          <Menu>
            <MenuTrigger className="hover:bg-sidebar-row-hover flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors duration-(--motion-fast) ease-out-quart">
              <span className="bg-primary text-primary-foreground grid size-7 shrink-0 place-items-center rounded-full text-xs font-medium uppercase">
                {me?.name.slice(0, 1)}
              </span>
              <span className="min-w-0">
                <span className="block truncate font-medium">{me?.name}</span>
                <span className="text-sidebar-muted-foreground block truncate text-xs">{me?.email}</span>
              </span>
            </MenuTrigger>
            <MenuContent side="top" className="w-60">
              <MenuItem onClick={() => navigate("/settings/general")}>
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
            href="/settings/general"
            aria-label="Settings"
            className="text-sidebar-muted-foreground hover:bg-sidebar-row-hover rounded-lg p-2 transition-colors duration-(--motion-fast) ease-out-quart"
          >
            <SettingsIcon className="size-4" />
          </Link>
        </div>
      </div>
    </aside>
  );
}
