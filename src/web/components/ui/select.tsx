import { useCallback } from "react";
import { useGlassSurface } from "@/components/glass/GlassSurface";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { ScrollArea } from "./scroll-area";
import { useSmoothHeight } from "./smooth-height";

export interface SelectOption<T extends string> {
  value: T;
  label: React.ReactNode;
}

/** Small, opinionated select used across settings. */
export function Select<T extends string>({
  value,
  onValueChange,
  options,
  className,
  itemClassName,
  placeholder,
  disabled = false,
  onOpenChange,
  "aria-label": ariaLabel,
}: {
  value: T | null;
  onValueChange: (value: T) => void;
  options: Array<SelectOption<T>>;
  className?: string;
  itemClassName?: string;
  placeholder?: string;
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
  "aria-label"?: string;
}) {
  const current = options.find((o) => o.value === value);
  const smoothHeight = useSmoothHeight();
  const glassRef = useGlassSurface({ source: "active-content", family: "overlay", priority: 100 });
  const materialRef = useCallback((node: HTMLElement | null) => {
    glassRef(node);
    const cleanup = smoothHeight(node);
    return () => { glassRef(null); cleanup?.(); };
  }, [glassRef, smoothHeight]);
  return (
    <SelectPrimitive.Root
      disabled={disabled}
      value={value}
      onValueChange={(v) => v !== null && onValueChange(v as T)}
      onOpenChange={onOpenChange}
    >
      <SelectPrimitive.Trigger
        aria-label={ariaLabel}
        className={cn(
          "bg-muted/60 enabled:hover:bg-muted focus-visible:ring-ring/50 inline-flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-lg border px-2.5 text-sm transition-[color,background-color,border-color,box-shadow] duration-[var(--motion-fast)] ease-out-quart outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50 data-disabled:cursor-not-allowed data-disabled:opacity-50",
          className,
        )}
      >
        <span className="truncate">{current?.label ?? <span className="text-muted-foreground">{placeholder ?? t("common.select")}</span>}</span>
        <ChevronsUpDownIcon className="text-muted-foreground size-3.5 shrink-0" />
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner sideOffset={6} alignItemWithTrigger={false} className="isolate z-50">
          <SelectPrimitive.Popup
            ref={materialRef}
            className={cn(
              "dropdown-glass text-popover-foreground flex max-h-80 min-w-(--anchor-width) origin-(--transform-origin) flex-col overflow-hidden rounded-xl border depth-float outline-none",
              "translate-x-0 translate-y-0 scale-100 transition-[opacity,scale,translate] duration-[var(--motion-base)] ease-out-expo",
              "data-[starting-style]:scale-96 data-[starting-style]:opacity-0",
              // Enters from the trigger's edge and settles outward, so the popup
              // reads as belonging to the control that opened it.
              "data-[side=bottom]:data-[starting-style]:-translate-y-1 data-[side=top]:data-[starting-style]:translate-y-1 data-[side=left]:data-[starting-style]:translate-x-1 data-[side=right]:data-[starting-style]:-translate-x-1",
              "data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[ending-style]:duration-[var(--motion-fast)] data-[ending-style]:ease-in-quart",
              "data-[side=bottom]:data-[ending-style]:-translate-y-0.5 data-[side=top]:data-[ending-style]:translate-y-0.5 data-[side=left]:data-[ending-style]:translate-x-0.5 data-[side=right]:data-[ending-style]:-translate-x-0.5",
            )}
          >
            <ScrollArea viewportClassName="p-1">
              {options.map((o) => (
                <SelectPrimitive.Item
                  key={o.value}
                  value={o.value}
                  className={cn("data-highlighted:depth-primary data-highlighted:text-primary-foreground data-highlighted:[&_.text-muted-foreground]:text-primary-foreground flex cursor-default items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 pointer-coarse:py-2.5 text-sm outline-none select-none transition-colors duration-[var(--motion-instant)] ease-out-quart",itemClassName)}
                >
                  <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
                  <SelectPrimitive.ItemIndicator className="transition-[opacity,scale] duration-[var(--motion-base)] ease-spring data-[starting-style]:scale-0 data-[starting-style]:opacity-0">
                    <CheckIcon className="size-3.5" />
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              ))}
            </ScrollArea>
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
