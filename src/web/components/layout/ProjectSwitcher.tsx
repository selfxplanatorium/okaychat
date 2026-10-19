import { useAui } from "@assistant-ui/react";
import { CheckIcon, ChevronsUpDownIcon, FolderIcon, LayersIcon, SettingsIcon } from "lucide-react";
import { useLocation } from "wouter";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { useData } from "@/state/data";

/** Picks the project the sidebar shows and new chats belong to. */
export function ProjectSwitcher() {
  const projects = useData((s) => s.projects);
  const active = useData((s) => s.activeProject);
  const setActive = useData((s) => s.setActiveProject);
  const aui = useAui();
  const [, navigate] = useLocation();
  const current = projects.find((p) => p.id === active);

  const pick = async (id: string | null) => {
    setActive(id);
    await aui.threads.reload();
    aui.threads.switchToNewThread();
    navigate("/");
  };

  return (
    <Menu>
      <MenuTrigger className="hover:bg-sidebar-row-hover text-sidebar-foreground mx-2 mb-1 flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm">
        {current ? <FolderIcon className="size-4 shrink-0" /> : <LayersIcon className="size-4 shrink-0" />}
        <span className="min-w-0 flex-1 truncate font-medium">{current?.name ?? "All chats"}</span>
        <ChevronsUpDownIcon className="text-sidebar-muted-foreground size-3.5 shrink-0" />
      </MenuTrigger>
      <MenuContent className="w-64">
        <MenuItem onClick={() => void pick(null)}>
          <LayersIcon /> All chats {!active && <CheckIcon className="ms-auto" />}
        </MenuItem>
        {projects.map((p) => (
          <MenuItem key={p.id} onClick={() => void pick(p.id)}>
            <FolderIcon /> <span className="truncate">{p.name}</span> {p.id === active && <CheckIcon className="ms-auto" />}
          </MenuItem>
        ))}
        <MenuItem onClick={() => navigate("/settings/projects")}>
          <SettingsIcon /> {projects.length ? "Manage projects" : "Create a project"}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
