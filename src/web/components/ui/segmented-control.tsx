import { useRef, useState } from "react";
import type { HTMLAttributes, KeyboardEvent, ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface SegmentedControlItem {
  value: string;
  label: ReactNode;
  /** Kept focusable with aria-disabled so the reason stays reachable. */
  disabled?: boolean;
  /** Why this choice is unavailable; shown in a tooltip. */
  reason?: string;
}

export interface SegmentedControlProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "role" | "onChange" | "defaultValue" | "children"> {
  items: ReadonlyArray<SegmentedControlItem>;
  value?: string | null;
  defaultValue?: string | null;
  onValueChange?: (value: string) => void;
  /** The group's accessible name; `aria-label` works too. */
  label?: string;
  disabled?: boolean;
}

/** A radio group drawn as one track: roving tabIndex, direction-aware arrows, Home/End. */
export function SegmentedControl({
  items,
  value: valueProp,
  defaultValue = null,
  onValueChange,
  label,
  disabled = false,
  className,
  onKeyDown,
  ...attributes
}: SegmentedControlProps) {
  const [uncontrolled, setUncontrolled] = useState<string | null>(defaultValue);
  const value = valueProp !== undefined ? valueProp : uncontrolled;
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const usable = (item: SegmentedControlItem) => !disabled && !item.disabled;
  const selected = items.findIndex((item) => item.value === value);
  // With no usable selection the first usable segment takes the tab stop.
  const tabStop = selected >= 0 && usable(items[selected]!) ? selected : items.findIndex(usable);

  const choose = (item: SegmentedControlItem) => {
    if (!usable(item) || item.value === value) return;
    if (valueProp === undefined) setUncontrolled(item.value);
    onValueChange?.(item.value);
  };

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    const from = refs.current.indexOf(document.activeElement as HTMLButtonElement);
    if (from < 0) return;
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const forward = event.key === "ArrowDown" || event.key === (rtl ? "ArrowLeft" : "ArrowRight");
    const backward = event.key === "ArrowUp" || event.key === (rtl ? "ArrowRight" : "ArrowLeft");
    const order = items.map((_, index) => index);
    let candidates: number[];
    if (event.key === "Home") candidates = order;
    else if (event.key === "End") candidates = order.reverse();
    else if (forward) candidates = [...order.slice(from + 1), ...order.slice(0, from)];
    else if (backward) candidates = [...order.slice(0, from).reverse(), ...order.slice(from + 1).reverse()];
    else return;
    const next = candidates.find((index) => usable(items[index]!));
    if (next === undefined) return;
    event.preventDefault();
    refs.current[next]?.focus();
    choose(items[next]!);
  };

  return (
    <div
      {...attributes}
      role="radiogroup"
      aria-label={attributes["aria-label"] ?? label}
      aria-disabled={disabled || undefined}
      onKeyDown={keyDown}
      className={cn("bg-muted inline-flex max-w-full rounded-lg p-0.5", disabled && "opacity-50", className)}
    >
      {items.map((item, index) => {
        const checked = item.value === value;
        const radio = (
          <button
            key={item.value}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-disabled={!usable(item) || undefined}
            tabIndex={index === tabStop ? 0 : -1}
            onClick={() => choose(item)}
            className={cn(
              "focus-visible:ring-ring/50 inline-flex min-h-7 min-w-0 flex-1 items-center justify-center rounded-md px-2.5 text-sm whitespace-nowrap outline-none transition-[color,background-color,box-shadow] duration-(--motion-fast) ease-out-quart focus-visible:ring-2 pointer-coarse:min-h-9",
              checked ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              !usable(item) && "cursor-not-allowed opacity-50",
            )}
          >
            {item.label}
          </button>
        );
        if (!item.reason) return radio;
        return (
          <Tooltip key={item.value}>
            <TooltipTrigger render={radio} />
            <TooltipContent>{item.reason}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
