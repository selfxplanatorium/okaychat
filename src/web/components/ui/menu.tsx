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
            "dropdown-glass text-popover-foreground data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 min-w-40 origin-(--transform-origin) rounded-xl border p-1 shadow-lg outline-none",
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
        "data-highlighted:bg-accent data-highlighted:text-accent-foreground flex cursor-default items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none data-disabled:opacity-50 [&_svg]:size-4",
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
