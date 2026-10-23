import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { cn } from "@/lib/utils";
import { ScrollArea } from "./scroll-area";

const Menu = MenuPrimitive.Root;
const MenuTrigger = MenuPrimitive.Trigger;
const MenuSubmenuRoot = MenuPrimitive.SubmenuRoot;

const itemBase =
  "flex cursor-default items-center gap-2 rounded-lg px-2.5 py-1.5 pointer-coarse:py-2.5 text-sm outline-none select-none transition-colors duration-[var(--motion-instant)] ease-out-quart data-disabled:opacity-50 [&_svg]:size-4";
// Touch opens highlight the first item like keyboard opens do, which reads as a selection. Touch also gets no
// `:active` fill, since mobile browsers keep it after the tap.
const itemClass = `pointer-fine:data-highlighted:depth-primary pointer-fine:data-highlighted:text-primary-foreground ${itemBase}`;
// The solid accent highlight would hide that the action destroys something.
const destructiveItemClass = `text-destructive data-highlighted:bg-destructive/10 ${itemBase}`;

function MenuContent({
  className,
  side = "bottom",
  align = "start",
  sideOffset = 6,
  alignOffset,
  anchor,
  children,
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<MenuPrimitive.Positioner.Props, "side" | "align" | "sideOffset" | "alignOffset" | "anchor">) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner side={side} align={align} sideOffset={sideOffset} alignOffset={alignOffset} anchor={anchor} className="isolate z-50">
        <MenuPrimitive.Popup
          className={cn(
            "dropdown-glass text-popover-foreground flex max-h-(--available-height) min-w-40 origin-(--transform-origin) flex-col overflow-hidden rounded-xl border depth-float outline-none",
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
          <ScrollArea viewportClassName="p-1">{children}</ScrollArea>
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

function MenuItem({ className, destructive, ...props }: MenuPrimitive.Item.Props & { destructive?: boolean }) {
  return <MenuPrimitive.Item className={cn(destructive ? destructiveItemClass : itemClass, className)} {...props} />;
}

function MenuSubmenuTrigger({ className, ...props }: MenuPrimitive.SubmenuTrigger.Props) {
  return <MenuPrimitive.SubmenuTrigger className={cn(itemClass, className)} {...props} />;
}

function MenuLabel({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("text-muted-foreground px-2.5 pt-1.5 pb-1 text-xs font-medium", className)} {...props} />;
}

function MenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return <MenuPrimitive.Separator className={cn("bg-border -mx-1 my-1 h-px", className)} {...props} />;
}

export { Menu, MenuTrigger, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuSubmenuRoot, MenuSubmenuTrigger };
