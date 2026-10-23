import { ComposerPrimitive } from "@assistant-ui/react";
import { BrainIcon, CheckIcon, ChevronRightIcon, GlobeIcon, GlobeOffIcon, PaperclipIcon, PlusIcon, ZapIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useData } from "@/state/data";
import { useChatModel } from "@/state/thread-meta";
import { useChatSearch } from "@/state/chat-search";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSubmenuRoot, MenuSubmenuTrigger, MenuTrigger } from "@/components/ui/menu";
import { EFFORT_LABELS, useEffortChoices } from "./ModelPicker";

const triggerClass =
  "hover:bg-muted text-muted-foreground hover:text-foreground aria-expanded:bg-muted flex h-7 shrink-0 pointer-coarse:h-9 items-center gap-1 rounded-lg px-2 text-xs font-medium transition-colors duration-(--motion-fast) ease-out-quart";

export function SearchToggle() {
  const { enabled, toggle } = useChatSearch();
  const active = useChatModel();
  const webTools = useData((s) => s.settings?.webTools ?? true);
  if (!active?.toolCall || !webTools) return null;
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={enabled}
      className={cn(
        triggerClass,
        "flex max-sm:hidden pointer-coarse:hidden",
        // Pressed state replaces the trigger's hover colors, so both must be overridden with `!`.
        enabled && "bg-primary/12! text-primary! hover:bg-primary/18!",
      )}
    >
      {enabled ? <GlobeIcon className="size-3.5" /> : <GlobeOffIcon className="size-3.5" />}
      Search
    </button>
  );
}

/** Touch and narrow layout: the plus button opens reasoning, search, and attachment choices in one menu. */
export function MobileComposerMenu() {
  const { active, current, options, set } = useEffortChoices();
  const { enabled, toggle } = useChatSearch();
  const webTools = useData((s) => s.settings?.webTools ?? true);
  const showSearch = !!active?.toolCall && webTools;
  return (
    <div className="hidden shrink-0 max-sm:block pointer-coarse:block">
      <Menu>
        <MenuTrigger
          aria-label="Composer options"
          className="aui-composer-add-attachment text-muted-foreground hover:text-foreground hover:bg-muted-foreground/15 dark:border-muted-foreground/15 dark:hover:bg-muted-foreground/30 size-7 pointer-coarse:size-9 rounded-full flex items-center justify-center transition-[color,background-color,scale] active:scale-[0.96] motion-reduce:transition-none"
        >
          <PlusIcon className="size-4" />
        </MenuTrigger>
        <MenuContent side="top" align="start" className="min-w-52">
          {active?.reasoning && (
            <MenuSubmenuRoot>
              <MenuSubmenuTrigger>
                {current === "none" ? <ZapIcon /> : <BrainIcon />}
                <span className="flex-1">Reasoning: {current ? EFFORT_LABELS[current] : "Default"}</span>
                <ChevronRightIcon className="text-muted-foreground ml-auto" />
              </MenuSubmenuTrigger>
              {/* -5px (border + padding) lines the submenu's top edge up with the parent menu's. */}
              <MenuContent side="right" align="start" alignOffset={-5}>
                <MenuLabel>Reasoning effort</MenuLabel>
                <MenuItem onClick={() => set(undefined)}>
                  <CheckIcon className={cn(!current ? "opacity-100" : "opacity-0")} />
                  Model default
                </MenuItem>
                {options.map((e) => (
                  <MenuItem key={e} onClick={() => set(e)}>
                    <CheckIcon className={cn(current === e ? "opacity-100" : "opacity-0")} />
                    {EFFORT_LABELS[e] ?? e}
                  </MenuItem>
                ))}
              </MenuContent>
            </MenuSubmenuRoot>
          )}
          {showSearch && (
            <MenuItem
              closeOnClick={false}
              onClick={toggle}
              className={cn(enabled && "depth-primary text-primary-foreground")}
            >
              {enabled ? <GlobeIcon /> : <GlobeOffIcon />}
              <span className="flex-1">Search</span>
              <CheckIcon className={cn("ml-auto", enabled ? "opacity-100" : "opacity-0")} />
            </MenuItem>
          )}
          <ComposerPrimitive.AddAttachment render={<MenuItem />}>
            <PaperclipIcon />
            Attach
          </ComposerPrimitive.AddAttachment>
        </MenuContent>
      </Menu>
    </div>
  );
}
