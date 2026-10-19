"use client";

import type { ComponentProps } from "react";
import { useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useIsomorphicLayoutEffect } from "../utils/useIsomorphicLayoutEffect";

export const paper = "bg-background border border-border/60 dark:bg-popover";

export const floating = "bg-background border border-border/60 dark:bg-popover";

export const field =
  "bg-foreground/[0.04] forced-colors:border dark:bg-foreground/[0.06]";

export const fieldInteractive =
  "bg-foreground/[0.04] transition-colors hover:bg-foreground/[0.07] forced-colors:border dark:bg-foreground/[0.06] dark:hover:bg-foreground/[0.09]";

export const pressable =
  "transition-transform duration-(--motion-fast) ease-out-quart active:scale-[0.96] motion-reduce:transition-none";

export const ghostButton =
  "flex items-center justify-center rounded-full text-muted-foreground outline-hidden transition-[background-color,color,scale] duration-(--motion-fast) ease-out-quart hover:bg-foreground/[0.06] hover:text-foreground/90 active:scale-[0.96] focus-visible:ring-1 focus-visible:ring-foreground/20 motion-reduce:transition-none dark:hover:bg-foreground/[0.09]";

export const inkButton =
  "bg-foreground text-background transition-[opacity,scale] duration-(--motion-fast) ease-out-quart hover:opacity-90 active:scale-[0.96] motion-reduce:transition-none forced-colors:border";

export const iconSwap =
  "[grid-area:1/1] transition-[opacity,scale,filter] duration-(--motion-base) ease-out-quart motion-reduce:transition-none";

export const iconSwapIn = "scale-100 opacity-100 blur-none";

export const iconSwapOut = "scale-[0.25] opacity-0 blur-[4px]";

export const labelSwap =
  "col-start-1 row-start-1 flex w-max items-center gap-1.5 leading-none transition-[opacity,filter] duration-(--motion-base) ease-out-quart motion-reduce:transition-none";

export const labelSwapIn = "opacity-100 blur-none";

export const labelSwapOut =
  "pointer-events-none select-none opacity-0 blur-[2px]";

/**
 * Base UI measures the panel and publishes its height, so the disclosure opens
 * and closes with a transition instead of keyframes: interruptible, and the
 * exit is shorter than the entrance.
 */
export const collapsePanel =
  "h-(--collapsible-panel-height) overflow-hidden opacity-100 transition-[height,opacity] duration-(--animation-duration) ease-out-expo data-[starting-style]:h-0 data-[starting-style]:opacity-0 data-[ending-style]:h-0 data-[ending-style]:opacity-0 data-[ending-style]:duration-150 data-[ending-style]:ease-in-quart motion-reduce:transition-none";

export const live = "text-blue-500 dark:text-blue-400";

export const mono = "font-mono text-[11px] tracking-tight";

export function ShimmerLabel({
  active = true,
  className,
  ...props
}: ComponentProps<"span"> & { active?: boolean }) {
  return (
    <span
      className={cn(active && "shimmer motion-reduce:animate-none", className)}
      {...props}
    />
  );
}

/**
 * Scroll region for content that keeps its own whitespace. `whitespace-pre` in
 * a bounded box clips a long line with no way to reach it, so the rows scroll
 * instead.
 *
 * `codeSurface` wraps all the rows as one block, and the rows are its children.
 * It cannot go on each row: `min-width: 100%` resolves against the scroll
 * container's visible width rather than its scroll width, so a per-row width
 * leaves every row except the longest ending its background at the fold.
 */
export const codeScroll = "overflow-x-auto";

export const codeSurface = "w-max min-w-full";

export function SwapLabel({
  active,
  children,
  className,
}: {
  active: 0 | 1;
  children: [React.ReactNode, React.ReactNode];
  className?: string;
}) {
  const layers = [useRef<HTMLSpanElement>(null), useRef<HTMLSpanElement>(null)];
  const [width, setWidth] = useState<number | null>(null);

  useIsomorphicLayoutEffect(() => {
    const target = layers[active]?.current;
    if (!target) return undefined;
    const measure = () =>
      setWidth(Math.ceil(target.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    return () => observer.disconnect();
  }, [active]);

  return (
    <span
      style={width === null ? undefined : { width }}
      className={cn(
        "grid overflow-x-clip transition-[width] duration-(--motion-base) ease-out-quart motion-reduce:transition-none",
        className,
      )}
    >
      {children.map((layer, index) => (
        <span
          key={index}
          ref={layers[index]}
          aria-hidden={active !== index}
          className={cn(
            labelSwap,
            active === index ? labelSwapIn : labelSwapOut,
          )}
        >
          {layer}
        </span>
      ))}
    </span>
  );
}

/**
 * Copy turns into a check without the two icons snapping past each other: both
 * are always mounted, and the check pops on the spring when it takes over.
 */
export function CopyFeedbackIcon({
  copied,
  className,
}: {
  copied: boolean;
  className?: string;
}) {
  return (
    <span data-slot="copy-feedback-icon" className={cn("grid", className)}>
      <CheckIcon
        aria-hidden
        className={cn(
          iconSwap,
          "ease-spring",
          copied ? iconSwapIn : iconSwapOut,
        )}
      />
      <CopyIcon
        aria-hidden
        className={cn(iconSwap, copied ? iconSwapOut : iconSwapIn)}
      />
    </span>
  );
}

const TEXT_SWAP_OUT_MS = 160;

/**
 * A label that changes in place (model, effort) crossfades: the outgoing value
 * stays mounted for one short beat so the two never pop.
 */
export function TextSwap({
  value,
  className,
}: {
  value: string;
  className?: string;
}) {
  const [shown, setShown] = useState<{ current: string; outgoing?: string }>({
    current: value,
  });

  if (shown.current !== value) {
    setShown({ current: value, outgoing: shown.current });
  }

  useEffect(() => {
    if (shown.outgoing === undefined) return undefined;
    const timeout = setTimeout(() => {
      setShown((state) =>
        state.outgoing === shown.outgoing
          ? { current: state.current }
          : state,
      );
    }, TEXT_SWAP_OUT_MS);
    return () => clearTimeout(timeout);
  }, [shown.outgoing]);

  return (
    <span className={cn("grid min-w-0 overflow-hidden", className)}>
      <span
        key={shown.current}
        className="chat-text-swap-in col-start-1 row-start-1 truncate"
      >
        {shown.current}
      </span>
      {shown.outgoing !== undefined && (
        <span
          aria-hidden
          className="chat-text-swap-out col-start-1 row-start-1 truncate"
        >
          {shown.outgoing}
        </span>
      )}
    </span>
  );
}
