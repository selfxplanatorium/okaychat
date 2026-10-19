import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { cn } from "@/lib/utils";

const Menu = MenuPrimitive.Root;
const MenuTrigger = MenuPrimitive.Trigger;

function MenuContent({
  className,
  side = "bottom",
  align = "start",
  sideOffset = 6,
  ...props
}: MenuPrimitive.Popup.Props & Pick<MenuPrimitive.Positioner.Props, "side" | "align" | "sideOffset">) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner side={side} align={align} sideOffset={sideOffset} className="isolate z-50">
        <MenuPrimitive.Popup
          className={cn(
            "dropdown-glass text-popover-foreground min-w-40 origin-(--transform-origin) rounded-xl border p-1 shadow-lg outline-none",
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
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

function MenuItem({ className, ...props }: MenuPrimitive.Item.Props) {
  return (
    <MenuPrimitive.Item
      className={cn(
        "data-highlighted:bg-accent data-highlighted:text-accent-foreground flex cursor-default items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none transition-colors duration-[var(--motion-instant)] ease-out-quart data-disabled:opacity-50 [&_svg]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function MenuLabel({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("text-muted-foreground px-2.5 pt-1.5 pb-1 text-xs font-medium", className)} {...props} />;
}

export { Menu, MenuTrigger, MenuContent, MenuItem, MenuLabel };
