// Ported from T3Code (MIT, Copyright (c) 2026 T3 Tools Inc.). Source: apps/web/src/components/ui/tooltip.tsx
// Scroll-dismiss tracking and the desktop titlebar offset are left out.
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

// Base UI's default, restated because a padding object zeroes the sides it omits.
const COLLISION_PADDING = 5;

// Base UI's default open delay applies, so tooltips wait for a deliberate hover.
const TooltipProvider = TooltipPrimitive.Provider;

function Tooltip<Payload>(props: TooltipPrimitive.Root.Props<Payload>) {
  return <TooltipPrimitive.Root {...props} />;
}

function TooltipTrigger(props: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  align = "center",
  alignOffset,
  sideOffset = 4,
  side = "top",
  anchor,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<TooltipPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset" | "anchor">) {
  return (
    <TooltipPrimitive.Portal>
      {/* Above floating panels (the theme editor is z-110), whose glass would otherwise blur it. */}
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        className="pointer-events-none z-[140] h-(--positioner-height) w-(--positioner-width) max-w-(--available-width) transition-[top,left,right,bottom,transform] data-instant:transition-none"
        collisionPadding={COLLISION_PADDING}
        data-slot="tooltip-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <TooltipPrimitive.Popup
          data-glass-surface="overlay" data-glass-tooltip=""
          className={cn(
            "text-popover-foreground relative flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) rounded-md text-xs text-balance transition-[width,height,scale,opacity] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-md)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] data-ending-style:scale-98 data-ending-style:opacity-0 data-instant:duration-0 data-starting-style:scale-98 data-starting-style:opacity-0 dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
            "bg-popover border shadow-md/5 not-dark:bg-clip-padding",
            "max-w-80 leading-snug wrap-anywhere whitespace-normal",
            className,
          )}
          data-slot="tooltip-popup"
          {...props}
        >
          <TooltipPrimitive.Viewport
            className="relative size-full overflow-clip px-(--viewport-inline-padding) py-1 [--viewport-inline-padding:--spacing(2)] data-instant:transition-none **:data-current:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-current:opacity-100 **:data-current:transition-opacity **:data-current:data-ending-style:opacity-0 **:data-current:data-starting-style:opacity-0 **:data-previous:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-previous:truncate **:data-previous:opacity-100 **:data-previous:transition-opacity **:data-previous:data-ending-style:opacity-0 **:data-previous:data-starting-style:opacity-0"
            data-slot="tooltip-viewport"
          >
            {children}
          </TooltipPrimitive.Viewport>
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

// Icon buttons are everywhere (several per message, two per code block). A tooltip root per button made a long
// chat mount hundreds of tooltip states, so every icon button is a trigger of this one shared tooltip.
type SharedTooltip = { tooltip: ReactNode; side: "top" | "bottom" | "left" | "right" };
const sharedTooltip = TooltipPrimitive.createHandle<SharedTooltip>();

/** Renders the shared icon-button tooltip. Mounted once at the app root. */
function SharedTooltipHost() {
  return (
    <TooltipPrimitive.Root handle={sharedTooltip}>
      {({ payload }) => (payload ? <TooltipContent side={payload.side}>{payload.tooltip}</TooltipContent> : null)}
    </TooltipPrimitive.Root>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, SharedTooltipHost, sharedTooltip };
