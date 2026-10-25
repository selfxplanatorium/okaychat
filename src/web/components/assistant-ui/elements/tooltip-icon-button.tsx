"use client";

import { type ComponentPropsWithRef, type ReactNode, forwardRef, useMemo } from "react";

import { sharedTooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Kbd } from "@/keyboard/Kbd";
import { ariaCombo } from "@/keyboard/keys";
import { useShortcut } from "@/keyboard/registry";

export type TooltipIconButtonProps = ComponentPropsWithRef<typeof Button> & {
  tooltip: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  /** Keyboard command this button runs: its target for the dispatcher, and its shortcut in the tooltip. */
  command?: string;
};

export const TooltipIconButton = forwardRef<
  HTMLButtonElement,
  TooltipIconButtonProps
>(({ children, tooltip, side = "bottom", className, command, ...rest }, ref) => {
  const combo = useShortcut(command ?? "");
  const payload = useMemo(
    () => ({
      tooltip: combo ? <span className="flex items-center gap-2">{tooltip}<Kbd combo={combo} /></span> : tooltip,
      side,
    }),
    [tooltip, side, combo],
  );
  return (
    <TooltipTrigger
      handle={sharedTooltip}
      payload={payload}
      render={
        <Button
          variant="ghost"
          size="icon"
          data-command={command}
          aria-keyshortcuts={combo ? ariaCombo(combo) : undefined}
          {...rest}
          className={cn(
            "aui-button-icon size-6 p-1 pointer-coarse:size-9 pointer-coarse:p-2",
            className,
          )}
          ref={ref}
        />
      }
    >
      {children}
      <span className="aui-sr-only sr-only">{tooltip}</span>
    </TooltipTrigger>
  );
});

TooltipIconButton.displayName = "TooltipIconButton";
