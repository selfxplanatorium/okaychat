import { Select as SelectPrimitive } from "@base-ui/react/select";
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";

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
  placeholder,
  "aria-label": ariaLabel,
}: {
  value: T | null;
  onValueChange: (value: T) => void;
  options: Array<SelectOption<T>>;
  className?: string;
  placeholder?: string;
  "aria-label"?: string;
}) {
  const current = options.find((o) => o.value === value);
  return (
    <SelectPrimitive.Root value={value} onValueChange={(v) => v !== null && onValueChange(v as T)}>
      <SelectPrimitive.Trigger
        aria-label={ariaLabel}
        className={cn(
          "bg-muted/60 hover:bg-muted focus-visible:ring-ring/50 inline-flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-2",
          className,
        )}
      >
        <span className="truncate">{current?.label ?? <span className="text-muted-foreground">{placeholder ?? "Select"}</span>}</span>
        <ChevronsUpDownIcon className="text-muted-foreground size-3.5 shrink-0" />
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner sideOffset={6} alignItemWithTrigger={false} className="isolate z-50">
          <SelectPrimitive.Popup className="dropdown-glass text-popover-foreground data-open:animate-in data-open:fade-in-0 max-h-80 min-w-(--anchor-width) overflow-y-auto rounded-xl border p-1 shadow-lg outline-none">
            {options.map((o) => (
              <SelectPrimitive.Item
                key={o.value}
                value={o.value}
                className="data-highlighted:bg-accent data-highlighted:text-accent-foreground flex cursor-default items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none"
              >
                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator>
                  <CheckIcon className="size-3.5" />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
