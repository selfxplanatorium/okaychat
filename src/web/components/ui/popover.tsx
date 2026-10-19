import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { cn } from "@/lib/utils";

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverClose = PopoverPrimitive.Close;

function PopoverContent({
  className,
  side = "bottom",
  align = "start",
  sideOffset = 6,
  children,
  ...props
}: PopoverPrimitive.Popup.Props & Pick<PopoverPrimitive.Positioner.Props, "side" | "align" | "sideOffset">) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner data-slot="popover-positioner" side={side} align={align} sideOffset={sideOffset} className="isolate z-50">
        <PopoverPrimitive.Popup
          className={cn(
            "dropdown-glass text-popover-foreground origin-(--transform-origin) rounded-xl border p-1.5 shadow-lg outline-none",
            "translate-x-0 translate-y-0 scale-100 transition-[opacity,scale,translate] duration-[var(--motion-base)] ease-out-expo",
            "data-[starting-style]:scale-96 data-[starting-style]:opacity-0",
            // Enters from the trigger's edge and settles outward, so the popup
            // reads as belonging to the control that opened it.
            "data-[side=bottom]:data-[starting-style]:-translate-y-1 data-[side=top]:data-[starting-style]:translate-y-1 data-[side=left]:data-[starting-style]:translate-x-1 data-[side=right]:data-[starting-style]:-translate-x-1",
            "data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[ending-style]:duration-[var(--motion-fast)] data-[ending-style]:ease-in-quart",
            "data-[side=bottom]:data-[ending-style]:-translate-y-0.5 data-[side=top]:data-[ending-style]:translate-y-0.5 data-[side=left]:data-[ending-style]:translate-x-0.5 data-[side=right]:data-[ending-style]:-translate-x-0.5",
            className,
          )}
          {...props}
        >
          {children}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverTrigger, PopoverContent, PopoverClose };
