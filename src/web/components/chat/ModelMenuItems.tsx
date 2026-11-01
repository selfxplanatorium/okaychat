import { ChevronRightIcon } from "lucide-react";
import { MenuContent, MenuItem, MenuSubmenuRoot, MenuSubmenuTrigger } from "@/components/ui/menu";
import { t } from "@/i18n";
import { useModelGroups } from "./ModelPicker";

/** Shared provider submenus keep model choices one hover away in Branch and Retry. */
export function ModelMenuItems({ onSelect }: { onSelect: (ref: string) => void }) {
  const groups = useModelGroups();
  if (!groups.length) return null;
  return (
    <>
      <div className="text-muted-foreground flex items-center gap-2 px-2.5 py-1.5 text-xs" role="presentation">
        <span className="bg-border h-px flex-1" />
        {t("composer.orSwitchModel")}
        <span className="bg-border h-px flex-1" />
      </div>
      {groups.map((group) => (
        <MenuSubmenuRoot key={group.id}>
          <MenuSubmenuTrigger>
            <span className="min-w-0 flex-1 truncate">{group.label}</span>
            <ChevronRightIcon className="text-muted-foreground ms-auto" />
          </MenuSubmenuTrigger>
          <MenuContent side="right" align="start" className="max-h-[min(24rem,var(--available-height))] max-w-[calc(100vw-1rem)]">
            {group.models.map((m) => (
              <MenuItem key={m.ref} onClick={() => onSelect(m.ref)}>
                <span className="min-w-0 truncate">{m.name}</span>
              </MenuItem>
            ))}
          </MenuContent>
        </MenuSubmenuRoot>
      ))}
    </>
  );
}
